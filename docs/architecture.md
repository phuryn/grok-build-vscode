# Architecture

How the Grok Build VS Code and desktop clients are put together, and the places
they deliberately stop being "thin." For day-to-day usage see the
[README](../README.md); for the test layers see [TESTS.md](../TESTS.md).

## The thin-client boundary

The host is a UI shell over either `grok agent stdio` or the pinned
`@agentclientprotocol/codex-acp` adapter. It speaks JSON-RPC over the
[Agent Client Protocol (ACP)](https://agentclientprotocol.com) on the selected
backend's stdin/stdout and renders one internal event vocabulary. Conversation
state remains in the selected CLI; provider identity and presentation state live
in the host.

| Lives in the CLI | Lives in the extension |
|---|---|
| Provider-owned conversation history and memory | Chips list (active editor + drag-added files) |
| MCP servers, subagents, plugins | Provider connection/model caches and immutable per-session provider metadata |
| Tool execution and model state | Grok auto-approval and client Plan gate; Codex permission presentation |
| Grok plan text on disk (`~/.grok/sessions/<…>/plan.md`) | Webview UI state, popovers, slash filter, pending diff per `toolCallId` |

Kill the host and its backend child dies with it; kill the backend and the host
surfaces an error and offers a fresh session. Restarting the session (the **+**
button) kills that child and spawns the same provider again; persisted provider
history survives.

## Message flow

```
webview / browser
       │ additive HostMsg/WebviewMsg (session.provider, providerState, models)
       ▼
sidebar host ──► AcpClient ──► GrokBackend   ──► grok agent stdio
                         ├────► CodexBackend  ──► node codex-acp (CODEX_PATH=codex)
                         └────► ClaudeBackend ──► node claude-agent-acp
                                                   (CLAUDE_CODE_EXECUTABLE=claude)
       ▲                         │
       └── established internal events ◄── Codex wire normalization
```

Grok supplies the mandatory `fs/*` and `terminal/*` callbacks, native
`x.ai/exit_plan_mode` / `x.ai/ask_user_question`, and its private notification
rail. Codex executes commands and edits server-side; its adapter sends ordinary
tool/diff updates and `session/request_permission`, including plan review.

`initialize` uses `acpClientCapabilities(provider, grokVersion, versionVerified)`:
only a live-verified grok >= 1.0.4 withholds `readTextFile` so the CLI's
image-aware `read_file` runs (#79). Measured 1.0.4+ builds treat client fs as
all-or-nothing, so that also stops write delegation. 0.2.x, 1.0.0–1.0.3,
Codex, an unreadable version, and a cache/unverified banner keep
`readTextFile: true`. The handlers still exist (`fs/read_text_file`,
`fs/write_text_file`, `terminal/{create,output,wait_for_exit,kill,release}`);
`terminal` is a separate capability.

`AcpClient` has a provider seam at the wire's divergence points. The default
`grokBackend` is an identity adapter. `CodexBackend` and `ClaudeBackend` spawn
the pinned `@agentclientprotocol/*-acp` entry points under Node with
`ELECTRON_RUN_AS_NODE=1` and the user's own CLI path (`CODEX_PATH` /
`CLAUDE_CODE_EXECUTABLE`). Claude's adapter is unbundled ESM, so the vsix also
packs its JS deps and never the optional native SDK binaries. Both adapters
normalize models, config options, usage, titles, and `session/list` into the
existing host shapes. Plan enforcement stays in the adapter/CLI, so the Grok
terminal/fs Plan gate is off for those providers. Claude authentication stays
in Anthropic's own `claude` CLI — this host never implements, proxies, holds,
or forwards Claude credentials.

Connection is explicit and binary-aware. `grok.providerConnections` records the
user choice; a located binary alone never connects Codex. `grok.providerModelCache`
holds each provider's last advertised model list, and `grok.projectProviderDefaults`
holds the last provider/model for each normalized project path. These exact keys
are used by VS Code globalState and the desktop `globalState.json` memento. An
empty cached `modelId` means “use that provider's default,” not “no selection.”
On Codex connect, a short-lived adapter creates a session in a temporary scratch
cwd, stores the advertised models, deletes that throwaway session through ACP,
and disposes; a failure is logged and does not fail the connection.

If no Codex binary is found, onboarding can install the pinned official
`rust-v0.147.0` standalone package into versioned global storage. The download is
streamed to a sibling staging file, SHA-256 verified before decompression, unpacked
with the dependency-free tar reader (preserving regular-file mode bits on POSIX),
then renamed into place atomically. Discovery
checks this managed package last, so a configured path, PATH command, or ChatGPT
extension bundle always wins. Every sidebar discovery, including session start,
uses the same class-owned locator inputs. Progress and cancellation stay host-local.

The new-session picker groups cached models from all connected providers, Grok
first. Choosing a model chooses the backend and persists it in the session's
`grok.sessionMeta` override; absent metadata means Grok for older installations.
An empty conversation may switch providers through the same discard-and-restart
path on the desk and remotely. After the first user turn the provider is immutable,
and the picker is provider-local; the host also infers the owner of a cached model
from older provider-blind clients and rejects a cross-provider live pick with a
targeted notice before it reaches an adapter. The additive `provider` field travels
in session/history frames through `HostMsg` to the shared webview and browser client.
Every remote snapshot also carries the relay-safe `providerState` frame
(`id` + `connected`, plus host-probed CLI/adapter version facts when known). The inline, `currentColor` provider marks appear only
when more than one provider is connected. In mixed-provider history and rail rows
the status dot overlays the mark; single-provider and old-host rows retain the
standalone dot structure.

The shared `media/chat.js` gear opens with **Use this app for**, then Remote
Control (desk only; Continue remotely + Your account, or Sign in / How it works —
unlink is Settings → Account only), then a single **Settings** entry. Versions,
CLI update, bug/feature tracker links, contact, and the non-affiliation
disclaimer live in Settings → About. Provider account rows appear on the desk gear only when no
provider is connected or one needs login; healthy connected accounts live in
Settings → Providers. The browser receives view-only connection state and
renders no account-management controls in the gear. Desk account actions
reuse the sidebar's provider login/logout messages. The exhaustive inbound policy
classifies `logout`, `runGrokLogin`, and the durable `recheckConnection` as
host-local, so a modified remote cannot clear credentials, connect an account, or
open a login terminal on the desk. A remote `retryProviderSession` may only restart
an already-connected provider; signed-out remote onboarding shows desk guidance
without dead action buttons. Login remains visible in a terminal. Its action starts
a bounded credential re-probe, and Re-check bypasses the history freshness clock;
Codex probes use `isCodexCredentialError`, so an uncoded `Sign in required` result
sets `needsLogin` and a later success clears it. Grok uses the same observable
re-probe lifecycle. Codex logout runs as an observed one-shot process and clears connection state only after exit success
(an unspawnable process is opened in a terminal while state remains connected).
After a successful sign-out, the provider is disconnected in memory and every
matching focused, background, active-remote, or detached-tab session is
synchronously detached before the memento write or replacement startup can
stall. Every queued draft with a conversation id is written to that conversation's
`grok.sessionMeta` at capture time. Focused and active-remote drafts return to
replacement composers only after replacement startup succeeds; failed starts leave
both META and the in-memory stranded copy intact. Background drafts get a named
transient desk notice, including start races that do not yet have an id. Detached
tabs keep an inert replacement and the META-backed draft, but deliberately miss
both transient notices and composer restore frames while disconnected. Every
same-provider, other-provider, and needs-provider reattachment restores and only
then clears META once the composer is live. Draft-bearing and `needsProvider`
sessions are protected from parking, release, empty sweeps, and TTL/LRU reaping;
provider retargeting scans detached logical tabs as well as attached sessions.
The local replacement uses the focused session's still-authorized cwd rather
than the project currently browsed in history. A rejected memento write is
reported but cannot make the old clients reachable again. A crashed or
clientless focused session on the other provider is untouched.
The desktop has no Codex-path settings row. Its JSON config store still reads
`grok.codexCliPath`, and VS Code keeps the contributed setting, so file/settings
overrides continue to participate in discovery without renderer plumbing.

Settings live in one shared surface ([media/settings.js](../media/settings.js)): a view over existing prefs and actions, plus the voice send-phrase / dictionary setters (`setVoiceSendPhrase` / `setVoiceKeyterms`, classified `propose` so a phone can edit them). Desktop and the remote browser open it as a full-window overlay from gear → **Settings**. The overlay traps Tab, marks covered siblings `inert`, and restores the opener on Escape or the top-left **← Back to app** link (above search; inside the trap). VS Code opens the same component in an editor-area webview tab (`grok.settings`, also a view/title gear on `grok.chat`) and has no Back link — the tab closes natively. Categories are General (purpose + chat display + telemetry), Voice, Notifications, Providers, MCP servers, Account, Advanced, About — each nav row is icon + label. The MCP page requests `grok mcp list --json` through the host, renders structured rows, and persists enable/disable with headless `grok mcp enable|disable`; those changes are explicitly global. Both outbound actions and inbound catalog data are host-local, so a remote browser never sees the page or mutates desk configuration. About is last and is the only place the non-affiliation disclaimer appears. Restore defaults only resets toggles/selects/sliders (`restoreChanges` — never free-text or list inputs such as the send phrase or dictionary), hides the button when nothing on the page would change, and expands an in-surface confirm that lists the rows and target values before acting. The tab snapshots on open and posts the same `set*` / `open*` messages, so a change cannot be lost or desync the sidebar. Host-local Advanced rows stay hidden on remote; Providers and Account render as read-only desk connection state plus a device-manager link. Telemetry is a desktop toggle, a VS Code settings-opener, and a remote read-only row using the privacy.md claims.

The `postMessage` half (host↔webview) is a **typed contract**: [src/protocol.ts](../src/protocol.ts)
is the single source of truth — `HostMsg` (host→webview) and `WebviewMsg` (webview→host)
discriminated unions. The host types `post`/`emit` against `HostMsg`, and a test asserts the
webview's mirror of the type list ([media/webview-helpers.js](../media/webview-helpers.js)) stays
in sync and that `chat.js` handles every host type — closing the "post one shape, handle another"
gap the untyped `any` direction used to leave open around restore, pagination, and media.

## How a session starts

When the panel opens (or you click **+** for a new session):

1. Resolve the selected provider. Grok uses `grok.cliPath` → `~/.grok/bin/grok`
   → PATH. Codex uses `grok.codexCliPath` → PATH → the newest matching OpenAI
   ChatGPT extension bundle → the versioned extension-managed package.
2. Spawn `grok agent stdio`, or Node with the packaged Codex ACP entry point and
   `CODEX_PATH` set to the located Codex binary.
3. Run `initialize` → `session/new` (or `session/load` to resume). Grok keeps its
   existing `session/set_model` lifecycle; Codex configures model, effort, and
   mode through `session/set_config_option`.
4. Normalize backend updates at the host boundary and stream the established
   message, thought, tool, permission, model, and usage events into the chat.

The composer unlocks as soon as the session is live. Its placeholder follows the
session provider (**Ask Grok…** / **Ask GPT…**). While a user turn is waiting, the
same animated activity row says **Grokking…** for Grok or **Opening AI…** for
Codex, then is replaced in place by the first thought / message / tool card.

### One stdout chunk is dispatched synchronously — state raised after an `await` is too late

`readline` emits a `line` event for **every** line in a chunk before the write
returns, so two ACP messages that arrive together are handled in the same
synchronous turn. Anything a handler sets *after* awaiting a response is
therefore **not** in force when the next line is processed.

This is not theoretical. It is how a `terminal/create` arriving in the same chunk
as a `session/set_mode` success ran `rm -rf` with Plan mode's gate still down:
the gate was raised after the await, one event-loop turn too late. The fix, and
the pattern to copy, is the `onResolve` hook on `AcpClient.request(...)` — it
runs **inside** `onLine`, after a successful response and before the promise
resolves, so state committed there is visible to the very next line. See
[Plan Mode](#plan-mode--provider-owned-review-grok-client-safety-gate).

Whenever a decision depends on state a response is *about* to establish, commit
it in that hook, not after the `await`. Tests must drive real line dispatch — a
single `stdout.write` carrying both JSON lines — because a test that
hand-sequences the two events cannot fail the way production does. Three review
rounds missed this precisely because the tests sequenced by hand.

### Session starts are serialized, and an abandoned send says so

`startSession` bumps `session.gen`, and `handleSend` checks that generation
after it has already emitted `userMessage`. A concurrent start therefore used to
strand a send: the echo painted a bubble, any client reasonably read it as
acceptance, and the guard then returned with no `agentEnd` and no `agentError`,
so no reply ever came and nothing retried. Remote clients drop their retry record
on that echo, so this was silent work loss.

Two rules now hold:

- **A post-echo bail reports itself.** `emitAbandonedSend` emits a generic
  `error` (`INTERRUPTED_SEND_TEXT` + additive `code: "interrupted-send"`),
  not `agentError` — after the generation bump this `Session` *is* the
  replacement, and `agentError` would clear its startup lock or a flushed
  follow-on turn. Cancel recovery emits its own `agentError` first and sets
  `staleSendReported`, so an abandoned send is never double-reported.
- **Starts do not interleave with a live turn.** `runExclusiveSessionStart`
  serializes starts per `Session`, and `handleSend` waits for that tail before
  committing. `decideSessionStart` takes an intent: opportunistic callers —
  desktop boot, `client-ready`, non-live `resumeSession` — pass `"ensure"`,
  which refuses while a turn is in flight, reuses a matching ready client, and
  never bumps `gen` over a live send. Deliberate restarts (cancel recovery, auth
  recovery, model/effort changes) pass `"replace"`.

The generation guard itself is correct and stays; the bug was the silent return.
Note that an already-echoed send **cannot** be transparently replayed — the echo
is in the session buffer, so a client-side retry duplicates the prompt. Visible
and recoverable is the correct terminal outcome for that interleaving; it is not
a substitute for delivering work queued while the host was down, which still
arrives.

## The session pool (Agent Dashboard)

The sidebar shows one conversation at a time, but it keeps a **pool of live
sessions** behind it — one spawned backend process each, with exactly
one *focused* (the one you see). All the per-session state lives in a
[`Session`](../src/session.ts) object; the sidebar holds `focused` plus a `Set` of
every live `Session` (`pool`). The point is **lossless re-focus**: a backgrounded
session keeps streaming into its own *view buffer* (every webview post that built
its chat, in order), so re-focusing it is a `clearMessages` + replay of that
buffer — no backend reload, no process kill, even mid-turn or mid-approval.

Switching focus (`focusSession`) never touches the backend: it swaps `this.focused`,
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
permission / question / plan review), **green** *finished while no view was
watching*, **red** *errored while no view was watching*.

The green/red dot is a **globally unseen-completion badge**, not a per-tab read
receipt or a live state. The persisted schema has one `unread` flag per conversation,
so it cannot represent “read in tab B but unread in tab A.” The deliberate rule is:
set the flag only when a turn ends while neither the local VS Code view nor any
remote tab owns that session. Focusing it in either surface clears the flag. Because
the flag lives in metadata rather than the live process, the badge **survives both
the idle reaping below and a full VS Code restart** — so unattended results remain
visible when you return, without marking a result unread in the tab that watched it.
There's no timer. The actual color is a pure
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

`maybeUpdateCliOnUpgrade` retains the normal session-start trigger: once per
activation it compares `CLI_UPDATE_VERSION_KEY`, updating only after an extension
version change; a fresh install records its baseline without updating. After that,
every session start reads `grok --version` through `resolvePlanModeAvailability`
(one short retry when the first read is empty/unparseable, then the last verified
banner in `grok.cliVersionCache` when that binary's mtime/size still match). A live
parseable answer always wins over the cache. On Windows, `maybePinBrokenCli` uses the
bounded `isStdioBrokenGrokVersion` check to move 0.2.61–0.2.70 to the current
`GROK_STDIO_DOWNGRADE_TARGET` before ACP spawn. `GROK_REQUIRED_VERSION` is the
cross-platform ACP behavior floor and the current recovery target.
A live parseable CLI below the floor latches Plan off (`planModeVersionVerified:true`);
an unreadable probe with no matching cache also sets `planModeAvailable:false` but
stays re-checkable — the picker keeps Plan clickable
(`planModeAvailability.recheckable`) and `setMode` re-probes via
`recheckPlanModeAvailability` instead of forcing a restart. A cache substitute
keeps that availability but is never verified, so a stale below-floor banner
stays re-checkable and a later live probe replaces the stand-in. A live
verified-old CLI still hard-disables the Plan row and rejects forged Plan requests. Agent-initiated and restored Plan transitions raise the client safety gate.
A live untrusted planning turn is cancelled, and the gate stays raised until both
that `session/prompt` settles and `session/set_mode(default)` confirms Agent; a
failure or stalled recovery stays gated and is surfaced explicitly.
Any stray `exit_plan_mode` request is answered with an error rather than entering the
native-verdict flow that this version floor exists to protect.
Availability is session-scoped so a later successful update re-enables Plan only for
newly started compatible processes, never for an older process that is still alive.
Reactive Windows stdio recovery remains a separate single-retry backstop after an
observed startup failure.

## Plan Mode — provider-owned review, Grok client safety gate

Grok owns plan-review continuation. The extension responds to
`_x.ai/exit_plan_mode` with its native success result: `approved`, `cancelled`
(Keep planning), or `abandoned` (Cancel). Approval continues into implementation
inside the original turn; cancellation stays in Plan and lets grok revise and
re-ask inside that same turn; abandon switches the CLI to its default mode and
ends the turn without a continuation. There is no synthetic verdict prompt, turn
cancel, or synthetic lifecycle.

- **The gate** ([src/plan-gate.ts](../src/plan-gate.ts)). While Plan Mode is
  active, `terminal/create` that isn't on a read-only allowlist is blocked —
  that hook is load-bearing because the CLI still hands mutating shells to the
  client. On grok 1.x, Plan-mode file safety rests on grok's native edit
  refusal (writes are not delegated). The `fs/write_text_file` workspace block
  stays in the handler for 0.2.x (still delegated) and for a later CLI that
  honours `writeTextFile` independently. Plan review is fed by `req.plan`
  (`exit_plan_mode.planContent` arrives populated on 1.x; 0.2.117 still sends
  `null`); the plan.md snoop is a fallback. Entering plan mode *any* way —
  including the agent self-initiating it — raises the gate; only an explicit
  user action lowers it. A grok user Plan pick commits `planActive` in the
  `session/set_mode` response hook — after a successful reply, before the next
  ACP line — so a same-chunk `terminal/create` or `session/request_permission`
  still sees the gate. A rejected transition keeps the previous badge and gate.

- **Verdict state and comments.** `handleExitPlan` settles all implementation-
  relevant state *before* releasing the blocked response. Approval restores the
  remembered pre-plan Auto accept choice and lowers the gate; Keep planning keeps
  the gate raised; Cancel lowers it but deliberately lands on Agent. An
  Approve/Keep-planning comment is sent through `_x.ai/interject` before the
  verdict response, without awaiting it inline. Clicking a verdict collapses the
  card immediately. A successful response write emits buffered `planResolved`;
  a failed write leaves the pending request unconsumed and the verdict
  unpersisted, so re-focus rebuilds an actionable card without a separate
  pending/failure message. While the interject response is outstanding, a
  memory-only `Session.inFlightPlanComments` entry owns the text. Acceptance
  removes it synchronously; a controlled restart moves only unresolved entries
  into the ordinary queue for the replacement process. A dead process drops its
  queue. Session restart clears the map, so it cannot resurrect text
  later. A write accepted by Node is never retried merely because its downstream
  effect is unknown. If the
  unadvertised RPC is unsupported or fails, the text is placed in the ordinary
  queued-send path rather than being lost. An abandon comment always uses that
  queue: the native abandoned turn has no continuation step that could drain an
  interjection, so the comment becomes a real prompt after the turn settles. A
  successful interjection emits the same `userMessage {steer:true}` shape as the
  ordinary Steer path and does not increment `Session.userMessageCount`; it has
  no prompt/rewind point, so counting it would inflate every later
  `afterUserMessage` position and make rewind discard surviving extension records.
  Plan, permission, and usage persistence share `afterHistoryEvent`, a replay-stable
  assistant/tool update boundary. It places native approvals before same-turn
  implementation output. `afterInterjection` remains the secondary compatibility
  boundary for comment/revision cycles, with array-order inference for older entries. The webview
  keeps the raw CLI envelope for classification but strips it and `<user_query>`
  from the displayed/copied comment.
  Each `Session` owns a `pendingExitPlans` map keyed by the ACP request id. The host
  registers a request only after its async snapshot generation check, and an answer
  must find that exact entry. Gate changes happen before the JSON-RPC response so
  same-turn implementation is safe, but consuming the entry and persisting the
  verdict happen only after `respondExitPlan` reports an accepted stdin write.
  Re-focus can replay the card without consuming it; stale and duplicate answers
  have no effect.

- **Legacy primer reads.** Older sessions on disk contain the retired v4 hidden
  primer and bracket-marker turns. `src/grok-primer.ts` therefore keeps only the
  version-agnostic `isPrimerText()` / `isPrimerSummary()` readers. Replay hiding,
  title repair, the empty-session sweep, and rewind/plan-position mapping continue
  to account for those historical turns. `suppressContent` / `SUPPRESS_TYPES` are
  also retained for other hidden maintenance turns; they are no longer a priming
  mechanism.

Codex and Claude plan review follow a different wire path: a normal
`session/request_permission` whose tool kind is `switch_mode` and whose
allow option means "implement this plan". The reply is still the selected
permission option. The card is not the generic permission chrome —
`planTextFromPermissionToolCall` lifts Codex `rawInput.plan` / Claude's
ExitPlanMode content block, and the webview renders grok's plan-review
shape with those adapter mode options. A `switch_mode` card that arrives
with no plan text must not collapse to an "Approved" / "Plan approved"
label. Auto accept does not select that option — `isPlanReviewPermission`
keeps `switch_mode` cards out of `autoApprovePendingPermissions` and the
incoming Auto-accept grant, so a mode flip (even one whose RPC later
fails) cannot implement an unread plan. `CodexBackend` reports
`usesClientPlanGate = false`, so none of the Grok filesystem/terminal
gate, plan-file snooping, or `x.ai/exit_plan_mode` verdict machinery is attached.
A successful Plan `session/set_config_option` still raises `client.planActive`
in the response hook so Auto accept cannot grant that review (or any other
same-chunk permission) before the host await continues. Their Plan/Agent chrome
still follows the agent's mode (`applyAgentModeToHostPlan`, plus Codex
`config_option_update`) so the button cannot stay on Plan after an approved
exit. Codex's effective mode is Plan when `collaboration_mode` is Plan
and otherwise the permission `mode` (`codexEffectiveModeId`) — collaboration
`default` is not flattened to Agent, because the adapter always reports
`agent-full-access` on that same snapshot.

The full pedagogical write-up lives in
[research/understanding-plan-mode.md](../research/understanding-plan-mode.md).

## Module map

| File | Role |
|---|---|
| [src/extension.ts](../src/extension.ts) | Entry point — registers commands, keybindings, output channel |
| [src/sidebar.ts](../src/sidebar.ts) | Webview provider, message routing, fs handlers, native diff opening, logout, generated-media serving (`postGeneratedMedia` → `asWebviewUri`, base64 fallback) |
| [src/diff-view.ts](../src/diff-view.ts) | Pure whole-file native-diff reconstruction (#66) — combines Grok's replaced regions + positioned sites with disk content, bounds expansion size, and finds the first changed line |
| [src/acp.ts](../src/acp.ts) | Provider-neutral ACP client — spawns the selected backend, manages session lifecycle, normalizes through its backend hooks, and emits the extension's established events. `interject` (#52 Steer), `forkSession` (#48), and worktree RPCs (P2-8) call the unadvertised `_x.ai/*` methods, returning `"unsupported"` on -32601 rather than throwing |
| [src/acp-backend.ts](../src/acp-backend.ts) / [src/grok-backend.ts](../src/grok-backend.ts) / [src/codex-backend.ts](../src/codex-backend.ts) / [src/claude-backend.ts](../src/claude-backend.ts) | Backend contract, Grok identity, Codex and Claude host normalization. Codex uses `session/set_config_option`; Claude maps `configOptions` into the host model picker, lists sessions with `{ cwd }`, and maps Agent/Auto-accept onto native permission modes |
| [src/codex-model-cache.ts](../src/codex-model-cache.ts) / [src/claude-model-cache.ts](../src/claude-model-cache.ts) | Short-lived connect warm-up that caches adapter models from a scratch `session/new`, deletes the temporary adapter-owned session, and cleans up the client/cwd |
| [src/provider-ui.ts](../src/provider-ui.ts) | Pure provider presentation/state policy — Grok-first model grouping, empty-model default sentinel, normalized project defaults, Codex-only listing-time freeze (`adapterActivityAt`), clear-all refresh guard (`adapterEntriesEligibleForClear`), and mixed-provider recency merge |
| [src/worktree.ts](../src/worktree.ts) | Pure worktree helpers (P2-8) — parse create/list/apply/remove/status, multi-cwd history merge; wire notes in [research/worktree.md](../research/worktree.md) |
| [src/session.ts](../src/session.ts) | Per-session state bag — one `Session` per live backend process, with immutable `provider` identity (the sidebar holds a *pool* plus one focused); carries the send queue (#37) and optional worktree binding (`cwd` / `worktree`), while cumulative billing stays solely in session-id-keyed metadata (#53) |
| [src/session-pool.ts](../src/session-pool.ts) | Pure reaping policy (`selectReapable`) — idle-TTL + LRU cap over the live-session pool |
| [src/acp-dispatch.ts](../src/acp-dispatch.ts) | Pure protocol helpers — line parsing, update routing, response + generated-media extraction, live context extraction (`contextUsedFromUpdateEnvelope`, compact notifications, `occupancyFromAdapterTurn` / `applyContextOccupancy`), billing helpers (`extractPromptUsage`/`addUsage`/`usageIsRealMeasurement`, including `costUsdTicks`), and the -32601 capability gate behind private RPCs |
| [src/protocol.ts](../src/protocol.ts) | Single source of truth for the host↔webview message contract — `HostMsg`/`WebviewMsg` unions + the runtime `HOST_MESSAGE_TYPES`/`WEBVIEW_MESSAGE_TYPES` arrays (kept exhaustive by compile-time `Record` maps). Pure types + two arrays, no runtime deps |
| [src/cli-locator.ts](../src/cli-locator.ts) / [src/cli-process.ts](../src/cli-process.ts) | Locate and invoke the `grok` binary cross-platform; one shim-aware execution policy covers ACP spawn plus version/update commands |
| [src/codex-cli-locator.ts](../src/codex-cli-locator.ts) / [src/codex-managed-installer.ts](../src/codex-managed-installer.ts) / [src/claude-cli-locator.ts](../src/claude-cli-locator.ts) | Pure, injected Codex discovery with the managed package at lowest priority; Claude discovery is PATH + `grok.claudeCliPath` + well-known user-bin locations only — no managed Anthropic installer. Windows `.cmd` shims are resolved to a native exe (`resolveClaudeSpawnTarget`) because the SDK spawn is `shell: false` |
| [src/terminal-manager.ts](../src/terminal-manager.ts) | Headless shells for the agent's `terminal/*` calls |
| [src/plan-gate.ts](../src/plan-gate.ts) | Plan-mode policy (pure) — workspace-write containment + read-only command allowlist |
| [src/plan-restore.ts](../src/plan-restore.ts) | Plan persist + restore decision (pure) |
| [src/grok-primer.ts](../src/grok-primer.ts) | Legacy primer replay/title detection helpers (pure) |
| [src/chips.ts](../src/chips.ts) | File-chip CRUD (pure) |
| [src/prompt-builder.ts](../src/prompt-builder.ts) | Chip → prompt-string with `@path` refs and fenced blocks (pure) |
| [src/slash-filter.ts](../src/slash-filter.ts) | Slash-command autocomplete filter + `matchSlashCommand` dispatch gate + hidden-command filter (`filterAdvertisedCommands` drops the config-mutating `/always-approve`) (pure) |
| [src/mention.ts](../src/mention.ts) | The composer's `@` file popover, host half (pure) — `filterMentionFiles` ranking, `buildExcludeGlob` (files.exclude + search.exclude → one findFiles exclude), `orderMentionIndex`, `clampMentionIndexLimit` (`grok.mentionIndexLimit`) and `mergeMentionEntries` (open tabs layered over the capped findFiles snapshot, #69); the webview half (`getMentionQuery`/`applyMentionPick`) lives in webview-helpers.js |
| [src/grok-config.ts](../src/grok-config.ts) | Reads grok's `config.toml` to detect `permission_mode = "always-approve"` so the mode button shows Auto accept (pure) |
| [src/mode-prefs.ts](../src/mode-prefs.ts) | Remembered-mode policy (pure) — persist Agent/Auto-accept (never Plan), apply on new sessions only |
| [src/view-move.ts](../src/view-move.ts) | View placement (pure) — the view default-homes in the Secondary Side Bar, which Cursor refuses to create. Decides the one first-run correction into the activity-bar container, and which move mechanism applies: `vscode.moveViews` names a CONTAINER (a host may render ours anywhere), the host's own picker names a LOCATION and is the only route to a dock the host draws itself |
| [src/sessions.ts](../src/sessions.ts) | Grok disk-driven session listing/delete plus provider-bearing name overrides (pure) — `indexSessions` (stat-only ordering), `readSessionEntries` (windowed read), `listSessions` (whole-list), `clearSessions`, `discoverRepos` (the repo catalog behind the remote switcher). Codex list/load/delete stays behind `AcpClient` and is shaped/merged by `provider-ui.ts` |
| [src/file-ref.ts](../src/file-ref.ts) | Open-file ref parsing + large-file inline-read guard (pure) |
| [src/file-upload.ts](../src/file-upload.ts) | Pure remote-document upload validation, owned staging-path checks, and session/fork lifetime accounting |
| [src/plan-review.ts](../src/plan-review.ts) | Plan-snapshot Markdown filename generation (pure) |
| [src/voice.ts](../src/voice.ts) | Voice-input pure helpers — STT request/response, ffmpeg args, device parsing, key resolution |
| [src/voice-recorder.ts](../src/voice-recorder.ts) | Batch capture (`ffmpeg` → WAV) + STT REST upload |
| [src/voice-streamer.ts](../src/voice-streamer.ts) | Shared live STT transport: `PcmVoiceStreamer` accepts raw PCM from any producer; `VoiceStreamer` composes it with local ffmpeg capture. Transcripts insert at the composer selection captured on start; a manual Send/Queue discards capture and invalidates late voice callbacks, while spoken `grok send` keeps listening |
| [src/telemetry.ts](../src/telemetry.ts) | Anonymous Aptabase telemetry — pure payload builders + allowlisted `session_start` snapshot (opt-out via `grok.telemetry.enabled`; see [privacy.md](privacy.md)) |
| [src/remote-policy.ts](../src/remote-policy.ts) / [src/remote-frames.ts](../src/remote-frames.ts) / [src/remote-uplink.ts](../src/remote-uplink.ts) / [src/remote-client-state.ts](../src/remote-client-state.ts) | AFK Pilot client — exhaustive protocol policy, relay frames/transport, and host-owned `clientId → {cwd, active Session, browser preferences}` tab state. `bracketRemoteSnapshot` caps reconnect and cold-load history at the last ten user messages, re-bases counter-positioned cards, and sends the transcript in one additive `historyBatch` frame inside replay brackets; cold `session/load` events remain live only on the desk until the complete remote snapshot replaces them. Chat/session UI/voice traffic uses targeted `host-to` frames; this includes speech summaries, whose inbound request fields and logical-tab TTS preferences are validated before the host spends the extra xAI call, with the result returned only to the requester. The browser speaks its retained original after a bounded wait if no result returns and ignores a late result. `client-left` removes ephemeral ownership while the live pool member remains reclaimable; only device-global state uses relay broadcast |
| [src/remote-voice.ts](../src/remote-voice.ts) / [media/pcm-worklet.js](../media/pcm-worklet.js) | Remote microphone boundary — one independent producer/stream per browser client, strict PCM chunk/duration/cumulative-byte caps, bounded buffering while that client's hands-free STT reconnects, targeted partial/state messages, and browser AudioWorklet downsampling to signed PCM16 LE / 16 kHz / mono. Send-phrase completion returns `voiceSubmit` to the owning browser, which submits through the ordinary relay-metered `send` or busy-turn queue path; STT never prompts ACP directly |
| [src/keep-awake.ts](../src/keep-awake.ts) | OS wake lock held for exactly the uplink's lifetime, so an AFK machine can't idle-suspend mid-turn. Pure plan builders per platform (`buildKeepAwakePlan`) + the `KeepAwake` runner; `grok.remote.keepAwake` is the opt-out. See [research/keep-awake.md](../research/keep-awake.md) |
| [media/chat.{js,css}](../media/) | Webview UI |
| [media/webview-helpers.js](../media/webview-helpers.js) | Pure webview helpers (file-ref detection, relative-time, mic-button state machine, trailing send-phrase highlight, math extraction `splitMath`/`stripUnsupportedTex`, and the subagent classifier `isSubagentToolCall`/`subagentLabel`) — shared between webview and tests |
| [src/desktop/config-store.ts](../src/desktop/config-store.ts) / [src/desktop/main.ts](../src/desktop/main.ts) / [src/desktop/app-update.ts](../src/desktop/app-update.ts) | Desktop configuration/state host. Dotted settings include `grok.codexCliPath`; the file memento supplies the same provider global-state keys as VS Code, and account login/logout opens the provider CLI in the native terminal. Packaged win32/darwin auto-update uses `electron-updater` against the relay generic feed; check/download failure falls back to the GitHub notice. `electron-builder.yml` explicitly includes the pinned Codex ACP package |

## History at scale

The history dropdown is one recency-sorted view across every connected provider.
Grok's store can grow into the thousands. Its old path read and `JSON.parse`d *every*
`summary.json` on every open, then rendered every row — linear cost that stalled the
popover at scale. It now loads **one page at a time** (`SESSION_PAGE_SIZE = 100`,
newest-first), built from two pure primitives in
[src/sessions.ts](../src/sessions.ts):

- `indexSessions` does **one `stat` per session dir, no reads** — it orders every id
  newest-first by `events.jsonl` **mtime** (falling back to `summary.json` before a
  transcript exists). The transcript mtime ignores `session/load` restamps. We sort by mtime
  *because the id is a UUIDv7 whose timestamp is creation, not last activity* — an
  id-sort would order by when the session was first opened, which is wrong.
- `readSessionEntries` reads + parses `summary.json` for **exactly the visible page's
  ids** and applies name overrides.

The combined `buildSessionsList` authorizes cwd before scheduling either
provider, so a stale remote project cannot spawn an adapter or mutate a Codex
cache. Codex history is listed from a lazily spawned adapter client without a `cwd`
argument, paginated to the terminal cursor with loop guards, then filtered by
resolved path on the host (case-insensitive on Windows). Per-project cache and
refresh keys use the same `normalizeWorkspaceFsPath` machinery, so adapter cwd
casing drift cannot create a second cache bucket on Windows. Codex rows keep a
host-owned activity clock after first discovery because the adapter restamps
`updatedAt` on load: opening never advances it, send advances it optimistically,
and turn end reasserts/rechecks the provider lists. The cache holds the complete
Codex listing. `provider-ui.ts` treats Grok pagination as a black box: each mixed
request consumes exactly one ordinary Grok page (including hidden-row slot
consumption and its within-page exact sort), then merges every not-yet-emitted
Codex row at-or-newer than that page's oldest visible Grok timestamp. Once Grok is
exhausted, the Codex suffix continues in pages bounded by the requested `limit`.
The wire cursor carries Grok's untouched
`nextOffset` plus a Codex `{updatedAt,id}` high-water mark; there is no combined
slot arithmetic or look-ahead. Only search may warm the full Grok catalog. Both
fresh and paged final merges collapse rows by globally
unique session id; provider, cwd, and display name are never identity keys. Cold Codex rows in
rename/delete and Pinned are proven through this adapter-backed cache rather
than Grok's disk catalog, without bypassing repository containment or live-owner
checks. Codex delete calls the
adapter capability and reports refusal rather than hiding a session locally.
Provider metadata still resolves an older Grok row with no explicit field to Grok,
but it does not permit two rows with the same global session id.

History is scoped to the **selected repo**. `discoverRepos` enumerates cwd catalogs from
`<grokHome>/sessions` (rejecting temp roots and `<grokHome>/worktrees` — a worktree is
not a checkout you choose between; the one carve-out is `trustedCwds`, the folder VS Code
actually has open, because the selection must always name a catalog row or `clearAllSessions`
silently no-ops). `postSessionsList` indexes that repo *plus* the worktrees belonging to it
(`worktreeCwdsForRepo`, pure), so a worktree session stays reachable after you leave it.
The primary workspace and remote-selected repos use the same parent match:
`sourceGitRoot` holds the CLI's *git root* rather than necessarily the opened folder, so
an opened subdirectory may sit inside that root. The reverse does not match because it
can be an independent nested checkout; missing parent metadata is also excluded rather
than granting destructive access to an ambiguous worktree catalog. The
picker itself is a remote-only affordance: in VS Code the window already *is* the
repository. And because the relay serves a client that can be newer than the installed
extension, the chip renders only once a `repos` frame has actually arrived — an older
host that never sends one gets no chip rather than a dead control.

At desktop width that picker becomes a **projects rail**, which is the same
capability-gated affordance in another shape: `#projects-rail` exists only in the
relay's page, so the element lookup is the entire gate and the VS Code webview renders
nothing new. Other projects' rows arrive on `repoSessions` (answering `listRepoSessions`);
where that frame never comes the rail degrades to the selected repo's own list. A
session's visual section is resolved in precedence order (Pinned, an expanded
Recent section, then project/archive) with one claimed-id set across the final render;
the same id therefore cannot appear in two rail groups. Click and highlight state is
also keyed by id, so two distinct sessions with the same display name remain independent.
Which
section a project sits in — Projects or Archived — is **derived in the client**, never a
stored section: `setRepoArchived` records one timestamped choice per repo in
`grok.repoArchives`, reported back on every catalog row as `archived`/`archivedAt`, and a
project counts as archived when that choice outranks its newest conversation or when
nothing has happened in it for thirty days. Activity newer than the choice simply
overrides it, which is what makes "work in an archived project and it returns" need no
bookkeeping. The age rule runs only on conversations the client actually holds — the
catalog's `updatedAt` is the session *directory's* mtime, which does not move when an
existing conversation continues, so trusting it against an older host would archive a
project in daily use. Ordering and the VS Code repo picker are untouched by any of it.

Selection and conversation ownership are **per remote browser tab**.
`RemoteClientState` maps the current opaque relay `clientId` to its normalized cwd and
active remote `Session`, while a high-entropy logical-tab token in `sessionStorage`
survives replacement relay connections. Presenting the same token atomically transfers
the mapping and marks the old socket stale; a different token cannot take it. Selecting
in tab A targets only A with a cwd-specific
snapshot; tab B can select the same cwd while retaining a different process, transcript,
session-list `activeId`, mode/chips/queue state, and voice stream. Repo history/dot
metadata can still refresh all clients viewing that cwd, but session output never fans
out by cwd. The local VS Code webview remains bound to its workspace, and every
live session created or adopted by its dashboard stays locally owned even while
backgrounded. A departed remote client's live session normally becomes ownerless and can
be reclaimed by either surface. During startup, priming or host-owned queued work keeps
the logical-tab binding across a pre-handshake `client-left`, so the same-token replacement
inherits the session and its queued prompt.

Queued remote text is metered at dequeue, not enqueue: `maybeFlushQueuedSends`
claims it with a host-issued submission id and sends `submitQueuedSend` to that browser
only after the active turn settles. The browser echoes the text and id on the ordinary
`send` path, so both relay limiters run before ACP is prompted. Reconnect snapshots
reuse the claim, and both the browser and host deduplicate its id; duplicate persisted
outbox frames therefore execute one prompt. `beginQueuedSendCommit` claims the ready
prefix and `finishQueuedSendCommit` removes it at the pre-prompt commit point, before
attachments are consumed and `session/prompt` is attempted. A quota rejection leaves a visible **Not sent**
block that can be edited or removed.

If the owning grok process exits, the host clears its pending queue and dispatch state;
queued text is not restored to the composer.

Destructive history actions follow the same ownership boundary. A delete is refused
while the target session is owned by any browser tab or by the local VS Code view, and
Clear all preserves every such session rather than only the requester's active row.
Cold `session/load` also reserves its Grok session id synchronously, before ACP can clear
and later repopulate `Session.activeSessionId`; local/remote resume, delete, and Clear all
all consult that bounded reservation. A same-token replacement joins the reservation's
in-flight operation, keeps the pending id authoritative in snapshots, and receives
completion through whichever relay client currently owns the bound `Session`; a
different logical tab remains blocked. Ownerless live pool members and unreserved cold
history remain deletable. This prevents an owner
from retaining a rendered transcript after its backing process and disk session have
been destroyed.

Relay IDs change after a network reconnect, so `media/chat.js` persists both the logical
tab token and `{repoCwd, id, cwd}` in device-scoped `sessionStorage`. Its `ready` binds
the fresh relay id before re-posting `selectRepo` + `resumeSession`; the host immediately
replaces the relay's provisional pre-token snapshot with the inherited tab state.
Same-token handoff therefore works even when replacement `ready` precedes the old
`client-left`. A session owned by another logical tab/the VS Code view is refused instead
of starting a colliding process; a missing session or unavailable repository produces a
targeted error and never silently starts blank. New, Resume, and Select-repo transitions
are serialized in arrival order per tab, while Resume additionally serializes by Grok
session id. A send waiting behind a transition is dispatched through the logical-tab token,
which resolves the current relay id only after the wait; non-`ready` state access never
implicitly recreates a departed client at the workspace cwd. Turn and mid-turn control
messages remain unlocked. `client-left` for a superseded socket cannot release the
replacement's mapping.

The host (`postSessionsList` in [src/sidebar.ts](../src/sidebar.ts)) orders everything
cheaply with `indexSessions`, then drives an **mtime-keyed read cache** so a re-open /
load-more / search only re-reads entries whose `summary.json` actually changed —
steady-state opens cost ~zero reads. **Search is server-side and complete**: a query
warms the whole catalog once (cache-backed) and filters by display name across *all*
sessions, not just the loaded page. One wrinkle the disk scan can't cover on its own:
a *brand-new* session has no `summary.json` yet, so opening history the instant a
session goes live would drop the active row until grok flushes the file. The host fixes
that by synthesizing a top-pinned row from in-memory state for any live pool session not
yet on disk **and scoped to the requested repo's cwds** (first, unfiltered page only —
those ids can't appear on a later page) — a still-focused session from a *different*
repo must not leak into the list being built for the one just selected, or it masquerades
as that repo's newest/active row and the remote auto-open shim mistakes it for an
already-open match instead of resuming or starting the right session. The
webview appends pages on scroll-near-bottom and automatically advances empty or
underfilled pages until overflow/exhaustion (de-duped by id, one request per
boundary, repeated-cursor guard). A visible Load more button backs up the
automatic path, and the empty-state label is withheld while `hasMore` is true.
The search box remains debounced. An opt-in
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
- **Cross-platform shell selection.** `terminal-manager.ts` picks the host shell
  for the agent's `terminal/*` commands via `resolveTerminalShell`: on Windows it
  runs them under PowerShell (`pwsh.exe`→`powershell.exe`→cmd.exe) to match the
  standalone grok CLI (#46 — cmd couldn't run the user's PowerShell profile
  functions or pipelines); elsewhere `shell:true` → `/bin/sh`. It also sets
  **`GROK_SHELL`** in grok's spawn env (the pure `grokShellEnvValue`) to match
  that shell, so the agent writes the correct dialect instead of guessing from its
  own host detection (§2.9). `cli-locator.ts` prefers `HOME`/`USERPROFILE` env over
  `os.homedir()` so tests can override paths.
- **Reasoning effort switches live where the CLI supports it.** Changing effort no
  longer restarts the process: `client.setReasoningEffort` sends `session/set_model`
  with `_meta.reasoningEffort` when the model advertises `supportsReasoningEffort`
  (grok 0.2.101+); the client tracks the effective effort from the `model_changed`
  notification (authoritative) and carries it through model switches (gated on the
  target model's effort menu). Older CLIs, and resetting to the model default, fall
  back to the Summarize/Restart flow.
- **Streaming is rAF-coalesced.** Message and thought chunks buffer into a raw
  string and re-render at most once per animation frame — long responses stay
  smooth under fast chunk rates.
- **`available_commands_update` drives slash autocomplete.** No hardcoded command
  list; the CLI tells the extension what's available, so plugin/skill installs
  surface immediately.
- **Model switching is agent-aware.** Models belong to *agent types*
  (`grok-build`/`grok-build-plan` vs. the `cursor` agent that owns the Composer
  models). The CLI binds the agent when the process spawns and locks it after the
  first turn, so a live `session/set_model` only works
  *within* the same agent — a cross-agent switch errors
  `MODEL_SWITCH_INCOMPATIBLE_AGENT`. So `switchModel` tries the live switch and,
  on that specific error (`isIncompatibleAgentError` in
  [src/acp-dispatch.ts](../src/acp-dispatch.ts)), persists the pick to
  `grok.defaultModel` and restarts — `newSession` re-applies the model before the
  first turn, while the agent is still rebindable. No history → transparent
  restart; with history → a Summarize / Just-Restart choice. (An **effort** change,
  by contrast, no longer restarts on recent CLIs — see the live-effort bullet
  below.) A restart on an empty session (no real conversation — common when
  you flip models/effort right after opening) takes the no-prompt path **and**
  discards the abandoned grok session dir afterward, so repeated switches don't pile
  up identical empty sessions in history; the pure `carrySessionName` moves any user
  rename onto the fresh session so the chosen name survives. The same cleanup runs on
  the effort-change empty-session branch, guarded so a dead client on a session *with*
  history keeps its history.
- **Empty sessions never accumulate (#24).** Beyond the model/effort restart
  case above, *any* time you leave an empty (`hasHistory === false`)
  session — New Session or switching to another — `parkFocused` deletes its on-disk
  dir, so at most one untitled **New session** exists at a time. `sweepEmptySessions`
  covers what parking cannot reach — a window closed without a prompt, a host that
  crashed — and runs on activation and after every new/opened session, in that
  session's repo. Each candidate is confirmed by reading `chat_history.jsonl`
  (`isEmptySession`): swept on **zero real user queries** in a history that
  `historyIsIntelligible` could actually parse — an unparseable file is not an empty
  conversation, and that interlock is what keeps a CLI format change from making
  every session look sweepable. Covers both today's sessions and the legacy
  primer-only ones. Live, being-loaded, renamed, pinned, worktree-bound and subagent
  sessions are excluded, as is anything newer than `SWEEP_MIN_AGE_MS` (30 min) —
  parking owns the recent ones, and another VS Code window's live sessions are
  invisible to this process. Detection is
  content-based and agent-agnostic — `extractUserQueries` counts both
  `<user_query>`-wrapped prompts and the unwrapped ones grok/composer sends for slash
  commands — so it's safe for the `grok-build` and `cursor` (composer) agents alike.
- **Generated media is path-based, not an ACP image block.** `/imagine` and
  `/imagine-video` write a file into the session dir and report its *path* as
  JSON-in-text on the completed tool result. The host parses the path, classifies
  image-vs-video by extension, and serves it to the webview via `asWebviewUri`
  (streamed from disk) so even a multi-MB video renders. A host-local
  `showInFolder` action replaces the open action for BOTH generated images and
  videos on a host that advertises the capability (the desktop app, whose media
  handler it owns), and reuses the same path authorization as `openFile`. An
  editor host keeps `openFile` — a tab is somewhere new to put the file, whereas
  the desktop already plays clips inline and enlarges images in place. See
  [research/image-generation.md](../research/image-generation.md).
  Codex image generation is detected only for a Codex-provider `kind:"other"`
  tool titled `Image generation`; its completed captured shape maps to
  `<codexHome>/generated_images/<sessionId>/<toolCallId>.png`. Both adapter ids
  must be UUID-shaped (`exec-UUID` for the tool), and the resolved plus canonical
  file path must remain under `generated_images`; failure is log-only and cannot
  reach the file-read/data-URI fallback. That trusted root feeds the same
  `postGeneratedMedia` path on VS Code, desktop, and remote, with
  the same inline rendering and surface-specific hover actions. Provider scoping
  ensures a Grok tool whose user-derived title contains the phrase is not media.
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
- **RTL content renders per-block, the chrome never mirrors.** `applyAutoDir`
  (chat.js) stamps `dir="auto"` on every block element `renderMarkdown` emits
  (ul/ol/li, h1–h3, td/th) after each `innerHTML` render site; loose paragraph
  text — which `renderMarkdown` emits bare with `<br>` breaks, never `<p>` — is
  covered by `unicode-bidi: plaintext` on the prose containers in chat.css
  (`.msg .body`, `.thinking-body`, `.plan-body`, `.subagent-result`,
  `.queued-text`), so each line takes its direction from its first strong
  character. Code is pinned LTR (`.code-block pre` + inline `code`:
  `direction: ltr; unicode-bidi: isolate`), list indent uses
  `padding-inline-start`, table cells `text-align: start`. The composer textarea
  and its `#input-highlight` send-phrase mirror are both `dir="auto"` with
  matching `plaintext` so the overlay stays byte-aligned per line.
