# Lane B real-app follow-up

Evidence supplied by the owner includes the 2026-09-27 `real-screens/INDEX.md`,
screenshots, `diag/*hostlog.json` and `diag/desktop.log` at `a06ec1c`, plus a
subsequent real-app run confirming Codex's live/reopened Subagent card and child
stream and Claude's unpinned launched receipt with completion after reopen.
The analysis below also uses installed adapter code and hermetic tests.

## 1. Codex handshake

The missing cards already occurred before Lane B; `a06ec1c` added an ineffective
opt-in. In the installed codex-acp bundle, `zClientCapabilities` has no `subagents`
property. The initialize parser drops that property before
`CodexAcpServer.initialize` stores `clientCapabilities`. Testing the unparsed
object against `clientSupportsSubagents` hid the defect.

The complete gate audit in `node_modules/@agentclientprotocol/codex-acp/dist/index.js`:

- `clientSupportsSubagents` accepts an object `subagents` OR
  `clientSupportsAirCapability(..., AIR_NATIVE_SUBAGENT_SESSIONS_KEY)`.
- The AIR gate requires `_meta.jetbrains.air.version` to be an integer >= 1 and
  its `capabilities` array to include `nativeSubagentSessions`.
- Session creation/resume and load construct `CodexSubagentEventRouter` using
  that predicate. The live `subscribeToSessionEvents` call uses it too.
- The router's `supported` flag governs native materialization and consumption
  of `subAgentActivity` / `collabAgentToolCall`. Unconsumed collaboration items
  reach `legacyCollaborationStarted/Completed`, producing the observed generic
  Start/Complete tool calls. Child subscriptions also use `supportsSubagents`.
- History branches on the same predicate into `streamNativeThreadHistory`;
  that branch suppresses legacy `collabAgentToolCall` rows. Without it,
  `createHistoryUpdates` emits the generic collaboration tool rows.
- `AIR_ASYNC_TASKS_KEY` is used independently by `createAsyncTasks`. It enables
  publication/tracking of async tasks and their stop interface; it is not a
  prerequisite of native subagent sessions. It remains disabled.

Only Codex advertises the AIR native capability. The regression test executes
this installed bundle's actual initialize parser and both predicates with all
four providers' capabilities, and demonstrates the old handshake failing after
parsing. It never starts the CLI.

## 2. Claude receipt

Introduced by `a06ec1c`: an `async_launched` acknowledgement was synthesized as a
running workflow with a generic title. There was no progress/completion stream
behind that label. The card is now `launchOnly`, not pinned, with no freshness or
live progress UI. Live metadata supplies `workflowName`; replay's generated
`Script file: <name>-<exact run id>.js` supplies the same name and `Summary:` the
description. A second acknowledgement cannot erase a previously known name.

The backend remembers exact launch tool-use, task and run IDs. A terminal task
notification must match a known launch, and matching IDs must not disagree,
before it changes the receipt to done/failed/cancelled. Uncorrelated text remains
ordinary content; task-notification XML remains a safe notice. DOM tests cover
desk, mirrored phone payloads, live and replay, names, descriptions and no pins.

## 3. Muse reopening

The Muse session-already-in-use failure is pre-existing (`v4.13.1` lifecycle code matches `a06ec1c`), unexplained, and was not fixed in this lane. The supplied real-app evidence includes failed reopens after restart with dead PIDs in `.session.lock` files and no surviving dev-instance Muse process at quit. Muse lifecycle, quit handling, resume behavior and history visibility remain exactly as in `a06ec1c`.

## 4. Grok ordering

Pre-existing; left unchanged. A DOM replay comparison executed both
`git show v4.13.1:media/chat.js` and the working renderer on the same sequence:
parent prose, `spawn_subagent`, completion, final `4`, agent end. Both render
one parent bubble ending `returns.4` above the card, matching the supplied
screenshot. `addSubagentCard` closes the tool group but retains the current agent
bubble, so the final chunk appends there. This comparison is a renderer replay,
not a second real CLI run. The requested backlog items remain unchanged.
