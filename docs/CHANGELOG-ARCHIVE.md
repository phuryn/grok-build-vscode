# Changelog archive

Releases before 2.0.0. Current releases are in [CHANGELOG.md](../CHANGELOG.md).

## 1.8.1 — 2026-07-24

### Changed

- **The reasoning-effort picker now matches the active model.** The gear's effort dots offer exactly the current model's advertised levels — grok-4.5 shows *low / medium / high* — instead of a fixed six-level ladder. A model that advertises no menu falls back to the full ladder, so nothing regresses.

## 1.8.0 — 2026-07-24

Two contributor features from [@funkpopo](https://github.com/funkpopo) ([#65](https://github.com/phuryn/grok-build-vscode/pull/65)), cherry-picked and verified end-to-end against real grok. Both need a recent Grok Build CLI (0.2.111+); older CLIs degrade gracefully.

### Added

- **Worktree sessions** — *Grok: New Worktree Session* (gear → *New worktree session*, or the Command Palette) runs a session in an **isolated git worktree** under `~/.grok/worktrees/`, so agent edits don't touch your main checkout until you **Apply worktree** (merge back); **Remove worktree** discards the isolated checkout. History rows show a `WT <label>` badge and reopen with the right cwd.
- **Rewind** — hover a message you sent → **Rewind** (or *Grok: Rewind Conversation*) to roll the conversation back: it truncates the chat and, on confirm, restores the files Grok changed since that point (a safety prompt shows first, because it can revert code on disk).
- **Deep Research / Workflow progress** — a live progress card with **Pause / Resume / Stop** for long autonomous runs, so they stay visible and interruptible.

## 1.7.5 — 2026-07-24

### Added

- **`@` file autocomplete in the composer** — type `@` to fuzzy-search workspace files and attach one as a chip (keyboard-navigable; the pick keeps both the `@path` text and a real chip). Thanks to [@funkpopo](https://github.com/funkpopo) ([#63](https://github.com/phuryn/grok-build-vscode/pull/63); closes [#60](https://github.com/phuryn/grok-build-vscode/issues/60)).
- **Sound notifications** — an optional short tone when Grok finishes a turn or hits an error, played *only when the Grok panel isn't focused* (a rising chime for done, a lower tone for errors). Off by default; toggle in gear → *Config & debug → Sound notifications* (`grok.soundNotifications`). ([#59](https://github.com/phuryn/grok-build-vscode/issues/59))

### Changed

- **Switch to Auto accept mid-turn** — the mode picker stays live during a running turn, so you can stop approving permission cards without stopping Grok; flipping to Auto accept also clears any card already on screen. Approving a plan now returns you to your pre-plan mode (Auto accept stays Auto accept). ([#64](https://github.com/phuryn/grok-build-vscode/issues/64))
- The waiting indicator (*Grokking* / *Thinking…*) now shimmers while idle. Thanks to [@funkpopo](https://github.com/funkpopo) ([#63](https://github.com/phuryn/grok-build-vscode/pull/63)).

### Fixed

- **Plan mode no longer blocks Grok from writing its own `plan.md`.** On Windows, Grok sometimes persists its plan via a PowerShell `Set-Content` command instead of the file-write tool; the plan-gate was refusing it ("Plan mode blocked a command…") and Grok had to retry. That write lands outside your workspace, so it's now allowed — while any command that also reaches into the workspace stays blocked. ([src/plan-gate.ts](src/plan-gate.ts))

## 1.7.4 — 2026-07-19

Eleven long-standing bugs found by running this extension through a multi-model bug-finding benchmark, then re-verified and fixed against the live tree — most of them Windows path handling. 42 new regression tests.

### Fixed

- **Windows path family:** drag-and-drop into the chat works on Windows (the dropped `file:///C:/…` URI was mis-stripped to `/C:/…` and silently failed); absolute Windows paths like `C:\work\file.ts` (with or without `:42`) now linkify in chat — and clicking any `path:line` ref now actually opens at that line; agent-sent `file://` media refs convert via a proper URI→path helper (drive letters + UNC hosts); session history now reads the same `~/.grok` the CLI writes (`GROK_HOME` override honored, USERPROFILE-first on Windows — a set `HOME`, e.g. git-bash, used to split them). ([media/chat.js](media/chat.js), [media/webview-helpers.js](media/webview-helpers.js), [src/file-ref.ts](src/file-ref.ts), [src/acp-dispatch.ts](src/acp-dispatch.ts), [src/sessions.ts](src/sessions.ts), [src/sidebar.ts](src/sidebar.ts))
- **Crash recovery:** after the CLI process dies, the next send respawns and resumes the same session instead of writing into the dead client (which errored, or hung at "Grokking…", until you manually started a new session); a `taskkill` that runs-but-fails (Access Denied) no longer leaves the agent's `wait_for_exit` pending forever — a direct signal fallback fires; an error or exit during the startup lock can no longer strand the composer's locked state. ([src/sidebar.ts](src/sidebar.ts), [src/terminal-manager.ts](src/terminal-manager.ts), [media/chat.js](media/chat.js))
- **Smaller correctness fixes:** full-line selections no longer attach one phantom line past the selection (VS Code selection ends are exclusive at column 0); Command Palette *New Session* clears the previous transcript like the toolbar button; the per-session webview reset clears the question/restored-card maps (a new session's tool updates could mutate the previous session's cards); generated media in a `..`-prefixed dir under grok home serves from disk instead of falling back to base64; the STT keyterm list enforces its documented 100-term cap. ([src/chips.ts](src/chips.ts), [src/sidebar.ts](src/sidebar.ts), [media/chat.js](media/chat.js), [src/sessions.ts](src/sessions.ts), [src/voice.ts](src/voice.ts))

## 1.7.3 — 2026-07-18

### Fixed

- **A missing Grok Build subscription/entitlement no longer traps you on the sign-in screen.** The backend's 403 *"requires a Grok subscription"* (which sign-in can't fix — the CLI even ignores your `XAI_API_KEY` while a cached OAuth session exists) now shows a clear in-chat "Not a sign-in issue" notice carrying the CLI's own advice, instead of the auth overlay. Only a genuine credential failure (ACP `-32000`, or unambiguous credential wording) opens the sign-in screen. ([#58](https://github.com/phuryn/grok-build-vscode/issues/58); [src/acp-dispatch.ts](src/acp-dispatch.ts), [src/sidebar.ts](src/sidebar.ts))
- **The "Grokking" indicator no longer sticks forever when auth recovery ends on the sign-in screen** — the failed turn now closes properly (error state, busy cleared), and a stale sign-in overlay can't resurrect when switching back to the session. ([media/chat.js](media/chat.js), [src/sidebar.ts](src/sidebar.ts))
- The sign-in screen now warns that a cached sign-in shadows `XAI_API_KEY` (`grok logout` to use the key). ([media/chat.js](media/chat.js))

## 1.7.2 — 2026-07-18

### Fixed

- **Hitting your usage/weekly limit no longer looks like a sign-in problem.** A rate-limited turn (ACP error `-32003`, or the CLI's limit phrasings) now shows a clear "Usage limit reached — not a sign-in issue" notice carrying the CLI's own message. Before, the limit's billing-flavored wording tripped the expired-token recovery, whose retry ended on the login screen. No reset date is shown because the CLI/backend never provides one. ([#57](https://github.com/phuryn/grok-build-vscode/issues/57); [src/acp-dispatch.ts](src/acp-dispatch.ts), [src/sidebar.ts](src/sidebar.ts))

## 1.7.1 — 2026-07-18

### Changed

- **README reworked as a landing page.** Features now sit directly under *Why use this?*, descriptions are trimmed to the point (deep technical detail stays in the dedicated docs), and the duplicate *Cost control* / *Context & cost* sections are merged into one. Fresh screenshots for **Context & cost**, **Fork conversation**, and **Queue or steer**, plus a new **Subagents** feature entry; the *Agent Dashboard* section folded into *Session history*, which now hosts the status-dot legend.
- **Smaller vsix** (~4 MB less): four unused screenshots removed and the `/imagine` hero image converted to WebP (2.9 MB → 240 KB).

## 1.7.0 — 2026-07-17

Three requested features, all built on ACP surfaces the Grok Build CLI already ships but never advertises — probe-confirmed against grok 0.2.101 first ([research/grok-build-oss-findings.md](../research/grok-build-oss-findings.md) § 3a) and pinned by new real-grok gates.

### Added

- **Steer — redirect Grok mid-turn without interrupting it.** A message sent while Grok works still queues by default; now the pending message carries a **Steer** button that sends it straight into the running turn, so Grok changes course mid-answer. It is not a Stop: the turn keeps its in-flight tool work and finishes normally. **Steer by default** (gear → *Config & debug*, off by default) makes send-while-busy skip the queue entirely; steered text is plain text only (no chips, editor context, or `/commands`), and a CLI that can't steer falls back to queueing rather than losing the message. ([#52](https://github.com/phuryn/grok-build-vscode/issues/52); [src/acp.ts](src/acp.ts), [src/sidebar.ts](src/sidebar.ts), [media/chat.js](media/chat.js))
- **Fork conversation** (gear → *Fork conversation*) — branch the conversation into a new session named `(Fork) <original>`, leaving the original byte-for-byte unchanged in your history. It branches the conversation, **not your code**: files on disk are untouched. ([#48](https://github.com/phuryn/grok-build-vscode/issues/48); [src/acp.ts](src/acp.ts), [src/sessions.ts](src/sessions.ts), [src/sidebar.ts](src/sidebar.ts))
- **Token usage in the context popover.** Click the donut for a **Session total** of what the conversation has billed (input / cache read / output), tracked across every turn, plus a collapsible **Last turn** with the same split and its **model calls** — the number that explains why a turn bills far more than the context it holds. Cache *read* is shown; no cache-*creation* figure exists anywhere in the CLI, so it is omitted rather than faked as zero. ([#53](https://github.com/phuryn/grok-build-vscode/issues/53); [src/acp-dispatch.ts](src/acp-dispatch.ts), [src/sidebar.ts](src/sidebar.ts), [media/chat.js](media/chat.js))

### Changed

- **Compact conversation moved from the gear menu to the context popover** — it is a context action, so it now sits next to the number that tells you when you need it (disabled at 0 tokens). The gear's Session section holds *Fork conversation*. ([media/chat.js](media/chat.js))
- **Usage telemetry adds three feature flags** (`showThinking` / `expandToolDetails` / `steerByDefault`) **and the host app** (VS Code / Cursor / …), so we can see whether our defaults are the ones people keep and which VS Code forks are worth supporting. Still anonymous, one event per session, no content — every field is listed in [docs/privacy.md](privacy.md). ([src/telemetry.ts](src/telemetry.ts))

### Fixed

- **The buttons on a pending message no longer miss while Grok is streaming.** Steer / Edit / Remove act on press instead of click: the pending block sits at the end of the chat, which re-scrolls on every streamed chunk, so the button moved out from under the cursor mid-click. ([media/chat.js](media/chat.js))

## 1.6.2 — 2026-07-16

### Fixed

- **A default model that isn't available no longer nags you.** When `grok.defaultModel` points at a model the session's agent can't use (e.g. a Composer model on a grok-build session, or a retired id), Grok already falls back to an available model — the extension now does so silently and heals the setting to that working model, instead of popping a warning telling you to change it. An empty default (the shipped value = CLI default) is left untouched. ([src/sidebar.ts](src/sidebar.ts))

### Changed

- **Usage telemetry now reports only from the official build.** The anonymous `session_start` event is gated on the official extension id, so a fork republished under a different publisher never reports into this project's analytics. (Unchanged otherwise: anonymous, one event per session, no content, double-gated on VS Code's global telemetry setting + `grok.telemetry.enabled`.) ([src/telemetry.ts](src/telemetry.ts), [src/sidebar.ts](src/sidebar.ts))

## 1.6.1 — 2026-07-16

Groundwork: Grok Build CLI went **open source** ([xai-org/grok-build](https://github.com/xai-org/grok-build)). We source-verified every item in our upstream feedback and probed the shipped **grok 0.2.101** binary to confirm which newly-visible ACP surfaces actually ship (`research/oss-surfaces-probe.cjs`, `research/grok-build-oss-findings.md`).

### Added

- **Voice input now works without a separate API key.** If you're signed in with `grok login`, the extension reuses that stored token (`~/.grok/auth.json`) for Speech-to-Text — no need to obtain and paste a dedicated console.x.ai key. A dedicated key (`grok.voiceApiKey` / `GROK_VOICE_API_KEY` / `XAI_API_KEY`) still takes precedence; only xAI-issued, non-expired tokens are used, and streaming auth failures now give re-login/key guidance instead of a raw error. The transmission (audio + credential to xAI's STT endpoint) is disclosed in [docs/privacy.md](privacy.md), and setup/costs moved to [docs/voice-setup.md](voice-setup.md). ([#51](https://github.com/PawelHuryn/grok-vscode/issues/51); [src/voice.ts](src/voice.ts), [src/voice-streamer.ts](src/voice-streamer.ts), [src/sidebar.ts](src/sidebar.ts))
- **Subagent rows now show real duration and output.** A subagent's completion (`duration_ms`, `tokens_used`, the child's output) rides a live notification the CLI already sends (`_x.ai/session_notification` → `subagent_finished`); we now consume it, so a delegation card fills in its timing and result even for the Composer agent, whose tool-channel completion carries no duration. A failed or cancelled subagent now shows its status and error (flagged red on the row) instead of a silent, empty "success," and the card carries a distinct bot icon. ([src/acp-dispatch.ts](src/acp-dispatch.ts), [src/sidebar.ts](src/sidebar.ts), [media/chat.js](media/chat.js), [media/chat.css](media/chat.css))
- **Automatic (context-full) compaction now shows a one-line notice in chat** — "Auto-compacting context (N% full)…" (and "Compaction failed." on failure) — where it used to happen silently. A manual `/compact` keeps its "Compacted." confirmation. ([src/acp-dispatch.ts](src/acp-dispatch.ts), [src/sidebar.ts](src/sidebar.ts), [media/chat.js](media/chat.js))

### Changed

- **The context donut refreshes instantly after `/compact` — and now after automatic (context-full) compaction too.** The fresh post-compact token count rides a live notification the CLI already sends (`_x.ai/session_notification` → `auto_compact_completed.tokens_after`), confirmed on grok 0.2.101; the donut reads that directly. Older CLIs that predate the notification (e.g. the Windows recovery build) fall back to the previous hidden `/session-info` probe, so nothing regresses. Automatic compaction, which never refreshed the donut before, now does. ([src/acp-dispatch.ts](src/acp-dispatch.ts), [src/sidebar.ts](src/sidebar.ts), [src/session.ts](src/session.ts))
- **Changing reasoning effort no longer restarts the session.** On a CLI that supports per-session effort (grok 0.2.101+ advertises it), the effort change applies live to the running session via `session/set_model` — no more Summarize-or-Restart prompt and no lost context. Older CLIs, and switching effort back to the model default, still restart as before. ([src/acp.ts](src/acp.ts), [src/sidebar.ts](src/sidebar.ts))
- **On Windows, the agent is now told which shell dialect to write for.** The extension runs the agent's commands under PowerShell (or cmd, per your setting), but the agent used to guess the dialect from its own host detection and could emit POSIX-shell idioms that fail. It now sets `GROK_SHELL` in the agent's environment to match the shell we actually run, so the generated commands match the host. ([src/terminal-manager.ts](src/terminal-manager.ts), [src/sidebar.ts](src/sidebar.ts))

### Fixed

- **An expired login token no longer forces a sign-out.** A long-lived sidebar session could wedge on an expired OAuth token (the pool shares `~/.grok/auth.json` with the CLI, and a token refresh can lose a rotation race), surfacing as a misleading "you need to pay" error even with an unused SuperGrok limit — while the standalone CLI kept working. The extension now recognizes an auth/entitlement error, transparently restarts that session's process (a fresh one re-reads the current token from disk — what a re-login does, minus the sign-out) and re-sends your message automatically. If the fresh process still can't authenticate, it falls back to the re-login prompt. ([src/acp-dispatch.ts](src/acp-dispatch.ts), [src/sidebar.ts](src/sidebar.ts), [src/session.ts](src/session.ts))
- **A failed shell command now shows an error on its row and group, not just inside its output.** A non-zero exit code was only surfaced as `[Error] exit N` in the expandable OUT block; the tool row and its collapsed group looked successful. A failed command now flags the row and group the same way a failed tool does. ([media/chat.js](media/chat.js))
- **Command labels handle the `(cd dir; cmd)` subshell.** grok wraps commands in a POSIX subshell even on Windows; a row that read "Run (cd" now names the command that actually runs (e.g. "Run node") by stripping the `( )` and skipping the `cd` prelude, and no longer drags a script's path into the label. ([media/webview-helpers.js](media/webview-helpers.js))
- **A restored BACKGROUND subagent now shows its result + duration on reload**, instead of a stuck card plus a redundant `[subagent:general-purpose] …` poller row. On `session/load` grok flattens the delegation's poller output to a text blob (not the live structured shape); the extension now parses that back, folds it into the card, and drops the poller row. A failed subagent flagged via the tool channel (the common ordering) now renders red too, and a cancelled one reads muted rather than as a failure. ([media/webview-helpers.js](media/webview-helpers.js), [media/chat.js](media/chat.js), [media/chat.css](media/chat.css))

## 1.5.15 — 2026-07-15

### Added

- **Inline edit diffs now show real file line numbers.** The gutter reads each region's actual position from the wire instead of restarting at 1 for every edit — a one-line change at line 147 now reads `147`, not `1`. The line-number column widens automatically past 999. ([media/chat.js](media/chat.js), [media/chat.css](media/chat.css))
- **A replace-all now shows every replaced site.** Renaming a token across 148 lines renders 148 hunks at their real line numbers and reports **+148 −148**, instead of one meaningless `+1 −1` — the per-site detail was always on the wire, we just weren't reading it. ([media/chat.js](media/chat.js))

### Changed

- **An edit's `+N −M` appears as each edit lands**, not when the whole tool batch finishes — the counts are on the wire 2–3s before the turn ends. ([media/chat.js](media/chat.js))

### Fixed

- **A whole-file rewrite of an existing file no longer renders as pure additions.** Grok reports each edit's diff twice, and the optimistic first report claims the file was empty; the authoritative correction was being discarded, so an overwrite showed `+7 −0` instead of the real `+4 −3`. ([media/chat.js](media/chat.js))
- **Expanding a running tool group no longer snaps shut when the batch finishes.** A manual expand (or collapse) now survives; Expand/Collapse All still overrides it. ([media/chat.js](media/chat.js))

## 1.5.14 — 2026-07-14

### Fixed

- **Inline-diff line numbers no longer wrap mid-digit.** In an edit's inline diff, line numbers ≥100 could break onto a second row (`147` → `14` / `7`); the gutter is now wide enough and the number never wraps. Thanks to [@jiezaichan](https://github.com/jiezaichan) (#47). ([media/chat.css](media/chat.css))

## 1.5.13 — 2026-07-13

### Fixed

- **On Windows, the agent's shell commands now run under PowerShell instead of cmd (#46)** — `pwsh.exe` when installed, else Windows PowerShell 5.1 (`powershell.exe`), else cmd.exe. The extension runs every command Grok requests (Grok delegates them over ACP), so the shell was ours to pick; matching the standalone Grok CLI means PowerShell profile functions and pipelines (`… | Format-List`) just work, instead of failing under cmd and forcing the agent into costly retry/re-wrap loops. Linux/macOS are unchanged (`/bin/sh`). ([src/terminal-manager.ts](src/terminal-manager.ts))
  - **Install PowerShell 7 (`pwsh`) for the best experience** — the Windows PowerShell 5.1 fallback rejects `&&` command chains and reports every failing command's exit code as `1`; pwsh 7 does neither.
  - New **`grok.terminalShell`** setting (`auto` | `cmd`) — an escape hatch back to `cmd.exe` on Windows if the PowerShell host ever causes trouble. ([package.json](package.json), [src/sidebar.ts](src/sidebar.ts))
- **Command output now shows in the tool row for the Composer agent too.** Composer runs shell commands in its own CLI-side shell (it doesn't delegate over ACP like Grok Build), so its command rows showed the command (IN) but no output (OUT). The captured output is now read from the completed tool-call update and attached by tool-call id — reliable even though Composer runs commands in parallel and finishes them out of order. ([media/chat.js](media/chat.js), [media/webview-helpers.js](media/webview-helpers.js))
- **A command row's one-line label no longer drags in a quoted argument.** `Write-Output '=== banner ==='` now reads "Run Write-Output", not a truncated "Run Write-Output === 1. git statu…" — a quoted arg is data, not a subcommand. ([media/webview-helpers.js](media/webview-helpers.js))

## 1.5.12 — 2026-07-13

### Added

- **Edit diffs are reviewable inline in chat, even under Auto accept (#45).** Every edit row shows an always-visible `+N −M` change count (rolled up onto collapsed "Edited N files" group headers, path-deduped) plus an expandable **inline diff** — a Codex-style line-number gutter, colored left-border stripe, subtle tint, and a `+/−` glyph for color-blind readability. It rides the same expand controls as command IN/OUT, works live and on session restore, and — because the diff data is always on the ACP wire regardless of permission mode — needs no permission card. The native `open diff →` link stays for the full side-by-side. ([media/chat.js](media/chat.js), [media/webview-helpers.js](media/webview-helpers.js), [media/chat.css](media/chat.css))

### Changed

- **The gear toggle "Expand command outputs" is now "Expand tool details"** — it governs command IN/OUT blocks **and** edit diffs, matching the *Expand All Tool Details* commands (the `grok.expandCommandOutputs` setting key is unchanged). ` ```diff ` blocks in Grok's messages now share the same Codex diff palette + left-border styling. ([media/chat.js](media/chat.js), [media/chat.css](media/chat.css), [package.json](package.json))

### Fixed

- **A shell command that exits 0 with no output** now shows a muted `✓ done · no output` marker instead of an empty `(no output)` line. ([media/chat.js](media/chat.js))

## 1.5.11 — 2026-07-13

### Added

- **Caret lands in the composer after you add context (#43).** Send Selection, Send File, @-mention, the **+** file picker, and image paste all reveal the panel *taking* focus, so you can type your prompt immediately — no click into the input first. ([src/sidebar.ts](src/sidebar.ts), [src/protocol.ts](src/protocol.ts), [media/chat.js](media/chat.js))

### Changed

- **"Grok: Send Selection" is now "Add Selection to Grok",** and a command-sent selection attaches in the **top** attachments row (removable, with its line range) like any other file — only the ambient active-editor chip stays in the bottom toolbar. ([package.json](package.json), [media/chat.js](media/chat.js))
- **"Grok: Send File" no longer silently no-ops** from the Command Palette when no file is open — it opens a file picker instead of doing nothing and dropping focus. ([src/sidebar.ts](src/sidebar.ts), [src/extension.ts](src/extension.ts))
- The internal debug command (`grok._debugDummyPlan`) is hidden from the Command Palette. ([package.json](package.json))

## 1.5.10 — 2026-07-12

### Added

- **Expand / collapse all tool details.** Two Command Palette commands — *Grok: Expand All Tool Details (This Session)* / *…Collapse All…* — open or close every tool group and command IN/OUT box, **including a batch that's still running**, and keep applying to tool calls that stream in afterward. It's a per-session latch (last action wins vs the gear setting; flipping the setting clears it) that survives Agent Dashboard focus-swaps and resets on a cold reopen — never persisted to disk. Bind them to a key if you like. ([src/extension.ts](src/extension.ts), [media/chat.js](media/chat.js), [src/sidebar.ts](src/sidebar.ts))

### Changed

- **`grok.expandCommandOutputs` now also opens command-bearing tool *groups*,** not just each command's IN/OUT detail — an Auto-accept "Ran N commands" batch is audit-visible with zero extra clicks; explore/edit-only groups stay collapsed. ([media/chat.js](media/chat.js))
- **Command rows read as "Run \<program\>"** — the executable plus a non-flag subcommand (`Run git status`, `Run npm test`, `Run node`, `Run Get-Date`), not a truncated slab of shell. The full command still lives in the row's IN/OUT detail. ([media/webview-helpers.js](media/webview-helpers.js))
- Refreshed the README — new mode-picker and image-paste screenshots, and a leaner **Install** section (the extension's onboarding installs the CLI and signs you in) with build-from-source / per-IDE scripts moved to [docs/INSTALL.md](INSTALL.md). ([README.md](README.md))

### Fixed

- **Failed non-shell tools now show their real error inline** instead of a generic "Tool call failed." — the reason is mined from variant-keyed `rawOutput` blobs (e.g. `list_dir` → `NotFound`, `read_file` → `FileReadError`) when there's no `message`/`content` to read. ([media/webview-helpers.js](media/webview-helpers.js))

## 1.5.9 — 2026-07-12

### Changed

- Documentation-only patch: the README hero screenshot now shows the current UI running **Grok 4.5** ([docs/screenshots/grok_4.5.png](https://github.com/phuryn/grok-build-vscode/blob/v4.13.1/docs/screenshots/grok_4.5.png), replacing the v1.4.20 shot). No code changes.

## 1.5.8 — 2026-07-12

### Fixed

- **RTL text (Arabic, Hebrew, Farsi) now renders correctly** (user report). Every paragraph and block takes its direction from its own first strong character — right-aligned with punctuation on the correct side — across chat bubbles, thinking traces, plan cards, subagent results, tables, lists (markers and indent flip too), and the queued block; the composer follows as you type. Code blocks and inline code stay pinned LTR (the same rule the Codex extension uses), and the chat chrome doesn't move — only text direction changes, per block. ([media/chat.js](media/chat.js), [media/chat.css](media/chat.css), [src/sidebar.ts](src/sidebar.ts))

## 1.5.7 — 2026-07-12

### Added

- **Command details (#41).** Every shell-command row expands (trailing `›` ↔ `v`) into a Claude-Code-style **IN/OUT block**: the full command text immediately — a lone running command is expandable mid-run — and the complete captured output when it finishes (the extension executes the commands itself, so the output is byte-for-byte what grok received). Exit 0 stays silent; failures render an `[Error] exit N` marker with error-tinted output; kills render a muted `[Cancelled]`. `grok.expandCommandOutputs` (also gear → Config & debug) pre-opens every detail — the audit view for Auto-accept sessions. Live-session only: the CLI doesn't replay terminals on restore. ([src/acp.ts](src/acp.ts), [src/sidebar.ts](src/sidebar.ts), [media/chat.js](media/chat.js))

### Changed

- **Tool rows read as one scannable line** — labels trim at 40 chars (full text one click away), long content ellipsizes at the row edge instead of wrapping, and the corner-radius scale is unified (bubbles 12 → code/IN-OUT blocks 8 → inline chips 6). ([media/chat.js](media/chat.js), [media/chat.css](media/chat.css))
- Refreshed the Marketplace description and README (new screenshots: cost control, effort picker, file chips). ([README.md](README.md), [package.json](package.json))
- Every outbound `session/cancel` is logged with its trigger (Stop click / plan verdict) in the Grok output channel, so any future spurious-cancel report (#37) is attributable at a glance. ([src/acp.ts](src/acp.ts))

### Fixed

- Private working docs no longer ship inside the public `.vsix` (they were bundled because `.vscodeignore` — not `.gitignore` — decides the package contents). ([.vscodeignore](.vscodeignore))

## 1.5.6 — 2026-07-11

### Added

- **Subagent rows, fully live.** A delegation renders as a purple *Subagent · \<task\>* row with running dots, then a duration stamp and a click-to-expand result under "Output of the subagent:" — the CLI envelope (plumbing tags, boilerplate lead-ins, one wrapping `<response>` pair, the Agent ID hint) is stripped when present, never failing. Covers grok-build's `spawn_subagent` — including `background: true` spawns, whose started-ack no longer masquerades as the result (the card completes from the output poller's `TaskOutput`, matched by task id) — and the Composer agent's `Task`. The `subagent_spawned`/`subagent_finished` lifecycle events are routed for the day the CLI transmits them (0.2.93 logs them but doesn't send them over ACP — live-verified). Real captured sessions are replayed end-to-end in the test suite. ([media/chat.js](media/chat.js), [media/webview-helpers.js](media/webview-helpers.js), [src/acp.ts](src/acp.ts), [test/fixtures/composer-subagent-session.jsonl](test/fixtures/composer-subagent-session.jsonl))

- **[ACP-feedback.md](internal/ACP-feedback.md)** — an upstream-facing summary of grok-CLI/ACP friction: the grok-build vs Composer wire differences, everything the extension works around or hides (with suggested fixes), what works well, and a Grok 4.5 verification checklist. Built from the wire captures and probes in `research/`.

### Changed

- **One copy/timestamp footer per turn, shown when the turn ends.** The copy action and time sit only under the turn's final agent message (the conclusion) and appear once the turn completes — no more copy icons flickering mid-conversation while grok works; the timestamp reads as the turn's end time. Code blocks keep their own copy buttons. ([media/chat.js](media/chat.js))
- **The composer grows with your text.** 2 lines at rest (Cursor-style), expanding to 5 as you type, then scrolling; scales with `grok.chatFontScale`. ([media/chat.js](media/chat.js), [src/sidebar.ts](src/sidebar.ts))

### Fixed

- **No more fake Subagent cards while working on subagent code.** grok titles Grep/Read calls with their query/filename (a search for `spawn_subagent` is titled exactly that), so title matching false-carded ordinary tools; the classifier now treats the wire's `_meta["x.ai/tool"].name` as authoritative both ways and matches exact tool names otherwise. ([media/webview-helpers.js](media/webview-helpers.js))
- **Subagent child sessions no longer clutter history.** Every delegation persists its child as a top-level session (`session_kind: "subagent"`); the history list hides them, and pagination advances by consumed index slots (`nextOffset`) so hidden rows can't stall or duplicate load-more. ([src/sessions.ts](src/sessions.ts), [src/sidebar.ts](src/sidebar.ts))
- **Restored plan/permission cards no longer drift to the end of the conversation.** The host counted replayed `<system-reminder>` turns and marker-only verdicts toward plan positions while the webview (correctly) renders no bubble for them — so every verdict given after a session restore persisted an unreachable position and its card landed at the bottom on the next restore. The host now counts exactly what the webview bubbles (`countsAsUserBubble`). Positions persisted by older builds stay as recorded. ([src/plan-restore.ts](src/plan-restore.ts), [src/sidebar.ts](src/sidebar.ts))

## 1.5.5 — 2026-07-11

### Changed

- **Codex-inspired chat restyle.** User bubbles use a theme-independent foreground tint (fixes bubbles that vanished on Cursor dark themes), inline and fenced code share one chip surface + editor-contrast text, one 28px ghost icon-button style across header/composer/message/code actions, file refs and "open diff →" render as real links (hover-only underline), plan/permission card text matches the chat font, and the composer types in the UI font instead of the editor's monospace. ([media/chat.css](media/chat.css), [media/chat.js](media/chat.js))
- The permanent plan-cancel notice no longer says "Grok is processing the cancellation…" — the transient dots indicator carries that state. ([src/sidebar.ts](src/sidebar.ts))
- **Resolved plan cards drop the inline plan text.** Once a plan is approved/rejected/cancelled (live or restored), the card shows just the plan-file link + verdict — the file opens as an editor tab; the Show/Hide toggle remains only when no plan file exists. ([media/chat.js](media/chat.js))
- **Toolbar icons equalized.** The mode button, context donut, and mode-picker icons now use the same 16px glyph and 28px highlight height as the settings/history buttons. ([media/chat.css](media/chat.css))

### Added

- **Context popover on the donut.** Click the context donut for the exact token count (`used / window`, %). (#39) ([media/chat.js](media/chat.js))

### Fixed

- **Resolved plan cards stay resolved on re-focus.** Re-opening a live session no longer resurrects an already-answered plan review with active Approve/Reject/Cancel buttons; resolved cards replay collapsed behind Show/Hide plan with their verdict (`planResolved`, the plan twin of `permissionResolved`). ([src/sidebar.ts](src/sidebar.ts), [media/chat.js](media/chat.js), [src/protocol.ts](src/protocol.ts))
- **`/session-info` no longer zeroes the context donut.** A turn's `totalTokens: 0` report is never a real measurement (`/compact` shrinks context, it doesn't empty it) and is now always ignored; `/context` (a CLI-TUI no-op over ACP) is hidden from autocomplete — use `/session-info`. (#39) ([src/acp-dispatch.ts](src/acp-dispatch.ts), [src/slash-filter.ts](src/slash-filter.ts))
- **The context donut is real on restore and right after `/compact`.** A restored session seeds the donut from grok's persisted `signals.json` instead of showing 0 until the first turn; and `/compact` is followed by a hidden, CLI-local `/session-info` turn (~25ms, no model call, not persisted to history) whose reply carries the exact post-compact count — parsed and pushed to the donut moments after "Compacted." (the compact turn's own meta reports 0 and the CLI recomputes `signals.json` only at the next turn's end, so this was otherwise unknowable — probe-verified). ([src/sessions.ts](src/sessions.ts), [src/acp-dispatch.ts](src/acp-dispatch.ts), [src/sidebar.ts](src/sidebar.ts), [research/signals-refresh-probe.cjs](../research/signals-refresh-probe.cjs))
- **Approving a plan no longer leaks grok's post-verdict filler** ("I'll wait for your verdict…") into the chat: the planning turn the CLI unblocks on our response is cancelled and content-suppressed on Approve exactly as Reject/Cancel already did — that text never survived a session restore, so it doesn't paint live either. ([src/sidebar.ts](src/sidebar.ts))
- **The welcome logo/byline actually hides once the chat has content** (a CSS `display` rule was overriding the `hidden` attribute), and a primer-only restore keeps the welcome screen instead of showing an empty chat. ([media/chat.css](media/chat.css), [media/chat.js](media/chat.js))
- **No more forever-spinning dots after cancelling a plan.** Turn end now always clears the waiting indicator (grok's `[Plan cancelled]` ack can be contentless, which orphaned it), and a plain Cancel is silent by design: the "Plan abandoned" notice is the whole UX — the verdict still reaches grok on a hidden turn, but its ack reply no longer paints. ([media/chat.js](media/chat.js), [src/sidebar.ts](src/sidebar.ts))
- **White flash on webview load fixed** (VS Code only): an inline critical style paints the theme background immediately and holds the welcome invisible until the stylesheet loads. ([src/sidebar.ts](src/sidebar.ts), [media/chat.css](media/chat.css))

## 1.5.4 — 2026-07-11

### Changed

- **One pending message instead of a queue.** Composing more text while a message is already queued now **appends** to the single pending block (blank-line separated — exactly how it sends), rather than stacking separate queue entries. Edit pulls the whole pending text back into the composer, Remove drops it, Stop still hands it back — no more edited messages landing at the end of a queue that was going to collapse into one message anyway. (#37 follow-up) ([media/chat.js](media/chat.js), [src/sidebar.ts](src/sidebar.ts))

## 1.5.3 — 2026-07-11

### Fixed

- **Typing while Grok works no longer cancels its tools.** Enter (and the send button) doubled as a hidden Stop while a turn was running, so a mid-turn "continue" silently resolved in-flight tools as *"cancelled by the user"* — amplified by busy-state leaking across dashboard session switches. Typed text now **never cancels**: messages compose into a per-session queue shown as pending blocks at the end of the chat (italic, clock tag, per-message Edit/Remove), survive session switches, and auto-send as one combined message when that session's turn ends — even while backgrounded. Stop (square button, empty composer only) hands queued text back to the composer instead of firing it. Thanks @githubuser1256! (#37) ([media/chat.js](media/chat.js), [src/sidebar.ts](src/sidebar.ts), [src/session.ts](src/session.ts), [src/protocol.ts](src/protocol.ts))
- **Enter during CJK IME composition no longer sends mid-composition.** The composer now respects `isComposing`/`keyCode 229`, so Enter confirms the IME candidate (Claude-Code-style: first Enter picks the character, second sends). Thanks @yyu0310! (#38) ([media/chat.js](media/chat.js))

### Added

- **Live-suite coverage for the Stop contract and concurrent sessions.** `cancel-mid-turn` pins that an id-less `session/cancel` settles the turn as cancelled and leaves the session usable; `parallel-sessions` pins that two CLI processes on one workspace answer overlapping prompts independently. ([scripts/live-tests.cjs](scripts/live-tests.cjs))

## 1.5.2 — 2026-07-10

### Added

- **One-click "Move view" in the gear menu.** Gear → **Config & debug → Move view** relocates the chat to the Secondary Side Bar, Primary Side Bar, or Panel instantly — direct moves into per-location view containers, no picker — each with a matching panel icon. Especially handy in Cursor, whose side-bar context menu hides the built-in "Move To" entry. ([src/view-move.ts](src/view-move.ts), [media/chat.js](media/chat.js))
- **Install scripts detect Cursor and can target every IDE at once.** `cursor` joins the auto-detect chain, and `--all` (Windows: `-All`) builds once and installs into every detected IDE. ([scripts/](scripts/))

### Changed

- **The view now opens in the Secondary Side Bar by default** (`viewsContainers.secondarySidebar`), next to your other AI tools. This raises the minimum VS Code to **1.106** — older hosts (e.g. Antigravity, currently on base 1.104) keep the last compatible version. A placement you set yourself still wins; use the gear mover or *Reset Location* to adopt the new default.

## 1.5.1 — 2026-07-09

### Fixed

- **The mode button tells the truth when `always-approve` is set in `config.toml`.** grok's global `permission_mode = "always-approve"` (set via Shift+Tab or `/always-approve` in the TUI) auto-approves every session server-side and is invisible over ACP, so the extension used to show a misleading "Agent mode" with no permission cards. It now detects the setting (project `.grok/config.toml` overriding global `~/.grok/config.toml`) and shows **Auto accept**, plus a one-time notice that it's a global config setting. (#31) ([src/grok-config.ts](src/grok-config.ts), [src/sidebar.ts](src/sidebar.ts))

### Changed

- **Hidden the `/always-approve` slash command.** It only mutates grok's global `config.toml` — a sticky, surprising side effect — and is a no-op over ACP, so it no longer appears in autocomplete or dispatches. (#31) ([src/slash-filter.ts](src/slash-filter.ts), [src/acp.ts](src/acp.ts))
- **Typed the host↔webview message contract.** The host→webview direction was `any`; it's now a discriminated union in `src/protocol.ts` (single source of truth), with the webview keeping a synced mirror and a test asserting both sides agree — so "post one shape, handle another" drift (restore/pagination/media) is a build error. Caught two latent mismatches on the way in. ([src/protocol.ts](src/protocol.ts), [media/webview-helpers.js](media/webview-helpers.js))
- **Strengthened the test & release gates.** The `release.*` scripts now run `test:live` by default (`-SkipLive`/`--skip-live` to opt out); the real-grok plan-mode test now models the true approve/reject flows with a disk-snapshot containment canary (the old single-turn test invented an impossible state); the live suite gained a capability-drift probe and a fast `--smoke` lane; and a required `@vscode/test-electron` activation smoke now runs in CI (`npm run test:integration`, validated against a real Extension Host).
- **Documentation consistency pass:** corrected the minimum VS Code version in the README, documented the `Grok: Compact Conversation` command, added the telemetry/mode-prefs/grok-config modules to the architecture map, and trimmed change-history narrative out of `CLAUDE.md` (it points at the changelog and `research/*` instead).

## 1.5.0 — 2026-07-09

### Added

- **Paste or attach images — Grok now sees the pixels.** Ctrl+V a screenshot, drag-drop, or attach a png/jpg/gif/webp and it rides the prompt as an inline vision block (validated at send, 20 MiB cap, session-scoped `[Image #N]` tags that restore as chips; SVG stays a path chip so Grok can edit the source). Thanks @cpulxb! (#32) ([src/chips.ts](src/chips.ts), [src/prompt-builder.ts](src/prompt-builder.ts), [src/sidebar.ts](src/sidebar.ts), [media/chat.js](media/chat.js))
- **The active-editor context chip tracks your live selection** (`file.ts:8-15`), and selection snippets restore as ranged chips when a session is reopened. Thanks @cpulxb! (#32) ([src/sidebar.ts](src/sidebar.ts), [media/webview-helpers.js](media/webview-helpers.js))

### Fixed

- **`/compact` actually compacts again — and says so.** A leading context envelope silently degraded it into an ordinary LLM turn that *grew* context ~6x; confirmed slash commands now lead the text block, the context donut accepts the post-compact reset, the hidden plan-mode primer is re-sent afterwards (thanks @cpulxb! #32), and the turn now ends with a visible **"Compacted."** confirmation. ([src/prompt-builder.ts](src/prompt-builder.ts), [src/slash-filter.ts](src/slash-filter.ts), [src/sidebar.ts](src/sidebar.ts))
- **Plan mode no longer blocks safe chained commands.** `cd repo && git status` was rejected outright, which crashed grok-4.5's planning phase; chains (`&&`, `||`, `;`) now pass when **every** segment is read-only — one mutating segment still blocks the whole command. (#36) ([src/plan-gate.ts](src/plan-gate.ts))

### Changed

- **Composer polish:** one focusable card, VS Code-style webview scrollbars, and the caret lands in the input on panel open, window refocus, new session, and session switches (thanks @cpulxb! #32); pasted images that can't be read block the send instead of silently dropping, and inline images carry a do-not-read-from-disk hint so Grok stops noisily `Read`-attempting its own copy. ([media/chat.js](media/chat.js), [media/chat.css](media/chat.css))

## 1.4.31 — 2026-07-09

### Added

- **The install/uninstall scripts can target any code-compatible IDE.** Pass a CLI name or path — `./scripts/install.sh antigravity-ide` (Windows: `pwsh scripts\install.ps1 -Cli antigravity`) — or set `CODE_CLI=…`; with no argument they auto-detect `code` → `code-insiders` → Antigravity and hint at other IDEs they found. Thanks @mingminghome for the Antigravity groundwork. (#35) ([scripts/](scripts/))

### Fixed

- **Session startup no longer crashes on an invalid or unavailable `grok.defaultModel`.** A failed `setModel` on session create/load is caught and logged, falling back to the CLI's current model instead of exiting; if the configured model isn't in the CLI's list, a warning toast suggests updating the setting. Thanks @mingminghome. (#33, #34) ([src/acp.ts](src/acp.ts), [src/sidebar.ts](src/sidebar.ts))

## 1.4.30 — 2026-07-09

### Fixed

- **The sign-in (and sign-out) terminal commands actually run now.** The onboarding button typed `"C:\…\grok.exe" /login` into the terminal — the wrong command (`login` is the CLI subcommand; `/login` only works inside the interactive TUI) *and* a PowerShell parser error (a quoted path followed by arguments needs the `&` call operator). Sign-in and sign-out now launch the grok binary directly as the terminal's own process, which behaves the same on PowerShell, cmd, and POSIX shells. README examples updated to `grok login` too. ([media/chat.js](media/chat.js), [src/sidebar.ts](src/sidebar.ts), [README.md](README.md))

### Changed

- The API-key option in the sign-in onboarding no longer claims extra models — it now just says "pay per token". ([media/chat.js](media/chat.js))

## 1.4.29 — 2026-07-05

### Fixed

- **A permission request that's only an edit is now reviewable, and its diff survives a VS Code restart.** A standalone edit collapsed to a bare one-line row with no way to open the diff — while a read+edit batch stayed expandable — and on restore the diff was lost entirely. A lone edit now keeps the same collapsible tool group (chevron, "N → M lines", "open diff →") as a multi-tool batch, in both the live and resumed orderings. ([media/chat.js](media/chat.js)) (#30)

## 1.4.28 — 2026-07-01

### Fixed

- **The mode switch (Agent / Plan / Auto-accept) is now disabled while the session is starting.** Picking a mode before the session existed called `setMode` too early and surfaced *"Couldn't switch mode: no session."* The mode button is greyed out and unclickable until the session is ready — like the send button — and the toggle-mode command is guarded server-side too. ([media/chat.js](media/chat.js), [media/chat.css](media/chat.css), [src/sidebar.ts](src/sidebar.ts))

## 1.4.27 — 2026-07-01

### Added

- **Context files now tell Grok how they got there.** A file you explicitly attach is listed as **"Attached file(s)"** (strong intent); the file that's auto-included because it's open in your editor is listed separately as **"Currently open in the editor (for context)"** (weaker, ambient) — so Grok doesn't treat a file you're just looking at as one you asked it to act on. ([src/prompt-builder.ts](src/prompt-builder.ts))
- **Uploaded attachments now have their own row above the input**, each with a remove (×) button. The active-editor file stays in the bottom toolbar as before. ([media/chat.js](media/chat.js), [media/chat.css](media/chat.css), [src/sidebar.ts](src/sidebar.ts))

### Fixed

- **grok-build now shows its real name and 512K context window.** grok resolves a `set_model("grok-build")` to a *versioned* id (`grok-build-0.1`) that isn't in the model list, so the toolbar showed the raw id and the context donut fell back to the 200K default (percentage read ~2.5× too high). The id is now normalized back to the list entry, and the window recomputes on every model change. ([src/acp.ts](src/acp.ts), [src/acp-dispatch.ts](src/acp-dispatch.ts), [media/chat.js](media/chat.js))
- **The voice/mic button no longer jumps when attachments appear.** It's now anchored to the input box instead of the composer, so the new attachments row above the input doesn't shove it out of place. ([media/chat.css](media/chat.css), [src/sidebar.ts](src/sidebar.ts))
- **Attachment chips show just the filename** — in the composer, the sent-message bubble, *and* restored sessions — for files outside the workspace (Windows absolute paths were previously shown in full); the full path stays on the hover tooltip, and Grok still receives the full path. The file-path context is sent in a machine-readable `<vscode-context>` envelope so the webview can parse it back deterministically on restore instead of showing the raw replayed paths. ([media/chat.js](media/chat.js), [media/webview-helpers.js](media/webview-helpers.js), [src/prompt-builder.ts](src/prompt-builder.ts))
- **Code blocks no longer render with a doubled blank line around them.** A fenced code block was wrapped in `<br><br>` on top of its own margin (the model sends just one blank line), so it looked double-spaced; code blocks are now emitted as their own block, like tables and math. ([media/chat.js](media/chat.js))

## 1.4.26 — 2026-06-30

### Fixed

- **Updating the Grok Build CLI no longer fails with "cannot rename locked executable."** The update tore the session pool down but didn't *wait* for the grok processes to actually exit, so `grok update` raced the still-held Windows lock on `grok.exe` (`Access is denied. (os error 5)`). Teardown now resolves only once each process has truly exited, kills the whole process **tree** on Windows (`taskkill /T /F`, so grok's backgrounded subagent/command children don't keep the binary locked), and the update retries once if a lingering lock slips through. ([src/acp.ts](src/acp.ts), [src/sidebar.ts](src/sidebar.ts), [src/cli-locator.ts](src/cli-locator.ts))

### Changed

- **Directory listings show the full relative path with a trailing slash** — `List docs/` and `List docs/screenshots/` instead of the basename-only `List screenshots`. ([media/chat.js](media/chat.js))

## 1.4.25 — 2026-06-30

### Fixed

- **Empty primer-only sessions are cleaned up even when large.** A hidden-primer turn can balloon to dozens of agentic tool/reasoning messages with no real user message; the startup sweep skipped those (`num_messages` over the gate) so they lingered in history with a primer-derived title. The chat-history content check is now authoritative regardless of message count — a session with our primer and zero real user queries is swept (real and renamed sessions are still never touched). ([src/sessions.ts](src/sessions.ts), [src/sidebar.ts](src/sidebar.ts))
- **The send button now shows the spinner from the moment the panel opens.** During the initial session spin-up it briefly showed neither the send arrow nor the spinner; it now defaults to the disabled spinner until the session is live. ([media/chat.js](media/chat.js))
- **Tool rows now show the detail again for List / Search / Fetch.** A directory listing shows the folder (`List docs`), a read shows the file and line range (`Read README.md lines 1-30`), a search shows the pattern, and a web fetch shows the page URL — these had regressed to a bare verb because the rawInput field names (`target_directory`, `url`) weren't being read. Verified against real on-disk sessions. ([media/chat.js](media/chat.js))

### Changed

- **The diff-preview edit row is now a single line** — `Edit chat.js  9 → 10 lines  open diff →` instead of three stacked lines. ([media/chat.js](media/chat.js), [media/chat.css](media/chat.css))
- **Table cells no longer break mid-word.** Long header/cell words were chopped between letters, making columns look cramped and arbitrarily narrow; cells now wrap only at spaces and hyphens (an unbreakable run falls back to the table's horizontal scroll). ([media/chat.css](media/chat.css))
- **The Grokking indicator spins the other way.** ([media/chat.css](media/chat.css))
- **The scroll-to-bottom button sits slightly higher**, so its gap above the composer's top border matches the border-to-textarea gap. ([media/chat.css](media/chat.css))
- **Trimmed the README privacy section** to a short privacy-by-design summary; the full detail moved to [docs/privacy.md](privacy.md). ([README.md](README.md), [docs/privacy.md](privacy.md))

## 1.4.24 — 2026-06-29

> Privacy-first, opt-out anonymous usage telemetry.

### Added

- **Anonymous usage telemetry (Aptabase).** One `session_start` event per session — fired on the **first real user message** (never the primer or empty/abandoned sessions) — carrying only an anonymous install id (a random GUID, no account or grok-login identity) plus the chosen **mode / model / effort**. **No message content, code, or file paths are ever sent;** country is derived by Aptabase from the request IP and the IP is then discarded. **On by default but fully gated** — it sends only when VS Code's global `telemetry.telemetryLevel` is enabled *and* the new `grok.telemetry.enabled` setting is on; either off stops everything. The event is built synchronously (capturing the right session's mode/model/effort) but **fired asynchronously off the send path** and any error is **swallowed silently**, so telemetry can never slow, surface to, or break a turn — a failure (offline, a wrong/typo'd key → a harmless 404, a malformed event) just means nothing lands. Thin, dependency-free client (no SDK). ([src/telemetry.ts](src/telemetry.ts), [src/sidebar.ts](src/sidebar.ts), [package.json](package.json))

### Tests — 609

- New: the telemetry helpers — `aptabaseHost` (region from app key), `osNameFromPlatform`, the `shouldSendTelemetry` two-gate check, distinct prod/dev keys, `buildSessionStartEvent` (install id + mode/model/effort as props, no content), and that `postEvent` **never throws** (a circular/malformed event or a no-region key is a silent no-op) ([test/telemetry.test.ts](test/telemetry.test.ts)). The unit suite stays network-free; a separate `npm run telemetry:probe` ([scripts/telemetry-probe.cjs](scripts/telemetry-probe.cjs), with an `APTABASE_KEY` override to fire a wrong key) sends real events to a **dev** Aptabase project (the published extension always reports to prod).

## 1.4.23 — 2026-06-29

> Hidden-by-default thinking traces with an always-on progress indicator, a scroll-to-bottom button, a remembered mode preference, and the YOLO → Auto accept rename.

### Added

- **Thinking traces are hidden by default (#26).** Grok's reasoning no longer fills the chat — a muted **Thinking…** stand-in (brain icon) shows while it reasons. Turn traces back on from gear → **Config & debug → Show thinking traces** (a live switch backed by `grok.showThinking`); it reveals them on already-loaded sessions too. When shown, a thinking row now matches the tool rows — same font size, a leading **brain icon**, and the shared chevron + hover (it was a smaller 11px and icon-less). ([media/chat.js](media/chat.js), [media/chat.css](media/chat.css), [src/sidebar.ts](src/sidebar.ts), [package.json](package.json))
- **The chat always shows live progress during a turn.** While a turn is in flight, one of **Grokking / a running tool / Thinking…** is guaranteed on screen — no dead frames, even with traces hidden. ([media/chat.js](media/chat.js))
- **Scroll to bottom (#28).** A floating button appears above the composer once you scroll up off the bottom; click it for an animated jump back down. It's anchored to the chat input area, so it stays correctly placed at any `chatFontScale` zoom. ([src/sidebar.ts](src/sidebar.ts), [media/chat.js](media/chat.js), [media/chat.css](media/chat.css))
- **New sessions remember your last mode (#25).** The last switch between **Agent** and **Auto accept** is reapplied on new sessions (Plan is deliberately never remembered), mirroring how model & effort already persist. It's applied up-front, so the toolbar shows the right mode from the first paint — no Agent → Auto accept flash while the session primes. Backed by `grok.defaultMode`. ([src/sidebar.ts](src/sidebar.ts), [package.json](package.json))

### Changed

- **The progress indicators now share one look.** *Grokking*, the *Thinking…* stand-in, and a running tool all use the editor font size, a 15px leading icon, and the same muted color + spacing — a running tool no longer brightens to look hovered. Motion is per-indicator: *Grokking* spins a lucide **orbit** icon (it's a generic wait), while *Thinking* and tools use the **three blinking dots** (discrete progress) — both replacing the old morphing "…" pills. ([media/chat.js](media/chat.js), [media/chat.css](media/chat.css))
- **Renamed the "YOLO" mode to "Auto accept."** The mode picker and the bottom-toolbar button now read **Auto accept**; "YOLO" survives only in the picker's one-line description. The internal mode id (`yolo`) and `autoApprove` flag are unchanged. ([media/chat.js](media/chat.js))
- **A user message's copy + timestamp now appear on hover** (the bubble or the row beneath it), matching grok messages — they used to always show. ([media/chat.css](media/chat.css))
- **Trimmed the README feature descriptions** that already carry a screenshot, cutting the redundant "what it looks like" prose. ([README.md](README.md))

### Tests — 599

- New: the Auto accept label, the thinking-traces toggle (hidden-by-default body class, live flip, the **Thinking…** stand-in vs. a visible trace, the Config & debug switch), the Grokking orbit indicator, the scroll-to-bottom visibility threshold + click, and a **step-by-step turn simulation** asserting a live progress indicator after every mid-turn event with traces hidden *and* shown ([test/webview-ui.dom.test.ts](test/webview-ui.dom.test.ts), [test/webview-harness.ts](test/webview-harness.ts)); the remembered-mode policy `modeToRemember`/`startsInYolo` — Plan never persisted, applied to new sessions only (#25) ([test/mode-prefs.test.ts](test/mode-prefs.test.ts)).

## 1.4.22 — 2026-06-29

> Single-home the sidebar so it can be moved in Cursor, and stop forcing whole-file reads on attachments.

### Fixed

- **The view can be relocated again (Cursor).** We declared the `grokSidebar` container in **two** places at once (`activitybar` + `secondarySideBar`); `secondarySideBar` only exists in VS Code ≥ 1.106, so on older bases (incl. current Cursor) the stray declaration is parsed-but-unsupported — it pinned the view to the left and could even shift *other* extensions' views. The container is now single-homed to `activitybar`; relocate it with right-click the **Grok** title → **Move To → Secondary Side Bar** (it persists). ([package.json](package.json))
- **Attached files are handed to grok as paths, not `@`-reads.** A file chip used to become `@relPath`, grok's "read this whole file" convention — which slurped large files (a big CSV/log) into context and *failed outright on binaries*: an attached image or video triggered `read_file` → *"Cannot read binary file"* (grok has no vision). Chips now render as a plain **"Attached file(s):"** path list, so grok decides how to consume each — grep/range-read big text, pass image/video paths to its media tools, read small files in full. Selected-range chips still inline the exact lines you picked. ([src/prompt-builder.ts](src/prompt-builder.ts))
- **Corrected the subscription requirement.** The sign-in screen claimed *SuperGrok **Heavy*** was required for Grok Build — wrong on two counts: it's **any SuperGrok *or* X Premium+** subscription, and naming the $300/mo Heavy tier scared off eligible users. Fixed in the onboarding, README, and Marketplace description (and clarified that Grok's free tier doesn't include the CLI agent). ([media/chat.js](media/chat.js), [README.md](README.md), [package.json](package.json))

### Changed

- **Renamed the "Voice input" feature to "Voice control"** across the UI and docs. ([README.md](README.md), [src/sidebar.ts](src/sidebar.ts), [media/chat.js](media/chat.js))
- **Welcome byline reads "(The Product Compass)"** again (dropped the "Newsletter" suffix). ([src/sidebar.ts](src/sidebar.ts))

## 1.4.21 — 2026-06-29

> Documentation-only patch: the README screenshots now match the current (v1.4.20) UI.

### Changed

- **README screenshots refreshed.** New hero image, plus shots for **session history**, the redesigned **tool-call rows**, and the **permission diff-preview** card; the tool-calls description now matches the categorized/icon design. The old v1.2.0 sidebar screenshot is removed. ([README.md](README.md), [docs/screenshots/](screenshots/))

## 1.4.20 — 2026-06-28

> A chat-readability overhaul plus housekeeping: tool and thinking rows get Codex-style category icons and a muted-until-hover look, failed tools finally show *why*, each narration sits above the tools it describes, and the empty "primer" sessions stop cluttering history (#24). Also renamed **Unofficial → Community**.

### Changed

- **Tool-call summaries are categorized by what the tool actually did.** Reads, globs, and greps were all rolled up as "Ran N commands"; they're now bucketed by ACP kind into "Explored N items" / "Edited N files" / "Deleted N files" / "searched web" / "Ran N commands" — so a turn that read five files reads "Explored 5 items", not "Ran 5 commands". Works on resumed sessions too: when the wire form omits `kind`, the category is recovered from the tool's title. ([media/chat.js](media/chat.js))
- **A turn's narration now interleaves with its tool groups instead of piling above them.** grok narrates each step then runs its tools (narrate → tools → narrate → tools); the narration used to coalesce into one bubble with the tool summaries stacked consecutively below it, so the summaries looked arbitrary. Each narration sentence now renders directly above the tool group it introduced, preserving grok's actual order. ([media/chat.js](media/chat.js))
- **Tool and thinking rows restyled (Codex-aligned).** Each tool row (single or group) now leads with one **lucide category icon** — `file` (read) / `folder-search` (search) / `pencil` (edit) / `square-terminal` (command, and the catch-all), picked by the strongest action in a group. Rows are flush-left in the standard font, **muted by default and brighten on hover** (no background highlight); a running group stays "active" until it completes. Expanded bodies use a thin secondary border (not blue). Thinking blocks now share the tool rows' chevron — same glyph, on the **right**, after the label — and the same expand border. ([media/chat.js](media/chat.js), [media/chat.css](media/chat.css))
- **Generated images/videos align with the message text** — dropped the extra horizontal inset they carried. ([media/chat.css](media/chat.css))
- **Renamed "Unofficial" → "Community".** The chat header, extension title, and README now read **Grok Build (Community)** / **Grok Build for VS Code (Community)**; the About fine print still notes it's unofficial, community-built, and not affiliated with xAI. ([package.json](package.json), [README.md](README.md), [src/sidebar.ts](src/sidebar.ts), [media/chat.js](media/chat.js))

### Fixed

- **Tool-call labels no longer leak raw regex/glob patterns.** A search tool used to render its bare pattern (e.g. `image_edit|/imagine`) as the whole label; it now shows `Search <pattern>`, and any tool we didn't predict falls back to grok's own formatted title instead of scraping arbitrary raw input. ([media/chat.js](media/chat.js))
- **Failed tool calls now show their reason instead of being silently dropped.** A `status: "failed"` tool update (e.g. *"Tool `image_to_video` failed: image reference not readable: …"* — grok occasionally malforms an image argument) used to render as nothing, so grok just looked like it gave up. The row now goes error-colored with the failure message beneath it (and a collapsed group with a failed child tints its icon red). ([media/webview-helpers.js](media/webview-helpers.js), [media/chat.js](media/chat.js), [media/chat.css](media/chat.css))
- **Empty "primer" sessions stop piling up in history (#24).** Each time the extension opened it left behind an empty, primer-only session (the ones titled "… Primer v4 Plan Mode …"). Now abandoning an empty session — New Session, or switching to another — deletes it on the spot, so at most one untitled **New session** ever exists; and a one-shot startup sweep clears the empties earlier runs left behind, each confirmed primer-only by **reading its chat history** so a real or non-extension session is never touched. Detection is content-based and agent-agnostic — it counts both `<user_query>`-wrapped prompts and the **unwrapped** ones grok/composer sends for slash commands like `/imagine` (so a real composer session is never mistaken for empty) — verified against real on-disk sessions from both the `grok-build` and `cursor` (composer) agents. The live untitled session always shows as **New session**, never grok's primer-derived title. ([src/sidebar.ts](src/sidebar.ts), [src/sessions.ts](src/sessions.ts), [src/grok-primer.ts](src/grok-primer.ts))

### Tests — 582

- New: tool-call categorization rebuilt from real Grok + Composer transcripts, the raw-pattern-leak fix, the unpredicted-tool fallback, narration↔tool-group interleaving, plan/permission cards landing below the interleaved lead-up, the per-row **category icons** (strongest-action pick), and **failed-tool surfacing**, driving the real `media/chat.js` ([test/tool-summary.dom.test.ts](test/tool-summary.dom.test.ts)); the thinking↔tool **chevron unification** ([test/webview-ui.dom.test.ts](test/webview-ui.dom.test.ts)); empty-primer-session detection incl. unwrapped composer prompts — `extractUserQueries` / `classifyUserQueries` / `isEmptyPrimerSession` ([test/sessions.test.ts](test/sessions.test.ts)) and `isPrimerSummary` ([test/grok-primer.test.ts](test/grok-primer.test.ts)).

## 1.4.19 — 2026-06-28

> Card-UX polish from a live image-generation session: permission cards read in order and minimize once answered, restored plans start collapsed, and background-task notices stop polluting the chat.

### Fixed

- **Grok's reply after a permission prompt now renders *below* the card, not above it.** A permission request arrives mid-turn, so streaming kept appending to the agent bubble already on screen *above* the new card — only a fresh user turn pushed the conversation past it. The card now finalizes the in-flight turn first (the `commitAgentTurn()` the plan card already used), so everything after the answer lands beneath it, in order. ([media/chat.js](media/chat.js))
- **Answered permission cards no longer reappear *active* when you re-focus a backgrounded session.** Re-focusing replays the session's post buffer, but the answer (a webview-only collapse) was never in it, so an already-decided card came back fully expanded with live buttons. The host now records a `permissionResolved` marker in the buffer on answer, so the replayed card comes back collapsed. ([src/sidebar.ts](src/sidebar.ts), [media/chat.js](media/chat.js))

### Added

- **Answered permission cards now persist across a full reload.** The CLI doesn't replay `session/request_permission` on `session/load`, so resumed sessions used to lose every approval you'd made. The extension now persists each answered card (title + allowed/rejected + the gated tool-call id) and replays it as a **collapsed** card **anchored to the exact tool it gated** — by tool-call id, or by the tool's title when no id was captured (the card title *is* the tool's title) — so it lands where you answered it, mid-turn, not at the turn boundary (with a user-message-position fallback if the tool never replays). ([src/sidebar.ts](src/sidebar.ts), [src/session.ts](src/session.ts), [src/sessions.ts](src/sessions.ts), [src/acp-dispatch.ts](src/acp-dispatch.ts), [media/chat.js](media/chat.js))

### Changed

- **Answered permission cards collapse to one muted line.** Picking an option used to leave the full card with greyed-out buttons and a "you chose: …" note in the transcript. It now minimizes to a single non-interactive line — a colored `Allowed` / `Rejected` verb plus what it applied to — matching the resolved question/plan cards, with the "Grokking…" indicator underneath until grok resumes. ([media/chat.js](media/chat.js), [media/chat.css](media/chat.css))
- **Restored plan cards start collapsed.** Resuming a long session no longer dumps full plan text — each restored plan shows its title, verdict, and a `Show plan` / `Hide plan` toggle (the body stays in the DOM, just hidden). ([media/chat.js](media/chat.js), [media/chat.css](media/chat.css))
- **Background-task completion is a one-shot toast, not a chat bubble.** When grok backgrounds a long command (e.g. a nested `grok -p …` image/video job), the CLI emits a structured `task_completed` update *and* feeds the result back as a `user_message_chunk` wrapped in `<system-reminder>…`. The extension now routes `task_backgrounded` / `task_completed` to their own events, pops a single `showInformationMessage` (with **Show Logs**) on completion — skipped during session replay — and drops the replayed `<system-reminder>` turn so it never surfaces as a fake user bubble on restore. ([src/acp-dispatch.ts](src/acp-dispatch.ts), [src/acp.ts](src/acp.ts), [src/sidebar.ts](src/sidebar.ts), [media/chat.js](media/chat.js))

### Tests — 545

- New: `task_backgrounded` / `task_completed` routing, `summarizeBackgroundCommand`, and `permissionOutcomeFor` ([test/acp-dispatch.test.ts](test/acp-dispatch.test.ts)); permission-card ordering + collapse + re-focus survival + restored-collapsed-card interleaving, restored-plan collapse toggle, and `<system-reminder>` suppression on restore, driving the real `media/chat.js` ([test/card-collapse-tasks.dom.test.ts](test/card-collapse-tasks.dom.test.ts)).

## 1.4.18 — 2026-06-28

> Grok CLI fixed the #22 Windows session-start regression (0.2.71, now on stable as 0.2.72) — adopt it and re-enable updates.

### Fixed

- **Sessions start on the latest Grok CLI again, and Windows updates are no longer paused (#22).** xAI fixed the `agent stdio` regression that hung session start on Windows across 0.2.61–0.2.70 (initialize on 0.2.61–0.2.64, then `session/new` on 0.2.67–0.2.70). The fix landed in **0.2.71** and is now on the **stable** channel as **0.2.72**. Verified end-to-end on native Windows — the `session/new` stdin-open probe passes and the full live ACP gate is green (handshake, prompt round-trip, session restore, plan-mode, subagent). The extension now treats **0.2.72 as the supported build**: it pins the bounded broken range **0.2.61–0.2.70** up to 0.2.72 before starting, and the gear → **Update Grok Build CLI** action (and the silent on-upgrade update) work normally again on Windows. The reactive downgrade-on-failure remains a backstop for any *future* still-broken build above 0.2.72. ([src/cli-locator.ts](src/cli-locator.ts), [src/sidebar.ts](src/sidebar.ts))

## 1.4.17 — 2026-06-27

> Pin Windows to the last working Grok CLI for *any* newer build — 0.2.61–0.2.69 all break session start (#22).

### Changed

- **The #22 Windows guard now pins *any* Grok CLI build above 0.2.60 back to 0.2.60 before starting**, instead of tracking a fixed broken range. 0.2.61–0.2.64 hang at `initialize`; 0.2.67 (stable) and 0.2.69 (alpha) answer `initialize` but hang at `session/new` — the bug has persisted on every build above 0.2.60, with no fix on either channel. Rather than widen a range per build (and eat a ~120s reactive hang on each new one), the extension treats everything newer than the supported 0.2.60 as broken on Windows. When xAI ships a build that passes the `session/new` check, raising the supported version one line adopts it; the reactive downgrade-on-failure stays as a backstop. ([src/cli-locator.ts](src/cli-locator.ts))

## 1.4.16 — 2026-06-26

> Clearer listing and docs; lighter changelog.

### Changed

- **README rewritten** to lead with what the extension does for you — diff-preview approvals, `@file` context, inline image/video, voice — instead of internals, with a trimmed feature list.
- **Listing clarified** as an **unofficial community extension** (display name + description).
- **Changelog slimmed:** releases before 1.4.0 moved to [docs/CHANGELOG-ARCHIVE.md](CHANGELOG-ARCHIVE.md); entries stay terse going forward.

## 1.4.15 — 2026-06-26

> Cover the #22 Windows session-start bug on newer Grok CLI builds (through 0.2.67) and when the hang moves to session start.

### Fixes

- **The Windows session-start workaround now covers Grok CLI 0.2.65–0.2.67 and a `session/new`-stage hang (#22).** Grok CLI 0.2.67 *looked* fixed — the ACP `initialize` handshake answers again — but the stdin-until-EOF regression only **moved**: the next request, `session/new`, now hangs instead (with stdin held open, as any live client must), so a real session still can't start. v1.4.14 only knew the 0.2.61–0.2.64 range and only recognized an `initialize`-stage hang, so anyone landing on 0.2.65–0.2.67 was left stuck. Now: the proactive pin covers the full confirmed-broken range **0.2.61–0.2.67** and pins the CLI back to the last fully-working **0.2.60** before starting; and the evidence-driven reactive recovery also fires on a **`session/new` / `session/load`** timeout, not just `initialize` — so a future still-broken build self-heals on the observed failure regardless of which startup request hangs. Verified with a controlled stdin-open probe (`initialize` then `session/new`) against real 0.2.67. ([src/cli-locator.ts](src/cli-locator.ts), [src/sidebar.ts](src/sidebar.ts))

### Docs

- Recorded that **0.2.67 does not fix #22** — the hang moved from `initialize` to `session/new` — with the reproduction probe in [research/stdio-eof-regression.md](../research/stdio-eof-regression.md). Rewrote CLAUDE.md's status into a concise current-state project map (per-version history lives here in the changelog, not there).

## 1.4.14 — 2026-06-25

> Smoother diff review on permission cards.

### Features

- **Diff previews don't nag you to save, auto-open, and clean up after themselves (#21).** Closing a diff preview **no longer prompts you to save**: every diff the extension opens — whether from the *open diff preview →* link on an edit card or auto-opened on a permission card — is now backed by read-only virtual documents instead of scratch buffers, so there's nothing to save (and you also get proper syntax highlighting now). On a permission card the diff also **opens automatically** (the *open diff →* button stays, to re-open it) and **closes itself** when you click **Allow / Reject**. The preview reuses a single tab across Grok's many small sequential edits and keeps focus on the chat, so reviewing a stream of edits is just: glance, decide, repeat. ([src/sidebar.ts](src/sidebar.ts), [media/chat.js](media/chat.js))

## 1.4.13 — 2026-06-25

> Self-healing recovery if a *future* Grok CLI build ships the same Windows bug. _(Not released on its own — rolled into the 1.4.14 release.)_

### Fixes

- **Auto-recovers from a still-broken future CLI build, not just the known ones (#22).** v1.4.12 pins the CLI back to 0.2.60 when it detects one of the *known* broken builds (0.2.61–0.2.64) before starting. But if xAI ships a **new** build (0.2.65+) that still has the bug, that closed range wouldn't catch it and the session would hang with no automatic fix. The extension now also recovers **reactively**: if a session fails to start on Windows with the regression's signature (the `initialize` handshake timing out / *"exited (code null)"*) and the CLI is on any build newer than the supported 0.2.60, it automatically downgrades to 0.2.60 and **retries the start once** — triggered by the actual failure rather than a hardcoded version list, so it self-heals on builds that don't exist yet. If you later update the CLI by hand onto another broken build, the same recovery runs again on the next failure. Every automatic downgrade (proactive or reactive) shows a notification explaining what happened. If the downgrade can't run, you still get the manual-workaround message as before. ([src/cli-locator.ts](src/cli-locator.ts), [src/sidebar.ts](src/sidebar.ts))

### Internal

- Verified on macOS (Apple Silicon) that the regression is **Windows-only** — grok 0.2.64, the build that hangs on Windows, completes the stdin-open ACP `initialize` handshake in ~450ms (4/4 runs) — so the whole workaround stays correctly gated to Windows. Recorded in [research/stdio-eof-regression.md](../research/stdio-eof-regression.md) with a reproduction probe. ([research/stdio-eof-mac-probe.cjs](../research/stdio-eof-mac-probe.cjs))

## 1.4.12 — 2026-06-25

> Works around a Grok CLI 0.2.61+ bug that stopped sessions from starting.

### Fixes

- **Sessions start again on Grok CLI 0.2.61–0.2.64 (#22).** A regression in the Grok CLI broke `grok agent stdio`: the agent no longer reads its first line of input until the input stream is closed, which never happens for a live connection — so the extension's startup handshake hung forever and you saw *"Grok exited (code null)"* / *"ACP request timed out: initialize"*. The last working build is **0.2.60**. Since the extension can't make the CLI read its input, it now **detects a broken CLI version on startup and automatically pins it back to 0.2.60** before connecting, with a one-time notice — no manual downgrade needed. Once the CLI is healthy again nothing is changed. If the automatic downgrade can't run, the start-failure message now tells you exactly how to fix it by hand (`grok update --version 0.2.60`). The version range is bounded to the known-broken builds so a future fixed release won't be needlessly downgraded. (The regression has so far only been reported on Windows, so the automatic pin and the update guard below currently apply there.) ([src/cli-locator.ts](src/cli-locator.ts), [src/sidebar.ts](src/sidebar.ts))
- **"Update Grok Build CLI" won't move you onto a broken build.** Because Grok CLI 0.2.61+ is unusable by the extension (above), the gear → **About** update action is now **disabled with a note** when you're on the latest supported version (0.2.60) or newer — so a one-click update can't reinstall a broken build. It stays enabled only when you're on something *older* than 0.2.60, and in that case it updates **to 0.2.60** (never to an unsupported `latest`). The silent on-upgrade CLI update follows the same rule. ([src/cli-locator.ts](src/cli-locator.ts), [src/sidebar.ts](src/sidebar.ts), [media/chat.js](media/chat.js))

### Docs

- Documented the root cause, the controlled reproduction, and a copy-paste bug report for xAI in [research/stdio-eof-regression.md](../research/stdio-eof-regression.md).

## 1.4.11 — 2026-06-20

> Nested code blocks render correctly.

### Fixes

- **Nested code blocks no longer eat the outer fence (#20).** Asking the chat for a code block fenced by 4 or 5 backticks (so it can contain an inner ```` ``` ```` block) used to strip the first three backticks of the outer fence and close the block early at the inner fence — splitting one block into several and mangling the output. The Markdown renderer now matches a fence of three-or-more backticks and requires the closing fence to be the same length, so a longer outer fence correctly wraps shorter inner ones (per the CommonMark spec). This makes clean, copy-pasteable nested examples (e.g. for an `AGENTS.md`) render the same as on grok.com and in the Grok CLI. ([media/chat.js](media/chat.js))

## 1.4.10 — 2026-06-18

> Session history that stays fast with thousands of sessions.

### Features

- **Session history loads in pages and stays fast at scale.** The history dropdown used to read and parse *every* saved session on each open, which got slow once a project had hundreds or thousands of them. It now loads the **most recent 100** (newest first by last activity) and pulls in older ones as you **scroll to the bottom**. The **search box** filters by name across your **entire** history — not just the loaded page — so you can still find an old session instantly. Behind the scenes it orders sessions with one cheap directory `stat` each (no file reads), reads only the page you're looking at, and caches by file modification time so re-opening the dropdown costs effectively no disk reads. ([src/sessions.ts](src/sessions.ts), [src/sidebar.ts](src/sidebar.ts), [media/chat.js](media/chat.js), [media/chat.css](media/chat.css))
- **Switching model or reasoning effort on a fresh session no longer clutters history.** Some model and effort changes need the session to restart. If you flip them a few times right after opening a session — before you've actually said anything — each restart used to leave behind an empty, identical session in your history. Now an empty session (one where only the hidden setup has run) restarts cleanly with no "Summarize & Restart vs. Just Restart" prompt, and the throwaway session is removed instead of piling up. If you had renamed that session, the name carries over to the restarted one. ([src/sidebar.ts](src/sidebar.ts), [src/sessions.ts](src/sessions.ts))

### Fixes

- **History dropdown no longer opens clipped off the right edge.** Opening the session-history popover quickly (before its rows had finished loading) could position it too far right, so it spilled past the panel edge and only looked right after closing and reopening. The popover is now right-aligned to the panel (respecting the edge padding) and grows leftward, so it stays fully on-screen no matter how its contents resize as sessions load in. In a narrow panel it also caps its width to fit, so a long session name truncates with an ellipsis instead of pushing the popover off the left edge. Resizing the panel while the dropdown is open now re-fits it live (no need to close and reopen), and switching to another panel tab or extension closes it so it can't reappear mis-sized when you come back. ([media/chat.js](media/chat.js))

### Internal

- **Opt-in performance simulation for the history popover.** A new `npm run test:perf` suite (kept out of `npm test` and CI) builds a 5000-session in-memory store and asserts the access-count improvement: first open drops file reads from 5000 to 100 (~98%), a repeat open does zero reads (modification-time cache), and search warms the catalog once then stays read-free — with a modeled-latency projection and a real in-memory parse-cost wall-clock. ([test/sessions.perf.ts](test/sessions.perf.ts), [vitest.perf.config.ts](vitest.perf.config.ts), [package.json](package.json))

### Docs

- Documented the pagination design in [docs/architecture.md](architecture.md) (§ History at scale) and [CLAUDE.md](../CLAUDE.md) (§ History pagination), and updated the *Session history* feature note in the [README](README.md).

## 1.4.9 — 2026-06-16

> Make the chat bigger — just the chat.

### Features

- **Adjustable chat font size (#14).** A new `grok.chatFontScale` setting zooms the Grok chat panel only — text, icons, and spacing together — as a percent (e.g. `150`, `200`, or smaller like `70`). Unlike VS Code's global `Ctrl/Cmd+Shift+=`, it leaves the rest of the editor at its normal size, so you can enlarge (or shrink) just the chat for readability. It applies live with no reload, the composer stays pinned to the bottom of the panel at any scale, and it works at both User (global) and Workspace (local) scope. ([package.json](package.json), [src/sidebar.ts](src/sidebar.ts), [media/chat.css](media/chat.css), [media/chat.js](media/chat.js))

### Docs

- **README polish.** Added screenshots for *Voice input* and the *Agent Dashboard*, and moved a few wire-level implementation details out of the feature blurbs into [docs/architecture.md](architecture.md) so the feature list reads less like internals. ([README.md](README.md), [docs/architecture.md](architecture.md))

## 1.4.8 — 2026-06-15

> Run several Grok sessions at once — switch between them instantly, and see at a glance which one needs you.

### Features

- **Multi-session Agent Dashboard.** The sidebar now keeps several sessions *alive* at once instead of one at a time. Switching between them from the history dropdown is **instant and lossless** — the conversation you switch away from keeps running in the background (mid-turn, mid-approval, anything), and switching back replays its exact state with no reload. Picking a session that isn't live anymore loads it from history as before. ([src/sidebar.ts](src/sidebar.ts), [src/session.ts](src/session.ts))
- **Status dots in the history dropdown.** Every session shows a dot so you can see what each one is doing without opening it. It's **gray** at rest, and only lights up when there's something to know: **blue** = working, **yellow** = needs you (a permission, question, or plan to review), **green** = finished with output you haven't opened yet, **red** = finished with an error you haven't opened. The green/red marker is an *unread* badge — it clears the moment you open the session, and it's **persisted**, so it survives the idle cleanup below and even a VS Code restart. Walk away, come back, and the green sessions are exactly the ones with results waiting. ([media/chat.js](media/chat.js), [media/chat.css](media/chat.css), [src/session-pool.ts](src/session-pool.ts))
- **Idle sessions are cleaned up automatically.** To keep a pile of background sessions from each holding a live process, a session left untouched for an hour — or beyond a cap of ~8 live — is quietly shut down (never one that's working or waiting on you). It reappears in history and reloads on click, so nothing is lost. ([src/session-pool.ts](src/session-pool.ts))
- **Updating the Grok Build CLI warns about sessions in progress.** With multiple sessions now able to run at once, the *Update Grok Build CLI* action confirms before it restarts when any session is mid-turn or waiting on you — so an update doesn't silently interrupt work in a background session. ([src/sidebar.ts](src/sidebar.ts))
- **No more long pause before Grok starts.** Sending your first message used to sit silent for 15–40 seconds before anything appeared. Behind the scenes the extension primes each session with a hidden plan-mode instruction, and that primer was running *in front of* your first message and — because Grok Build is an agentic CLI — was wandering off to read files and search the workspace before your real prompt even ran. The primer now fires **the moment a session goes live**, silently in the background, so it's almost always finished before you hit send; if you're quick, your message shows immediately and is released the instant the primer settles. The primer text itself was also trimmed to just the protocol it needs to teach (the product blurb and repo link that were tempting Grok to go exploring are gone), so it completes in a beat instead of dozens of seconds. ([src/sidebar.ts](src/sidebar.ts), [src/grok-primer.ts](src/grok-primer.ts), [src/session.ts](src/session.ts))
- **A "Grokking…" indicator while you wait.** Every turn now shows an animated *Grokking…* placeholder the instant you send, so there's immediate feedback that Grok received your message — it's replaced in place the moment the first thought, reply, or tool action arrives. ([media/chat.js](media/chat.js), [media/chat.css](media/chat.css))

## 1.4.7 — 2026-06-15

> Sharper math, and one-click export for equations and diagrams.

### Features

- **Math now renders with [MathJax](https://www.mathjax.org) (replacing KaTeX).** MathJax produces self-contained SVG that's closer to "real LaTeX," renders `\label`/`\ref`-style environments without painting red errors, and — crucially — gives every equation an exportable vector. Inline `\(…\)` sits on the text baseline in your editor's text color; display `\[…\]` gets its own centered, horizontally-scrollable block. The swap also fixed a double-rendering bug where Chromium drew MathJax's hidden accessibility MathML as a *second*, visible copy of each equation (`enableAssistiveMml: false`). ([media/chat.js](media/chat.js), [src/sidebar.ts](src/sidebar.ts), [media/mathjax/](media/mathjax/))
- **Copy / Download / Open actions on display math + Mermaid diagrams.** Hover any display equation or rendered diagram for a top-right overlay (mirrors the generated-image actions): **Copy** the LaTeX/Mermaid source, **Download** as an image, or **Open** it in VS Code's image preview. Download offers a quick-pick — **PNG** (rasterized with your VS Code theme background, i.e. what you see), or a **transparent SVG** tuned **for a dark** or **for a light** background. Math recolors its ink for each; Mermaid is re-rendered in its matching light/dark theme so a "for light background" diagram actually uses the light palette. ([media/chat.js](media/chat.js), [src/sidebar.ts](src/sidebar.ts))

### Internal

- **`video-gen` is excluded from the default live-test gate** (opt-in via `--only=video-gen`). In the headless test harness grok 0.2.x spins on `/imagine-video` instead of producing a clip, so it never completes — the feature works interactively, so a default-on test only produced noise. ([scripts/live-tests.cjs](scripts/live-tests.cjs))

## 1.4.6 — 2026-06-15

> Grok's Mermaid diagrams now render as diagrams.

### Features

- **Mermaid diagram rendering.** Grok answers with ` ```mermaid ` fenced blocks — flowcharts, sequence/state diagrams, git graphs, class diagrams, ER, pie, and more — which the chat previously showed as raw diagram source. These now render as real diagrams via the vendored **[Mermaid](https://mermaid.js.org)** library (bundled into the extension, no network — works offline and in the packaged build). The diagram is themed to match VS Code (dark/light) and gets horizontal scroll so a wide flowchart doesn't blow out the narrow sidebar. Rendering is asynchronous and DOM-based (Mermaid measures text to lay out nodes), so unlike the LaTeX path it runs as a post-render pass over the inserted message; an SVG cache keyed by the diagram source keeps the streaming bubble flicker-free (the agent message re-renders every animation frame) and stops the same diagram being laid out dozens of times before the first render resolves. A half-streamed block stays as plain text until its closing ` ``` ` arrives, and if Mermaid can't load or the diagram is malformed the readable source is shown instead of an error. ([media/chat.js](media/chat.js), [src/sidebar.ts](src/sidebar.ts), [media/mermaid/](media/mermaid/))

## 1.4.5 — 2026-06-15

> Grok's math now renders as math.

### Features

- **LaTeX / math rendering.** Grok increasingly answers with TeX — inline `\(…\)` and display `\[…\]` (including `\begin{pmatrix}` matrices, fractions, sums, Greek) — which the chat previously showed as raw backslash-soup. Math is now rendered with **[KaTeX](https://katex.org)**, vendored into the extension (no network, works offline and in the packaged build). The renderer pulls LaTeX out *before* HTML-escaping so the backslashes and braces survive intact; inline math flows with the text, display math gets its own block with horizontal scroll so a wide matrix doesn't blow out the narrow sidebar. A malformed expression renders as an inline red error (KaTeX `throwOnError:false`) instead of blanking the message; if KaTeX somehow can't load, the raw TeX is shown rather than swallowed. `\label{…}` (which Grok emits inside `align`/`equation` blocks for cross-referencing) is stripped before rendering — KaTeX has no `\ref`/`\eqref` system so it would otherwise paint the label as a red error, and `\label` produces no visible output in real LaTeX anyway. Single `$…$` is deliberately **not** a delimiter — too many false positives with prose currency ("$5 and $10"). ([media/chat.js](media/chat.js), [media/webview-helpers.js](media/webview-helpers.js), [src/sidebar.ts](src/sidebar.ts), [media/katex/](media/katex/))

## 1.4.4 — 2026-06-15

> You can read history again while Grok is thinking.

### Fixes

- **Scrolling up no longer gets yanked back down while Grok is thinking** ([#16](https://github.com/phuryn/grok-build-vscode/issues/16)). The chat snapped to the bottom on *every* streaming update, so any attempt to scroll up and re-read earlier messages (or Grok's own earlier reasoning) was undone on the very next thought chunk. The view now follows streaming output only while you're already pinned to the bottom; the moment you scroll up to read history, auto-scroll pauses and leaves you there. Genuinely interactive activity you need to see — **permission cards**, **ask-user-question cards**, and **your own sent message** — still pulls the view back down and re-pins. This also restores the ability to keep an eye on reasoning while permission cards stack up ([#15](https://github.com/phuryn/grok-build-vscode/issues/15)). ([media/chat.js](media/chat.js), [media/webview-helpers.js](media/webview-helpers.js))

## 1.4.3 — 2026-06-09

> Docs catch-up and a faster, leaner session start.

### Docs

- **README rewrite.** Restructured around three audiences: users get a clean **Requirements → Install → Quick start** path, then a **Features & capabilities** section where each feature is its own collapsible — ordered by what actually sells the extension (diff-preview approval, modes, `/imagine` images+videos, voice…) rather than by implementation. **Configuration**, **Commands & keybindings**, and **Development** each collapse into a single `<details>` so the page scans in seconds while staying self-contained for the Marketplace listing. The deep dive — diagram, message flow, module map, design notes, and the Plan-Mode "the one part that isn't thin" explainer — moved to a new [docs/architecture.md](architecture.md), linked from a short *How it works* teaser.
- **Removed stale claims.** Dropped the **Subagents** feature section (still research-only — it rarely fires in practice, so it shouldn't read as shipped) and the "generated media is inlined as base64" known-limit (1.4.2 switched media to `asWebviewUri` streaming). Trimmed the opening screenshots to the sidebar + an inline `/imagine` result, with a *More screenshots* link to the folder; removed a decorative image that carried no information.
- **Canonical `README.md` / `CHANGELOG.md` casing.** The working-tree files were lowercase on disk (a Windows case-insensitivity slip) while git already tracked them uppercase; the disk now matches. (`vsce` still normalizes the *packaged* copies to lowercase inside the `.vsix` — that's its own convention, which the Marketplace renders fine.) `scripts/release.*` now reference `CHANGELOG.md` so the release-notes extraction works on case-sensitive filesystems too.

### Changed

- **The hidden plan-mode primer no longer costs a startup round-trip.** The extension sends Grok a hidden "primer" that teaches it the Plan-Mode verdict protocol. It used to fire at **every** session start — new *and* every restore — locking the composer until Grok acknowledged and burning a turn even on a session you only opened to glance at. It's now sent **lazily**, as its own hidden turn before your **first real prompt** — on a new *or* restored session — so it rides along with work you already triggered. The composer is ready the instant the session connects, and opening/abandoning a session (or restoring just to read history) costs nothing. Re-asserting the primer on the first post-restore send (rather than trusting a copy buried in replayed history, which a `/compact` can drop) keeps Plan Mode reliable across resumes. Best-effort and unchanged in protocol — the plan-gate remains the real enforcement. ([src/grok-primer.ts](src/grok-primer.ts), [src/sidebar.ts](src/sidebar.ts))

## 1.4.2 — 2026-06-09

> Generated video renders now, and inline media is a tighter thumbnail.

### Fixes

- **Generated videos (`/imagine-video`) finally render.** Detection, path extraction, MIME, and CSP were all already correct — the failure was the delivery: a multi-MB clip base64-inlined into a single `postMessage` `data:` URI was silently dropped, so the `<video>` got an empty source. Generated files are now served via `webview.asWebviewUri` (the grok home is a `localResourceRoots` entry), so the webview **streams the file straight from disk** instead of carrying it as a giant string — videos play, and large images load lazily. Files written outside the served roots still fall back to a base64 `data:` URI, so nothing regresses. ([src/sidebar.ts](src/sidebar.ts), [media/chat.js](media/chat.js))

### Polish

- **The Copy path / Open in VS Code hover icons now sit on the image.** They were anchored to the chat column's right edge, so on a thumbnail they floated in empty space well to the right of the picture. The media block is now sized to the rendered image, so the icons pin to the image's own top-right corner — for videos too. ([media/chat.css](media/chat.css))
- **Inline media is capped at 320px wide** (was 640px), so a generation reads as a compact thumbnail in the narrow sidebar instead of dominating the chat. The file is untouched — click an image (or **Open in VS Code**) for full resolution. ([media/chat.css](media/chat.css))

## 1.4.1 — 2026-06-09

> A two-part fix for generated images that stopped rendering in 1.4.0.

### Fixes

- **Generated images are visible again.** 1.4.0 capped inline media at 640px by wrapping it in a `width: fit-content` container. That made the `<img>`'s `max-width: 100%` resolve against an *indefinite* width, which collapses a replaced element to zero in Chromium — so every generation (including plain `/imagine`) rendered as an invisible, zero-width image. The container is now a normal block (definite width), so the percentage resolves correctly while the **640px cap stays**. ([media/chat.css](media/chat.css))
- **Reference-edited images (`image_edit`) now render too.** Editing a real photo with `/imagine` runs Grok's **`image_edit`** tool (title `imagine-edit: …`, variant `ImageEdit`) — a surface 1.4.0's detector didn't know about, so the saved file was never inlined. Confirmed live against grok 0.2.x: the completed result reports the path as the same machine-readable JSON `{path}` the other media tools use (an extended-length `\\?\C:\…` Windows path, stripped to canonical form). `isMediaGenToolCall` now recognizes it. ([src/acp-dispatch.ts](src/acp-dispatch.ts))

## 1.4.0 — 2026-06-08

> Two new CLI surfaces — generated image/video rendering and a Sign-Out action. The media wire format was confirmed live against grok 0.2.33 (see [research/image-generation.md](../research/image-generation.md)). Available on the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=PawelHuryn.grok-vscode-phuryn).

### Fixes

- **Every message you send no longer renders twice (grok 0.2.33 regression).** grok **≥0.2.33 echoes the live prompt back** as a `user_message_chunk` mid-turn — 0.2.3 did not (the code's own comment read "the agent never echoes them back"). The webview already renders the bubble optimistically from `send()`, so the echo produced a **second, duplicate bubble** (and double-counted `userMessageCount`, skewing plan positioning). The host now forwards `user_message_chunk` **only during a session/load replay** (a new `replaying` flag), and the webview's `appendUserChunk` guards the same — so a live echo can never double the bubble. ([src/sidebar.ts](src/sidebar.ts), [media/chat.js](media/chat.js))

### Image & video generation

- **Generated images and videos render inline.** When Grok generates an image (the subscription-only `/imagine`) or a video (`/imagine-video`), it now shows up as an actual image or a playable `<video>` in the chat instead of a dead tool chip. The real wire format (confirmed live, [research/image-generation.md](../research/image-generation.md)) is **not** an ACP image block — Grok's **`image_gen`** / **`image_to_video`** tools write the file into the session directory (`images/*.jpg`, `videos/*.mp4`) and report the path as a JSON string inside the completed tool result's text. The host recognizes the media-gen call, parses the path out and classifies image-vs-video by extension (`isMediaGenToolCall`/`extractGeneratedMediaPaths`), reads the file and inlines it as a `data:` URI (webviews can't load arbitrary disk paths under the CSP — `media-src data:` was added for video), and the webview renders it. Hovering an image or video reveals two top-right icons (styled like the code-block copy button): **Copy path** and **Open in VS Code** — the latter is the only way to open a *video's* file, since its click drives playback controls (clicking an image still opens its source too). Inline media is capped at **640px** on the longer edge so full-resolution generations stay legible in the chat (the file is untouched). ACP-standard image/`resource_link` blocks are also handled as a forward-compatible fallback. Both render identically on **session resume** (Grok replays the generation as a single collapsed `tool_call`). ([src/acp-dispatch.ts](src/acp-dispatch.ts), [src/acp.ts](src/acp.ts), [src/sidebar.ts](src/sidebar.ts), [media/chat.js](media/chat.js), [media/chat.css](media/chat.css))

### Account

- **Sign out from the extension (#13).** New `Grok: Log Out` command (palette) and a **Sign out** item in the gear menu run `grok logout` to clear the CLI's cached credentials, tear down the live session, and drop back to the auth-required onboarding screen — no more switching to a terminal to change xAI accounts. ([src/sidebar.ts](src/sidebar.ts), [src/extension.ts](src/extension.ts), [package.json](package.json), [media/chat.js](media/chat.js))

### Keeping the CLI current

- **The Grok Build CLI is updated silently when the extension upgrades.** Grok doesn't auto-update, so a user who installs a new extension version could be left on an older CLI whose wire format the new extension no longer matches. Now, the first time a session starts after the extension's own version changes, the host runs `grok update` once before spawning the CLI — so the next handshake reports the freshly-updated version. It fires **only on an actual upgrade**, never on a fresh install (the "not-first-run" rule — a clean install just records its baseline version), at most once per activation, via `execFile` while no grok process is alive (sidesteps the Windows binary lock), and is best-effort (a failed update logs and continues on the current binary). The gate is the pure, unit-tested `extensionWasUpgraded`. ([src/cli-locator.ts](src/cli-locator.ts), [src/sidebar.ts](src/sidebar.ts), [media/chat.js](media/chat.js))
- **The welcome status line tracks real readiness.** It now follows the true session-start lifecycle — `Updating Grok Build CLI…` (during a silent update) → `Starting…` (through the hidden primer turn, while the composer spinner is up) → `Connected · v<version>`. Previously it flipped to "connected" at the ACP handshake, *before* the primer had been sent and processed, so it claimed readiness while grok was still being primed; it now stays "Starting…" until the spinner actually clears. ([media/chat.js](media/chat.js))

### Gear menu & status polish

- **The gear menu gets an "Other" group with About, Config & debug, and Log out.** The flat Config / Account / Debug sections collapse into two sub-views (mirroring the Model picker): **About** shows the *This extension* + *Grok Build CLI* versions, checks for a newer CLI (`grok update --check`), and offers an **Update Grok Build CLI** action; **Config & debug** holds the config links + extension logs. The on-demand update tears the session down, runs `grok update`, then **resumes the same session** on the fresh binary (preserving the conversation), showing the `Updating… → Starting… → Connected · v<new>` lifecycle. ([media/chat.js](media/chat.js), [media/chat.css](media/chat.css), [src/sidebar.ts](src/sidebar.ts))
- **About shows the real CLI version, even on builds the handshake doesn't tag.** The native-Windows build doesn't report a version in the ACP `initialize` response, so About used to read a bare "—" right next to a confident "CLI is up to date". It now adopts the version the update check returns (`grok update --check`'s `currentVersion`), and the action collapses to a grayed "CLI is up to date" (no button) when there's nothing to do. ([media/chat.js](media/chat.js))
- **The Config & debug → MCP servers link works on Windows.** It used to type a quoted `"C:\…\grok.exe" mcp list` into the terminal, which PowerShell (the default Windows shell) parses as a string literal and rejects with "Unexpected token". It now launches grok directly as the terminal's own process (`shellPath`/`shellArgs` → `grok mcp list`), sidestepping shell quoting entirely. ([src/sidebar.ts](src/sidebar.ts))
- **Transient status text animates and is capitalized.** "Starting", "Updating Grok Build CLI", "Thinking", and "Summarizing" now show an animated trailing ellipsis (a CSS `::after` so the layout doesn't shift), and the welcome line reads "Starting…" / "Connected · v…" (capitalized). ([media/chat.css](media/chat.css), [media/chat.js](media/chat.js))

### Tests

- New grok-free tests for v1.4.0: the `image_gen`/`image_to_video` path-in-JSON result extraction (`isMediaGenToolCall`/`extractGeneratedMediaPaths`, classifying image vs video and covering the collapsed-resume shape) and ACP-standard image fallbacks (`extractImageContent`/`collectToolImages` across inline base64, resource blob, file/remote `resource_link`) plus image-vs-text chunk routing, and happy-dom DOM tests driving the real `media/chat.js` render paths — `addGeneratedMedia` (clickable inline `<img>`, `<video controls>`, remote-link fallback, and the hover **Copy path** / **Open in VS Code** actions for both image and video). Plus the silent-update gate (`extensionWasUpgraded` — fresh-install vs upgrade vs unchanged vs downgrade) and a happy-dom suite pinning the welcome version-line lifecycle (`Updating Grok Build CLI…` → `Starting…` at the handshake → `Connected · v<version>` only when the priming spinner clears, and no reversion on later busy toggles). And the 0.2.33 regression fixes: a fake-CLI scenario that echoes a live `user_message_chunk` + a DOM test asserting a single bubble (no duplicate), and a gear-menu suite (the Other group, the About panel's versions + `grokUpdateStatus`-driven update button incl. the version-from-update-check fallback, the Config & debug links). **401 grok-free tests total.**

## 1.3.2 — 2026-06-05

- **Refreshed the Marketplace screenshot.** Updated the "alongside VS Code" README image to `v1.3.1_vscode.png` so the listing reflects the current UI. No code changes. ([README.md](README.md))

## 1.3.1 — 2026-06-05

### Fixes

- **Grok's `ask_user_question` tool works now instead of failing every time (#12).** When Grok tried to ask an inline multiple-choice question, the tool errored with `Client returned an invalid response to user question: missing field 'outcome'` and Grok fell back to dumping the question as plain text. The client had no handler for the question request (`x.ai/ask_user_question`), so it fell through to the catch-all that acknowledges unknown server requests with a bare `{}` — which Grok's deserializer rejects because the response is an internally-tagged enum that requires an `outcome` field. There's now a proper inline **question card**: each question renders its options (a single single-select question resolves on one click, like a permission card; multiple/multi-select questions let you pick then **Submit**; **Skip** dismisses), and the client replies with `{ outcome: "accepted", answers, annotations }` (or `cancelled`). The full wire format was recovered directly from the `grok.exe` binary (method name, the `AskUserQuestionExtResponse` enum, its `accepted`/`cancelled`/`skip_interview`/`chat_about_this` tags, and the `answers`/`annotations` fields) and is documented in [research/ask-user-question.md](../research/ask-user-question.md). ([src/acp.ts](src/acp.ts), [src/acp-dispatch.ts](src/acp-dispatch.ts), [src/sidebar.ts](src/sidebar.ts), [media/chat.js](media/chat.js), [media/chat.css](media/chat.css), [media/webview-helpers.js](media/webview-helpers.js))
- **The question card now clearly confirms your answer.** The question text under the "Grok is asking" label is prominent, and once you answer the card collapses to the question plus a bright green **✓ &lt;your choice&gt;** (for both single- and multi-select) instead of just greying out — so it's obvious Grok received it even when its reasoning continues above. **Skip** collapses to a "Skipped" state. ([media/chat.js](media/chat.js), [media/chat.css](media/chat.css))
- **Answered questions survive a session resume.** Resuming a session from history rebuilds each answered question as a read-only "You answered" card — previously the question simply vanished on reload. On replay Grok relabels the tool call's title to the display form "Ask: \<question\>" and emits one `tool_call` per question, so the card is detected by its `rawInput.questions` (robust to the relabelled title) and rendered immediately; the chosen answer is filled in when it arrives in the replay stream. Handles both agent schemas — grok-build (`ask_user_question`, `question`, quoted answer text) and the cursor/composer agent (`AskQuestion`, `prompt`, option-id answer text mapped back to labels). (If Grok's replay omits a particular answer, the question still renders without the green ✓ line.) ([media/chat.js](media/chat.js))
- **Resuming a session whose model belongs to a different agent no longer crashes.** A session created with a Composer model (cursor agent) resumed while the default model is a grok-build one — or vice-versa — failed the whole resume with `Cannot switch to model '…': it requires agent '…' but the active agent is '…'` → `Grok exited (code null)`. A resumed session's agent is fixed by its history, so the cross-agent model can't be applied live; the resume now keeps the session's own model instead of crashing. ([src/sidebar.ts](src/sidebar.ts))

### Tests

- 18 new grok-free tests (337 total): the pure response builders (`makeQuestionResponse`/`makeQuestionCancelledResponse`) and answer-map helper (`buildQuestionAnswers`), a happy-dom suite driving the real question card through single-click / multi-select / multi-question / Skip / the collapsed answered state / resume-restore (including the replayed "Ask: \<question\>"-titled and cursor/composer shapes), and a `SCENARIO_ASK_QUESTION` round-trip in the fake-CLI ACP integration suite asserting Grok receives a well-formed `outcome:"accepted"` reply.

## 1.3.0 — 2026-06-02

### Voice input

- **New: dictate prompts with a microphone button.** A mic button now sits in the top-right corner of the composer. Click it to record (it turns blue with animated "listening" waves), click again to stop, and the transcription is appended into the input box ready to edit and send. Transcription is powered by [xAI's Speech-to-Text API](https://docs.x.ai/developers/model-capabilities/audio/voice). ([media/chat.js](media/chat.js), [media/chat.css](media/chat.css), [src/sidebar.ts](src/sidebar.ts))
- **Live streaming transcription (default).** Words now appear in the composer in real time as you speak, over xAI's STT WebSocket (`wss://api.x.ai/v1/stt`) — instead of only after you stop. `ffmpeg` streams raw PCM16 to the socket; the host folds the `transcript.partial` events (keyed by `start` — the trailing `transcript.done` is often empty because smart-turn finalizes mid-stream, a quirk confirmed via `research/voice-stream-probe.cjs`) into the live transcript and relays it to the webview. Falls back to one-shot batch mode via `grok.voiceStreaming: false`. Adds the extension's first runtime dependency, `ws` (tiny, zero sub-deps), bundled into the `.vsix`. ([src/voice-streamer.ts](src/voice-streamer.ts), [src/voice.ts](src/voice.ts), [src/sidebar.ts](src/sidebar.ts), [media/chat.js](media/chat.js))
- **Fully hands-free, continuous listening.** Saying **"grok send" submits and keeps the mic listening** — each command transparently restarts a fresh stream (so every message is one clean utterance), and you can **keep dictating the next message while Grok is responding** (mid-response messages are queued and sent the moment Grok's turn ends). After the first mic click, no mouse or keyboard is needed until you're done; the mic stops on a manual click or after ~2 minutes of silence (the ffmpeg cap). ([src/sidebar.ts](src/sidebar.ts), [src/voice-streamer.ts](src/voice-streamer.ts), [media/chat.js](media/chat.js))
- **The "grok send" command is highlighted in the composer.** As you speak (or type) the phrase, the trailing occurrence is wrapped in a subtle accent pill — visible feedback that it's recognized as a command before it's consumed on send. Implemented as a backdrop overlay behind the transparent textarea (textareas can't style their own text); detection is the pure, unit-tested `trailingSendPhrase()`. Uses the configured `grok.voiceSendPhrase`. ([media/webview-helpers.js](media/webview-helpers.js), [media/chat.js](media/chat.js), [media/chat.css](media/chat.css), [src/sidebar.ts](src/sidebar.ts))
- **Hands-free send via "grok send".** Ending a dictation with the phrase **"grok send"** strips the phrase and auto-submits the message. The two-word default is deliberate — it won't trip on a message that merely ends in "send" (verified against real STT output) — and it's passed to the STT model as a **`keyterm` bias** so it's recognized reliably (fixing the "grok send" → "gronsent" mishearing). Configurable/disablable via `grok.voiceSendPhrase`; detection is a pure, unit-tested `parseVoiceCommand()`. ([src/voice.ts](src/voice.ts), [src/sidebar.ts](src/sidebar.ts), [media/chat.js](media/chat.js))
- **Why it's built the way it is.** Two hard constraints shaped the design, both verified against the real stack (see [research/voice-input.md](../research/voice-input.md) + [research/voice-probe.cjs](../research/voice-probe.cjs)): (1) the Grok CLI advertises `promptCapabilities.audio: false` and rejects audio content blocks over ACP — it's a text/code agent, so audio can't ride the CLI; and (2) VS Code webviews can't access the microphone (`getUserMedia` is blocked with no override). So capture runs in the **extension host** via an `ffmpeg` child process — the same place the CLI and terminals are spawned — and the recorded clip is POSTed straight to xAI's separate Speech-to-Text product (`api.x.ai/v1/stt`), bypassing ACP entirely. The full pipeline (DirectShow device auto-detection → mono/16 kHz capture → graceful stop → upload → transcript) was confirmed end-to-end on native Windows with `grok` 0.2.3 and ffmpeg 8.0.1. ([src/voice.ts](src/voice.ts), [src/voice-recorder.ts](src/voice-recorder.ts))
- **Setup.** Voice input needs `ffmpeg` on `PATH` (or `grok.ffmpegPath`) and an xAI API key. The STT API is a **separate** [console.x.ai](https://console.x.ai) developer key billed pay-as-you-go (~$0.10/hr) — distinct from the Grok CLI login, which can't authenticate against it, and unaffected by a SuperGrok subscription. Provide it via `grok.voiceApiKey`, or `GROK_VOICE_API_KEY` / `XAI_API_KEY` in the workspace `.env`. New settings: `grok.voiceApiKey`, `grok.ffmpegPath`, `grok.voiceInputDevice`. ([package.json](package.json))
- **Discoverable setup.** When no API key is configured, the mic button shows a small "needs setup" dot and a hint tooltip (rather than only failing on click), and clicking it offers an actionable **Open Settings** / **Get a Key** prompt. A missing-`ffmpeg` error offers a jump to `grok.ffmpegPath`. The hint updates live when the relevant settings change. ([media/chat.js](media/chat.js), [media/chat.css](media/chat.css), [src/sidebar.ts](src/sidebar.ts))
- **Cost, measured.** STT is billed by *audio duration*, not word count: **$0.10/hr** batch, **$0.20/hr** streaming. We measured a 510-word passage from this project's design chat → **3.06 min of audio → $0.0051 (~½¢) batch / $0.0102 streaming**, i.e. ~**1¢ per 1,000 words batch**. Method (synth → `POST api.x.ai/v1/stt` → cost from the returned `duration`) and a reusable probe are in [research/voice-cost-probe.cjs](../research/voice-cost-probe.cjs); see README § Voice input. ([README.md](README.md))
- **Startup feedback (loading state).** The mic shows a **"connecting…" spinner** while the stream spins up (~½–1s); the blue listening waves appear only once it's actually capturing — your "talk now" signal, so the first words aren't clipped. Click during "connecting" to cancel. ([media/chat.js](media/chat.js), [media/chat.css](media/chat.css), [media/webview-helpers.js](media/webview-helpers.js))
- **Punctuation is preserved and de-duplicated.** The command is stripped but the sentence's own punctuation stays: "…what's the weather today grok send?" → "…what's the weather today?". When the message *already* ended in punctuation, the command's trailing mark is dropped rather than doubled — so "…mate. grok send." → "…mate." (not "…mate.."), and "…not sure. grok send?" → "…not sure." (not "…not sure.?"). At most one trailing mark, the message's own. ([src/voice.ts](src/voice.ts))
- **Blocked sends are queued, not dropped.** "grok send" spoken while a send is blocked (Grok mid-response, or the hidden session-start primer) is queued and flushed the moment the turn ends or the session is ready. ([media/chat.js](media/chat.js))
- **Voice listens only for the active session.** Starting a new session, resuming one from history, or a model/effort restart now hard-stops any in-progress capture and resets the mic to idle (dropping a half-spoken message or a queued "grok send"), so listening never bleeds across a session switch. ([src/sidebar.ts](src/sidebar.ts), [media/chat.js](media/chat.js))
- **Tests.** 85 new grok-free tests (319 total): the pure STT/ffmpeg helpers (incl. the streaming URL builder, the `start`-keyed segment accumulator, streaming ffmpeg args, `trailingSendPhrase`, send/sent tolerance, and punctuation preservation) plus happy-dom coverage of the live-streaming composer, continuous-listening queue, connecting state, and command highlight (request/response/error mapping, per-platform capture args, DirectShow device parsing, key resolution), the mic-button state machine, and a happy-dom DOM suite driving the real mic button through the record → transcribe → insert → error-reset lifecycle. The live STT round-trip stays a manual probe ([research/voice-stt-probe.cjs](../research/voice-stt-probe.cjs), [research/voice-e2e-verify.cjs](../research/voice-e2e-verify.cjs)) per the grok-free CI convention.

## 1.2.4 — 2026-06-01

### Model switching

- **Switching to a model bound to a different agent now works instead of erroring.** Picking a model whose agent type differs from the running session — e.g. the Composer models, which belong to the CLI's `cursor` agent rather than `grok-build` — failed with `Cannot switch to model '…': it requires agent 'cursor' but the active agent is 'grok-build-plan'. Start a new session to use this model.` The CLI binds the agent at spawn and locks it after the first turn (including our hidden primer), so a live `session/set_model` can only stay within the same agent. The fix mirrors the reasoning-effort flow: the chosen model is persisted to `grok.defaultModel` and the session restarts, where `newSession` re-applies it *before* the primer runs — while the agent is still rebindable (verified against grok 0.2.3 in `research/*.cjs`). With no user history yet the restart is transparent; with history you get the same **Summarize & Restart** / **Just Restart** prompt as an effort change. Same-agent switches still happen live with history intact. ([src/sidebar.ts](src/sidebar.ts), [src/acp-dispatch.ts](src/acp-dispatch.ts))
- **Model/effort changes are locked while the session is starting.** A model switch fired during the hidden-primer window raced that turn: a probe showed `session/set_model` sometimes lands *before* the agent locks (applied live) and sometimes *after* (rejected → restart), so switching on a fresh-looking empty session would intermittently appear to "do nothing". The model button and effort dots are now disabled while a turn is in flight or the session is priming — the same `busy` signal that disables send/submit — and the host ignores model/effort messages that slip through the start window. The control re-enables the moment the session is ready. ([media/chat.js](media/chat.js), [src/sidebar.ts](src/sidebar.ts))

### UI

- **The model button shows the user-facing name everywhere.** The gear popover's model button showed the raw model ID (`grok-build`) while the dropdown showed the friendly name (`Grok Build`). Both now resolve through a pure `modelDisplayName()` helper, falling back to the ID only when a model has no name. ([media/webview-helpers.js](media/webview-helpers.js), [media/chat.js](media/chat.js))

## 1.2.3 — 2026-05-30

### Plan mode

- **Grok's own `plan.md` write no longer blocked when the home directory is the workspace.** The plan-mode write gate exempts grok's CLI-owned `~/.grok/sessions/.../plan.md` so it can be written and snooped during planning, but the exemption previously relied on that file living *outside* the workspace — true for project workspaces, false when the user opens their home directory as the workspace root. There the plan file resolved inside the containment root and the workspace block won, so planning stalled (repeated `fs/read_text_file`/`fs/write_text_file` errors, then `session/prompt` timeout). `shouldBlockWrite` now exempts a plan-file write only when it also resolves under the resolved grok home (`~/.grok`), so home-as-workspace plan writes are allowed while real workspace writes — and an arbitrary project-local `.grok/sessions/.../plan.md` that isn't grok's own — stay blocked. (#10, #11, thanks @shugav)

## 1.2.2 — 2026-05-29

### Plan mode

- **Plan-mode gate hardening.** Relative workspace write paths are now resolved against the workspace root before containment checks, and common mutating forms of otherwise read-only-looking commands (shell separators/newlines, command-executing heads like `env`/`awk`/`sed`, write/exec flags on `find`/`fd`/`sort`/`tree`, mutating Git forms, and `npm audit --fix`) are blocked before plan approval. Grok's own `.grok/sessions/.../plan.md` write stays allowed and snooped. (#5, #6, thanks @shugav)

### Reasoning effort

- **`grok.defaultEffort` no longer crashes startup — and effort forwarding still works.** The `Grok exited (code 2)` crash was a value mismatch, not a protocol limitation: the picker offered `max`, which the grok CLI doesn't have (it accepts `none, minimal, low, medium, high, xhigh`). Fixed by aligning the offered values to grok's real set — dropped the bogus `max`, added `none`/`minimal`. `--reasoning-effort` is still forwarded (before the `stdio` subcommand, where the agent-level flag belongs) and changing effort still restarts the session. A pure `buildGrokAgentArgs()` helper + a fake-CLI startup test pin the arg shape. (#3, #4, thanks @shugav for the report)

### Plan review

- **Open a plan as a Markdown editor tab.** Live and restored plan cards now show a link that opens the plan text in a normal VS Code editor (an extension-owned snapshot — deliberately *not* grok's CLI-owned `.grok/sessions/.../plan.md`). Opening it doesn't send a verdict, disable the approval controls, or clear typed feedback. Better for reviewing long plans. (#7, #8, thanks @shugav)

## 1.2.1 — 2026-05-29

Robustness fixes from a static audit (cross-checked with Codex). The high-impact ones are in the child-process supervision layer; a few low-impact correctness/perf cleanups ride along. Findings judged overstated or cosmetic (e.g. the non-`file://` URI drop) were left as-is.

### Fixes

- **Responding to the CLI after it exits no longer crashes the extension host.** `respondPermission` / `respondExitPlan` / `cancel` / the internal request + response writers all did a bare `this.proc?.stdin.write(...)`. The `exit` handler never cleared `this.proc`, so after the CLI died the optional-chaining check still passed and the write hit a destroyed pipe — throwing `ERR_STREAM_DESTROYED` synchronously, or emitting an async `'error'` with no listener, either of which became an uncaught exception in the host. Real trigger: clicking Approve/Reject/Cancel (or a late `terminal/output` ack) after the CLI has crashed. All writes now route through a single `writeLine()` helper that checks `stdin.writable` and try/catches; `start()` registers a `stdin` `'error'` listener; the `exit` handler drops `this.proc` so later writes are skipped; `dispose()`'s `kill()` is wrapped (it can throw `EPERM` on Windows if the process already exited). ([src/acp.ts](src/acp.ts))
- **Killed terminal commands are no longer reported as a clean exit.** A process terminated by a signal reports `code === null`; the old `code ?? 0` masked that as exit code `0`, so the agent assumed an interrupted command had succeeded. Signal kills now map to the shell convention `128 + signum` (SIGTERM → 143) via a new pure `resolveExitCode()` helper. The same `exit` handler also no longer clobbers an exit code already set by the `spawn` `'error'` handler. ([src/terminal-manager.ts](src/terminal-manager.ts))
- **Windows: killing a terminal now kills the whole process tree.** With `shell: true`, `spawn` wraps the command in `cmd.exe`; `proc.kill("SIGTERM")` only terminated that wrapper, orphaning long-running descendants (`npm`, `node`, …) that held file locks and blocked subsequent grok runs. `kill()` now uses `taskkill /pid <pid> /T /F` (via `execFile`, no shell) on Windows through a new pure `buildKillPlan()` helper; POSIX keeps the direct signal. ([src/terminal-manager.ts](src/terminal-manager.ts))
- **Terminal output no longer corrupts multi-byte UTF-8 at a buffer boundary.** Output was decoded with `Buffer.toString()` per chunk, so a character split across the truncation point (or across two stream chunks) became a replacement char (`�`) — visible for any non-ASCII output (emoji, i18n text, localized Windows paths). Each terminal now decodes through a `StringDecoder` that buffers incomplete sequences across boundaries. ([src/terminal-manager.ts](src/terminal-manager.ts))
- **Per-request ACP timers are cleared on response.** Each `request()` armed a `setTimeout` (30 min for prompts) that was never cleared on success — the resolved request left a live timer and its closure pending until it fired and no-op'd. Timers are now tracked on the pending entry and cleared on response and on process exit. ([src/acp.ts](src/acp.ts))
- **`#` in file paths (C#/F# folders) now parses correctly.** The "open file" ref parser used `[^#]+`, so a path with a `#` followed by a real `#L<n>` line suffix failed the match and fell through to opening the literal (wrong) path. Parsing moved to a pure `parseFileRef()` that anchors the `#L…` fragment to the end of the string. ([src/file-ref.ts](src/file-ref.ts))
- **Dropping a huge file with Shift no longer freezes the window.** Shift-drop read the entire file synchronously just to count lines; a multi-MB log stalled the host (and a 500 MB file could OOM it). Files over 10 MB now skip the line count and fall back to a no-selection chip. ([src/file-ref.ts](src/file-ref.ts), [src/sidebar.ts](src/sidebar.ts))

### UI / session fixes (live-testing pass)

Surfaced while smoke-testing the rebuilt extension:

- **"No session" error when sending before the session finished loading.** The composer was interactive during the whole `start()` + `session/new` window; sending then hit `prompt()`'s `sessionId` guard and surfaced a "no session" bubble. The composer is now **locked (spinner, disabled) for the entire session-start window** — not just the priming step — and cleared on every start outcome (ready, missing-CLI, error). ([src/sidebar.ts](src/sidebar.ts))
- **Plan-verdict protocol markers no longer leak into restored conversations.** The host prepends `[Plan approved|rejected|cancelled]` to the wire-level prompt for grok's benefit; live hid it, but on resume grok replayed the raw text and the marker showed in the user bubble. Replayed verdict messages now strip the marker; a **marker-only verdict** (no comment) renders no user bubble at all (matching live), while grok's reply to it still shows. ([media/chat.js](media/chat.js))
- **Restored plan cards land in the right place.** A marker-only verdict was counted as a user message on replay but never counted live, desyncing the saved `afterUserMessage` positions so cards drifted to the bottom. Marker-only verdicts are no longer counted on replay, re-aligning positions with what the host persisted. ([media/chat.js](media/chat.js))
- **Live plan card now matches the (nicer) restored look.** After picking a verdict, the live card drops its buttons + comment box and shows a single colored verdict label (`Approved`/`Rejected`/`Cancelled`), instead of leaving greyed-out buttons and an uncolored label. ([media/chat.js](media/chat.js))
- **Can't delete the active session from history.** Deleting the live session didn't stick (the CLI re-persists it); the delete button is now hidden for the active row (rename still available). ([media/chat.js](media/chat.js))

### Testing — 204 tests

- New regression tests cover each fix, written to fail before the fix landed (TDD). Process layer: `writeLine` swallows a throwing/destroyed stdin and skips a non-writable pipe ([test/acp-integration.test.ts](test/acp-integration.test.ts)); `resolveExitCode` maps signals to `128 + signum` and passes real codes (incl. 0) through; a killed process surfaces a non-zero exit; `buildKillPlan` issues `taskkill /T /F` on Windows and `SIGTERM` on POSIX; truncating mid-character emits no `�` ([test/terminal-manager.test.ts](test/terminal-manager.test.ts)); a resolved `request()` leaves no armed timer ([test/acp.test.ts](test/acp.test.ts)). Pure path helpers: `parseFileRef` / `shouldReadFileInline` ([test/file-ref.test.ts](test/file-ref.test.ts)). Webview: marker stripping + marker-only suppression + position alignment on replay, the collapsed live verdict card, and delete hidden for the active session ([test/plan-history-restore.dom.test.ts](test/plan-history-restore.dom.test.ts), [test/plan-card.dom.test.ts](test/plan-card.dom.test.ts), [test/webview-ui.dom.test.ts](test/webview-ui.dom.test.ts)).
- **Flaky CI fix.** `test/acp-integration.test.ts` shared one `stderr` array binding across tests, so a prior test's late stderr could bleed into the next (reliably failed `gate blocks fs/write` on Linux). Each test now captures into its own array, listeners are removed in `afterEach`, and the stderr assertion waits for its line (stderr lags the stdout response across pipes). Reproduced on Ubuntu via Docker before fixing.
## 1.2.0 — 2026-05-28

### Plan mode is now enabled

The headline of this release reverses 1.1.0's "Plan mode stays disabled." The `x.ai/exit_plan_mode` ACP path is still broken in `grok` 0.2.3 — it treats *any* client response (result **or** error) as approval, so a plan can't be rejected at the protocol layer. Rather than wait on the CLI, this build **enforces plan mode client-side**, mirroring how YOLO mode is implemented.

- **Client-side plan gate ([src/plan-gate.ts](src/plan-gate.ts), pure + unit-tested).** While a plan is active, the extension blocks the two *mandatory* server→client choke points the agent cannot avoid:
  - `fs/write_text_file` — refused when the path resolves **inside the workspace** (grok's own `~/.grok/sessions/<cwd>/<id>/plan.md` lands *outside* the workspace, so it's allowed — and snooped to recover the plan text, since `exit_plan_mode` arrives with `planContent: null`).
  - `terminal/create` — refused unless the command is on a conservative **read-only allowlist**. The classifier is pipe-aware: a pipeline passes only if *every* `|`-separated stage is independently read-only, and shell metacharacters that chain, redirect, or smuggle code (`>`, `;`, `&&`, `` ` ``, `$(`, `{ }`) block it outright. The allowlist covers **read-only PowerShell pipelines** (`Get-ChildItem | Select-Object …`, `Get-Content`, `Test-Path`, etc.) for native Windows, while excluding anything that writes or executes (`Out-File`, `Set-Content`, `Invoke-Expression`/`iex`, `ForEach-Object`, `Where-Object`).
- **Asymmetric mode sync.** Entering plan mode *any* way (including an agent-initiated `current_mode_update: plan`) raises the gate; it's lowered only by explicit user action, never by the CLI's mode flapping (the false-approve emits `current_mode_update: default`, which is deliberately ignored).
- **Mode picker copy updated.** Plan mode is no longer marked disabled; its description now reads "Grok explores and proposes a plan; file writes and commands are blocked until you approve it." Matched in the README modes table and command list.

### Three-verdict plan review (Approve / Reject / Cancel)

The plan-review card now offers three distinct outcomes, each mapped to a different ACP verdict and different downstream behavior. (Earlier in the iteration this was a two-button Approve / Keep planning UI; user testing surfaced that "I want to stop planning but not implement" had no clean exit, so we split it.)

- **Approve & implement** → verdict `approved`. Drops the gate, returns the CLI to act mode, sends "Implement it now" as the next prompt.
- **Reject** (with optional comment) → verdict `rejected`. Keeps the gate up — you're still in Plan mode. If you wrote a comment, it's sent to Grok as a plain user message (not "revise the plan"); Grok decides whether to re-plan or answer. The chosen button highlights, a **Rejected** label appears.
- **Cancel** → verdict `abandoned`. Drops the gate, switches the CLI back to act mode, sends nothing. Use this to back out of planning entirely. **Cancelled** label appears.

### Suppressing the CLI's false-approval response

Because grok 0.2.3 treats any `exit_plan_mode` response as approval, rejecting a plan would otherwise let the agent keep streaming "OK, the plan is approved, here's what I'll do…" before our follow-up prompt landed. On Reject / Cancel we now:

1. Send the verdict to the CLI (it still mis-interprets it, but that's fine — the gate is authoritative).
2. Immediately send `session/cancel` to interrupt the in-flight prompt.
3. Set a content-only suppression flag (`suppressPlanReject`) that drops `messageChunk` / `thoughtChunk` / `toolCall` events for the rest of the turn — but **not** `promptComplete` / `agentEnd`, so the webview's `busy` state still clears and the send button re-enables when the cancelled turn ends.
4. Post `agentReset` to the webview, which removes the in-flight agent bubble from the DOM so the false-approval text never reaches the screen.

A `finally` in `handleSend` clears the suppression as a safety net so it can't get stuck.

### Plan markdown rendering

Plan bodies render through the same Markdown pipeline as agent messages now (headings, lists, code fences) instead of monospace `<pre>` blocks. Applies to both the live review card and the restored history cards. A bug along the way: the `.code-block` `position: relative` rule was scoped under `.msg.agent .body`, so when plan cards contained fenced code their absolutely-positioned copy buttons escaped to the viewport and overlapped the Session-history / New-session header buttons. The scoping was loosened so any `.code-block` is its own positioning context.

### Per-session plan history (restored inline, not at the bottom)

grok overwrites `~/.grok/sessions/<…>/plan.md` every time the agent proposes a new plan, so older plans in a session are physically gone from disk. We now persist each resolved plan to VS Code's `globalState` keyed by session id (`SessionMetaOverride.plans`), capturing **text + verdict + `afterUserMessage`** (the count of user messages already sent at the moment of resolution).

On session resume:

- The host posts a `planHistoryQueue` to the webview *before* `session/load` starts.
- The webview drains the queue inline as the replay streams: each plan card lands at its saved user-message boundary (right where the plan actually happened), not in a clump at the bottom. Legacy entries without a saved position fall back to the end of replay.
- The plan-gate state is restored from the *last* verdict via a pure helper ([src/plan-restore.ts](src/plan-restore.ts)): `rejected` → re-raise the gate (you were mid-planning); `approved` / `abandoned` / no log → leave the gate down (Cancel-then-restore no longer comes back stuck in Plan mode). Without this, the CLI's replayed `current_mode_update` events would raise the gate even when the user had cancelled.
- A separate `pendingPlanText` field holds the displayed plan from render → verdict-click, since `lastPlanText` is cleared the moment the card renders. (Regression: without this, restored plans showed `"(empty plan)"` despite content being persisted.)

### Native-Windows webview fixes (carried forward + locked in)

The history-popover, whole-row-click, and reasoning-trace-expand fixes from 1.1.0 are now covered by DOM tests so they can't silently regress again (see Testing).

### Testing — 178 tests, all grok-free

- **Two clearly separated tiers.** `npm test` (and CI) runs **only grok-free tests** — pure-logic unit tests plus DOM tests that drive the real `media/chat.js` in a headless `happy-dom` window. The **grok-dependent probes** live in `research/*.cjs`, require the `grok` binary, are run manually, and are never collected by Vitest or CI.
- **New pure module + tests** for the persist / restore decision: [src/plan-restore.ts](src/plan-restore.ts) extracts `appendPlanEntry` and `decideRestoreState`. 15 tests cover chronological append, immutability, text preservation (the wiped-`lastPlanText` regression), and the verdict-driven restore decision for every verdict including the "rejects then cancels → Agent mode" case that previously came back in Plan mode.
- **New DOM tests** in `test/plan-history-restore.dom.test.ts` (12 tests) lock in the restore-flow rendering: positioned plans interleave at the right boundary, legacy plans flush at end of replay, multiple plans at the same position drain together, live user message drains queued plans, `clearMessages` resets queue + counter, all three verdict buttons produce matching status labels, `agentReset` removes the in-flight agent bubble and a subsequent `messageChunk` creates a fresh one.
- **New ACP integration tests** in `test/acp-integration.test.ts` (6 tests) drive the real `AcpClient` over JSON-RPC stdio against a ~150-line fake `grok agent stdio` fixture (`test/fixtures/fake-grok-acp.cjs`). Covers the wire layer + plan-mode gate end-to-end: plan-snoop, workspace-write gate (on and off), terminal-create gate for mutating vs read-only commands. Encodes only what ACP requires, not grok's version-specific quirks, so it stays stable across CLI bumps.
- **178 tests, ~1.4s**, no network, no spawned `grok`. The whole suite runs on a clean Ubuntu CI runner via `.github/workflows/ci.yml`.

### Bug fixes (this iteration)

- **Effort-picker dots are now visually balanced.** The "filled / empty" dots used the `●` / `○` Unicode glyphs, which render at different sizes in most fonts (the empty one is visibly larger). Replaced with CSS-shaped spans so active and inactive states are the same diameter.
- **Spawning `.cmd` / `.bat` CLI paths now works on Windows.** Node 18+ refuses to spawn those without `shell: true` (CVE-2024-27980). `AcpClient.start()` now detects them and sets `shell: true` automatically, so installs that resolve grok to a `.cmd` shim (or the test fake-CLI) start correctly.

## 1.1.0 — 2026-05-27

### Windows support

- **Native Windows is now first-class.** xAI shipped a native Windows build of the `grok` CLI (`irm https://x.ai/cli/install.ps1 | iex`), so the extension no longer needs WSL. This reverses the 1.0.3 "Windows isn't supported" onboarding panel.
  - **Onboarding** now detects Windows and shows the PowerShell install command (`irm https://x.ai/cli/install.ps1 | iex`) with copy-to-clipboard and "Open terminal & run" — the same flow macOS/Linux already had, just with the right command per platform.
  - **"Open terminal & run"** sends the PowerShell installer on Windows and the `curl | bash` installer elsewhere. The CLI locator (`grok.cmd`/`grok.exe`) and headless terminal manager (`shell:true`) already worked cross-platform.
- **README + CLAUDE.md** updated: platforms now read "macOS, Linux, and Windows"; install steps show both the bash and PowerShell one-liners; build-from-source and uninstall lines note the `scripts\*.ps1` equivalents.

### Webview UI

Surfaced by the first native-Windows smoke test (against `grok` 0.2.3):

- **Session-history popover now hides.** `.history-popover` set `display:flex`, which beat the UA `[hidden]{display:none}` rule (author styles win), so the dropdown rendered as an empty box on startup and `hidden = true` could never dismiss it. A `.toolbar-popover[hidden] { display:none }` rule restores correct hide behavior — the popover now closes on select, click-outside, and new-session.
- **Whole history row is clickable.** Resume was wired only to the name label even though the row showed a pointer cursor; the handler moved to the row, so clicking anywhere on it (name, meta line, or padding) resumes. Rename/delete buttons keep their own `stopPropagation`.
- **Reasoning traces are expandable again.** The "Thinking…/Thought for *N*s" line is once more a collapsible header — click it to reveal the full trace (collapsed by default, rAF-coalesced while streaming). This reverses the 1.0.2 change that discarded the trace at the render layer.
- **Decluttered welcome screen.** Removed the static tips list (Enter to send / slash commands / file chips) from the empty-session screen.
- **Restored user prompts when loading a session.** `session/load` replays history as session updates, but `user_message_chunk` had no route, so replayed user prompts fell through to the ignored generic-update branch and vanished — loaded sessions showed only the agent's half of the conversation. The chunk is now routed and rendered into a user bubble, with the in-flight agent turn committed at each user boundary. Replayed reasoning headers read "Thought" (no elapsed time, since the original timing isn't in the replay stream); live turns keep "Thought for *N*s".
- **Inline diffs render as diffs.** Fenced ` ```diff ` blocks now color added lines green and removed lines red using VS Code's own `diffEditor` *line* backgrounds (so they match the editor's diff view), dim hunk/metadata lines, and wrap long lines instead of forcing horizontal scroll. Copy still yields plain diff text (the handler reads `innerText`, since each row is now a block-level span).
- **Copy-code button no longer fights the text.** It fades to 0.95 opacity on code-block hover and full opacity on button hover, so its background stays solid instead of blending into the first line of code.

### Mode picker

- **Agent-mode description corrected.** As of `grok` 0.2.3, Agent mode acts directly and only prompts for changes it judges sensitive; the picker no longer claims it "asks for approval before making each change." Matched in the README modes table.
- **Plan-mode note de-emphasized.** The "Reject / Abandon not yet supported" note under disabled Plan mode is now muted gray (`descriptionForeground`) instead of warning yellow — it's an explanation, not an alert.

### Verified (no change)

- **Plan mode stays disabled.** Re-tested the `x.ai/exit_plan_mode` rejection path live against `grok` 0.2.3 over ACP: rejecting a plan with a JSON-RPC error still let the agent exit plan mode and execute the whole plan (it created the target file anyway). The CLI bug from the 0.1.x baseline is unchanged, so the Plan UI remains off.

## 1.0.3 — 2026-05-19

### Tool calls

- **In-progress group header** now shows only the current action in present-progressive form with three animated dots — *Reading CLAUDE.md*, *Listing root folder*, *Running command*, *Searching web*, *Editing chat.js*. Previous behavior accumulated `"X, Y +N"` as new calls streamed in.
- **Completed multi-call summaries** are now categorical instead of listing the first two calls: *Explored N items, searched web, ran N commands*. Reads and directory listings roll into "explored"; web search/fetch into "searched web" (no number); everything else into "ran N commands".
- **Chevron moved to the right** of the label and only appears on hover; rotates 90° when expanded.
- **Friendlier detail labels** — `web_search` → *Web search*, `List .` → *List root folder*.

### Markdown rendering

- **Tighter heading and list spacing.** Headings and lists no longer get a phantom `<br><br>` stacked on top of their own CSS margin when preceded by a blank line. Block elements rely on their margins; only paragraph-to-paragraph transitions emit a `<br><br>`.

### Message layout

- **User bubble min-width 40%.** Short prompts no longer collapse to a text-width sliver against the right edge.
- **Show more / Show less hover** flips to a full-contrast inverted pair (`foreground` on `editor-background`) instead of the semi-transparent secondary-button hover. Reads as a solid pill.

### Performance

- **Streaming rAF-coalesced.** `agent_message_chunk` and `agent_thought_chunk` no longer trigger a full markdown re-render per chunk. Updates batch into one paint per animation frame, with a synchronous flush on `promptComplete` so the final chunks always land. Long responses no longer jank.

### Cleanup

- **Removed dead `grok.defaultPermissionMode` setting** that was declared in `package.json` but never read by any code.
- **`activationEvents` dropped** — modern VS Code auto-generates activation from the view contribution, so the explicit entry is redundant (linter-flagged).

### Docs

- **README restructured** for a dev-reading audience. New top-level sections: *Why an extension, not the CLI?*, *Key concepts* (where state lives, modes, chips, permission cards), *Architecture* (diagram + session lifecycle + module map + design choices), *Development*. Slash-command tables moved to `docs/SLASH-COMMANDS.md`. Marketplace install promoted; stale 1.0.1 VSIX path removed.
- **package.json `description`** rewritten to lead with the "thin ACP client" framing instead of a feature laundry list. Added keywords: `agent-client-protocol`, `acp-client`, `xai-grok`.

### Fixes

- **Shell-set `XAI_API_KEY` now works.** Previously the alias to `GROK_CODE_XAI_API_KEY` (which the CLI actually reads) only fired for keys loaded from a workspace `.env`. Keys in the user's shell environment are now mapped too, matching what the README documents.
- **Broader auth-error detection.** The auth-required onboarding panel now triggers on 401/403/`forbidden`/`api_key`/`credential` errors as well as anything containing `auth`. Reduces the chance of users seeing a generic "Failed to start Grok" toast when the real cause is missing or invalid credentials.

### Onboarding

- **Windows shows an honest "not supported" panel.** Native Windows users no longer get the macOS/Linux `curl | bash` install command (which can't run in cmd/PowerShell). They get a clear note pointing to the README's WSL workaround.
- **"SuperGrok Heavy" labeling.** The auth panel now names the *Heavy* tier explicitly (which is what carries the Grok Build entitlement) instead of the ambiguous "SuperGrok subscription".

### Distribution

- **Removed precompiled `.vsix` files** from `releases/`. They were drifting from `main` and the README's quick-install line pointed at the stale 1.0.1 build (which lacked the new onboarding UI). The marketplace listing is the canonical install path; build-from-source remains supported for development.

---

## 1.0.2 — 2026-05-19

### Markdown rendering

- **Header hierarchy** — H1 / H2 / H3 now scale visibly above body text (1.4em / 1.25em / 1.1em). Previously every heading rendered at body size, just bold.
- **Body rhythm** — agent message bodies use `line-height: 1.55` for easier scanning; first-child headings drop their top margin to avoid awkward leading gaps.
- **Nested bullet markers** — disc → circle → square at three depths (was disc → circle only).
- **GFM tables** — pipe tables with `|---|---|` separator rows now render as bordered tables with bold tinted header rows and per-column alignment (`:---`, `:---:`, `---:`). Wrapped in an `overflow-x: auto` container so wide tables get a horizontal scrollbar instead of breaking layout.

### Code blocks

- **Copy code button** — fenced code blocks now show a hover-revealed "Copy code" button in the top-right corner. Click writes the code (raw text, no formatting) to the clipboard and flashes a checkmark for 1.5 s.

### Message layout

- **User messages as bubbles** — right-aligned, capped at 80 % width, no border, lighter `editorWidget-background` tint. Inline `YOU` / `GROK` role labels removed; position alone signals sender.
- **Per-message actions** — every user and agent message shows a hover-revealed action row at the bottom: timestamp (`6:47 AM`) and a copy-message button that copies the raw markdown.
- **Show more / Show less** — restyled to match the secondary-button family (proper padding, button background). Hover-reveal behavior unchanged.

### Thinking traces

- **Reasoning hidden by design** — the "Thinking..." indicator stays as a single line at standard text size; on completion it flips to "Thought for *N*s". The actual trace text is discarded at the webview rendering layer (never enters the DOM) instead of being collapsed behind a chevron — there's no expansion affordance.

### Onboarding

- **In-sidebar onboarding** — the missing-CLI and authentication-required errors no longer pop modal VS Code dialogs. The welcome panel itself swaps to an onboarding state:
  - **Missing CLI** — shows the install command (`curl -fsSL https://x.ai/cli/install.sh | bash`) with copy-to-clipboard and an "Open terminal & run" button, plus a "Re-check connection" button.
  - **Auth required** — explains the two paths: SuperGrok subscription (run `grok /login` in a terminal) or API key from [console.x.ai](https://console.x.ai) with `XAI_API_KEY` in a workspace `.env`. Same "Re-check connection" hand-off.
  - All onboarding is deterministic — no AI calls happen before the CLI is reachable.
- **Welcome on every new session** — clicking the new-session button now restores the welcome panel (logo, byline, version, tips) instead of leaving an empty pane. Previously the welcome only appeared on first activation.

### Docs

- README now points to [console.x.ai](https://console.x.ai) as the place to obtain an API key, alongside the existing `grok /login` flow.

---

## 1.0.0 — 2026-05-18

### UI / UX

- **Mode labels** — mode button now shows "Agent mode" / "Plan mode" (YOLO unchanged) in both the button and the picker. The button collapses to icon-only when the sidebar is narrow.
- **Context donut** — label changed from a percentage to `usedK/maxK` format (e.g. `20K/200K`) so the scale adapts to the model's context window. Tooltip shows exact token counts.
- **Settings gear — Model and Effort** — added "Model and Effort" section header above the model+effort row; removed the sparkle icon from the model name button; model name font now matches the rest of the popover (13 px); fixed double-border between the model row and the Session section.
- **Effort dots** — increased dot size (10 px → 14 px); each dot now shows a descriptive tooltip ("Low — fast, lightweight reasoning", etc.).
- **Summarize & Restart** — when changing reasoning effort with an active conversation, a VS Code dialog offers *Summarize & Restart* or *Just Restart*. The summarize path sends a silent summary request to the current session, starts a fresh session with the new effort level, injects the summary as context (suppressed from the chat UI), and shows a "Context from previous session applied" banner. The original Grok summary response is hidden — only the banner appears.

### Fixes

- Resolved race condition where changing effort (or clicking New Session) showed "Grok exited (code 143)" errors from the previous session's process being disposed. Each session now carries a generation counter; `exit` events and errors from replaced sessions are suppressed.
- `--reasoning-effort` flag was never actually passed to the spawned process. Fixed — the flag is now read from `grok.defaultEffort` and forwarded on every session start.

---

## 0.9.0 — 2026-05-18

### UI / UX

- **Bottom toolbar** — removed the top bar entirely; model, mode, gear, and new-session controls now live in a responsive row at the bottom of the composer, next to the send button. The row shrinks gracefully to icon-only when the sidebar is narrow (labels disappear, icons stay).
- **Mode selector redesign** — each mode now has a distinct icon and a one-line description (Claude Code-style popover). Agent uses a shield icon, Plan uses a list-tree icon, YOLO uses a lightning bolt.
- **Collapsible user messages** — messages taller than ~3 lines collapse automatically with a gradient fade. "Show more" appears on hover; "Show less" collapses back.
- **Tool call display** — single tool calls render as a flat row with a human-readable label ("Read sidebar.ts", "Edit package.json", "Run npm test"). Multiple calls from one agent step collapse into a grouped header ("Read, Edit +2") that expands on click.
- **Welcome screen** — xAI Grok mark logo (white), "Grok Build" title, "by Pawel Huryn (The Product Compass)" byline.

### Features

- **Reasoning effort** — configurable from the gear popover (CLI default | Low | Medium | High | XHigh | Max). Changing effort restarts the session so the new flag takes effect. Also exposed as `grok.defaultEffort` VS Code setting.
- **YOLO mode** — auto-approves all permission requests in the extension without any CLI restart. Session and memory are fully preserved; switching back to Agent or Plan mode re-enables approval cards immediately.
- **Gear / settings popover** — single gear icon opens a panel with three sections:
  - *Session*: Reasoning Effort picker, Compact conversation shortcut
  - *Config*: Open global config (`~/.grok/config.toml`), Open project config (`.grok/config.toml`), List MCP servers in a terminal
  - *Debug*: Show extension logs
- **MCP server support** — the extension passes `mcpServers: []` in `session/new` (the CLI rejects the call without this field), and the CLI loads its own MCP configuration from `~/.grok/config.toml` / `.grok/config.toml` alongside that empty list. Configure servers via `grok mcp add` or by editing the config files directly.

### Fixes

- Removed `--reasoning-effort high` default that was causing 403 errors on free/SuperGrok accounts (the flag is unsupported in stdio mode on some subscription tiers).
- Removed stale `hint` element references that caused silent JS errors in the webview.
- Popovers now position themselves above their trigger button (correct for a bottom toolbar) and clamp to stay within the panel width.

---

## 0.1.0 — unreleased

Initial preview. ACP client for `grok agent stdio`.

### Implemented

- Sidebar chat webview driven by `grok agent stdio` over ACP
- Streaming agent messages + separate thinking trace (collapsible, shows elapsed time)
- Permission-request cards with diff-editor preview (allow always / allow once / reject)
- Plan-mode toggle (`session/set_mode`) + plan-approval cards (`x.ai/exit_plan_mode`)
- Model picker (live `session/set_model`)
- Slash-command autocomplete sourced from `available_commands_update`
- Context-usage donut from prompt result `_meta.totalTokens`
- File chips with hide-toggle, Explorer drag-and-drop (Shift = embed inline)
- Right-click "Grok: Send File / Selection" in Explorer + editor
- `Ctrl+;` opens sidebar; `Alt+G` inserts @-mention for active file
- Required server→client handlers: `fs/read_text_file`, `fs/write_text_file`, `terminal/{create,output,wait_for_exit,kill,release}`
