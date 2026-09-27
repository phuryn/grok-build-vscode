# Subagents over ACP

> **v1.6.1 update (grok 0.2.101):** the `subagent_spawned`/`subagent_finished`
> lifecycle events DO transmit live — on the **`_x.ai/session_notification`** rail
> (NOT the `_x.ai/session/update` persist/replay rail the 0.2.93 measurement
> watched, which is why it saw "never transmitted"). The extension now CONSUMES
> them (`isSubagentLifecycleUpdate` re-routes to the webview's `subagentUpdate`)
> for real `duration_ms` + output, **including the Composer agent**. Any "only
> logs / never transmitted over ACP" note below is superseded — see
> `research/grok-build-oss-findings.md` § discovery-2 and `docs/internal/ACP-feedback.md` §2.4.

> **Status: SHIPPED (subagent row) as of grok 0.2.93 / extension post-1.5.5.**
> grok now emits a **genuine `spawn_subagent` tool call** — see § Ground truth
> (0.2.93) below for the captured wire shapes. The extension renders a
> purple-accented row (task description + blink-dots → duration + expandable
> result) and hides the child's persisted sibling session from history
> (`session_kind: "subagent"`). The sections after § Ground truth (0.2.93)
> describe the OLD 0.2.3–0.2.3x background-shell mechanism and are kept as
> history — the classifier still excludes the legacy
> `get_command_or_subagent_output` poller as defense.

## Ground truth (0.2.93) — genuine spawn_subagent

Captured from the live-suite `subagent` test's persisted parent session
(`updates.jsonl`, 2026-07-11; temp cwd `grok-live-sub-*`). One `toolCallId`
carries the whole delegation:

1. `tool_call` — title `"spawn_subagent"`, `rawInput: { prompt, description,
   subagent_type: "general-purpose", background: false }`, `_meta["x.ai/tool"]
   = { name: "spawn_subagent", kind: "task", label: "Subagent" }`.
2. `subagent_spawned` — recorded in `updates.jsonl` under method
   **`_x.ai/session/update`**: `{ subagent_id, parent_session_id,
   child_session_id, subagent_type, effective_context_source, model }`.
   **CAUTION: `updates.jsonl` is grok's event LOG, not the wire** — on 0.2.93
   these lifecycle events are logged but **never transmitted to the ACP
   client** (live-verified by the `subagent-composer` live test: zero
   `_x.ai/session/update` messages arrive while the log fills). The extension
   routes them anyway (`subagentLifecycle` → `subagentUpdate`) for the day the
   CLI starts sending them.
3. `subagent_finished` — same method/status: `{ subagent_id, status:
   "completed", tool_calls, turns, duration_ms, tokens_used, output }`. For a
   **background** spawn (`background: true`) the spawn call "completes"
   immediately with a started-ack text; the real output reaches the client on
   the `get_command_or_subagent_output` poller's completed update
   (`rawOutput {type:"TaskOutput", Result:{task_id, duration_secs, output}}`),
   which the extension matches back to the card by task id.
4. `tool_call_update` — re-titles the call to the human task description
   (`rawInput.variant: "Task"`).
5. `tool_call_update` completed — the result THREE ways: text content with
   embedded `<subagent_meta>`/`<subagent_result>` tags, structured
   `rawOutput: { type: "SubagentCompleted", output, subagent_id, subagent_type,
   tool_calls, turns, duration_ms, worktree_path, resume_from_hint }`, and the
   `subagent_finished.output` above.

**Composer-era (≤0.2.x) legacy:** child activity was never streamed on the
parent connection. The child was persisted twice: as a **top-level sibling
session** under the same cwd folder (`summary.json` carries `session_kind:
"subagent"`, `agent_name: <type>` — this is what the history filter keys on)
and as `<parent>/subagents/<child-id>/meta.json` (compact stats record). A
nested inspector would have had to read the child session from disk (or
`session/load` it via `resume_from_hint`). That shape is still what
`test/fixtures/composer-subagent-session.jsonl` pins, and the host must keep
tolerating it.

**grok 1.0.3+ multiplexed stdout (captured 2026-08-14):** the CLI writes
parent and every background child onto **one** ACP stdout. Every
`session/update` carries `params.sessionId` — there is no ACP `messageId`.
Content chunks interleave word-level across writers. `_x.ai/session_notification`
delivers `subagent_spawned` on the **parent** sessionId *before* the child's
first chunk (`subagent_id` == `child_session_id`, plus `parent_session_id` /
`description` / `model`). Child `tool_call` / `tool_call_update` /
`user_message_chunk` / thoughts / prose then arrive with the **child's**
sessionId. `fs/*` + `terminal/*` server requests still use the parent
sessionId. `subagent_finished` (flattened `output`, `will_wake`) also rides
the parent sessionId. A trailing parent `user_message_chunk` may set
`update._meta.hideFromScrollback: true` (system wake note) — do not render
it. `_x.ai/session/update` did not appear on this capture.

The host demuxes on `params.sessionId` (`parseAcpLine` keeps it;
`isForeignSessionUpdate` / `handleSessionUpdate` emit additive `childStream`
messages). The webview routes those into the existing subagent card keyed by
`child_session_id` (exact `subagent_id` first, FIFO first-untagged only as
fallback). A child tool event closes the open prose segment so later prose
appends *after* the tool row. Word-level chunks coalesce to one markdown /
thought paint per card per frame. A child chunk whose session matches no card
is dropped from the parent transcript. Cold `session/load` still does not
replay child transcripts into the parent — children remain sibling sessions
on disk. Cards rebuild from tool calls; replayed lifecycle frames tag and finish
existing cards rather than create them. Fixture:
`test/fixtures/grok-subagent-mux.jsonl`.

**Other providers:** Codex alone advertises `clientCapabilities.subagents: {}`.
`normalizeCodexUpdate` turns native spawn/state events into stable tool calls,
tagged with the child session ID before any child chunks arrive. Its full
replay follows the same route. The default Start/Complete rows disappear under
this opt-in; live `wait` remains an ordinary tool. Claude keeps the default
handshake so replay retains its Agent call. Its explicit subagent marker is
authoritative; `normalizeClaudeUpdate` extracts output and usage from the
hand-back (including the replay trailer), with no child stream. Muse delegates
through workflows and reports children in the workflow roster. See
[per-provider captures and mappings](subagent-workflow-shapes.md#client-mappings).

`spawn_subagent` goes through the normal `session/request_permission`
flow, so in Agent mode the user first approves it like any other tool.

Bundled-docs theory confirmed against **grok 0.2.33** (CLI docs at
`~/.grok/docs/user-guide/16-subagents.md`, cross-checked with `grok --help`:
`--agents <JSON>`, `--best-of-n`). **Live wire shape captured against the
native-Windows build `grok` 0.2.3** (`research/win-subagent-probe.cjs` + the
`subagent` live test in `scripts/live-tests.cjs`) — and it does **not** match the
docs. See [§ Ground truth](#ground-truth-native-windows-02x) below.

## Summary

Subagents are **independent child sessions that run in parallel**, each with its
own context window; the parent delegates work and gets a summary back. They're
**enabled by default**. The bundled docs say the main agent delegates by calling a
**`spawn_subagent`** tool with a **`subagent_type`** parameter selecting the
child's role — but that tool is **not what the native-Windows 0.2.x build actually
emits over ACP** (next section). We keep `spawn_subagent` detection as
forward-compat for builds that do emit it.

## Ground truth (native-Windows 0.2.x)

The live `grok` 0.2.3 build has **no `spawn_subagent` / `subagent_type` tool over
ACP**. A delegation is a pair of ordinary tool calls:

1. **`run_terminal_command`** with `rawInput.variant: "Bash"`,
   `is_background: true`, content text `"Spawn background subagent to
   investigate…"`, and a `[bg]`-prefixed title (`"Background task t1 started"`).
   *This is the delegation* — the child runs as a backgrounded shell task.
2. **`get_command_or_subagent_output`** with `rawInput.variant: "TaskOutput"`,
   `task_id: "t1"`, title `"Get task output: t1"` — the parent **polls** the
   background task's output. *This is a reader, not a delegation.*

The trap: the poller's name contains the substring **"subagent"**, so a naive
`/subagent/` match false-fires a card on the output reader. The classifier
explicitly excludes it (see below). The live suite's `subagent` test asserts the
poller is **NOT** carded (`misfired.length === 0`) and that a real delegation is
detected via the background spawn + poll pair.

## `spawn_subagent` (forward-compat / other builds)

| Field | Notes |
|---|---|
| tool name | `spawn_subagent` |
| `subagent_type` | child role — built-ins below; project/user agents can add or shadow types |
| (other rawInput) | the task prompt for the child |

### Built-in `subagent_type` values

| Type | Description |
|---|---|
| `general-purpose` | Default. Full-capability agent for any task. |
| `explore` | Research agent — searches/reads/greps/runs shell, **no file edits**. |
| `plan` | Planning agent — explores and produces a structured plan, **no edits**. |

### Agents vs Personas (context, not needed for the card)

- **Agents** configure a whole session (model, tools, prompt, skills). Defined as
  `.md` files in `.grok/agents/` or `~/.grok/agents/`, or via `--agents <JSON>`.
- **Personas** are behavioral overlays applied to a subagent during resolution
  (tone/format/focus). Defined in `config.toml` `[subagents.personas]` or
  `.grok/personas/*.toml`. A persona can declare `default_isolation = "worktree"`
  — this is where grok's **git-worktree** isolation ties in.

Disable subagents with `GROK_SUBAGENTS=0` or `[subagents] enabled = false`.

## How the extension handles it

- `isSubagentToolCall(call)` / `subagentLabel(call)` (pure, in
  `media/webview-helpers.js`):
  - match the forward-compat `spawn_subagent` shape (by name and by
    `rawInput.subagent_type`), plus broad fallbacks for relabeled titles / renames;
  - **also card the native-build delegation** — a backgrounded `run_terminal_command`
    (`rawInput.is_background:true`, or a `[bg]`-prefixed title). This is grok 0.2.x's
    actual subagent mechanism, so without it the card never fires on the native build.
    A *foreground* command (`is_background:false`/absent) is left in the tool group;
  - **explicitly exclude the `get_command_or_subagent_output` poller** — an
    early-return on names ending in `output` or starting with `getcommand`, so the
    "subagent"-in-the-name reader never cards (its `is_background` is unset anyway);
  - degrade gracefully (no match → existing tool-group behavior). The label is the
    `subagent_type` (e.g. "general-purpose"), else the backgrounded command
    (truncated), else a generic "Subagent" / "background task".
- `media/chat.js` renders a distinct **Subagent: \<type\>** card
  (`addSubagentCard`); `media/chat.css` `.subagent-card`.

## Still open

Live child prose/tools/thoughts now render inside the parent card on grok
1.0.3+ (`childStream`). A deeper nested inspector (the child's own session
from disk, `session_kind:"subagent"` siblings + `<parent>/subagents/<id>/meta.json`)
is still a non-goal. On native-Windows the legacy correlation key is the background
`task_id` (`"t1"`) shared between the spawn `run_terminal_command` and the
`get_command_or_subagent_output` polls — so a future inspector can group the
poll output under the spawn card by `task_id`. Today's card is a flat labeled
marker; the live suite's `subagent` test guards the two invariants we rely on
(real delegation detected, poller not carded).
