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
rows("ignored", "ACP update", "hook_execution", "src/sidebar.ts xaiNotification: CLI hook diagnostics have no host hook-execution surface.");
rows("ignored", "ACP update", "pending_interaction interaction_resolved", "src/acp.ts handleServerRequest: session/request_permission and question RPC responses own interactive cards; lifecycle echoes are unused.");
rows("ignored", "ACP update", "response_completed", "src/acp-dispatch.ts extractPromptUsage / src/sidebar.ts prompt completion: aggregate prompt usage is authoritative, not per-inference usage/signatures.");
rows("ignored", "ACP update", "session_summary_generated", "src/sidebar.ts xaiNotification/postSessionName: summary notification is unused; cliSessionTitle reads persisted titles on history refresh (live title gap tracked by session_info_update).");
rows("ignored", "ACP update", "tool_call_delta_chunk", "src/acp-dispatch.ts routeSessionUpdate: complete tool_call/rawInput creates cards; incremental pre-call argument fragments are not rendered.");
rows("ignored", "ACP update", "subagent_progress", "src/acp-dispatch.ts isSubagentLifecycleUpdate: deliberately excluded periodic progress; spawn/finish and child streams own cards.");
// ACCEPTED entries are real, pre-existing gaps that were triaged and backlogged. They stay
// listed with their reason in every report; only a NEW unknown kind fails the audit.
rows("ignored", "ACP update", "session_info_update", "ACCEPTED pre-existing gap (backlog: Grok renames a conversation mid-session and the rail does not follow): src/sidebar.ts xaiNotification has no title-update handler; the title arrives on history refresh via cliSessionTitle.");
rows("ignored", "ACP update", "retry_state", "ACCEPTED pre-existing gap (backlog): Grok reports a model-request retry and no host code shows it; the turn continues normally once the retry succeeds.");
rows("handled", "ACP update", "workflow_updated", "src/run-progress.ts parseRunProgressUpdate / src/sidebar.ts xaiNotification: workflow phase/status/result snapshots drive cards.");
rows("handled", "ACP update", "subagent_spawned subagent_finished turn_completed", "src/sidebar.ts subagentLifecycle/xaiNotification / media/chat.js: child lifecycle and replayed turn completion.");
rows("handled", "ACP update", "model_changed", "src/acp.ts handleServerRequest: synchronizes current model and effective effort.");
rows("handled", "ACP update", "agent_message_chunk agent_thought_chunk user_message_chunk available_commands_update tool_call tool_call_update", "src/acp-dispatch.ts routeSessionUpdate / src/sidebar.ts: standard message, command and tool event routing; hidden user chunks may deliberately be dropped.");
rows("handled", "ACP method", "session/update", "src/acp-dispatch.ts parseAcpLine / src/acp.ts handleSessionUpdate: standard update routing.");
rows("handled", "ACP method", "_x.ai/session_notification _x.ai/session/prompt_complete _x.ai/session/update", "src/acp.ts handleServerRequest / src/sidebar.ts: live notification, completion and replay lifecycle rails.");
rows("handled", "ACP method", "_x.ai/mcp_initialized _x.ai/mcp/servers_updated", "src/acp.ts handleServerRequest / src/sidebar.ts applyMcpNotification: connector status refresh.");
rows("handled", "ACP method", "fs/read_text_file", "src/acp.ts handleServerRequest: host file read response.");
