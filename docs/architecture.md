# Architecture

How the Grok Build VS Code extension is put together, and the one place it
deliberately stops being "thin." For day-to-day usage see the
[README](../README.md); for the test layers see [TESTS.md](../TESTS.md).

## The thin-client boundary

The extension is a UI shell over `grok agent stdio`. It speaks JSON-RPC over the
[Agent Client Protocol (ACP)](https://agentclientprotocol.com) on the CLI's
stdin/stdout and renders the results. Almost all real state lives in the CLI
process, not the extension.

| Lives in the CLI | Lives in the extension |
|---|---|
| Conversation history, memory, `~/.grok/` | Chips list (active editor + drag-added files) |
| MCP servers, subagents, plugins | YOLO flag (auto-approval) |
| Tool execution, model state | Plan-mode gate + per-plan verdict log |
| Plan text on disk (`~/.grok/sessions/<…>/plan.md`) | Webview UI state, popovers, slash filter, pending diff per `toolCallId` |

Kill the extension and the `grok` child dies with it; kill `grok` and the
extension surfaces an error and offers a fresh session. Restarting the session
(the **+** button) kills the CLI child and spawns a new one — memory the CLI
persisted under `~/.grok/` survives.

## Message flow

```
VS Code webview ──postMessage──► extension host ──JSON-RPC over stdin/stdout──► grok agent stdio
                                                  ◄── session/update (message chunks, thought chunks, tool calls, mode changes)
                                                  ◄── fs/read_text_file, fs/write_text_file
                                                  ◄── terminal/create, terminal/output, terminal/wait_for_exit, terminal/kill, terminal/release
                                                  ◄── session/request_permission
                                                  ◄── x.ai/exit_plan_mode, x.ai/ask_user_question
```

The extension implements **every mandatory server→client handler**
(`fs/read_text_file`, `fs/write_text_file`, `terminal/{create,output,wait_for_exit,kill,release}`)
— miss one and the agent crashes mid-session.

The `postMessage` half (host↔webview) is a **typed contract**: [src/protocol.ts](../src/protocol.ts)
is the single source of truth — `HostMsg` (host→webview) and `WebviewMsg` (webview→host)
discriminated unions. The host types `post`/`emit` against `HostMsg`, and a test asserts the
webview's mirror of the type list ([media/webview-helpers.js](../media/webview-helpers.js)) stays
in sync and that `chat.js` handles every host type — closing the "post one shape, handle another"
gap the untyped `any` direction used to leave open around restore, pagination, and media.

## How a session starts

When the panel opens (or you click **+** for a new session):

1. Locate the `grok` binary: `grok.cliPath` setting → `~/.grok/bin/grok` → `PATH`.
2. Spawn `grok agent stdio` as a background child — visible in `ps` / Task
   Manager, never opening a terminal window.
3. If `grok.defaultEffort` is set, pass `--reasoning-effort <value>` **before**
   the `stdio` subcommand (it's an agent-level flag).
4. `initialize` → `session/new` (or `session/load` to resume) → `session/set_model`.
5. Stream `session/update` notifications (messages, thoughts, tool calls,
   permission requests, mode changes) back into the chat.

The composer unlocks as soon as the session is live. The extension's hidden
"primer" message (below) fires **eagerly and silently** the moment the session
goes live — in the background, without blocking the composer — so it's almost
always finished before you send. Your first real prompt simply `await`s the same
in-flight primer turn (grok runs one turn at a time) and is released the instant
it acks. While any user turn is waiting on grok — including that brief held-behind-
primer gap — the chat shows an animated **Grokking…** placeholder, replaced in
place by the first thought / message / tool card.

## The session pool (Agent Dashboard)

The sidebar shows one conversation at a time, but it keeps a **pool of live
sessions** behind it — one spawned `grok agent stdio` process each, with exactly
one *focused* (the one you see). All the per-session state lives in a
[`Session`](../src/session.ts) object; the sidebar holds `focused` plus a `Set` of
every live `Session` (`pool`). The point is **lossless re-focus**: a backgrounded
session keeps streaming into its own *view buffer* (every webview post that built
its chat, in order), so re-focusing it is a `clearMessages` + replay of that
buffer — no grok reload, no process kill, even mid-turn or mid-approval.

Switching focus (`focusSession`) never touches grok: it swaps `this.focused`,
replays the target's buffer to the webview, and re-pushes the mode/sessions UI.
Clicking a session that *isn't* live (cold — it was reaped, or predates this
window) loads it from grok's on-disk history into a fresh pool member instead
(`openSession`).

Two details make the pool safe:

- **Per-session generation guard.** Each `Session` owns a `gen` counter, bumped
  only when *its* client is torn down. Handlers capture their session's `gen` when
  wired, so a backgrounded session's in-flight events are never judged "stale" just
  because focus moved elsewhere (the old global counter would have done exactly
  that).
- **Session-scoped emit.** `emit(session, …)` buffers to that session and only
  forwards to the webview when it's the focused one; `post(…)` is for UI-wide
  messages (status dots, the sessions list) that aren't tied to one chat.

**Status dots.** Every row in the history dropdown shows a dot. It's **gray** at
rest — and "at rest" is deliberately one bucket: idle, already-read, cold, or
loaded-from-disk all look the same, because the warm-process-vs-cold distinction is
an implementation detail no user should have to reason about. It lights up only
when there's something to know: **blue** working, **yellow** needs-you (a pending
permission / question / plan review), **green** *finished with output you haven't
opened yet*, **red** *finished with an error you haven't opened*.

The green/red dot is an **unread badge**, not a live state. When a session's turn
ends while you're looking at a *different* session, a persisted `unread` flag is set
(in the same `globalState` session-meta that holds rename overrides); opening that
session clears it. Because the flag lives in metadata rather than the live process,
the badge **survives both the idle reaping below and a full VS Code restart** — so
you can fire off several agents, walk away, and come back to find the green dots are
exactly the sessions with results waiting. There's no timer: a session you never
open stays green, because it genuinely *is* still unread. The actual color is a pure
function ([`computeDot`](../src/session-pool.ts)) of `(live status, unread,
unreadError)`, so the policy is unit-tested without a process pool. The host pushes
one changed dot at a time (cheap, no disk read) and the full map on each list
refresh.

**Reaping** ([src/session-pool.ts](../src/session-pool.ts)). A live process per
session isn't free, so the pool is bounded — silently. The pure `selectReapable`
picks victims under two rules: an **idle TTL** (a session untouched for an hour is
torn down, swept every 5 min) and an **LRU cap** (at most ~8 live; the
least-recently-used eligible sessions are evicted past it). It **never** reaps the
focused session or a `working`/`needs-you` one — so the cap can be exceeded when
everything spare is busy, by design. Reaping just kills the process and recomputes
the dot — a reaped session that's still unread **stays green**, a read one goes
gray — and re-clicking the row reloads the session from disk.

One safety valve sits next to this: the explicit **Update Grok Build CLI** action
tears down every live session to swap the binary, so it now confirms first if any
session is `working` or `needs-you` (the silent startup auto-update runs before
anything is in flight, so it doesn't ask). The teardown is **awaited** before
`grok update` runs — `kill()` only signals, and on Windows the `grok.exe` lock
clears a beat after the process actually exits, so an un-awaited update would race
it and fail with *"cannot rename locked executable"*. On Windows the kill is a
`taskkill /T /F` of the process **tree** (grok backgrounds subagent/command
children that a parent-only kill would orphan, and they keep the binary locked),
and the update retries once if a lingering lock still slips through.

## The Workspaces panel (multi-workspace)

grok keys its on-disk session store by the **exact spawn cwd**, URL-encoded:
`~/.grok/sessions/<encodeURIComponent(cwd)>/<session-id>/`. That makes every
workspace grok has ever run in discoverable by decoding the store's directory
names — which is exactly what the **Grok Workspaces** tree view (primary side
bar, [src/workspace-tree.ts](../src/workspace-tree.ts)) does. It lists this
window's folder(s) first (multi-root included, never removable), then
user-added folders (a `globalState` registry; the **+** action quick-picks from
the discovered workspaces with session counts, or browses to any folder).
Session rows carry the same status dots as the history dropdown
(`ThemeIcon("circle-filled", ThemeColor)` over the shared `computeDot` value)
and paginate per workspace: 5 rows, then a grayed "Show more (N hidden)" row
revealing 10 more per click (an empty-label, description-only TreeItem — native
theming renders it dim with the standard hover highlight in light and dark).
Deep-dive: [research/multi-workspace.md](../research/multi-workspace.md).

Two design rules carry the whole feature
([src/workspaces.ts](../src/workspaces.ts), pure):

- **Identity is canonical; disk access is literal.** One real folder can have
  several storage spellings (VS Code lowercases the drive letter on Windows, a
  terminal doesn't; trailing separators). Workspaces are deduped/merged by
  `canonicalizeWorkspacePath`, but every read/delete/spawn uses the literal
  on-disk spelling (`WorkspaceRef.storageCwds`) — and merged session indexes
  dedupe by id, because on a case-insensitive filesystem two spellings serve
  the *same* physical dir.
- **Every session owns its workspace.** `Session.cwd` is stamped at
  `startSession` and threads through everything derived from it: the spawn cwd,
  plan-gate containment root, `.env`, the *project* `config.toml` lookup
  (auto-approve detection), relative-path resolution for chat file links, and
  the empty-session cleanup. Opening a session from another workspace spawns
  grok **in that folder**; the pool happily holds sessions from several
  workspaces at once (live blue/yellow dots included). The chat's history
  popover stays scoped to this window's workspace — pool members homed
  elsewhere are filtered out of it — and while the panel is visible the chat's
  history button hides (`historyPanelVisible` in the message contract).

Workspace-level actions: **New session here** (spawns in that folder), **Open
folder in new window**, **Clear sessions** (deletes on-disk history across all
spellings while **preserving every live session** homed there — grok re-persists
a live session's dir, so deleting it wouldn't stick), and **Remove from panel**
(forgets an added folder; never touches disk). What the panel can't show:
live blue/yellow status for sessions run by *another* VS Code window — there's
no cross-window channel; only the persisted unread badge travels.

## Plan Mode — the one part that isn't thin

Everything else mirrors the CLI. Plan Mode is enforced **client-side**, because
the CLI's `x.ai/exit_plan_mode` is unreliable: it reports "approved" to *any*
client reply — result or error — regardless of what the user actually chose. So
the extension can't trust the wire verdict. Two mechanisms cover the gap:

- **The gate** ([src/plan-gate.ts](../src/plan-gate.ts)). While Plan Mode is
  active, the two mandatory server→client choke points are policed: a
  `fs/write_text_file` resolving inside the workspace is blocked, and a
  `terminal/create` that isn't on a read-only allowlist is blocked. grok's own
  `~/.grok/sessions/<…>/plan.md` write lands *outside* the workspace, so it's
  allowed (and snooped to recover the plan text, since `exit_plan_mode` arrives
  with `planContent: null`). Entering plan mode *any* way — including the agent
  self-initiating it — raises the gate; only an explicit user action lowers it.

- **The primer** ([src/grok-primer.ts](../src/grok-primer.ts)). A hidden system
  message tells grok in plain English to ignore the bogus tool verdict and read
  the real decision from the **next** user message instead, as a bracketed
  marker: `[Plan approved]` / `[Plan rejected]` / `[Plan cancelled]` (optionally
  followed by a free-form comment). Approve → drop the gate + send "implement it
  now"; Keep planning → the gate stays up. The primer fires **eagerly and
  non-blocking** (`ensurePrimed`) — its own hidden turn, kicked off the moment a
  session goes live (new **and** restored, and after `/compact`) rather than in
  front of the user's first prompt. It returns a reused `session.primingPromise`,
  so a first send that races the background primer awaits the *same* turn and is
  released when it acks. It is *re-sent* on go-live after a restore: a primer
  buried in replayed history isn't reliably honored (a `/compact` can drop it from
  effective context), so the extension re-asserts it rather than trusting the
  replay. The silent turn is hidden by a session-level `suppressContent` flag,
  which deliberately lets `userMessage`/`agentStart` through so a racing user send
  still paints its own bubble + Grokking indicator. **Primer v4** is kept minimal
  on purpose: grok-build is agentic, and the old v3 primer's product-blurb
  paragraph + repo URL + "acknowledge briefly" line were tempting grok into a
  15–40s pre-turn exploration of the workspace before the user's message even ran
  — so v4 keeps only the plan protocol and adds an explicit *do not use tools /
  read files / search the workspace / take any action; reply with just `ok`*
  constraint. When grok replays an earlier primer as a user message on restore,
  the pure `isPrimerText()` helper detects it so the bubble is hidden and not
  counted toward plan positions — but that detection does **not** mark the session
  primed.

The full pedagogical write-up lives in
[research/understanding-plan-mode.md](../research/understanding-plan-mode.md).

## Module map

| File | Role |
|---|---|
| [src/extension.ts](../src/extension.ts) | Entry point — registers commands, keybindings, output channel |
| [src/sidebar.ts](../src/sidebar.ts) | Webview provider, message routing, fs handlers, diff preview, logout, generated-media serving (`postGeneratedMedia` → `asWebviewUri`, base64 fallback) |
| [src/acp.ts](../src/acp.ts) | ACP client — spawns CLI, manages session lifecycle, emits events |
| [src/session.ts](../src/session.ts) | Per-session state bag — one `Session` per live `grok agent stdio` process (the sidebar holds a *pool* of these + one focused); `cwd` homes each session in its workspace |
| [src/session-pool.ts](../src/session-pool.ts) | Pure reaping policy (`selectReapable`) — idle-TTL + LRU cap over the live-session pool |
| [src/workspaces.ts](../src/workspaces.ts) | Multi-workspace data layer (pure) — canonical path identity vs literal storage spellings, store-driven workspace discovery, added-workspace registry policy, merged/deduped session indexes, tree dot palette |
| [src/workspace-tree.ts](../src/workspace-tree.ts) | Grok Workspaces tree view (primary side bar) — workspace/session/load-more nodes over the sidebar's panel API + the `grok.workspaces.*` commands; visibility drives `historyPanelVisible` |
| [src/acp-dispatch.ts](../src/acp-dispatch.ts) | Pure protocol helpers — line parsing, update routing, response + generated-media extraction (`isMediaGenToolCall`/`extractGeneratedMediaPaths`) |
| [src/protocol.ts](../src/protocol.ts) | Single source of truth for the host↔webview message contract — `HostMsg`/`WebviewMsg` unions + the runtime `HOST_MESSAGE_TYPES`/`WEBVIEW_MESSAGE_TYPES` arrays (kept exhaustive by compile-time `Record` maps). Pure types + two arrays, no runtime deps |
| [src/cli-locator.ts](../src/cli-locator.ts) | Locate the `grok` binary; cross-platform |
| [src/terminal-manager.ts](../src/terminal-manager.ts) | Headless shells for the agent's `terminal/*` calls |
| [src/plan-gate.ts](../src/plan-gate.ts) | Plan-mode policy (pure) — workspace-write containment + read-only command allowlist |
| [src/plan-restore.ts](../src/plan-restore.ts) | Plan persist + restore decision (pure) |
| [src/grok-primer.ts](../src/grok-primer.ts) | The hidden primer text + replay-detection helper (pure) |
| [src/chips.ts](../src/chips.ts) | File-chip CRUD (pure) |
| [src/prompt-builder.ts](../src/prompt-builder.ts) | Chip → prompt-string with `@path` refs and fenced blocks (pure) |
| [src/slash-filter.ts](../src/slash-filter.ts) | Slash-command autocomplete filter + `matchSlashCommand` dispatch gate + hidden-command filter (`filterAdvertisedCommands` drops the config-mutating `/always-approve`) (pure) |
| [src/grok-config.ts](../src/grok-config.ts) | Reads grok's `config.toml` to detect `permission_mode = "always-approve"` so the mode button shows Auto accept (pure) |
| [src/mode-prefs.ts](../src/mode-prefs.ts) | Remembered-mode policy (pure) — persist Agent/Auto-accept (never Plan), apply on new sessions only |
| [src/view-move.ts](../src/view-move.ts) | View placement (pure) — maps the gear-menu "Move view" destinations to the extension-owned per-location view containers targeted via `vscode.moveViews` (view default-homes in the Secondary Side Bar) |
| [src/sessions.ts](../src/sessions.ts) | Disk-driven session listing/delete + name overrides (pure) — `indexSessions` (stat-only ordering), `readSessionEntries` (windowed read), `listSessions` (whole-list), `clearSessions` (multi-keep via `exceptIds`) |
| [src/file-ref.ts](../src/file-ref.ts) | Open-file ref parsing + large-file inline-read guard (pure) |
| [src/plan-review.ts](../src/plan-review.ts) | Plan-snapshot Markdown filename generation (pure) |
| [src/voice.ts](../src/voice.ts) | Voice-input pure helpers — STT request/response, ffmpeg args, device parsing, key resolution |
| [src/voice-recorder.ts](../src/voice-recorder.ts) | Batch capture (`ffmpeg` → WAV) + STT REST upload |
| [src/voice-streamer.ts](../src/voice-streamer.ts) | Live capture (ffmpeg PCM → WebSocket STT) |
| [src/telemetry.ts](../src/telemetry.ts) | Anonymous Aptabase telemetry — pure payload builders + a fire-and-forget `session_start` (opt-out via `grok.telemetry.enabled`; see [privacy.md](privacy.md)) |
| [media/chat.{js,css}](../media/) | Webview UI |
| [media/webview-helpers.js](../media/webview-helpers.js) | Pure webview helpers (file-ref detection, relative-time, mic-button state machine, trailing send-phrase highlight, math extraction `splitMath`/`stripUnsupportedTex`, and the deferred subagent classifier `isSubagentToolCall`/`subagentLabel`) — shared between webview and tests |

## History at scale

The history dropdown lists every session the CLI saved for this workspace, and that
store can grow into the thousands. The old path read and `JSON.parse`d *every*
`summary.json` on every open, then rendered every row — linear cost that stalled the
popover at scale. It now loads **one page at a time** (`SESSION_PAGE_SIZE = 100`,
newest-first), built from two pure primitives in
[src/sessions.ts](../src/sessions.ts):

- `indexSessions` does **one `stat` per session dir, no reads** — it orders every id
  newest-first by `summary.json` **mtime**. mtime is the cheap last-activity proxy:
  grok rewrites that file (it holds `updated_at`) on every turn. We sort by mtime
  *because the id is a UUIDv7 whose timestamp is creation, not last activity* — an
  id-sort would order by when the session was first opened, which is wrong.
- `readSessionEntries` reads + parses `summary.json` for **exactly the visible page's
  ids** and applies name overrides.

The host (`postSessionsList` in [src/sidebar.ts](../src/sidebar.ts)) orders everything
cheaply with `indexSessions`, then drives an **mtime-keyed read cache** so a re-open /
load-more / search only re-reads entries whose `summary.json` actually changed —
steady-state opens cost ~zero reads. **Search is server-side and complete**: a query
warms the whole catalog once (cache-backed) and filters by display name across *all*
sessions, not just the loaded page. One wrinkle the disk scan can't cover on its own:
a *brand-new* session has no `summary.json` yet, so opening history the instant a
session goes live would drop the active row until grok flushes the file. The host fixes
that by synthesizing a top-pinned row from in-memory state for any live session not yet
on disk (first, unfiltered page only — those ids can't appear on a later page). The
webview appends pages on scroll-near-bottom (de-duped by id, one request per boundary)
and debounces the search box. An opt-in
perf simulation ([test/sessions.perf.ts](../test/sessions.perf.ts) via
`npm run test:perf`, kept out of `npm test`/CI) asserts the op counts at N=5000: first
open drops reads 5000→100 (~98%), steady-state re-open is 0 reads, search warms once
then 0. **Clear all** remains the relief valve for an overgrown store; pagination is
the steady-state fix.

## Design choices worth knowing

- **Pure modules split for testability.** Everything tagged "(pure)" above has no
  `vscode` import, no process spawn, no network — it runs under Vitest in a plain
  Node process. That's *why* the bulk of protocol behavior can be regression-
  tested without launching VS Code or the `grok` binary. See
  [TESTS.md](../TESTS.md).
- **Auto accept (YOLO) is client-side only.** A single `autoApprove` flag —
  toggling Agent ↔ Auto accept doesn't restart the CLI or even send a message.
  When the CLI raises a permission request, the extension just answers "allow
  always" automatically.
- **Cross-platform without per-OS branches.** `terminal-manager.ts` uses
  `spawn(cmd, { shell: true })` so Node picks `cmd.exe` or `/bin/sh`;
  `cli-locator.ts` prefers `HOME`/`USERPROFILE` env over `os.homedir()` so tests
  can override paths.
- **Streaming is rAF-coalesced.** Message and thought chunks buffer into a raw
  string and re-render at most once per animation frame — long responses stay
  smooth under fast chunk rates.
- **`available_commands_update` drives slash autocomplete.** No hardcoded command
  list; the CLI tells the extension what's available, so plugin/skill installs
  surface immediately.
- **Model switching is agent-aware.** Models belong to *agent types*
  (`grok-build`/`grok-build-plan` vs. the `cursor` agent that owns the Composer
  models). The CLI binds the agent when the process spawns and locks it after the
  first turn (including our primer), so a live `session/set_model` only works
  *within* the same agent — a cross-agent switch errors
  `MODEL_SWITCH_INCOMPATIBLE_AGENT`. So `switchModel` tries the live switch and,
  on that specific error (`isIncompatibleAgentError` in
  [src/acp-dispatch.ts](../src/acp-dispatch.ts)), persists the pick to
  `grok.defaultModel` and restarts — `newSession` re-applies the model *before* the
  primer runs, while the agent is still rebindable. No history → transparent
  restart; with history → the same Summarize / Just-Restart choice as an effort
  change. A restart on a *primer-only* session (no real conversation — common when
  you flip models/effort right after opening) takes the no-prompt path **and**
  discards the abandoned grok session dir afterward, so repeated switches don't pile
  up identical empty sessions in history; the pure `carrySessionName` moves any user
  rename onto the fresh session so the chosen name survives. The same cleanup runs on
  the effort-change empty-session branch, guarded so a dead client on a session *with*
  history keeps its history.
- **Empty primer sessions never accumulate (#24).** Beyond the model/effort restart
  case above, *any* time you leave an empty (primer-only, `hasHistory === false`)
  session — New Session or switching to another — `parkFocused` deletes its on-disk
  dir, so at most one untitled **New session** exists at a time. A one-shot startup
  sweep (`sweepEmptyPrimerSessions`) clears empties left by earlier runs, each
  confirmed by reading `chat_history.jsonl` (`isEmptyPrimerSession`): swept only if
  the session received our primer and **zero real user queries**. Detection is
  content-based and agent-agnostic — `extractUserQueries` counts both
  `<user_query>`-wrapped prompts and the unwrapped ones grok/composer sends for slash
  commands — so it's safe for the `grok-build` and `cursor` (composer) agents alike.
- **Generated media is path-based, not an ACP image block.** `/imagine` and
  `/imagine-video` write a file into the session dir and report its *path* as
  JSON-in-text on the completed tool result. The host parses the path, classifies
  image-vs-video by extension, and serves it to the webview via `asWebviewUri`
  (streamed from disk) so even a multi-MB video renders. See
  [research/image-generation.md](../research/image-generation.md).
- **Math renders via vendored MathJax (SVG), extracted before HTML-escaping.** Grok
  answers with TeX (inline `\(…\)`, display `\[…\]`, `\begin{pmatrix}` matrices).
  The pure `splitMath` pulls math spans out *before* the markdown pass escapes
  HTML — so backslashes and braces survive into placeholders, mirroring the
  code-block/table extraction — and `renderMath` in `chat.js` renders each span
  with [MathJax](https://www.mathjax.org) (`media/mathjax/tex-svg-full.js`, a
  self-contained ~2.3 MB IIFE, no network) via `MathJax.tex2svg` (synchronous once
  startup resolves; raw-TeX fallback + an `upgradeMathInDom` pass until then).
  `enableAssistiveMml:false` stops a hidden MathML copy from rendering as a visible
  duplicate, and we supply `mjx-container[display="true"]{display:block}` ourselves
  since manual `tex2svg` skips MathJax's injected stylesheet. Single `$…$` is
  deliberately not a delimiter — it false-matches prose currency. *(v1.4.7 replaced
  KaTeX with MathJax, mainly so every equation is an exportable self-contained SVG.)*
- **Display math + Mermaid diagrams export to PNG/SVG.** Both end up as a
  self-contained `<svg>` in an export host (`.math-export` / `.mermaid-block`)
  carrying the source. A hover overlay (delegated `.expr-btn` handler, mirroring the
  generated-image `buildMediaActions`) offers Copy (the source), Download, and Open.
  Download quick-picks a **PNG** (canvas-rasterized with the VS Code theme
  background — WYSIWYG) or a **transparent SVG** for a dark/light background (math
  recolors `currentColor`; mermaid re-renders per theme via a `%%{init}%%`
  directive). The host (`sidebar.ts exportExpr`) runs the quick-pick + save dialog;
  Open writes the PNG to `globalStorageUri/exports/` and previews it.
- **Mermaid renders async, as a post-pass over the inserted DOM.** Grok answers
  with ` ```mermaid ` fences (flowcharts, sequence/state diagrams, git graphs, …).
  Unlike the synchronous math render, `mermaid.render` is async and needs
  the live DOM (it measures text to lay out nodes), so `renderMarkdown` only turns
  the fence into a `.mermaid-block` placeholder (carrying the source as a readable
  fallback code block) and `renderMermaidIn` in `chat.js` swaps in the SVG
  afterward via vendored [Mermaid](https://mermaid.js.org) (`media/mermaid/`, a
  self-contained ~3.3 MB IIFE, no network). The streaming agent bubble rebuilds
  its DOM every animation frame, so two source-keyed module caches make that
  flicker-free: `mermaidSvgCache` re-applies a rendered SVG synchronously on a
  cache hit, and `mermaidInFlight` stops a diagram being laid out repeatedly before
  its first render resolves. Themed to VS Code dark/light; `securityLevel:"strict"`;
  malformed/half-streamed diagrams keep the readable source. No CSP change (the lib
  has no `eval`/`new Function`; its inline styles are covered by `style-src`).
