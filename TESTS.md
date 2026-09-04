# Test Design

Three layers:

1. **Grok-free automated tests** (Vitest) — pure-logic unit tests plus happy-dom DOM tests that drive the real `media/chat.js`, plus a fast TerminalManager suite that spawns real shell children. **4,850+ tests across ~207 files, all passing in about two minutes.** The per-file list below is **non-exhaustive** and its counts predate several feature releases (voice, ask-question, plan-mode, v1.4.0 media/subagent/logout, v1.4.19 card-collapse/background-task, the Agent Dashboard/session-pool, telemetry, vision input, and the typed host↔webview message contract) — it's indicative, not exact. `npm test` is the source of truth. One suite is worth naming because it replaces clicking: `test/device-login-cloud-fixes.test.ts` enumerates every provider-row configuration a remote can be in — fresh, starting, waiting, verifying, done-with-a-stale-snapshot, connected, lapsed, failed, plus the desk-remote controls — and asserts one row per provider with an unchanging heading. A Playwright twin renders the same cases to a single screenshot when a person wants to look at them. **None of them spawn the `grok` binary**, so the whole suite runs in CI on clean boxes (`.github/workflows/ci.yml`'s `test` job runs `npm ci && npm run compile && npm test` and never installs grok; the VSIX is built once, on Ubuntu). **CI's `test` job runs this exact suite — `npm test` locally ≡ that job, verbatim.** It is a **two-OS matrix (`ubuntu-latest`, `macos-latest`), `fail-fast: false`** — added after six tests sat red on macOS for at least ten days with nothing in the pipeline able to see them.
2. **Real-grok pre-release suite** (`npm run test:live`, `scripts/live-tests.cjs`) — an **on-demand, run-on-request** gate that spawns the real `grok` binary and drives it over ACP end-to-end: handshake, a **capability-drift probe** (`capabilities` — snapshots advertised `promptCapabilities` and asserts the documented `image:false` baseline; with `vision-prompt` pinning that vision *actually* works, the pair is an advertised-vs-actual drift detector), prompt round-trip, a **mid-turn cancel** (`cancel-mid-turn` — the Stop-button contract: an id-less `session/cancel` settles the in-flight prompt with a cancelled stopReason and the session stays usable, #37), **mid-turn steering** (`interject` — the Steer contract, #52: `_x.ai/interject` reaches the model mid-turn AND the turn still ends uncancelled, so steering never destroys in-flight tool work), **conversation forking** (`session-fork` — #48: a new session id, the parent's history carried into it, loadable), **concurrent sessions** (`parallel-sessions` — two CLI processes on one workspace answer overlapping prompts independently, no cross-talk), session restore, the **plan-mode gate modeled as the two real flows** (primer → plan → `[Plan rejected]` (gate up, 0 workspace mutations + a byte-identical-seed-file containment canary) → `[Plan approved]` (gate down, implementation can land)), image gen, video gen, the two **v1.6.1 notification-rail canaries** — `compact-notification` (after `/compact`, an `auto_compact_completed.tokens_after` arrives on `_x.ai/session_notification` and feeds the real `contextUsedFromCompactNotification`; asserts NO `auto_compact_started` on a manual compact, pinning the auto/manual split) and `effort-live` (set_model `_meta.reasoningEffort` applies live and is confirmed **applied** — not just accepted — by a `model_changed` whose `reasoning_effort` equals the target) — and subagent delegation on BOTH agent families — `subagent` (default model / grok-build agent) and `subagent-composer` (first `*composer*` model) — each of which now **hard-asserts the LIVE `_x.ai/session_notification` lifecycle** (`subagent_spawned` + a matching `subagent_finished` with a finite `duration_ms`; the CLI transmits these as of grok 0.2.101 and the extension fills the card's duration/output from them, incl. Composer whose tool-channel completion carries none). Each **SKIP**s when grok doesn't delegate or the model isn't available. It **reuses the real compiled modules** (`out/acp-dispatch.js`, `out/plan-gate.js`, `out/grok-primer.js`, `media/webview-helpers.js`) so it tests shipped logic, not re-implementations. Non-deterministic / entitlement-gated outcomes **SKIP** (don't fail the gate); only a real regression **FAILS**. It is **never run by `npm test` or CI** — it needs an authenticated `grok` + network + subscription. The **`release.*` scripts now run it by default** (`-SkipLive`/`--skip-live` opts out). Flags: `--smoke` (handshake + capability-drift only), `--quick` (skip slow tests incl. the 4-turn plan-mode), `--only=<name>`, `--skip=<name>`, `GROK_BIN=<path>`. See [CLAUDE.md § Test taxonomy](CLAUDE.md).
3. **VS Code integration smoke** (`npm run test:integration`, `@vscode/test-electron`) — boots a real VS Code, activates the extension, asserts the contributed commands are registered, and resolves the webview via the **missing-CLI onboarding path** (needs no grok binary), covering host glue the unit suite can't (activation, `getHtml`/CSP, `localResourceRoots`, command registration). The repo-selection suite then points `grok.cliPath` at `test/fixtures/fake-grok-acp.cjs` (`provisionFakeGrok`) so remote resume / `session/load` and matching-sessionId worktree tests run hermetically on every platform. Compiles in isolation (`integration/tsconfig.json` → `out-integration/`); `.vscode-test.mjs` drives it. Runs in CI as a **required** job under `xvfb` (validated passing against a real VS Code Extension Host). Still grok-binary-free. Not part of `npm test` (needs a headed/`xvfb` VS Code + an Electron download).

4. **Screens checks** (`npm run e2e:screens`, here **and** in the relay repo) — a real Chromium / real Electron window driven through chat → file panel → open a file → edit, capturing a frame at each step and asserting what layer 1 structurally cannot. The vitest DOM suites run in happy-dom, which has **no layout engine**: rects are zeros and stylesheets never apply, so an icon with no size, a control pushed off-screen, or a panel overlapping the header all satisfy every assertion they can make. The file panel's action row shipped as three EMPTY BOXES through a green suite, three review rounds and a deploy; a human found it in a screenshot. These assert rendered geometry — every painted icon occupies space, the panel starts below the bar holding its toggle, nothing scrolls sideways — and leave the frames in `.screens/` for a person or a model to look at. Grok-free and deterministic, so safe in a gate. The desktop one builds the **grok-qa fixture** (`scripts/qa-fixture.mjs`): a fixed project *and* a fixed session store pointed at via `GROK_HOME`, so the rail has real history in it and frames are comparable between runs.
5. **Live app smoke** (`npm run smoke:live`) — the desktop app against the **real** grok CLI: start it, send a prompt, wait for the reply, open the file panel on real files, confirm the CLI actually wrote a transcript. Complements (2) rather than repeating it — `test:live` drives the CLI over ACP and proves the *protocol*; this drives the *app* and proves a person can use it. Prints a report and leaves frames to read. **Never in `npm test` or CI** (real CLI, key, network), and it refuses to fall back to the test fixture when no real CLI is present, because a green run against a fake is worse than no run.

6. **Lifecycle host** (`npm run e2e:lifecycle-host`) — a long-lived real desktop host the relay repo's orchestrator spawns as a child. Not a driver: it provisions the fake ACP CLI, connects the shipped uplink to `GROK_RELAY_URL` with a development-only injected token, prints `GROK_LIFECYCLE_HOST_READY` once the relay admits the host (`clients` frame), clears the ready deadline on that line, and idles until it reads `GROK_LIFECYCLE_HOST_SHUTDOWN` on stdin (then kills Electron, waits for its actual exit, and exits; SIGINT/SIGTERM remain a fallback). Restart is shutdown + spawn against the same `GROK_HOME`. The token gate (`resolveInjectedDeviceToken`) is in the grok-free unit suite; the runner itself is not. A production build never accepts the injected token.

7. **Open-timing check** (`npm run e2e:open-timing`) — the real Electron build against the grok-qa fixture, opening conversations from the rail and then reading the `session open:` lines the app *actually wrote to `desktop.log`*. It exists because the unit suite proves the formatter and can prove nothing about the wiring: whether the phases tile a real open, whether the line survives the route to the log file, or whether the clock covers the part of the open the user is waiting through. It asserts every phase is present and that phases + `other` equal the total exactly, and it reports the window between the click and the clock — the measurement that found `resolve`. It writes a synthesised 1.47MB `session-meta.json` on **every** run (the size a heavy real store reaches; contents synthesised, never copied from a real store), because that is what moves `resolve` from ~40ms to ~250ms — and a pre-start window of a couple of hundred milliseconds is what lets the check SEE the clock wiring vanish. It asserts the widest `resolve` is **non-zero**, which is the functional signal: the phase prints `0ms` when no caller owns a clock, so unwiring `openSession` takes it to exactly 0. (A millisecond floor was tried and removed — that is a claim about how fast the machine is, and a fast enough machine would fail a correct build.) `SMALL_META=1` opts out, for comparing the two. Grok-free and deterministic.

   It also carries three instruments the line itself cannot provide, because `total` is WALL time and a spinner and a frozen window print the same number. A **50ms heartbeat installed in the Electron main process** (through Playwright's `app.evaluate`, so no product code ships for it) measures how LATE a timer fires, which is what a freeze actually is; it reports the worst stall AND the **total** unresponsive time, because the worst alone improves when work merely moves out of a measured phase into the gap between two opens. `FAKE_NEW_SESSION_DELAY_MS=3000` makes the fake agent stall only its `session/new` reply, which separates a slow AGENT from a slow HOST — measured: the delay lands in `new` and the main thread is *less* disturbed than at baseline, so an agent that takes three seconds is a spinner and not the reported freeze. `FILLER_SESSIONS=N` writes N synthesised conversations beside the fixture's three, because three is not a load test and the catalog is walked synchronously: at 3000 the main thread was unresponsive for 2.4s in one stall, which is #133 reproduced on demand. `MAIN_STALL_MS=N` turns lateness into an assertion; it is off by default deliberately, because a threshold guessed before a healthy range is known on real hardware is a check nobody trusts. **Quote it only from a matched pair taken back to back.** The number is load-sensitive: the same build measured 10.1s of unresponsiveness while a test suite ran alongside it and 4.7s on an idle machine, which is a bigger spread than most of the improvements being measured. Walk counts do not drift that way and are the safer claim.

   Two blind spots it documents rather than fixes: returning to a conversation whose client is still alive takes the `focusSession` branch and logs **nothing at all**, and `dispose` is structurally 0ms on the rail-open path (a cold open builds a fresh `Session`, so there is no client to replace — the outgoing one is parked before the clock exists).

Separately, **grok-dependent probes** live as standalone scripts under `research/*.cjs`. They exercise the real CLI's ACP behavior (e.g. confirming `exit_plan_mode` treats any client reply as approval, or capturing the native-Windows media/subagent wire shapes) and are run **manually** — Vitest's `include` glob is `test/**/*.test.ts`, so it never collects them. They're non-destructive (ACK writes without touching disk and run in a temp cwd) and require a `grok` binary on PATH; CI doesn't run them. The probes are the **discovery** tool (capture an undocumented shape once); layer 2 is the **regression** tool (re-verify the shapes still hold before each release).

The goal of layers (1)+(2) is to make the protocol surface and UI logic regression-proof. Layer 1 catches logic regressions on every commit; layer 2 catches CLI-contract drift (a new grok version changing a wire shape) before each release.

## Standing test discipline

- Every branch on `session.provider === …` has explicit coverage for both providers.
- Remote conversation claim: a `resumeSession.claim` transfers the same live `Session` and a non-claim still refuses; the loser gets `error.code: "session-superseded"` without `clearMessages`; a stale session-bound message from a demoted tab is refused rather than adopted; the desk `focused` pointer is untouched. Client: rail/history/Continue here set the bit, reconnect restore does not.
- When a wrapper takes over a function with documented invariants, the wrapper carries the function's contract tests. Mixed history treats Grok consumed-slot pagination as opaque and property-tests exact-once/no-skip output against a full-list oracle across hidden rows, ties, mtime drift, and Codex age mixes.
- Provider sign-out regressions drive the real `onMessage({type:"logout"})` command path and assert pre-persistence atomic disposal (slow + rejected stores), focused/remote/background draft recovery, detached-tab reconnect replacement, focused-cwd rooting while another project is browsed, and other-provider preservation. A background draft is asserted on both sides of a host restart: parked into globalState by the real logout, handed back by a real `resumeSession` on a **second sidebar sharing the same memento** (against the fake Codex adapter), and never handed back twice. Re-connection drives the real `recheckConnection` and asserts every stranded view is adopted, while a detached view keeps META untouched until its same-provider or other-provider logical tab reconnects and has a composer. History authorization drives the real remote `listSessions` ingress; pagination drives the real DOM message/request path without synthetic scroll events.
- Draft lifecycle tests also drive New-session parking, remote detach/reconnect,
  release, failed and successful provider retargeting, the empty-session sweep,
  and the TTL/LRU selector. The invariant is that `needsProvider` or a draft makes
  a session non-empty and non-reapable, while META is cleared only after startup.
- An auth-shaped failure from a background probe is asserted through that probe's own entry point — a gear re-check for the model warm-up, a remote `listSessions` for the history listing — and must change the ACCOUNT's state rather than let a surface degrade silently; Codex uses only `isCodexCredentialError`, so an uncoded `Sign in required` matches while `unauthorized model for project` and billing failures leave it alone.
- Provider-login tests use Codex's uncoded `Sign in required` shape and drive the
  real Re-check and login actions, including a delayed successful probe. Remote
  policy tests prove durable Re-check is refused while retrying an already-connected
  session remains available.
- Fixtures for external artifacts mirror the real artifact listing and layout, including multi-platform bundles and the Codex package structure; idealized fixture layouts are insufficient.
- Every new filesystem or network stream has fault-injection coverage for its asynchronous error paths.
- **A green `tsc --noEmit` says nothing about this directory.** `tsconfig.json` is `include: ["src/**/*"]`, and vitest transpiles with esbuild rather than typechecking — so a type error in a test file passes every gate we run. A duplicate import in a test survived six of them. Read test code as unchecked code.
- **Colour is checked by looking, not only by reasoning** (`npm run e2e:hc-colour`). It renders the shipped `media/chat.css` in real Chromium against the REAL palette values from VS Code's bundled workbench — Dark Modern and Dark High Contrast — and measures each mark's contrast against the surface behind it. #139 was diagnosed from theme data alone (`button.background` is literally `Color.black` for hcDark) and that was right, but reading a token value is a weaker claim than a picture: measured, the active effort dots and the popover check sat at **1.14:1** against the popover in High Contrast, which is not "hard to see" but invisible. After the fix, 7.01:1 there and 4.99:1 in Dark Modern (from 2.39:1, so standard dark is a modest brightening, not a regression). Frames land in `.screens/`. It is not a live VS Code window, so it cannot catch a theme overriding something we did not model — what it catches is us using a colour in a role its own theme never promised.
- A VS Code colour token is used in the ROLE it was defined for, and `test/theme-token-roles.test.ts` enforces it across `media/*.css`. `button.background` is a surface, legible only under `button.foreground`; Dark High Contrast sets it to pure black, which is how a check mark and the filled effort dots became invisible (#139). A foreground mark takes a foreground token.

---

## What we test

### `test/acp-dispatch.test.ts` — protocol primitives (86 tests)

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

### `test/slash-filter.test.ts` — slash autocomplete + dispatch gate

- `getSlashQuery` activates on `/` at position 0 (`atStart`) or after whitespace (mid-prompt skills); no false positives on `path/foo/bar`
- `isAdvertisedSkill` is true only when `_meta.scope` + `_meta.path` are non-empty strings
- Empty query returns the full command list
- Name filter is case-insensitive substring, prefix matches first then mid-name, stable within each tier (#110)
- `applySlashPick` replaces the slash token at the caret (including mid-prompt skills), preserves trailing text, returns the new caret position
- `matchSlashCommand` recognizes an advertised command only at position 0 (rejects Unix paths / mid-line slashes)
- `filterAdvertisedCommands` drops the config-mutating `/always-approve` from both the autocomplete list and the dispatch gate (#31)

### `test/slash-popover.dom.test.ts` — "/" skill/command popover in a real DOM (#110)

- Typing `ui` finds `ux-ui-promax`; `design` finds `web-design`
- Prefix matches rank above substring matches; non-matches stay out; matching is case-insensitive; no-match hides the popover
- Skills (`_meta.scope`+`_meta.path`) are offered mid-prompt; commands only at position 0 (#110)

### `test/mention.test.ts` — "@" file autocomplete, pure halves (24 tests)

- `getMentionQuery` triggers only on `@` at text start / after whitespace (emails like `user@host` never trigger), is caret-anchored, closes on whitespace or a second `@`
- `applyMentionPick` replaces only the `@token` before the caret with `@relPath `, preserves surrounding text, returns the new caret, and is `$`-sequence-safe
- `filterMentionFiles` ranks basename-prefix → basename-substring → path-substring → subsequence, case-insensitive, shorter-path-first within a tier, capped at the limit
- `buildExcludeGlob` merges only `true`-valued patterns from files.exclude/search.exclude and always excludes node_modules/.git
- `orderMentionIndex` sorts shallow-first then alphabetical without mutating its input
- Mention attachment containment rejects parent/absolute escapes, path-prefix siblings, and canonical paths outside the workspace; Windows checks are case-insensitive

### `test/file-upload.test.ts` — remote document upload boundary, pure

- Accepts only `.md`, `.txt`, `.pdf`, `.csv`, `.xlsx`, `.docx`; strips both path separator styles, sanitizes Windows-reserved basenames, and strictly validates base64/empty/20 MiB cases
- Owned staging paths must have exactly `<root>/<uuid>/<filename>` shape
- Session deletion preserves paths still referenced by another session/fork and identifies files safe to remove after the last reference

### `test/worktree.test.ts` — worktree helpers, pure (P2-8, 23 tests)

- `parseWorktreeCreate` / `parseWorktreeApply` / `parseWorktreeRemove` / `parseWorktreeList` / `parseWorktreeStatus` pull the worktree path/label/status out of each `_x.ai/git/worktree/*` payload shape (and tolerate the unsupported/malformed forms)
- Path equality is separator- and case-normalized so a worktree cwd matches across slash styles
- `worktreeDisplayName` derives the `WT <label>` badge; `mergeSessionIndexes` / `collectSessionCwds` fold the workspace cwd + known worktree paths into one newest-first history list without dupes

### `test/rewind.test.ts` — rewind helpers, pure (P2-9)

- `parseRewindPoints` / `parseRewindExecute` pull the selectable restore targets + execute result out of the `_x.ai/rewind/*` payload shapes (tolerating the unsupported/malformed forms)
- Target selection, confirm-prompt and label formatters produce the QuickPick text the gate shows before reverting files

### `test/run-progress.test.ts` — Deep Research / Workflow / Goal progress, pure (P2-10)

- `isRunProgressUpdate` / `parseRunProgressUpdate` recognize + normalize `workflow_updated` / `goal_updated` off the live `_x.ai/session_notification` rail into the progress-card shape
- `workflowControlCommand` maps a pause/resume/stop control to the CLI's control slash command

### `test/mention.dom.test.ts` — "@" popover + waiting indicator in a real DOM (12 tests)

- Typing `@`/`@ch` posts `mentionQuery` per keystroke; a mid-word `@` (email) posts nothing
- `mentionResults` renders name + dimmed-dir rows and shows the popover; stale replies (query moved on / popover closed) are dropped; an empty list hides the popover but keeps the token querying
- ArrowDown + Enter picks the highlighted file (token rewritten, `addMentionFile` posted, popover hidden) without triggering send/queueSend; clicking a row picks too; Escape closes without touching the text
- `agentStart` shows the shared waiting indicator with provider copy (Grokking / Opening AI), and the composer placeholder switches live between Ask Grok and Ask GPT

### `test/grok-config.test.ts` — config.toml permission-mode reader (15 tests)

- `readUiPermissionMode` reads `permission_mode` from the `[ui]` table only (ignores other tables, the `[[marketplace.sources]]` array table, comments, CRLF)
- `isAlwaysApprovePermission` matches the hyphen/underscore spellings grok writes
- `configForcesAlwaysApprove` applies project-over-global precedence (#31)

### `test/terminal-manager.test.ts` — terminal handler

These actually spawn real shell children (the resolved POSIX `$SHELL` or `/bin/sh`, or real PowerShell on Windows) — fast enough to keep in the unit suite.

- Captures stdout from a quick command + exit code
- Captures stderr and nonzero exit (exact code on POSIX; non-zero under Windows PowerShell, which collapses native codes to 1)
- Honors `outputByteLimit` and sets the `truncated` flag
- Returns `exitStatus: null` while still running
- Injects env from ACP-style `[{name, value}]` pairs
- Honors `cwd`
- `waitForExit` resolves on repeated calls after exit
- Throws on unknown terminalId
- `kill` / `release` on missing id is a no-op
- `disposeAll` kills outstanding terminals
- **`resolveTerminalShell` (#46, #140)** — POSIX → `$SHELL` when it is an absolute path in the POSIX-grammar allowlist and a regular executable file (else `/bin/sh`, no PATH probe); Windows → `pwsh.exe`→`powershell.exe`→cmd.exe, in that order
- **`unwrapGrokBashLoginWrapper` / `posixSpawnArgv` (#140)** — peel grok's `/bin/bash -lc` wrapper; POSIX spawn is `[host, '-c', script]` (`shell: false`) so `$SHELL` cannot exec bash 3.2; skipped-on-Windows live test asserts `$0` is the host shell
- **Windows PowerShell host (#46, Windows-only, skipped on CI)** — real PowerShell pipeline (`… | Measure-Object`), a non-builtin cmdlet (`Get-Date`), `$PSVersionTable`, and a `Format-List` pipeline all run through `TerminalManager` (cmd.exe would fail these); the resolved host shell is never cmd.exe

### `test/cli-locator.test.ts` — CLI discovery + upgrade detection (9 tests)

- Configured path wins if it exists
- Returns `undefined` when configured path is missing
- Falls back to PATH lookup; `~/.grok/bin/grok` is also accepted when present
- Returns `undefined` when nothing is found
- **`extensionWasUpgraded`** — true on any version change (incl. a downgrade), false on a fresh install / unchanged version / empty stored version; gates the silent `grok update` the extension runs once when its own version changes

### `test/sessions.test.ts` — session listing & naming

- **`capAutoName` / `capSessionMetaAutoNames`** — storage ceiling for `autoName` (`AUTO_NAME_MAX_CHARS` 120): long prompts cut on a nearby word boundary, multi-line whitespace collapsed, already-short and exactly-at-limit names unchanged, empty/undefined → `""`. The map helper caps only `autoName`, leaves `customName` and already-short entries byte-identical, and is a no-op the second time.

- Lists sessions from grok's on-disk layout (`~/.grok/sessions/<urlencoded-cwd>/<id>/`) for the current cwd only
- Row naming precedence (#96): a manual `customName`, then grok's own title (`cliSessionTitle` — `session_summary`, else `generated_title`), then our first-message `autoName`, then `Untitled (<date>)`. A legacy primer-derived title is rejected in both its summarized and verbatim forms, while a real session that merely mentions a primer is kept
- Sorts by most-recently-updated; tolerates malformed/missing session files without throwing
- Delete removes the right entry and leaves others intact
- **`isEmptySession`** — the predicate the sweep deletes on (#97). Chat history is authoritative: zero real user queries means empty, whatever `num_messages` says, which covers both today's never-typed-into sessions and legacy primer-only ones. Renamed, pinned, worktree-bound and subagent sessions are refused, as is a history file that exists but cannot be read; a directory holding nothing but `summary.json` is the unloadable shape and does qualify
- **`historyIsIntelligible`** — the interlock beneath it: a history in a format we cannot parse is never called empty (one CLI schema change would otherwise make the sweep delete everything), while a truncated final line from a write in progress still leaves the real queries before it visible, and a zero-byte file falls through to the message count rather than to a parse failure

### `test/plan-mode-transition.test.ts` — Plan chrome follows the RPC outcome

Drives `GrokSidebar.setMode("plan")` against a stub client. A rejected `session/set_mode` must leave `planActive` down and keep the previous Auto-accept badge; a successful one must not raise the host chrome until the RPC returns. The same-chunk race — success reply plus a `terminal/create` in one stdout write — is pinned in `test/acp.test.ts` through the real readline dispatch, not by calling handlers directly. Auto accept → Plan plus a same-chunk `session/request_permission` is pinned here through that same readline path: grok must reject a mutating edit, and Codex/Claude must not auto-select their plan-review `allow_once`/`allow_always` (Codex `implement_plan`, Claude `acceptEdits`) because a stale `session.planActive` read would still see `autoApprove` and grant implementation. Codex must also not apply grok's write/terminal refusal (`usesClientPlanGate` stays false). The inverse click — a pending adapter plan-review card, then a flip to Auto accept — must not write `implement_plan` / `acceptEdits` / `default`, including when the mode-change RPC then fails; the card stays in `pendingPermissions` and a later `permissionAnswer` is still accepted. A sibling pending edit is still auto-approved (#64). A `switch_mode` card that arrives after Auto accept is already on is also left for a human.

### `test/plan-gate.test.ts` — plan-mode policy (69 tests)

The pure heart of client-side plan enforcement. No spawn, no fs — just the classification logic the **three** choke points call (`fs/write_text_file`, `terminal/create`, and — since 2.1.1 — `session/request_permission`, which previously auto-declined every `execute` on tool kind alone).

- **Write containment is allowlist-shaped, not denylist-shaped** — only the canonical grok-owned `~/.grok/sessions/<encoded-cwd>/<id>/plan.md` is permitted; every other write is refused, inside the workspace *or* outside it. The older rule blocked only paths inside the session cwd, which permitted writes into a sibling repository
- **Read-only command allowlist** — `isReadOnlyCommand` passes only when *every* segment is on the read-only head list, with argument-aware rules where the head alone doesn't decide (`git`/`npm` subcommands, `find -delete`/`-exec`, `sed -i`, `sips -g` versus its transforming forms)
- **Commands are tokenized the way a shell would** before classification — quotes removed, escapes normalized, dialect-aware (POSIX / PowerShell / cmd). This is what stops `find . -de\lete` reading as safe while executing `-delete`, and it is why properly quoted arguments (`grep -rn "TODO" src`) are *allowed*: a quoted token is inert, so refusing it was over-blocking rather than caution
- **Metacharacter rejection, by meaning rather than by character** — redirection is judged by its target, so provable null sinks and stream merges (`2>$null`, `2>/dev/null`, `2>&1`) pass while anything naming a path is refused; parentheses, substitution, globbing that could yield an option, and cmd `%VAR%`/`!VAR!` expansion are refused
- **One narrow control-flow grammar** — `if (Test-Path … | $? | $LASTEXITCODE) { … } else { … }` with both branches recursively classified. Script-block braces stay unsafe by default; nested control flow, computed conditions and calculated properties (`@{e={ … }}`) remain refused
- **Regression corpus** — each bypass found during the 2.1.1 review rounds is pinned: a mutating command riding along with a plan write, `$()` inside a quoted payload, a bare-paren subexpression behind an allowlisted head, and escaped dangerous options

### `test/session-start-decision.test.ts` / `test/send-start-race.test.ts` — send vs startSession

A concurrent `startSession` used to swallow a send: `handleSend` echoed `userMessage`, then `gen !== session.gen` returned with no turn-failed signal. `decideSessionStart` is the pure gate (`ensure` refuses a live turn and reuses a matching ready client). The sidebar tests drive real `handleSend` / `startSession`: an opportunistic start during a turn leaves `gen` and the client untouched; a replacing start after the echo emits `INTERRUPTED_SEND_TEXT` as `error` with `code: "interrupted-send"` (not `agentError`); a send behind a paused start issues exactly one prompt after startup settles.

### `test/queued-send-commit.test.ts` — queued-send claim lifecycle (4 tests)

The queue is released at `handleSend`'s synchronous commit point, not before it. Covers: a send that bails before committing keeps the text, a send that commits releases it and cannot be re-flushed at turn end, and text appended during the attempt survives.

### `test/pending-permission.test.ts` — permission option lifecycle (4 tests)

Plan mode hides persistent-grant options on `execute` cards, and the host validates an answer against the options it actually rendered — so a remote client cannot answer with an option id it was never offered. Covers restoring the full set once plan mode exits.

### `test/persisted-state.test.ts` — durable client state

`PersistedState` keeps session names, pins, archives and the install id in `~/.grok/client-state/*.json` instead of VS Code `globalState`, so another client on the same machine reads the same state. Covered: keys it does not own delegate straight to `globalState`; the first-run migration seeds each file from `globalState` **and preserves the existing install id** (a fresh one would read as a new machine at the relay and mint a second device row against the one-device cap); disk beats a stale shadow, and a disk value hydrates the shadow so downgrade still finds it; a synchronous read refreshes when another client changed the file; a write **rebases on the current disk snapshot** — another client's entries survive, and *the writer's own deletions still delete* rather than being resurrected; the install id is created atomically, so of two racing instances one wins and the other adopts it; write-then-rename; corrupt JSON and wrong-shaped JSON (`null`, arrays, unrelated objects) both fall back to the shadow rather than crashing activation on `Object.values`; an unwritable directory degrades to `globalState`; writes stay ordered.

Load-time `autoName` sweep: a fat prompt is capped on the first read (never empty, never gated on the write), a short name stays byte-identical, `customName` is never touched, the file is written only when something changed, a second load is a no-op, and an entry another client added between load and that write survives the rebase.

Injected `StateFs` mirrors node's real `writeFileSync(file, data, options)` signature deliberately: an earlier double read the exclusive-create flag off a fourth positional argument, which node **silently ignores**, so the atomic create was inert in production while the suite stayed green.

### `test/auto-name-write.test.ts` — autoName write sites

The two live `autoName` writers (`sessionTitle` and adapter history refresh) plus `updateSessionMeta` (the setter they share) all persist `capAutoName`'s result, so a later third path through the setter cannot store a raw prompt.

### `test/webview-helpers.test.ts` — pure webview helpers (153 tests)

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

### `test/acp.test.ts` — ACP client helpers

- **Request timer lifecycle** — a resolved `request()` clears its timeout (no leaked timer).
- **Plan gate same-chunk raise** — a successful `session/set_mode` reply and a mutating `terminal/create` in one stdout write must block the command. The gate is committed in the response hook so readline cannot dispatch the request before `planActive` is up.
- **Advertised `clientCapabilities` (#79)** — `acpClientCapabilities(provider, grokVersion, versionVerified)` withholds `readTextFile` only for a live-verified grok >= 1.0.4 (no upper cap). A live 1.0.3, a cache/unverified 1.x banner, grok 0.2.117, Codex, and an unknown version keep the delegated handshake. The fake-CLI integration lifecycle test asserts the 1.0.4 wire payload; a second case asserts 0.2.117 still advertises `readTextFile`.
- **Spawn argv** — `buildGrokAgentArgs()` returns `["agent", "stdio"]` with no effort, and `["agent", "--reasoning-effort", <value>, "stdio"]` (flag before the subcommand) for a valid effort.

### `test/acp-integration.test.ts` — ACP wire layer + plan-mode gate (17 tests)

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

### `test/webview-ui.dom.test.ts` — webview regressions in a real DOM (170 tests)

happy-dom test locking in the native-Windows regressions this build fixed (plus later busy/version/dedup behavior), so they can't silently come back:

- **History popover** — opens on the history button (and requests the session list), toggles closed on re-click, closes on an outside click but stays open on a click inside it
- **Session rows** — whole row resumes (clicking the meta area, not just the label, posts `resumeSession`); the delete and rename action buttons `stopPropagation` so they don't *also* resume
- **Mode picker** — offers Agent / Plan / Auto accept, posts `setMode` with the chosen id, closes on select, toggles closed on re-click; disabled only during the startup window (`busyLocked`) but **stays live during a running turn** so Auto accept can be picked mid-run (#64)
- **Sound notifications (#59)** — the gear → Config & debug switch reflects the setting and posts `setSoundNotifications` on toggle
- **Settings surface** — shared overlay renders every category, search filters across pages, a toggle posts the same `setShowThinking` message as the gear, and host-local rows stay hidden on remote
- **Reasoning trace** — a thought chunk renders a collapsed thinking block whose header click toggles the body open/closed (chevron ▶/▼)
- **Gear settings lock** — the model button shows the friendly name (not the raw id); model + effort controls are disabled while busy/priming and re-enable when busy clears
- **Remote provider parity** — no `providerState` keeps legacy history rows dot-only; the minimal frame enables glyph+badge overlays only with two connected providers, groups the empty-session picker Grok-first, permits an empty cross-provider pick, scopes a non-empty Codex picker to Codex, never renders account management on the phone, and replaces signed-out login actions with desk guidance
- **User-message dedup** — a `user_message_chunk` echoed live (grok ≥0.2.33) never doubles the optimistic bubble; only a `session/load` replay drives user bubbles
- **Welcome version lifecycle** — flips to "Connected · v<version>" only when session start finishes, not at the bare ACP handshake; later busy toggles don't overwrite it
- **Gear menu** — the Other group's About sub-view renders local Grok-only, Codex-only, combined, remote host-reported, and old-host fallback version states; Grok retains update actions while Codex separates binary/adapter versions and stays advise-only

### `test/projects-rail.dom.test.ts` — the browser's projects rail (56 tests)

The rail is the relay page's surface: `#projects-rail` lives in that page, never in the
extension's `getHtml()`, so the harness adds the mount the way the browser does — and the
absence of that element is exactly what keeps VS Code free of it. First assertion in the
file: with the element present but `IS_REMOTE` false, nothing renders and nothing is
posted.

- **Degrade before feature** — a host that never answers `listRepoSessions` still gets a
  usable rail (the selected repo reads the ordinary `sessions` frame), is probed **once**
  rather than once per project, and is never offered controls it would drop: cross-project
  *Clear all history* and *Archive project* are both withheld until the host proves itself
- **Ordering is by the newest conversation**, not the catalog's `updatedAt` — that is the
  session directory's mtime, which *clearing a project touches*, so the emptied project
  used to jump to the top. Ties break on the name for the same reason
- **Archiving is derived, never stored as a section** — one timestamped choice per project
  plus a 30-day rule, both read against that project's newest conversation. Covered: a
  choice overridden the moment the project is worked in again, an explicit un-archive
  surviving the age rule, the floor that keeps the three newest projects visible, the
  project you are reading never being filed away, and the age rule refusing to run at all
  on a host that cannot supply real activity
- **The project holding the live conversation stays open** — its twisty is disabled, and a
  project folded *before* the conversation moved there springs open — including when that
  conversation lives in a worktree, whose cwd is not a catalog row
- **Search** reaches into Archived and forces it open, rather than answering "No matches"
  while the project sits collapsed below
- **Global row identity** — duplicate source rows with one session id render once across
  Pinned/Recent/project groups, while two different ids both named `GPT` select and
  highlight independently. The real-Electron provider journey repeats this through
  Codex create/send/list/rename/re-list using adapter cwd casing drift.

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

- `addGeneratedMedia` renders an image as `<img>` and a video as `<video controls>` from the host's `media` message, wires the Copy-path / Open-in-VS-Code hover actions, replaced by Show-in-folder for both media kinds on a host that advertises it, and falls back to an open-link button for a remote URL
- The captured Codex image-generation tool sequence reaches that same DOM entry
  point on VS Code, desktop, and remote. The desktop suite also drives the real
  Electron window and asserts the app-resource image plus Copy/Show actions.
- the (deferred) subagent classifier renders a *Subagent: \<type\>* card when fed a delegation shape

### `test/question-card.dom.test.ts` — `x.ai/ask_user_question` card (12 tests)

- Renders each question's options (single-question single-select resolves on one click; multi → pick-then-Submit; Skip → cancel), replies `{outcome:"accepted", answers, annotations}` (or cancelled), collapses to the question + a green `✓ <choice>`, and rebuilds a read-only "You answered" card from the resume replay
- A free-text **Other** is added to every question the CLI didn't supply one for, is never duplicated when it did, and the typed text — not the label — is what reaches grok (#85)

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
