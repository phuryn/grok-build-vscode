# Workflow / Goal / Deep Research progress (P2-10)

Design + wire notes for progress cards on the live `_x.ai/session_notification`
and persisted `_x.ai/session/update` rails. Engines stay in the CLI; the extension
only renders cards and optional pause/resume/stop by display name.

## Slash surface (leave alone)

Advertised by the CLI and **not** in `HIDDEN_SLASH_COMMANDS`:

| Command | Role |
|---|---|
| `/deep-research <query>` | Launch a background research workflow |
| `/workflow …` | Launch / `pause` / `resume` / `stop` / `save` by display name |
| `/goal …` | Set / `status` / `pause` / `resume` / `clear` an autonomous goal |
| `/workflows` | TUI run dashboard (no ACP equivalent — cards replace the need) |

## Live rail kinds

From CLI binary symbols (0.2.111) + session_notification family:

| `sessionUpdate` | Meaning |
|---|---|
| `workflow_updated` | Rollup for a background run (phase, agents, last_event, …) |
| `goal_updated` | Rollup for `/goal` (deliverables, phase, …) |
| `workflow_started` / `_paused` / `_resumed` / `_completed` / `_failed` / `_cancelled` | Lifecycle siblings (parsed when present) |
| `goal_created` / `_paused` / `_resumed` / `_completed` / `_cleared` | Goal lifecycle siblings |

### Typical `workflow_updated` fields (snake_case)

`run_id`, `display_name` / `name`, `objective`, `current_phase` / `phase`,
`agent_budget`, `agents_used`, `current_agent_label`, `last_event`,
`last_event_detail`, `pause_message`, `result_summary`, …

### Typical `goal_updated` fields

`goal_id`, `objective`, `phase`, `total_deliverables`, `completed_deliverables`,
`current_deliverable_title`, `token_budget`, …

## Extension mapping

| Layer | Role |
|---|---|
| `src/run-progress.ts` | Pure `isRunProgressUpdate` / `parseRunProgressUpdate` / `workflowControlCommand` |
| `sidebar.ts` xaiNotification / subagentLifecycle | Share `parseRunProgressUpdate` and emit `{ type: "runProgress", update }`; a parsed replay frame returns before subagent forwarding |
| `media/chat.js` | Upsert teal progress cards; Pause/Resume/Stop → `workflowControl` → `/workflow …` |

Cold replay establishes each card at its first workflow frame. Cards are buffered
on the session like subagent rows, so a warm re-focus replays them. Live updates
for the same run id update that card in place; duplicate frames do not create a
second card, and older revisions cannot rewind it. The order regression in
`test/workflow-replay.dom.test.ts` drives the real ACP dispatcher, sidebar and
renderer through cold load, both rails, and a fresh webview buffer replay.
`readWorkflowCompletion` reconciles unfinished buffered runs with
`~/.grok/sessions/<encoded cwd>/<session id>/workflows/<run id>/state.json`
on notification ingestion, before replay, and every two seconds for pooled
sessions, including sessions without a viewer. Only an explicit terminal run
status repairs a notification; missing, unreadable or incomplete files retry.
Workflow agent rows disclose activity only when there is detail to show.
Rows with a positive snapshot token total and no observed activity have no
button or chevron. Expansion is held in memory per run, with every new run
collapsed; it is never a host setting.

Since 4.13.2 the live transcript entry and the pinned card render the same
closed header (`makeDelegationHeader`, shared with subagent cards): icon, kind,
name, static dots from the reported phases (windowed to the current step and its
neighbours past four), status and elapsed time. Two minutes without a frame shows
as the status "no update for 2 min". Expanding shows labelled phases, one row per
agent with its tokens, then Pause/Resume and Stop and the pause message, then the
result. A finished run (`complete` or `completed`, including a Partial
result summary) leaves the pin and replaces its marker with an expandable
summary that arrives collapsed, without Pause/Stop. Stateless phase definitions
remain unknown during a live run except for its current position; successful
completion marks them done. The retained current phase cannot mark a terminal run's step active;
failed/cancelled runs preserve pending steps instead of claiming they finished.

The expanded card orders purpose, progress (strip, elapsed time, receipt,
pause reason and spend), labelled markdown Output when present, then roster.
The collapsed pin retains the phase name alone; expanded views do not repeat
phase or status in the heading. Output uses the same `renderMarkdown`, direction
handling and link interception as message bodies, including underscore emphasis.
This summary renders notification metadata, not the contents of a report file.
Workflow definitions and artifact generation live in the CLI, not this repo.
Assistant prose arrives independently through `messageChunk`, and file reads
through tool calls; neither is required for the workflow card to finish.

Receipt arrival, token increases and reported state transitions remain separate
facts. Duplicate frames refresh only receipt age. Zero tokens do not establish
activity, and even a state transition retains the absence of observed token
activity in agent detail. Missing fields hide their dependent affordances.
Counts use thousands separators; names and control handles never use run ids.

## Probes

A dedicated live capture (launch `/deep-research` and dump `workflow_updated`
payloads) can be added under `research/run-progress-probe.cjs` when credit budget
allows; unit tests pin the pure parsers against synthetic shapes derived from
binary field names + user-guide semantics.

## Reload and older hosts

`workflowContent: { resultSummary: string | null, pauseMessage: string | null }`
preserves CLI field provenance across the host/client boundary. Null is explicit
absence; a missing object identifies legacy hosts by capability, not version.
The existing `detail`, status values and completion flags stay unchanged for
older receivers. `src/protocol.ts` carries `RunProgressUpdate`; the relay mirror
forwards the message. The previous renderer reads only known properties and
ignores `workflowContent`, so this adds no new enum value or default-branch risk.

New clients never treat legacy `detail` as output: it irreversibly mixes event
prose, pause messages and results. They omit that ambiguous line while retaining
structured purpose, progress, elapsed time, receipt, spend and roster. The client
can deploy first, but reliable output display requires the updated host. No
delimiter splitting or diagnostic keyword guessing is used.

The relay forwards the host snapshot; it does not read the CLI workflow store.
`GrokSidebar.emit` buffers normalized `runProgress` messages.
`buildRemoteSnapshot` / `sendRemoteHistorySnapshot` bracket that buffer in
`historyReplay`; a full host restart first obtains history via ACP
`session/load`. Replaying a stale active notification does not consult
`state.json` unless the host reconciles it. The client receipt then correctly
says "no update since this view opened", but the run status can be stale.

A repaired update uses the existing `runProgress` message, `done: true`, and
`phase: "completed"` for CLI `complete`. The v2.0.4 renderer already maps
`completed` to done and removes controls using `done`; no new wire value is
introduced. The newer client also recognizes explicit terminal phase values
from hosts that incorrectly set `done: false`. It cannot establish completion
from an old host's active-only snapshot, silence, or all-done agents between
stages. Missing terminal evidence therefore needs the host repair deployed.

The two-stage fixture records the supplied state shape and identifies its
synthetic second-run fields. Regression stale notifications are constructed,
not claimed as a capture. Direct access to the affected Sprite was denied
(EACCES) during this repair, so the exact last notification in its store has
not been independently read.

## Result provenance (source audit, 2026-09-22)

Audited upstream commit `4247f661689354b831191f11eeeac8424993fe3d`:

- [tracker.rs, apply_outcome and summarize_result](https://github.com/xai-org/grok-build/blob/4247f661689354b831191f11eeeac8424993fe3d/crates/codegen/xai-grok-shell/src/session/workflow/tracker.rs#L493):
  only `WorkflowOutcome::Completed { result }` assigns `result_summary`.
  Strings pass through; null becomes `done`; an object with a string `report`
  becomes that report plus an optional `_Full report: path_` footer; other values
  are JSON-serialized. The result is capped at 16 KiB on a UTF-8 boundary.
  Resume clears it. It is the workflow's completion value, not intrinsically
  the last agent's response.
- [deep_research.rhai](https://github.com/xai-org/grok-build/blob/4247f661689354b831191f11eeeac8424993fe3d/crates/codegen/xai-grok-shell/src/session/workflows/deep_research.rhai#L518)
  builds a chat report, prefixes the partial-status markdown, writes the full
  report, and calls `complete` with `report`, `path`, `status` and claim ids.
- [notify.rs, build_workflow_updated](https://github.com/xai-org/grok-build/blob/4247f661689354b831191f11eeeac8424993fe3d/crates/codegen/xai-grok-shell/src/session/workflow/notify.rs#L106)
  sends `result_summary` separately from `last_event` / `last_event_detail` and
  `pause_message`. The tracker records `workflow_outcome_ignored` with detail
  `ignored cancelled while status is cancelled`; our `eventLabel` creates the
  English prefix `Workflow outcome ignored:`. This is event history, not output.

`workflowOutputText` displays prose or string fields `report`, `summary`, or
`sentence` from a JSON object, in that priority. This is a bounded presentation
policy for known human-facing fields, not a universal workflow result schema.
Other JSON values, machine-only objects, truncated JSON, JSON fences, empty
strings and the CLI's `done` sentinel produce no output block. Unrecognized
object fields are intentionally omitted. The CLI conflates a literal `done`
result with null; the card omits both rather than repeating its status.

`test/fixtures/workflow-output.json` reconstructs the three owner transcriptions
with source-verified field placement; it is labelled synthetic, not a capture.
