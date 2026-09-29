# Subagents and workflows

How the extension shows work that an agent hands to other agents, for each of
the four CLIs it drives, and why the cards look the way they do. For the
message flow around it see [architecture.md](architecture.md); the raw wire
captures behind this page are in
[research/subagent-workflow-shapes.md](../research/subagent-workflow-shapes.md).

## Two kinds of delegated work

- **A subagent** is one child agent that the main agent starts, usually with a
  short task, and waits on. It returns one result.
- **A workflow** is a named run with steps (phases) and several agents. It
  usually runs in the background after the prompt has ended, and reports back
  when it finishes.

Grok, Codex, Claude Code and Muse Code each expose these differently: some
send a tool call, some send their own events, some stream the child's words
and some send nothing until the end. The UI does not mirror those
differences: the host maps every provider onto one of two card shapes, a
**Subagent card** and a **Workflow card**, and both share one header. The same
messages reach VS Code, the desktop app and a phone or browser connected
remotely, so all of them draw the same cards.

## What each CLI sends

The behaviour below was measured on 2026-09-26–27 with these versions. Newer
releases can change it; the probe under [How to verify](#how-to-verify)
re-measures it.

| Provider | CLI measured | ACP layer measured |
|---|---|---|
| Grok | 1.0.41 | native (`grok agent stdio`) |
| Codex | codex-cli 0.157.0 | `@agentclientprotocol/codex-acp` 1.11.0 |
| Claude Code | 2.1.283 | `@agentclientprotocol/claude-agent-acp` 0.76.0 |
| Muse Code | 1.4.0 | the bundled adapter in `adapters/muse/`, on `@muse-code/sdk` 1.3.0 |

### What the extension asks for at `initialize`

Two adapters report delegation in detail only when the client opts in. The
extension opts in where it gains something and stays out where it would lose
more than it gains. The choice per provider is in `acpClientCapabilities`
([src/acp.ts](../src/acp.ts)).

| Provider | Opt-in sent | Why |
|---|---|---|
| Grok | none needed | Grok reports subagents and workflows on its own `_x.ai/session_notification` rail, and replays them on `_x.ai/session/update`. |
| Codex | `subagents: {}` plus the AIR metadata capability `nativeSubagentSessions` (`_meta.jetbrains.air`) | Without it Codex sends only "Start subagent", `wait` and "Complete subagent" rows and never the child's output. With it the child's output streams live and comes back on reopen. The adapter's `initialize` parser drops the plain `subagents` field, so the AIR capability is what actually turns it on. |
| Claude Code | the AIR capability `asyncTasks` only | It adds task events that carry a workflow's progress. Native subagent sessions stay off: with them on, Claude sends no tool call for the subagent and a reopened conversation loses the subagent entirely. |
| Muse Code | none | The bundled adapter reads Muse's own workflow items and forwards them (see below). |

### Subagents

Muse Code 1.4.0 offered no plain subagent tool: asked for one, its model ran a
one-agent workflow, which gets a Workflow card. (Muse's protocol defines
subagent items, but none were sent.)

| | Grok | Codex | Claude Code |
|---|---|---|---|
| **Starts with** | a `spawn_subagent` tool call (`Task` on Grok's Composer agent), in the foreground or the background | `subagent_spawned` on the parent session | an `Agent` tool call marked `_meta.claudeCode.subagent: true`, foreground or background |
| **Lifecycle** | `subagent_spawned` and `subagent_finished` on `_x.ai/session_notification` | `subagent_state_update`; disconnected children show stopped | foreground tool updates; a background receipt settles as “in background”; ID-correlated task events or notifications supply any later outcome |
| **Child's own output, live** | yes, on the child's own `sessionId`: thinking, tool calls, prose | yes, on the child's own `sessionId` | no |
| **Card name** | the task description | the agent's name (the adapter's task text is a placeholder, not the child's prompt) | the task description |
| **Open while running** | Activity: the child's thinking, tool rows and prose | Activity | nothing yet, so no chevron |
| **Result** | from `subagent_finished`, the tool's completion, or for a background run the `get_command_or_subagent_output` result | the child's last message | cleaned foreground hand-back, or the background task's summary/result when supplied; never the launch receipt |
| **Time** | reported (`duration_ms`) | not reported; the app measures it while it watches live | reported, or measured while observing live work; no clock for “in background” |
| **Tokens** | `tokens_used`, at the finish only | not reported | reported, at the finish only |
| **Controls** | none | none | none |
| **After reopening** | the card, result and time rebuild from the replayed tool call and lifecycle; the child's activity is not replayed | everything comes back, including the child's activity; no time | foreground hand-back restores result and usage; a background task notification restores only its reported outcome/result, with no invented usage or time |

Notes:

- A Grok **background** subagent's spawn call completes at once with
  "Subagent started in background". The card ignores that acknowledgement and
  keeps running until the real result arrives.
- Grok saves every child as a conversation of its own. The history list hides
  them.
- Codex's `wait` call shows as an ordinary tool row while it runs and is not
  replayed. The Codex adapter (1.11.0) gives up waiting on subagents after ten
  minutes and marks those still running as failed; that deadline is the
  adapter's, not ours.
- Claude's child activity would need native subagent sessions, which the
  extension leaves off for the reason in the table above.
- Claude adapter 0.76.0 excludes `local_agent` from its AIR task runtime even
  with `asyncTasks` enabled. The September 27 background capture contains a
  receipt and a parent reply, but no subagent task event. The receipt settles
  the card as **in background**, with no clock, staleness warning, result or
  empty chevron, on desk, phone and reopen. The answer arrives in Claude's
  reply. The wake-up's `usage_update` has `_claude/origin.kind` equal to
  `task-notification`, but no task ID; workflows use the same marker, so it
  cannot identify a card or finish it. The host maps `async_task_*` events
  when supplied and `<task-notification>` on replay by task/tool ID. An
  observed outcome supplies done, failed or stopped, its result and any
  reported duration/tokens. The smoke accepts a foreground hand-back or an
  honest “in background” card; receipt text anywhere and done without a
  result fail. The expected live desktop case on this adapter is “in background”.

### Workflows

Codex has no workflow mechanism: asked for one, the model reports none, and
no command offers one. (`/goal` exists in Codex and is a different feature.)

| | Grok | Claude Code | Muse Code |
|---|---|---|---|
| **Starts with** | the model's `workflow` tool, `/workflow`, or `/deep-research` | the `Workflow` tool, through the ordinary permission prompt | the model's `workflow` tool, also used for a single delegated task |
| **Progress on the wire** | a `workflow_updated` rollup per revision on `_x.ai/session_notification`: phases, current phase, agents with tokens, elapsed time, result, pause message | with the opt-in, `async_task_spawned`, `async_task_progress` and `async_task_state_update`: the current `<phase>: <agent>`, a duration and the run's state | Muse's own `workflow` item snapshots (children with state and usage, a final summary), which the bundled adapter forwards as `session_info_update._meta["muse/workflow"]` |
| **Steps** | named phases with their states | every phase declared in the script's literal `meta` block, from launch; the current one from progress | none reported; one dot per agent instead |
| **Agents** | one row per agent, with state and tokens | one row per agent seen in progress; no tokens, because usage is only a run total | `Agent 1`, `Agent 2` and so on, with state, and tokens when reported |
| **Time** | reported; the card counts on between frames and holds while paused | reported | not reported; the app measures it while it watches live |
| **Result in the card** | `result_summary`: prose, or the `report`, `summary` or `sentence` field of a JSON object; any other JSON shows as a JSON code block | the task's terminal `summary`, when Claude sends one, as sanitized Markdown; the `outputFilePath` is not shown, and Claude's own reply usually carries the answer too | Muse's final summary; a JSON value shows as a code block |
| **Controls** | Pause or Resume, and Stop | none | none |
| **Finish** | a terminal `workflow_updated`; the host also checks the run's own state file | a terminal task state; on reopen, the replayed `<task-notification>` | a terminal `workflow` item |
| **After reopening** | the frames replay and the card is rebuilt where the run happened, with steps, agents, time and result | task events are not replayed; the card comes back from the launch acknowledgement and the task notification, with its name, the declared steps and the outcome | Muse's history carries the finished item: agent dots, agents and result; no time |

Notes:

- **Grok controls** send `/workflow pause|resume|stop <name>` as a real turn,
  as if it were typed, from the desk or a phone. They need the run's display
  name; a run id is never used as a handle, and a run without a usable name
  shows no Pause or Stop.
- **Grok completion** does not rely on the last notification alone. For every
  unfinished run the host reads the run's `state.json` in the CLI's session
  folder (on arrival, before every snapshot and every two seconds), so a run
  that ended while nobody watched does not stay live. A missing or
  half-written file changes nothing; a finish is never guessed.
- **Grok workflow agents** are subagents on the wire too (`subagent_spawned`
  with a `workflow_run_id`) but have no tool call, so they get no card and
  their words are not shown. Their roster row carries state and tokens.
- **Claude steps.** Claude's progress names only the running phase, so the
  card used to grow one step at a time. The host now reads the phase titles
  from the `meta` block at the top of the `Workflow` tool's script; the script
  is tokenized, never run, and at most 64 titles of 200 characters are kept.
  When a later phase starts the earlier ones turn done, every agent seen in the
  current phase stays active, and a stopped run marks the running step
  cancelled.
- **Claude reopen.** While the host still holds the conversation (switching
  back to it, or a phone reconnecting), the observed progress is kept. When
  the conversation is loaded again from Claude's own history, only the launch
  acknowledgement and the task notification come back; if that notification
  is outside the loaded part of the history, the card cannot show that the run
  finished. The `Workflow` permission row stays in the transcript either way,
  since it records a decision.
- **Muse agents' own results** are opaque references (`resultRef`) that SDK
  1.3.0 offers no public way to resolve, so the card shows only the overall
  result. The `workflow` tool row that launched the run is hidden; the card is
  the record.
- **No controls for Claude or Muse yet.** Claude's adapter has a stop call and
  Muse's protocol defines workflow cancel commands; neither is wired, so those
  cards show no controls rather than controls that do nothing.

### Results that arrive in a turn nobody started

Grok workflows, Claude's `Workflow` and Muse's `workflow` all end the prompt
first and deliver their answer later, in a turn the client never started.
Codex's `wait` and Claude's foreground `Agent` hold the turn open instead.
Claude's background `Agent` can also deliver a later follow-up.

The host keeps routing session updates after a prompt has returned, so the
late answer appears once, as an ordinary reply, with no busy indicator and no
new turn footer. On reopen:

- Grok replays a hidden wake message before the answer (marked
  `hideFromScrollback`); it is not shown.
- Claude replays a raw `<task-notification>` as a user message. The host turns
  it into a small notice, such as "Background task completed.", and never a
  user bubble.
- Muse opens a turn of its own to post the answer. A prompt sent during that
  turn is queued behind it through Muse's own queue rather than refused.

## How the extension normalizes it

Every provider is mapped onto one of the two cards in the host, before
anything reaches the webview. No provider adds a host-to-webview message type,
so a phone mirrors exactly what the desk shows.

| Card | Fed by | Provider mapping |
|---|---|---|
| Subagent card | a `toolCall` that `isSubagentToolCall` recognizes, then `toolCallUpdate`, `subagentUpdate` (lifecycle) and `childStream` (the child's output) | Grok is native. `normalizeCodexUpdate` turns Codex's `subagent_spawned` and `subagent_state_update` into a synthetic tool call `codex-subagent:<child id>`, tagged with the child's session. `normalizeClaudeUpdate` cleans hand-backs/errors, hides async receipts and maps ID-correlated task outcomes and reported usage onto the original tool update. |
| Workflow card | `runProgress`, whose payload is the `RunProgressUpdate` from `parseRunProgressUpdate` | Grok's `workflow_updated` is parsed directly. Claude's receipts and task events (`ClaudeWorkflows`) and Muse's snapshots are rewritten as Grok-shaped `workflow_updated` frames in `BackendUpdate.workflowUpdate` and go through the same parser. |

The only provider-specific flags on a workflow are additive:
`controlsAvailable: false` (no controls, and no handle an older renderer could
send), `agentProgressDots` (one dot per agent, for Muse) and `launchOnly` (a
Claude launch receipt with no live progress, never pinned).

Child output is routed by session ID. While a conversation is being reopened,
only IDs announced by an explicit spawn count as children; without that rule,
Codex's own parent replay was read as child output and a reopened Codex
conversation stopped showing its history.

## The card, and why it looks like this

- **One header for both kinds:** icon (a robot or the workflow glyph), kind
  ("Subagent" or "Workflow"), name, step dots (workflows only), status, time,
  and a chevron. The two cards used to be built separately, and each dropped a
  different part of its header depending on state and provider. Both now use
  one blue, and red on failure; a separate colour for subagents was one more
  meaning to learn and carried no information.
- **Closed by default, with a chevron only when there is something to open.**
  The earlier workflow card said everything it knew, all the time: on a phone
  the same run was drawn three times and the pinned copy took half the
  screen. Nothing appears under a header until it is opened, and a card with
  nothing inside yet (a Claude subagent in background) has no chevron.
- **The same status words everywhere:** running, paused, done, failed,
  stopped, in background. “In background” means a launch was reported but no
  task outcome was observed. Internal labels such as "final workflow update" and "No agents
  reported" are gone.
- **Tokens inside the card, and only when there is something to count.** The
  header says what the run is, whether it is running and for how long. A workflow
  leaves a zero count out; a subagent card shows the count the agent
  reported, even zero. Counts use the same compact form as the context
  popover's ledger (1.48K, 288K).
- **The result reads like a reply.** It uses the message renderer and
  sanitizer and the conversation's copy button. The CLI sends the result, the
  last event and the pause message as separate fields, and the card keeps
  them apart: an event line is never shown as output. An older host that
  merged those fields gets no output block rather than a guess.
- **Time is the only live signal.** Nothing blinks or pulses. The wire cannot
  prove an agent is alive (one captured run kept every agent at zero tokens
  throughout and sent one revision twice), so a pulse on a local timer would
  show motion that did not happen. The clock uses the provider's time when
  there is one, and the app's own measurement only while it watches the run
  live; a reopened conversation shows the provider's time or none, never an
  invented one. A running workflow with no new frame for two minutes says "no
  update for 2 min". A settled “in background” subagent has neither a clock
  nor a staleness warning; it makes no claim that work is still running.
- **At most three dots in a long workflow's header.** Eight dots crowded the
  header, most of all on a phone. Up to four steps, every dot shows. Past
  four, it shows three: the current step (else a failed one, else the first
  unfinished one) and its neighbours, shifted so a step at either end still
  shows three, or the last three once every step is finished. An ellipsis
  marks each side where steps are hidden. The dots never wrap; the name is shortened instead. The full
  list stays inside the card.
- **Find opens a closed card, and only one that can open.** With every card
  closed, a Find hit inside a result was hidden again by the card's
  one-second refresh. Find now opens the card through the card's own open
  state, as it does for a collapsed tool row, and only when the header is
  expandable, so it can never force open a card that then cannot close.
- **A workflow's card stays where the run started.** Replay parses workflow
  frames on the replay rail too, so the card is rebuilt at its original place,
  and a completion repair updates that entry instead of appending a new one.
  Before this, finished runs piled up above the message box on every reload.
- **Controls only where the CLI offers them.** Only Grok's workflows can be
  paused or stopped from the card. See the notes under [Workflows](#workflows).
- **A live workflow is pinned above the message box.** A workflow keeps
  running after the turn ends, and a card in the transcript scrolls away with
  its controls. The pin sits inside the composer, so the scroll-to-bottom and
  previous-prompt buttons move up with it instead of covering it. A run that a
  view learned about from a replay, which is how a phone joins a
  conversation, is pinned too.

### The live workflow card

- **One live card.** While a workflow runs, it has exactly one full card.
  - **Pinned (the default):** the card sits above the message box, and where
    the workflow started the transcript shows one muted line: the workflow
    icon and "Workflow *name* started · live below". The line does not open.
  - **Unpinned:** the full card sits where the workflow started, and nothing
    for that run is in the pin.
  - **Finished, in either mode:** the pin entry goes away and the transcript
    card becomes the closed report, where the workflow started.
  - Pause, Resume and Stop are on whichever copy is live, never on both and
    never on the trace line. A Claude launch receipt and the subagent cards
    are unchanged.

  Showing the full card twice, once in the transcript and once in the pin,
  looked cluttered, so the transcript keeps only a trace until the run ends.
- **A pin toggle, remembered.** An open live card ends its controls row with
  a pin button, even when it has no Pause or Stop. Pressed (pinned), its label
  is "Unpin: show it where it started"; released, "Pin above the message
  box". It flips one preference, so every live workflow moves together; an
  opened card stays open and the transcript does not scroll. On a desk the
  preference is the `grok.pinLiveWorkflows` setting (on by default). On a
  phone or browser it is a per-device preference stored locally and never
  sent to the host. A host too old to send the value is treated as pinned,
  which was the behaviour before.
- **One marker, one colour vocabulary.** The header dots, the steps and the
  agent rows all use the same small circle: **green** for done, **blue** for
  the current step, a **grey** ring for what comes next (dashed when the
  state is unknown), **red** for failed, and a **grey** ring with a stroke for
  stopped. Before, the steps used text glyphs of different widths and no
  colour, so they did not visibly match the coloured dots in the header.
- **The process on top, as rings on a track.** An open card draws its steps
  in their own band under the header: a ring per step, green filled for done,
  a blue ring for the step in progress, a hollow grey ring for what comes
  next and a red ring for a failed one, with the track green up to the step
  in progress. The step in progress is bold, a stopped one struck through.
  Drawn as a row, the steps read as the first item of the agent list rather
  than a picture of the run. A long run folds like the header dots: the step
  in progress and one either side, the rest in a "+N done" ring before them
  and a "+N" ring after, so at most five slots share a phone's width. A ring
  whose step has a group below is a button that opens it and brings it into
  view; a step not started with no agents has no group, so its ring is only a
  marker. The closed header keeps its small dots.
- **Agents grouped under their step.** Below the stepper each step is a
  heading with its marker and agent count. A step that finished successfully
  folds to one line with its count, state, time and tokens (each when known);
  a failed, stopped or cancelled step with agents stays open, as does the step
  in progress; a step not
  started with no agents appears only on the stepper, so a long run does not
  fill a phone with empty headings. A row shows only what its label adds to
  the step above it (`verifier-1`, not "Verify / verifier-1"), because a label
  alone does not always say which step it ran in. An agent whose phase names
  no single declared step goes in a last "Other" group, never a guessed one.
  A step's time is shown only when the card saw the step start and finish,
  measured on the run's own clock. A provider that declares no steps (Muse)
  gets no stepper and no groups, just the agents. Agent names are in regular
  weight, with state and tokens muted on the right; an agent that is blocked
  or waiting on a permission stays orange, because that one needs the person.
- **A Grok JSON result** that has no known human-facing field now shows as a
  JSON code block instead of no Output at all.
- **A reopened Grok workflow sits after the row that launched it.** Grok's
  replay can report the run before the "Creating workflow" row, so in 4.13.2
  the finished card could land above it. The card is now placed after the
  launch row whose run id matches; names are not used, because a later launch
  can reuse one.


## Where the code lives

| File | What it does here |
|---|---|
| [src/acp.ts](../src/acp.ts) | `acpClientCapabilities` (the opt-ins above); `handleSessionUpdate` routes child sessions to `childStream` and a backend's `workflowUpdate` to the lifecycle listener |
| [src/acp-dispatch.ts](../src/acp-dispatch.ts) | `isForeignSessionUpdate`, `childStreamFromRoute`, `isSubagentLifecycleUpdate`, and the hidden-wake check |
| [src/acp-backend.ts](../src/acp-backend.ts) | `BackendUpdate`, including `workflowUpdate` and `notice` |
| [src/codex-backend.ts](../src/codex-backend.ts) | `normalizeCodexUpdate`: native subagent events to a synthetic tool call |
| [src/claude-backend.ts](../src/claude-backend.ts) | `normalizeClaudeUpdate`: subagent hand-back, `Workflow` launch receipt, task-notification notice |
| [src/claude-workflows.ts](../src/claude-workflows.ts) | `ClaudeWorkflows`: matches task events to the launch, seeds steps from the script, infers step states |
| [adapters/muse/projection.mts](../adapters/muse/projection.mts) | projects Muse's `workflow` items into `session_info_update._meta["muse/workflow"]` |
| [src/muse-backend.ts](../src/muse-backend.ts) | lifts that metadata into `workflowUpdate` |
| [src/run-progress.ts](../src/run-progress.ts) | `parseRunProgressUpdate`, `workflowControlCommand` |
| [src/workflow-state.ts](../src/workflow-state.ts) | `readWorkflowCompletion`: a Grok run's finish from its state file |
| [src/sidebar.ts](../src/sidebar.ts) | the live and replay listeners that emit `subagentUpdate`, `runProgress` and `childStream`; `controlWorkflow`; `refreshWorkflowCompletions` |
| [media/webview-helpers.js](../media/webview-helpers.js) | `isSubagentToolCall`, `subagentLabel`, `cleanSubagentOutput`, `parseSubagentTaskResult` |
| [media/chat.js](../media/chat.js) | `makeDelegationHeader`, `addSubagentCard`, `applyChildStream`, `renderDelegationResult`, `applyWorkflowProgress`, `renderWorkflowSurface`, `renderWorkflowTranscript`, `syncWorkflowPin`, `windowWorkflowDots`, `windowWorkflowSteps`, `renderWorkflowGroups`, `workflowPhaseStates`, `workflowOutputText`, and Find's `revealFindMatch` |
| [media/chat.css](../media/chat.css) | `.delegation-*`, `.subagent-card`, `.workflow-*` |

## How to verify

**Offline, in `npm test`:**

| Test | Covers |
|---|---|
| `test/delegation-cards.dom.test.ts` | the shared header, chevrons, clocks, two-minute staleness, the dot window, Find, Muse's hidden tool row |
| `test/provider-delegation.test.ts` | each provider's captured frames through its normalizer; the Codex handshake through the installed adapter's parser |
| `test/provider-delegation.dom.test.ts` | the same captures drawn on desk, phone and after a reopen |
| `test/claude-workflows.test.ts` | reading the script's `meta` block without running it, ID matching, step states |
| `test/run-progress.test.ts` | the workflow parser |
| `test/run-progress-card.dom.test.ts` | workflow steps, agents, reports and controls |
| `test/run-progress-lifecycle.dom.test.ts` | a real Grok capture, and completion repair from the CLI's state file |
| `test/workflow-replay.dom.test.ts` | a cold reopen keeps one card at the run's place |
| `test/subagent-mux.dom.test.ts`, `test/subagent-replay.dom.test.ts` | Grok child output routing, and a Composer-agent replay |

**Live, before a release.** These start the real CLIs with real sign-ins,
spend model usage, and are never part of `npm test` or CI:

```sh
npm run smoke:acp                                         # Codex, Claude Code, Muse Code
npm run test:live -- --only=subagent,subagent-composer,workflow   # Grok
```

Among their other checks, these runs ask for a trivial subagent (Grok, Codex,
Claude) and a trivial workflow (Grok, Claude, Muse), check the wire and the
parsed progress, then drive the real desktop app and record what it drew. The evidence lands in
`.verification/acp-smoke/<run>/`. There,
`<provider>-render/render-report.md` (Grok: `grok-render/render-report.md`)
shows every card closed and opened, with its header, steps, agents, result,
copy control and token line; `render-report.json` has the untruncated text,
and `desktop-wire.jsonl` the real messages. A model that declines to delegate
is reported as INCONCLUSIVE, not as a pass. A person reads the render report
before shipping: the scripts check that a card exists and finished, or that
Claude's background launch settled honestly without claiming an outcome.
A person still judges whether it reads well. See [TESTS.md](../TESTS.md) for every assertion and for
`npm run smoke:render`, which reruns only the desktop part.

**When a CLI changes,** rerun the capture probe and compare with
[research/subagent-workflow-shapes.md](../research/subagent-workflow-shapes.md):

```sh
npm run compile
node research/subagent-workflow-shape-per-provider-probe.cjs <provider> <subagent|workflow>
```

Its logs are written under `research/subagent-workflow-shape-logs/`, which is
gitignored because the frames carry machine paths and account details.
