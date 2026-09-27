# Live workflow follow-up (installed adapters, 2026-09-27)

## Claude asyncTasks audit

Authority: installed `@agentclientprotocol/claude-agent-acp` 0.76.0,
`dist/air-extension.js`, `async-tasks.js`, `acp-agent.js` and
`acp-subagents.js`. The initial implementation used source-only inspection. The Run 3 follow-up below also reads the existing Muse catalog through MSP, without creating a session or sending a prompt.

Advertising `_meta.jetbrains.air: { version: 1, capabilities: ["asyncTasks"] }`
changes these surfaces:

- Enables `AsyncTaskRuntime`, publishing `async_task_spawned`,
  `async_task_progress`, and `async_task_state_update` on the parent session.
  Task identity, description/name, transcript preference, stop availability,
  tool-use attribution and output-file paths can arrive on separate frames.
  Progress can include description, summary, last tool and aggregate usage.
- Applies to all non-agent background work: `local_workflow` becomes
  `workflow`, `local_bash` becomes `shell`, `local_monitor`/`mcp` become
  `monitor`, and other task types retain their names. Explicit foreground
  tasks are not announced; Bash needs proof it was backgrounded.
  `local_agent`/subagent-typed tasks are excluded. Native subagent sessions
  are independently gated and remain disabled for Claude.
- Background Bash can be recovered from its structured `backgroundTaskId`
  tool result or the adapter's recognized background-command text. Matching
  tool-call updates gain `_meta.jetbrains.air.asyncTasks.backgrounded: true`.
  Existing tool results still arrive; this does not change shell permissions,
  cause a command to run in the background, or replace the Bash tool card.
- Reconciles SDK `background_tasks_changed` full snapshots: discovers live
  tasks, promotes background tasks, and marks missing tasks `stopped`.
  Level-only discoveries use `showInTranscript: false`. An authoritative
  terminal event can correct that provisional stopped state to completed or
  failed. Late attribution/output paths can cause repeated terminal frames.
- Maps pending/running, paused, completed, failed and killed/cancelled/stopped
  to the corresponding AIR states. Active tasks finish failed on conversation
  reset or stream failure/end, or stopped for a cancelled session at stream
  end. Reset also clears the task registry. A normal prompt ending does not
  finish background work.
- Makes announced nonterminal tasks stoppable through
  `_session/async_task/stop { sessionId, asyncTaskId }`, backed by SDK
  `stopTask`. Success publishes stopped state and a single
  `Task stopped by user` assistant acknowledgement. Claims prevent duplicate
  stops; failure releases the claim. No pause/resume interface is exposed here.
- Does not add async lifecycle replay to `session/load`, workflow child
  transcripts, a complete phase roster, or workflow result-file contents.

The host advertises this only for Claude. Codex retains only
`nativeSubagentSessions`. `ClaudeWorkflows` accepts only workflow tasks, caches
early events until task/tool-use IDs match a launch receipt, and keeps that
receipt's `run_id`. It accumulates observed `<phase>: <agent label>` pairs;
all agents observed in the current phase stay active together. Because Claude awaits each phase before entering the next, an observed later phase marks prior phases and their agents done. Terminal task state still controls failed/stopped outcomes. Aggregate
usage is not assigned to an individual agent. Final states update live,
including the stopped correction and duplicate metadata-only terminal frames.
Duplicate receipts cannot erase progress. Shell/monitor tasks remain their
ordinary tool presentation. No new control UI or transport is introduced;
the adapter's stop API above is available for a future control integration.

Desk and phone share `RunProgressUpdate`, the existing lifecycle listener,
host buffer and remote mirroring. Warm reopen retains observed progress;
cold reopen retains the named launched/done receipt from acknowledgements and
correlated task notifications. Markdown summaries use the existing sanitizer.

## Muse result reference audit

Installed `@muse-code/sdk` 1.3.0 `dist/src/msp.d.ts` declares
`WorkflowChild.resultRef` as an **opaque** durable-owner string. The generated
`MspMethod` vocabulary has no URI/reference resolution method. The nearby
`subagent/readResult` method takes `SubagentTargetParams`: a command ID, parent
session ID and durable native `subagentId`, specifically the ID from a
`kind: subagent` item. It is a command with an admission acknowledgement,
not a documented `resultRef`-to-text request. Native subagent items can carry
`SubagentResult` (summary, text, structured data and references).

Workflow children instead carry `(childId, attempt)` and `resultRef`. Neither
the SDK facade/fold nor our adapter maps these to a native `subagentId`, and
the captured workflow emits no such native item. The URI's apparent host and
task path are not a published parsing contract. Consequently these workflow
references are **not resolvable through the installed public SDK/MSP contract**;
result fetching is skipped rather than guessing a child target or file path.
This is a contract limitation, not evidence that a live server rejects every
possible undocumented request.

Muse now opts into child-state dots on the existing collapsed header and
finished report. One dot follows each child; no phase list, names or percentage
is invented. Numbered rows and overall sanitized Output remain. SDK snapshots
and history use the same projection, so desk, phone and reopen agree.

## Cloud update handoff

`removeCloudHostUpdateStamps` removes both
`$HOME/afkpilot/.afkpilot-host-checked` and `$HOME/.afkpilot-agents-updated`
after maintenance and attempt persistence, before exit. Missing files are
accepted independently; other errors prevent exit through the existing failed
update path. The restart's BOOT installs the CLIs; selecting latest versions
belongs to the parallel relay change. No agent is started/probed by this helper.

## Validation

The targeted tests execute the installed Claude initialize schema, native and
async gates, and `AsyncTaskRuntime`, including background Bash and terminal
correction. Muse tests execute the installed SDK `SessionFold` before our
projection, plus desk/phone/buffered-reopen DOM rendering. Cloud tests run the
real filesystem helper through update admission, including missing files and
an asynchronous unlink failure. There is no provider adapter gate in that item.

Files by item:

| Item | Implementation | Tests |
|---|---|---|
| Claude | `src/acp.ts`, `src/claude-backend.ts`, new `src/claude-workflows.ts` | `test/acp.test.ts`, new `test/claude-workflows.test.ts` and `test/fixtures/claude-async-workflow.json`, `test/provider-delegation.test.ts`, `test/provider-delegation.dom.test.ts` |
| Muse | `adapters/muse/projection.mts`, `src/run-progress.ts`, `media/chat.js`, `media/chat.css` | `test/provider-delegation.test.ts`, `test/provider-delegation.dom.test.ts` |
| Cloud update | `src/cloud-host-update.ts`, `src/sidebar.ts` | `test/cloud-host-update.test.ts` |

Current-state documentation updated in `CLAUDE.md`, `docs/architecture.md`,
`docs/internal/ACP-feedback.md`, `research/subagent-workflow-shapes.md` and
this audit. No version bump or commit.

## Run 3: phase presentation and blank Muse catalog rows

The supplied `real-screens/INDEX.md` Run 3 and Claude host log confirmed the
normalizer emitted unknown states, including when the Describe labels alternated
wave/tide/wave/reef. `ClaudeWorkflows` now marks earlier phases and their agents
done at the next phase. Every observed current-phase agent remains active;
terminal completed/failed/stopped updates still decide the final outcome. Grok
and Muse workflow projection/rendering are unchanged by this follow-up.

A read-only `session/list` against the Run 3 Muse binary
`1.4.0-R4161.1` and workspace returned the empty row as:

```json
{
  "status": "notLoaded",
  "activeTurnId": null,
  "turnCount": 0,
  "forkedFrom": null,
  "createdAt": "2026-09-27T05:45:51.831613Z",
  "updatedAt": "2026-09-27T05:45:52.353129Z"
}
```

Identity/path/workspace/provider/model fields were also present. `title`,
`firstUserPrompt`, `lastActivityAt` and `name` were absent. The local index had
`msp_turn_count: 0`, `prompt_count: 0`, null MSP title/prompt, and the index's own
fallback title `New session`; that fallback was **not** on the MSP listing.
The two real workflow conversations had numeric `turnCount: 1`, titles and
first prompts. `test/fixtures/muse-session-list.json` retains the observed
field presence and numeric types with scrubbed identities, paths and prompts.

The zero was not lost or encoded as a string: our adapter carried it as
`_meta.turnCount`, `MuseBackend.listSessions` flattened it, and `adapterListEntry`
turned it into `numMessages: 0`. Contrary to the earlier presumed filter,
the checked source tree at `4da4534` plus the workflow changes had no
`turnCount !== 0` guard. Both the adapter listing and shared history cache
mapped every row, letting the empty title become `Untitled (date)`.

`isBlankMuseSession` now filters the raw MSP page in `MuseSession.listSessions`,
before the shared cache feeds the rail and History. It hides only known zero
completed-turn root sessions with no prompt, derived title, content activity or
active turn. Running sessions, forks and missing/unknown count or identity-state
metadata stay visible. `updatedAt` is not evidence of content: the blank row's
bookkeeping advanced it. Filtering retains `nextCursor`, so an entirely empty
page cannot hide conversations on later pages. No session is deleted.

Follow-up files: `src/claude-workflows.ts`, `adapters/muse/session.mts`,
`test/claude-workflows.test.ts`, `test/provider-delegation.dom.test.ts`,
`test/muse-session.test.ts`, new `test/fixtures/muse-session-list.json`,
`CLAUDE.md` and this report. Validation: 83 tests in those three test files,
`npx tsc -p . --noEmit`, and `npm run compile:muse-adapter` passed.
