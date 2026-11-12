// Reviewed against the host, not the provider's advertised capability menu.
// Grok's _meta is flat: each key is a field, NOT a provider namespace.
export const grokBoundaries = { handled: {}, ignored: {}, findings: {} };
function rows(status, boundary, names, reason) {
  const menu = grokBoundaries[status][boundary] ??= {};
  for (const name of names.split(" ")) menu[name] = reason;
}
const meta = (status, names, reason) => rows(status, "ACP metadata", names, reason);
meta("handled", "agentTimestampMs", "src/acp-dispatch.ts agentTimestampMsFromMeta / src/sidebar.ts: original message and replay timestamps.");
meta("handled", "defaultAuthMethodId", "src/sidebar.ts startSession: warnOAuthShadowOnce reads the initialize auth method.");
meta("handled", "hideFromScrollback", "src/acp-dispatch.ts updateHidesFromScrollback: hides CLI-only user chunks.");
meta("handled", "model", "src/acp.ts setModel / src/grok-backend.ts modelSetSucceeded: reads model.Ok acknowledgement.");
meta("handled", "reasoningEffort reasoningEfforts supportsReasoningEffort totalContextTokens", "src/acp.ts newSession/loadSession: model picker, supported effort menu and context window.");
meta("handled", "path scope", "src/slash-filter.ts isAdvertisedSkill / media/chat.js: skill file links and command scope.");
meta("handled", "totalTokens usage", "src/acp-dispatch.ts extractPromptUsage/gateZeroTokenMeta / src/sidebar.ts: context and per-prompt billing.");
meta("handled", "x.ai/tool", "media/webview-helpers.js isSubagentToolCall: recognizes spawn_subagent tool metadata.");
meta("ignored", "agentId agentInstanceId agentVersion hostname", "src/acp.ts start: provider instance diagnostics are not host identity or version probes.");
meta("ignored", "chunkId eventId promptId requestId promptIndex", "src/acp.ts onLine/handleSessionUpdate: JSON-RPC IDs and session IDs route events; provider trace IDs/index are unused.");
meta("ignored", "streamStartMs turnStartMs", "src/sidebar.ts message handlers use agentTimestampMs and host turn timing, not provider stream clocks.");
meta("ignored", "updateType updateParams", "src/acp-dispatch.ts parseAcpLine/routeSessionUpdate: params.update is authoritative; metadata copies are unused.");
meta("handled", "inputTokens outputTokens cachedReadTokens reasoningTokens modelId", "src/acp-dispatch.ts extractPromptMeta: reads flat last-call counters/model into PromptResultMeta; extractPromptUsage separately reads aggregate billing.");
meta("ignored", "sessionId", "src/acp.ts newSession/handleServerRequest: session identity comes from result/params.sessionId, not the duplicate metadata field.");
meta("ignored", "agentType", "src/acp.ts newSession: host model menu uses advertised IDs/efforts; CLI owns agent implementation selection.");
meta("ignored", "modelState x.ai/sessionConfig x.ai/sessionDetail", "src/acp.ts newSession / src/grok-backend.ts configState: standard models/modes and sessionId are used instead of duplicate CLI configuration envelopes.");
meta("ignored", "availableCommands", "src/acp-dispatch.ts routeSessionUpdate: available_commands_update supplies the command menu; initialize metadata copy is unused.");
meta("ignored", "tools", "src/acp.ts handleSessionUpdate / media/chat.js: cards consume actual tool_call updates, not advertised tool schemas.");
meta("ignored", "mcpServers mcpApps x.ai/mcp/sdk x.ai/pluginDirs", "src/acp.ts listMcpServers / src/sidebar.ts applyMcpNotification: explicit MCP RPCs and status notifications supply the connector UI.");
meta("ignored", "currentWorkingDirectory gitRoot isGitRepo showNonGitWarning codebaseIndexed", "src/sidebar.ts startSession: host workspace/Git discovery owns project state; CLI startup diagnostics are unused.");
meta("ignored", "grokShell", "src/grok-backend.ts spawn / src/sidebar.ts buildEnv: host TerminalManager and GROK_SHELL own shell execution; initialize flag is unused.");
meta("ignored", "cancelRewind", "src/acp.ts listRewindPoints/executeRewind: explicit rewind RPCs determine support; initialize hint is unused.");
meta("handled", "feedbackEnabled", "src/feedback.ts parseFeedbackEnabledMeta / src/sidebar.ts session listener: enables the thumbs feedback surface.");
meta("ignored", "voiceMode", "src/sidebar.ts: host dictation configuration owns voice UI; CLI voice hint is unused.");
meta("ignored", "metadata sessionRecap", "src/acp.ts newSession: optional CLI startup/recap annotations are unused; transcript comes through session updates.");
meta("ignored", "subagentBackground", "src/sidebar.ts subagentLifecycle/xaiNotification: spawn/finish events and tool calls own cards; background hint is unused.");
meta("ignored", "x.ai/schedulerBackgroundLoops", "src/run-progress.ts parseRunProgressUpdate: workflow lifecycle snapshots drive cards; scheduler capability hint is unused.");
rows("ignored", "ACP method", "_x.ai/announcements/update", "src/acp.ts handleServerRequest: falls through to serverRequest; CLI announcements have no host surface.");
rows("ignored", "ACP method", "_x.ai/models/update", "src/acp.ts newSession/loadSession: session catalog is authoritative; unsolicited global catalog broadcasts are not applied.");
rows("ignored", "ACP method", "_x.ai/queue/changed", "src/sidebar.ts send: host owns its prompt queue; CLI queue broadcasts are not a host control surface.");
rows("ignored", "ACP method", "_x.ai/sessions/changed", "src/sidebar.ts postSessionsList/buildSessionsList: host history refresh owns the catalog; CLI global list invalidations are unused.");
rows("ignored", "ACP method", "_x.ai/settings/update", "src/sidebar.ts: host configuration and acknowledged model/mode changes own settings; CLI global settings broadcasts are unused.");
rows("handled", "ACP update", "hook_execution", "src/grok-hooks.ts / src/acp.ts routeHookUpdate: Stop, StopFailure and SubagentStop results become tool rows with failure diagnostics; other hook events remain ignored.");
rows("ignored", "ACP update", "pending_interaction interaction_resolved", "src/acp.ts handleServerRequest: session/request_permission and question RPC responses own interactive cards; lifecycle echoes are unused.");
rows("ignored", "ACP update", "response_completed", "src/acp-dispatch.ts extractPromptUsage / src/sidebar.ts prompt completion: aggregate prompt usage is authoritative, not per-inference usage/signatures.");
rows("ignored", "ACP update", "session_summary_generated", "src/sidebar.ts xaiNotification/postSessionName: summary notification is unused; cliSessionTitle reads persisted titles on history refresh (live titles arrive through session_info_update).");
rows("ignored", "ACP update", "tool_call_delta_chunk", "src/acp-dispatch.ts routeSessionUpdate: complete tool_call/rawInput creates cards; incremental pre-call argument fragments are not rendered.");
rows("ignored", "ACP update", "subagent_progress", "src/acp-dispatch.ts isSubagentLifecycleUpdate: deliberately excluded periodic progress; spawn/finish and child streams own cards.");
// Seen only in the full test:live run (edits, Stop, reopen, background tasks), 2026-09-27.
meta("handled", "details old_line new_line", "media/chat.js extractDiffSites: edit-diff sites from _meta.details[] and the echo's first-site old_line/new_line.");
meta("ignored", "isReplay", "src/sidebar.ts: replay is known from the host's own session/load and historyReplay state; the per-update flag is unused.");
meta("ignored", "cancellationCategory", "src/acp.ts prompt result: a cancelled turn is read from stopReason \"cancelled\"; the category is diagnostic.");
rows("ignored", "ACP method", "_x.ai/task_backgrounded _x.ai/task_completed", "src/acp-dispatch.ts routeSessionUpdate handles the same events as session/update task_backgrounded / task_completed; these standalone notifications duplicate them.");
rows("ignored", "ACP method", "_x.ai/session/interjection", "ACCEPTED pre-existing gap (backlog): no host reader for Grok's interjection notice.");
// ACCEPTED entries are real, pre-existing gaps that were triaged and backlogged. They stay
// listed with their reason in every report; only a NEW unknown kind fails the audit.
// Seen once in the 4.15.2 release gate's test:live (grok 1.0.62): session/request_permission carried
// _meta {kind:"sensitive"} on an execute approval. The card renders and asks like any other.
meta("ignored", "kind", "ACCEPTED pre-existing gap (backlog: Grok marks some approvals sensitive): the permission card asks as usual; the sensitivity label is not shown, and Auto accept answers it as Grok's own --always-approve would.");
rows("ignored", "ACP update", "retry_state", "ACCEPTED pre-existing gap (backlog): Grok reports a model-request retry and no host code shows it; the turn continues normally once the retry succeeds.");
// New in grok 1.0.41 (auto-updated 2026-09-28, after 4.13.3 shipped). All notifications, none awaits a reply;
// the render sections stay clean without them. Backlog: "Grok 1.0.41 sends ten kinds nothing reads".
rows("handled", "ACP update", "hook_run_started", "src/grok-hooks.ts / src/acp.ts routeHookUpdate: awaited Stop, StopFailure and SubagentStop batches show running tool rows; pre/post tool hooks remain ignored.");
rows("ignored", "ACP update", "last_turn_summary", "ACCEPTED pre-existing gap (backlog: Grok 1.0.41 kinds): an end-of-turn summary notification; nothing shows it.");
rows("ignored", "ACP update", "background_tasks", "ACCEPTED pre-existing gap (backlog: Grok 1.0.41 kinds): a snapshot list of the session's background tasks; the per-task task_backgrounded / task_completed events already drive the cards.");
meta("ignored", "bareName qualifiedName pluginName workflowPath workflowSource feedbackTraceOffer x.ai/memoryMode", "ACCEPTED pre-existing gap (backlog: Grok 1.0.41 kinds): extra labels on tool, workflow and session events; the fields the renderer reads are unchanged.");
// New by grok 1.0.52 (seen in the 4.14.2 release test:live, 2026-10-13). Backlog: "Grok 1.0.52 metadata nothing reads".
meta("handled", "contextWindows", "src/acp.ts contextWindowSizes: a model's selectable context sizes (e.g. [256000, 500000]) feed the context popup's context-window dropdown and /context-window <size> (#202, 4.14.3).");
meta("ignored", "requestTrimmedTokens", "ACCEPTED pre-existing gap (backlog: Grok 1.0.52 metadata): tokens the CLI trimmed from a request, beside totalTokens on session updates; the meter reads totalTokens.");
meta("ignored", "x.ai/memoryNotesWritable", "ACCEPTED pre-existing gap (backlog: Grok 1.0.52 metadata): whether the CLI's memory notes are writable for the session; no host surface for memory notes.");
meta("ignored", "x.ai/requestingSessionId", "ACCEPTED pre-existing gap (backlog: Grok 1.0.52 metadata): the session that raised a permission request; approval already answers on the request's own session, the card does not name a requesting child.");
// New by grok 1.0.70 (seen in the 4.15.4 release test:live, 2026-10-28). Backlog: "Grok 1.0.70 displayName".
meta("ignored", "displayName", "ACCEPTED pre-existing gap (backlog: Grok 1.0.70 displayName): another label beside bareName/qualifiedName on a skill command and beside workflowPath on a workflow_updated rollup; the slash menu reads the command's name and the workflow card its title.");
// New by grok 1.0.77 (seen in the 4.15.9 release test:live, 2026-11-12). Backlog: "Grok 1.0.77 turnCount".
meta("ignored", "x.ai/session/turnCount", "ACCEPTED pre-existing gap (backlog: Grok 1.0.77 turnCount): the CLI's own count of a session's turns; the host keeps its own history and shows no turn count.");
rows("handled", "ACP update", "workflow_updated", "src/run-progress.ts parseRunProgressUpdate / src/sidebar.ts xaiNotification: workflow phase/status/result snapshots drive cards.");
rows("handled", "ACP update", "subagent_spawned subagent_finished turn_completed", "src/sidebar.ts subagentLifecycle/xaiNotification / media/chat.js: child lifecycle and replayed turn completion.");
rows("handled", "ACP update", "model_changed", "src/acp.ts handleServerRequest: synchronizes current model and effective effort.");
rows("handled", "ACP update", "agent_message_chunk agent_thought_chunk user_message_chunk available_commands_update tool_call tool_call_update", "src/acp-dispatch.ts routeSessionUpdate / src/sidebar.ts: standard message, command and tool event routing; hidden user chunks may deliberately be dropped.");
rows("handled", "ACP method", "session/update", "src/acp-dispatch.ts parseAcpLine / src/acp.ts handleSessionUpdate: standard update routing.");
rows("handled", "ACP method", "_x.ai/session_notification _x.ai/session/prompt_complete _x.ai/session/update", "src/acp.ts handleServerRequest / src/sidebar.ts: live notification, completion and replay lifecycle rails.");
rows("handled", "ACP update", "session_info_update", "src/grok-backend.ts normalizeUpdate -> sessionTitle: live rail/header title, with customName taking precedence.");
rows("handled", "ACP method", "_x.ai/session/setup", "src/acp.ts sessionSetup / src/sidebar.ts: session-scoped detail inside the Opening the conversation startup stage.");
rows("handled", "ACP method", "_x.ai/mcp_initialized _x.ai/mcp/servers_updated", "src/acp.ts handleServerRequest / src/sidebar.ts applyMcpNotification: connector status refresh.");
rows("handled", "ACP method", "fs/read_text_file", "src/acp.ts handleServerRequest: host file read response.");
