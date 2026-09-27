# Subagent and workflow shapes over ACP, per provider

Raw capture of what Grok, Codex, Claude Code and Muse Code put on the wire when
asked for a trivial subagent and a trivial workflow. The capture sections
describe the client at probe time; [Client mappings](#client-mappings) describes
the current implementation.

- Captured 2026-09-26, Windows 11, extension HEAD `4d7f11094a514a592fc3a9ed4a5436b0b47fdff9`.
- Probe: [`subagent-workflow-shape-per-provider-probe.cjs`](subagent-workflow-shape-per-provider-probe.cjs).
- Raw logs: not committed, because they carry machine paths and account metadata. The probe writes
  them to `research/subagent-workflow-shape-logs/` (gitignored), one JSONL per run; rerun it to regenerate.
  Each line is `{seq, t, phase: "live"|"load", dir, msg}`; `dir` is `c2a`, `a2c`,
  `probe`, and for Muse also `msp-s2a` / `msp-a2s` / `adapter-log`.

## Installed and signed in

| Provider | CLI | ACP layer | Signed in |
|---|---|---|---|
| Grok | `grok 1.0.30 (04b7ffed98c6)`, `~/.grok/bin/grok.exe` | native (`grok agent --no-leader --reasoning-effort low stdio`) | yes (`cached_token`) |
| Codex | `codex-cli 0.157.0` (a global npm install; what `locateCodexCli` returns) | `@agentclientprotocol/codex-acp` 1.11.0 | yes (ChatGPT) |
| Claude Code | `2.1.281`, `~/.local/bin/claude.exe` | `@agentclientprotocol/claude-agent-acp` 0.76.0 | yes (claude.ai) |
| Muse Code | `Muse Code 1.4.0 (1.4.0-R4161.1)` via `%LOCALAPPDATA%\Programs\muse\muse.cmd` | our adapter (`out/muse-adapter`), `@muse-code/sdk` 1.3.0 | yes (`~/.config/muse/auth.json`) |

Muse runs natively on Windows now; `research/muse-acp-probe.cjs` still refuses
win32. The SDK logs a schema-fingerprint mismatch against the 1.4.0 host
("proceeding under additive-optional evolution").

## Method

One fresh session per prompt, in a fresh `%TEMP%\swshape-<provider>-*` cwd.
Spawn specs, locators and client capabilities come from the extension's own
`out/` modules (`locate*Cli`, `*Backend.spawn`, `acpClientCapabilities`), so the
handshake is the one the extension sends. After the prompt resolves the probe
keeps listening until the wire is quiet (background work keeps talking), then
kills the process tree, starts a fresh process and `session/load`s the finished
session (`phase: "load"`).

Deviations from the extension, all deliberate:

- Grok gets `--no-leader` so the probe never attaches to the owner's live leader.
- Every provider was asked for low reasoning effort through the backend's own setter.
- `--optin` runs add `clientCapabilities.subagents: {}` (the ACP subagent RFD)
  and JetBrains AIR `_meta.jetbrains.air {version: 1, capabilities:
  ["nativeSubagentSessions", "asyncTasks"]}`. The probe sent both; the current Codex client sends only the native-subagent AIR capability;
  both adapters gate their native subagent/task surfaces on them.
- Muse ran **in-process**: the adapter's own `MuseSession` (the class `main.mjs`
  wraps in an ndjson stream) with the SDK's `spawnMspConnection` tapped. One run
  therefore records both the ACP the extension would receive (`a2c`) and the MSP
  underneath it (`msp-s2a`), which the adapter does not forward.

Safety policy: permission requests were allowed only for a subagent/workflow
launcher or a read/search/think tool, else `reject_once`; `fs/*` was honoured
only inside the scratch cwd; every `terminal/*` request was refused. What
actually happened: the only `session/request_permission` in any run was Claude's
`Workflow` tool (allowed). Grok sent one `terminal/output` (refused, see Grok).
Nothing else was denied and no tool wrote anything.

Prompts: subagent - "Delegate this to a subagent using your own subagent /
agent-spawning tool ... what is 2+2?"; workflow - Grok `/workflow shape-probe`
(a saved two-phase `.rhai`) and then the same script inline through the model's
`workflow` tool, Claude the same two-step script inline through its `Workflow`
tool, Codex and Muse "do you have a workflow mechanism? if so run a two-step
alpha/beta one, else say NO_WORKFLOW_MECHANISM".

## Summary

| | Subagent on the wire | Workflow on the wire | Parent/child keys | Replay (`session/load`) |
|---|---|---|---|---|
| **Grok** | `spawn_subagent` tool call + `_x.ai/session_notification` `subagent_spawned` / `subagent_progress` / `subagent_finished`; child prose on its own `sessionId` | `workflow` tool call + `workflow_updated` rollups (phases, agents, `result_summary`) + one `subagent_*` pair per `agent()` carrying `workflow_run_id` | `child_session_id` (== `subagent_id`), `parent_session_id`, `workflow_run_id`, `run_id` | lifecycle on `_x.ai/session/update` with `isReplay: true`; subset of `workflow_updated` revisions; **no child transcript** |
| **Codex** default | three `kind:"other"` tool calls: "Start subagent X", `wait`, synthetic "Complete subagent X"; no child output | none (model says `NO_WORKFLOW_MECHANISM`) | `_meta.codex.subagent.threadId` / `path` | same tool calls; start gains `rawOutput {task_name}` only on replay |
| **Codex** opt-in | `subagent_spawned` + `subagent_state_update`; child prose on its own `sessionId`; `wait` tool call stays | none | `subagentSessionId` | **full**: `subagent_spawned`, child chunks, state update (the `wait` call is gone) |
| **Claude** default | `Agent` tool call (`kind:"think"`, `_meta.claudeCode.subagent: true`), `toolResponse` meta, hand-back `rawOutput` | `Workflow` tool call, permission, `toolResponse {status:"async_launched", taskType:"local_workflow"}`, then nothing until a post-turn message | `_meta.claudeCode.toolResponse.agentId`, `taskId`, `runId` | tool call replayed at final input, `toolResponse` meta gone; workflow wake appears as a raw `<task-notification>` user message |
| **Claude** opt-in | `subagent_spawned` / `subagent_state_update`; **no `tool_call`**; child prose on its own `sessionId` | `async_task_spawned` / `async_task_progress` / `async_task_state_update` beside the tool call | `subagentSessionId`, `asyncTaskId`, child `_meta.claudeCode.parentToolUseId` | **subagent vanishes entirely**; workflow replays like default (no `async_task_*`) |
| **Muse** (MSP) | no plain subagent tool; delegation *is* a workflow | `workflow` tool call + MSP `workflow` item with `children[]` | `workflowRunId`, `children[].childId`, `resultRef` | MSP inline history carries the terminal `workflow` item |
| **Muse** (ACP, our adapter) | only the `workflow` tool call ("launched" JSON) | same | none | same tool call |

Every agent that runs work in the background ends the prompt first and reports
the result later, in a turn the client never started (Grok, Claude, Muse), or
holds the turn open (Codex `wait`, Claude synchronous `Agent`).

## Grok

### Subagent (observed, `grok-subagent.jsonl`)

The model chose `background: true`. One `toolCallId` carries the spawn:

```jsonc
// session/update, parent sessionId
{"sessionUpdate":"tool_call","toolCallId":"call-0271…-0","title":"spawn_subagent",
 "rawInput":{"description":"2+2 number only","prompt":"What is 2+2? …","subagent_type":"general-purpose","background":true},
 "_meta":{"x.ai/tool":{"name":"spawn_subagent","kind":"task","label":"Subagent","read_only":false},"subagentBackground":true}}
// then tool_call_update: title -> "2+2 number only", kind "other", rawInput.variant "Task", run_in_background
// then completed at once: rawOutput {"type":"Text","text":"Subagent started in background.\nsubagent_id: 01a0df1b-51c9-…"}
```

Lifecycle on `_x.ai/session_notification`, parent `sessionId`:

```jsonc
{"sessionUpdate":"subagent_spawned","subagent_id":"01a0df1b-51c9-…","attempt_id":"at1.5fd0…",
 "parent_session_id":"01a0df1b-418f-…","parent_prompt_id":"1e15…","child_session_id":"01a0df1b-51c9-…",
 "subagent_type":"general-purpose","description":"2+2 number only","effective_context_source":"new","model":"grok-4.7","agentAddress":"aa1.…"}
{"sessionUpdate":"subagent_progress","subagent_id":"…","child_session_id":"…","duration_ms":2253,"turn_count":1,
 "tool_call_count":0,"tokens_used":1806,"context_window_tokens":500000,"context_usage_pct":0,"tools_used":[],"error_count":0}
{"sessionUpdate":"subagent_finished","subagent_id":"…","child_session_id":"…","status":"completed","tool_calls":0,
 "turns":1,"duration_ms":2353,"tokens_used":11656,"output":"4","will_wake":false}
```

The child streams on its **own** `sessionId`: `user_message_chunk` (its prompt),
`agent_thought_chunk`s, `agent_message_chunk` "4", plus `_x.ai/session_notification`
`response_completed`, `hook_run_started` / `hook_execution` (`subagent_stop`) and
`turn_completed` for the child. The parent then polls with
`get_command_or_subagent_output` (`_meta["x.ai/tool"].kind: "background_task_action"`),
retitled `"[subagent:general-purpose] 2+2 number only (01a0df1b)"`, completing with
`rawOutput {"type":"TaskOutput","Result":{task_id, status, duration_secs, output:"4\n\n<subagent_meta>…</subagent_meta>…"}}`.
All of this matches `research/subagents.md` § grok 1.0.3+ multiplexed stdout.

### Workflow

**`/workflow <saved>` did not start** (`grok-workflow.jsonl`). With
`.grok/workflows/shape-probe.rhai` in a `git init`ed scratch cwd, the reply was a
host turn: `agent_message_chunk "Workflow 'shape-probe' unavailable: unknown workflow: shape-probe"`
with `_meta.hostTurn: true`, zero tokens, even after waiting for the catalog's
`workflows-reload`. Inferred, not verified: project workflows are gated by
folder trust (the scratch folder is untrusted, and the docs say trust gates
project skills and instructions). User-scope `~/.grok/workflows/` was not tried
because it edits the owner's config.

**Model-launched `workflow` tool works** (`grok-workflow-tool.jsonl`), same script inline:

```jsonc
{"sessionUpdate":"tool_call","toolCallId":"call-d1d1…-0","title":"workflow",
 "rawInput":{"source":{"type":"script","script":"let meta = #{ name: \"shape-probe\", … }"},"validate_only":false},
 "_meta":{"x.ai/tool":{"name":"workflow","kind":"workflow","label":"Workflow","read_only":false}}}
// retitled "Creating workflow 'shape-probe'", rawInput.variant "Workflow", agent_budget, args
// completed at once: rawOutput {"type":"Workflow","run_id":"wf_01a0…","task_id":"wf_01a0…","name":"shape-probe","script_path":"…\\script.rhai","message":"Workflow 'shape-probe' started in the background. …"}
```

Progress is `workflow_updated` on `_x.ai/session_notification`, a full rollup
per revision (live revisions 1, 2, 4, 4, 5, 6, 8, 8, 9, 10; duplicates arrive):

```jsonc
{"sessionUpdate":"workflow_updated","run_id":"wf_01a0df1f3cec…","revision":10,"name":"shape-probe",
 "objective":"Two trivial one-word steps","status":"complete","foreground":false,
 "phases":[{"title":"One","state":"done"},{"title":"Two","state":"done"}],"current_phase":"Two",
 "agent_budget":128,"agents_used":2,"agents_reserved":0,"agents_remaining":126,"elapsed_ms":9025,"active_agents":0,
 "agents":[{"agent_id":"01a0df1f-3d01-…","label":"step-one","phase":"One","state":"done","tokens_used":8273,"duration_ms":2287}, …],
 "last_event":"workflow_completed","result_summary":"{\"one\":\"alpha\",\"summary\":\"done\",\"two\":\"beta\"}"}
```

`last_event` walks `workflow_started` → `phase_entered` → … → `workflow_completed`.
No `workflow_started` / `workflow_completed` *sessionUpdate* kinds appeared; the
lifecycle lives only in `last_event`. Each `agent()` is also an ordinary
subagent: `subagent_spawned` with `description` = the agent label,
`capability_mode: "read-only"` and **`workflow_run_id`**, the child streams on
its own `sessionId`, then `subagent_progress` / `subagent_finished`. Completion
then wakes the parent in a turn nobody prompted: `turn_completed` with
`prompt_id: "workflow-completed-wf_01a0…-10"` and the parent's answer "alpha
beta", after the client's `session/prompt` had already returned.

### Replay

Lifecycle is replayed on **`_x.ai/session/update`** with `_meta.isReplay: true`:
`subagent_spawned` / `subagent_finished` (not `subagent_progress`), and only
`workflow_updated` revisions 1, 2, 6 and 10, followed by one more live
`workflow_updated` rev 10 on `_x.ai/session_notification` after the load. Tool
calls collapse into a single `tool_call` at final state (title already the
description, `status: "completed"`, `rawOutput` present). **Child transcripts
are never replayed.** The wake turn replays with a `user_message_chunk` that was
never sent live: "A background workflow stopped. Review the workflow completion
reminder, …" with `update._meta.hideFromScrollback: true`.

### Surprising

- `get_command_or_subagent_output` made grok send the **client** a
  `terminal/output` request whose `terminalId` is the subagent id
  (`01a0df1b-51c9-…`), a terminal the client never created. The probe refused
  it; grok returned the result anyway.
- Grok sends JSON-RPC **responses to requests the client never made**:
  `{"id":"skills-reload","result":{"result":{"reloaded":1}}}` and
  `{"id":"workflows-reload",…}`.
- No `session/request_permission` reached the client for `spawn_subagent`,
  `get_command_or_subagent_output` or `workflow`; grok emitted
  `pending_interaction {kind:"permission"}` then `interaction_resolved` itself
  (a user-global `pre_tool_use` hook also ran).
- `workflow_updated` carries no `display_name` / `phase` fields; the live names
  are `name` and `current_phase`.

## Codex

### Subagent, default handshake (`codex-subagent.jsonl`)

`multi_agent` is `stable true` in this CLI. No permission request. No child
output reaches the wire; the answer appears only in the parent's final message.

```jsonc
{"sessionUpdate":"tool_call","title":"Start subagent addition","kind":"other","toolCallId":"call_PVNQ…","status":"in_progress",
 "rawInput":{"agentThreadId":"01a0df1c-5ee8-…","agentPath":"/root/addition","activityKind":"started"},
 "_meta":{"codex":{"subagent":{"threadId":"01a0df1c-5ee8-…","path":"/root/addition","activity":"started"}}}}
{"sessionUpdate":"tool_call","toolCallId":"call_NVGk…","kind":"other","title":"wait","status":"in_progress",
 "rawInput":{"prompt":null,"senderThreadId":"<parent>","receiverThreadIds":[],"agentsStates":{},"status":"inProgress"},
 "_meta":{"codex":{"collaboration":{"tool":"wait","senderThreadId":"<parent>","receiverThreadIds":[]}}}}
{"sessionUpdate":"tool_call","title":"Complete subagent addition","kind":"other",
 "toolCallId":"subagent-completed-01a0df1c-6468-…","status":"in_progress",
 "rawInput":{"agentThreadId":"01a0df1c-5ee8-…","agentPath":"/root/addition","activityKind":"completed"}, "_meta":{"codex":{"subagent":{…,"activity":"completed"}}}}
```

Each is closed by a `tool_call_update status:"completed"`. `receiverThreadIds`
stays empty on the `wait` call even though it waited on the child. Replay
returns the same three calls; the start call gains
`rawOutput {"output":"{\"task_name\":\"/root/addition\"}"}`, which was never
sent live.

### Subagent, opt-in (`codex-subagent-optin.jsonl`)

```jsonc
// parent sessionId
{"sessionUpdate":"subagent_spawned","subagentSessionId":"01a0df1e-ee46-…","name":"Arithmetic","task":"Delegated task for Arithmetic","capabilities":{}}
// child sessionId 01a0df1e-ee46-…: session_info_update threadStatus active, agent_message_chunk "4" (_meta.codex.phase "final_answer"), threadStatus idle
// parent sessionId
{"sessionUpdate":"subagent_state_update","subagentSessionId":"01a0df1e-ee46-…","state":"completed"}
```

The start / complete tool calls disappear; the `wait` tool call remains.
`task` is a placeholder, not the child's prompt. **Replay is the most complete
of any provider**: `subagent_spawned`, the child's `agent_message_chunk` on the
child `sessionId`, and `subagent_state_update` all come back (the `wait` call does not).

### Workflow

None. Observed: the model answered `NO_WORKFLOW_MECHANISM` / "I have subagent
spawning, messaging, and waiting tools." `available_commands_update` lists
`plan mcp skills status review review-branch review-commit compact goal rename
logout` plus `$`-prefixed skills; nothing workflow-like. `codex --help` has no
workflow command. `/goal` exists and is a different feature.

## Claude Code

### Subagent, default handshake (`claude-subagent.jsonl`)

The `Agent` tool, streamed in pieces (`rawInput` grows over three updates):

```jsonc
{"sessionUpdate":"tool_call","toolCallId":"toolu_01GA…","title":"Task","kind":"think","status":"pending","rawInput":{},
 "_meta":{"claudeCode":{"toolName":"Agent","subagent":true}}}
// updates: title "Compute 2+2", rawInput {description, prompt, run_in_background:false}, content = the prompt
{"sessionUpdate":"tool_call_update","toolCallId":"toolu_01GA…","_meta":{"claudeCode":{"toolName":"Agent","toolResponse":{
  "status":"completed","agentId":"a38127c78899654ed","agentType":"general-purpose","content":[{"type":"text","text":"4"}],
  "resolvedModel":"claude-opus-5-5[1m]","totalDurationMs":1898,"totalTokens":36430,"totalToolUseCount":0,"usage":{…}}}}}
{"sessionUpdate":"tool_call_update","toolCallId":"toolu_01GA…","status":"completed",
 "rawOutput":[{"type":"text","text":"[Subagent hand-back] … The report follows:\n  4\nagentId: a381… (use SendMessage …)\n<usage>…</usage>"}],
 "content":[{"type":"content","content":{"type":"text","text":"4"}}]}
```

No child session, no child stream (this child used no tools, so child tool
calls with `_meta.claudeCode.parentToolUseId` were not exercised). Replay: one
`tool_call` at its final input, then the completed update; the `toolResponse`
meta is gone and `content` becomes the hand-back preamble text instead of "4".

### Subagent, opt-in (`claude-subagent-optin.jsonl`)

```jsonc
// parent sessionId
{"sessionUpdate":"subagent_spawned","subagentSessionId":"a7403efe6eda536e7","name":"Compute 2+2","task":"What is 2+2? …","capabilities":{}}
// child sessionId "a7403efe6eda536e7" (the Claude agentId, not a UUID)
{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"4"},"_meta":{"claudeCode":{"parentToolUseId":"toolu_01Hk…"}}}
{"sessionUpdate":"subagent_state_update","subagentSessionId":"a7403efe6eda536e7","state":"completed"}
```

No `tool_call` is sent for the `Agent` tool, but a lone `tool_call_update`
carrying `toolResponse` meta arrives for that never-announced `toolCallId`.
**Replay drops the subagent completely**: only the user message and the final
"4" come back.

### Workflow, default handshake (`claude-workflow.jsonl`)

Claude Code 2.1.281 has a `Workflow` tool (JS scripts with `agent()` /
`phase()`), and it goes through `session/request_permission`:

```jsonc
{"sessionUpdate":"tool_call","toolCallId":"toolu_01Rr…","title":"Workflow","kind":"other","status":"pending","rawInput":{},
 "_meta":{"claudeCode":{"toolName":"Workflow"}}}
// session/request_permission: toolCall.name "Workflow", options allow-once / allow-with-updates / reject
{"sessionUpdate":"tool_call_update","toolCallId":"toolu_01Rr…","_meta":{"claudeCode":{"toolName":"Workflow","toolResponse":{
  "status":"async_launched","taskId":"wa0bi8de9","taskType":"local_workflow","workflowName":"shape-probe",
  "runId":"wf_5562e303-f29","summary":"Two trivial one-word steps","transcriptDir":"…","scriptPath":"…"}}}}
// completed: rawOutput "Workflow launched in background. Task ID: wa0bi8de9 …"
```

Then nothing about the run: no phases, no agents, no completion event. The
prompt returns `end_turn`, and about two seconds later an `agent_message_chunk`
"alpha beta" arrives outside any prompt. On replay that wake turn appears as a
**plain `user_message_chunk` containing the raw `<task-notification>` XML**
(`<task-id>`, `<status>completed</status>`, `<result>{"one":"alpha","two":"beta"}</result>`, …)
with no hide flag, followed by the answer.

### Workflow, opt-in (`claude-workflow-optin.jsonl`)

The AIR `asyncTasks` capability adds three new `sessionUpdate` kinds on the
parent session beside the same tool call:

```jsonc
{"sessionUpdate":"async_task_spawned","asyncTaskId":"w6z17zrih","name":"Two trivial one-word steps","taskType":"workflow",
 "description":"Two trivial one-word steps","showInTranscript":false,"canStop":true}
{"sessionUpdate":"async_task_progress","toolCallId":"toolu_01T8…","asyncTaskId":"w6z17zrih"}
{"sessionUpdate":"async_task_progress","asyncTaskId":"w6z17zrih","description":"Two: step-two","summary":"Two trivial one-word steps",
 "lastToolName":"step-two","usage":{"totalTokens":70470,"toolUses":0,"durationMs":3073}}
{"sessionUpdate":"async_task_state_update","toolCallId":"toolu_01T8…","asyncTaskId":"w6z17zrih","state":"stopped"}
{"sessionUpdate":"async_task_state_update","toolCallId":"toolu_01T8…","asyncTaskId":"w6z17zrih","state":"completed"}
{"sessionUpdate":"async_task_state_update","toolCallId":"toolu_01T8…","asyncTaskId":"w6z17zrih","state":"completed","outputFilePath":"…\\tasks\\w6z17zrih.output"}
```

Progress is "`<phase>: <agent label>`" in `description`; there is no phase list,
no per-agent roster and no result on the wire (only an output file path). The
workflow's `agent()` calls do **not** produce `subagent_spawned` even with
`nativeSubagentSessions` advertised. The terminal edge says `stopped` then
`completed` twice. **Replay sends none of the `async_task_*` frames**: it is
identical to the default handshake's replay (tool call at `status: "pending"`,
the completed update, the raw `<task-notification>` user message, the answer).

## Muse Code

### What Muse offers

- No plain subagent tool. Asked for a subagent, the model used its **`workflow`**
  tool with a generated JS script (`host.agent({input})`); asked again with
  "plain subagent, not a workflow tool", it answered `NO_PLAIN_SUBAGENT_TOOL`
  (`muse-subagent-noworkflow.jsonl`). That is the model's report, not a tool list.
- MSP defines item kinds `subagent` and `workflow` (and `subagent/*`,
  `workflow/cancel`, `workflow/childControl` commands). Only `workflow` was emitted.
- `skill/list` returned the user's skills; nothing workflow-specific.

### MSP, under our adapter (`muse-subagent.jsonl`, `muse-workflow.jsonl`)

```jsonc
// item/started, kind toolCall
{"tool":"workflow","callId":"call_01a0df1e…","args":"{\"name\":\"alpha-beta two-step\",\"script\":\"export default async function workflow(host) { const a = await host.agent({ input: … }); … }\"}"}
// item/completed toolCall visibleOutput: {"status":"launched","entryId":"alpha-beta two-step","workflowRunId":"workflow-run-model-tool-call_01a0…",
//   "taskId":"…","scriptPath":"…","maxParallelAgents":16,"policy":{…},"message":"Workflow launched: the workflow runs in the background …"}
// item/started, kind workflow, then item/updated rev 2..11
{"kind":"workflow","status":"inProgress","fallbackText":"Workflow: model-chosen generated workflow",
 "workflowRunId":"workflow-run-model-tool-call_01a0…","entryId":"alpha-beta two-step","scriptId":"generated.workflow.alpha-beta_two-step",
 "triggerSource":"guidanceAuto","children":[{"childId":"01a0df1e-cf85-…","attempt":1,"status":"terminal","durationMs":4633,"terminal":"completed",
 "resultRef":"subagent-result://01a0df1e-cf85-…/task/6b58…#5"},{"childId":"01a0df1e-e253-…","attempt":1,"status":"started"}]}
// item/completed rev 12: status "completed", message "<workflow-launch-reconciled>{… \"final_summary\":{\"status\":\"completed\",\"summary\":\"{\\\"status\\\":\\\"ok\\\",\\\"a\\\":\\\"alpha\\\",\\\"b\\\":\\\"beta\\\"}\"} …}</workflow-launch-reconciled>"
```

Child status walks `scheduled` → `started` → `usage` (with token counts) →
`completed` → `terminal`. Children carry no label, no phase and no transcript
on the parent session; nothing was sent under a child session id. The prompt's
turn completes right after launch; completion starts a **second MSP turn**
(`turn/started` with a new `turnId`, triggered by `reminderChild` items) whose
`agentMessage` is the answer.

### ACP from our adapter

`adapters/muse/projection.mts` projects only `toolCall`, `agentMessage` and
`userMessage`, so the extension receives the `workflow` tool call and its
"launched" JSON, then later a bare `agent_message_chunk` "alpha beta" after
`session/prompt` has already returned `end_turn`. The `workflow` item, its
children and the reconciled summary are dropped live and on replay, although
MSP's inline resume history does carry the terminal `workflow` item.

## Cross-provider observations

- **Where the child speaks.** Grok, Codex-opt-in and Claude-opt-in put child
  output on a separate ACP `sessionId` over the same connection. Codex-default,
  Claude-default and Muse never send child output.
- **Linking parent to child.** Grok `child_session_id`/`parent_session_id` (+
  `workflow_run_id`); ACP RFD `subagentSessionId` on a parent-session
  `subagent_spawned`; Claude also stamps child updates with
  `_meta.claudeCode.parentToolUseId`; Codex default only `_meta.codex.subagent.threadId`.
- **Background work outlives the prompt.** Grok workflows and background
  subagents, Claude `Workflow`, and Muse `workflow` all return `end_turn`
  first and deliver the result in an unprompted turn later.
- **Replay fidelity varies inversely with opt-in for Claude** (default keeps
  the tool call; opt-in drops it) and directly for Codex (opt-in replays the
  child transcript).

## Inferred, not observed

- Grok `/workflow <saved>` failing with "unknown workflow" is probably the
  folder-trust gate on project workflows.
- Grok auto-approves `spawn_subagent` / `workflow` for ACP clients; whether
  that is a default or this machine's config was not isolated.
- The Codex and Claude opt-in shapes come from an ACP RFD
  (`sessionCapabilities.subagents`, both adapters advertise it) and the
  JetBrains AIR extension; neither is part of the published ACP schema this
  repo pins.

## Client mappings

| Provider | Live and cold replay | Controls / limitations |
|---|---|---|
| Grok | Tool calls create Subagent cards; lifecycle tags and finishes them. Existing workflow rollups feed `parseRunProgressUpdate`. | Existing behavior retained; child transcript is live-only. |
| Codex | ACP `subagents: {}` plus AIR `nativeSubagentSessions`, without `asyncTasks`. `normalizeCodexUpdate` makes `codex-subagent:<childId>` tool calls and maps terminal states to their updates. The card is tagged at creation, so child-session prose/tools use the existing mux on live and load. | Opt-in replaces default Start/Complete rows. Live `wait` stays; replay omits it. No workflow mechanism was captured. The installed adapter's initialize schema strips `subagents`; AIR metadata survives and enables its native gate. See [real-app fixes](lane-b-real-app-fixes.md). |
| Claude | Default handshake. Explicit `claudeCode.subagent: true` identifies the card. Backend normalization extracts output, duration and tokens from `toolResponse` and the hand-back trailer retained on replay. Workflow launch metadata (`async_launched`, `local_workflow`, `runId`) and the replay launch acknowledgement produce the same unpinned named launch receipt. | No child stream, no asyncTasks opt-in, no workflow controls. A later bare answer leaves the receipt as launched. A task notification completes it only when task, tool-use or run IDs identify the launch unambiguously. Task-notification XML becomes a session-scoped `planNotice`, never a user bubble. |
| Muse | `Projection.accept` projects full workflow snapshots into ACP `session_info_update._meta["muse/workflow"]`; `MuseBackend` extracts the rollup. The existing progress parser/card shows `children[]` as a numbered roster, token usage when reported, terminal states, and the reconciled `final_summary.summary` as Output. `acceptHistory` uses the same projection. | No driven controls, invented phases or completion percentage. `resultRef` is not fetched. Revisions suppress duplicate/stale snapshots. |

The host's `BackendUpdate.workflowUpdate` uses the existing lifecycle handler
to emit `runProgress`. Codex uses `toolCall` / `toolCallUpdate` and `childStream`;
Claude notices use the existing scoped `planNotice`, preceded on replay by the
existing `turn_completed` presentation boundary so the answer follows the
notice rather than appending to an earlier bubble. All are buffered and
mirrored by the existing remote policy; no host-to-relay message type is added.
During `session/load`, `AcpClient.loadingChildSessionIds` tracks explicit spawn
announcements. Only those IDs route to child streams before the RPC resolves;
other replay updates remain parent updates even when their wire ID differs
from the requested load ID. The set is cleared on success and failure without
prematurely claiming a successfully loaded session.
Muse projects structured JSON summaries as a labelled Markdown code block so
the entire returned value survives the shared Grok human-field output filter.
`controlsAvailable: false` is additive on the existing progress payload, and
the control handle is also omitted so older renderers cannot send commands.

### Background turns (item 5)

`AcpClient.onLine` routes `session/update` independently of its pending RPC
map. Resolving `session/prompt` with `end_turn` removes only that request;
`handleSessionUpdate` continues emitting messages. Sidebar's `messageChunk`,
tool and lifecycle listeners guard session generation, not `session.busy`,
and continue buffering/mirroring those messages. `appendAgent` likewise accepts
chunks without an `agentStart`. Muse's notification subscription and Projection
remain active after its pending turn resolves. Consequently background answers
already appear once; no new live turn synthesis or duplicate completion path is
needed. This does not add a busy indicator or a new turn footer for the wake-up.

### Validation and fixture hygiene

`test/fixtures/provider-delegation.json` whitelists relevant fields from these
captures and replaces identifiers, hand-back agent hints and launch paths with
neutral values. It contains no host paths, hostname or skill listing. The unit
and DOM tests cover provider isolation, live/load mappings, buffered reopen,
mirrored presentation, post-end-turn text, and pause Markdown (#189). The pause
block still reads only `workflowContent.pauseMessage`; stale event detail never
reappears there. `resultSummary` and pause text share `renderMarkdown` sanitizing.

The owner ran the full compile and suite. The follow-up fixes were checked with
only `test/codex-acp-integration.test.ts` and `test/provider-delegation.dom.test.ts`:
31 tests passed. No live agent was started or probed for implementation.
