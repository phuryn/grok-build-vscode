(function () {
  const vscode = acquireVsCodeApi();
  // True in the relay's browser client (its chat.html shim sets the flag before
  // loading this file); always false inside the VS Code webview. Gates the
  // host-only affordances: worktree/rewind actions (their host flows run native
  // VS Code UI a browser user can't see) and the AFK Pilot account section.
  const IS_REMOTE = !!window.grokRemoteClient;

  const $ = (id) => document.getElementById(id);
  const messagesEl = $("messages");
  const input = $("input");
  const sendBtn = $("send-btn");
  const micBtn = $("mic-btn");
  const inputHighlight = $("input-highlight");
  const newBtn = $("new-btn");
  const historyBtn = $("history-btn");
  const repoBtn = $("repo-btn");
  const modeBtn = $("mode-btn");
  const gearBtn = $("gear-btn");
  const addBtn = $("add-btn");
  const chipsEl = $("chips");
  const attachmentsEl = $("attachments");
  const donutEl = $("donut");
  const donutArc = $("donut-arc");
  const donutLabel = $("donut-label");
  const contextPopover = $("context-popover");
  const slashPopover = $("slash-popover");
  const mentionPopover = $("mention-popover");
  const modePopover = $("mode-popover");
  const gearPopover = $("gear-popover");
  const addPopover = $("add-popover");
  const historyPopover = $("history-popover");
  const repoPopover = $("repo-popover");
  const scrollBottomBtn = $("scroll-bottom-btn");

  // Canonical low→high ORDER for known effort ids, and the FALLBACK ladder when a
  // model advertises no menu (`max` is not a real grok level — see #3/#4).
  const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh"];
  const EFFORT_TOOLTIPS = {
    none: "None — no extra reasoning",
    minimal: "Minimal — least reasoning",
    low: "Low — fast, lightweight reasoning",
    medium: "Medium — balanced",
    high: "High — deeper reasoning",
    xhigh: "XHigh — deepest reasoning, slowest",
  };

  // The effort levels the gear picker OFFERS: the ACTIVE model's advertised menu
  // (`models[]._meta.reasoningEfforts`, already delivered to the webview on the
  // `session` message), ordered low→high with any unknown advertised value
  // appended. Falls back to the full ladder only when a model advertises none
  // (older CLI / non-reasoning model). So the dots always match what the current
  // model actually accepts — not a hardcoded set (grok-4.5 advertises just
  // low/medium/high). The advertised list rides in state.availableModels, which
  // is our per-session cache; the picker is locked until that's loaded anyway.
  function effortLevelsForModel() {
    const m = (state.availableModels || []).find((x) => x && x.modelId === state.currentModelId);
    const adv = m && Array.isArray(m.reasoningEfforts)
      ? m.reasoningEfforts.filter((v) => typeof v === "string" && v)
      : [];
    if (!adv.length) return EFFORT_LEVELS.slice();
    const known = EFFORT_LEVELS.filter((id) => adv.includes(id));
    const extra = adv.filter((id) => !EFFORT_LEVELS.includes(id)); // unknown advertised → keep as given
    return [...known, ...extra];
  }

  const state = {
    welcomeVisible: true,
    currentModelId: null,
    availableModels: [],
    currentModeId: "agent",
    effort: "",
    cwd: "",
    contextWindow: 200000,
    usedTokens: 0,
    useCtrlEnter: false,
    commands: [],
    chips: [],
    // Start busy+locked: opening the view immediately spins up a session
    // (ready → startSession), so the send button shows the spinner from the
    // first paint until the host posts setBusy:false once the session is live.
    busy: true,
    // Voice-input button: "idle" | "listening" | "transcribing" (see nextMicState).
    mic: "idle",
    // Whether the host found a voice API key. Optimistic until the host says
    // otherwise; drives the mic button's "needs setup" hint.
    voiceConfigured: true,
    // Streaming dictation: text typed before the mic started ("base"), and
    // whether live partials have begun replacing the tail.
    voiceBase: "",
    voiceLive: false,
    // The configured send phrase (for highlighting it in the composer).
    voiceSendPhrase: "grok send",
    // Render MIRROR of the focused session's host-owned send queue (#37) —
    // messages typed/dictated while Grok was busy. All mutations route through
    // the host (queueSend/dequeueSend/clearQueuedSends) and come back as a
    // queuedSends snapshot, so the queue survives focus switches and the HOST
    // flushes it (one combined prompt) when the session's turn ends.
    sendQueue: [],
    queuedWrapEl: null, // the .queued-msgs container pinned to the end of the chat
    // Steer (#52). Optimistic: `_x.ai/interject` is unadvertised, so we can't ask
    // whether it works — we offer it and let the host latch this off the first
    // time the CLI answers -32601 (the text falls back to the queue, never lost).
    steerSupported: true,
    lastTurnUsage: null, // last prompt's billing split (#53), for the donut popover
    sessionUsage: null, // session-cumulative billing — summed by the host, not grok
    activeAgentEl: null,
    activeAgentRaw: "",
    activeUserEl: null,
    activeUserRaw: "",
    // Count of clipboard images still being read (FileReader in flight). Send
    // is held while > 0 so a paste-then-Enter can't race the image onto the
    // NEXT message — the pasteImage post must reach the host before send does.
    pendingPaste: 0,
    activeThoughtEl: null,
    activeThoughtHdrEl: null,
    thoughtStartTime: null,
    activeToolGroupEl: null,
    slashFiltered: [],
    slashActive: 0,
    // "@" file popover: the rows the host sent for the current token
    // (mentionResults), the highlighted row, and the token the rows answer —
    // null while no token is under the caret (stale replies are dropped
    // against it, so fast typing can't render an older query's rows).
    mentionFiles: [],
    mentionActive: 0,
    mentionQuery: null,
    pendingDiffByToolCallId: new Map(),
    toolItemsByToolCallId: new Map(),
    toolFailuresById: new Map(), // toolCallId → error text, so a single-call group carries it onto the flat

    agentRenderScheduled: false,
    thoughtBuffer: "",
    thoughtRenderScheduled: false,
    sessions: [],
    repos: [],
    // Set by the first `repos` frame — the host's proof that it supports the
    // switcher at all. Older extensions never send one (see repoSwitcherAvailable).
    reposKnown: false,
    selectedRepoCwd: "",
    activeRepoCwd: "",
    activeSessionId: null,
    // Dashboard dot per grok-session id (id → "working"|"needs-you"|"unread"|
    // "error"|"none"). The host computes the value (live status + persisted unread
    // badge); the webview just paints it. Sent in full on each `sessions` message
    // and patched incrementally by `sessionDot`.
    dots: {},
    sessionSearch: "",
    renamingSessionId: null,
    // History pagination: the host sends one page at a time (newest-first by last
    // activity) so the popover stays fast with thousands of sessions. `sessionTotal`
    // is the full count (or matched count when searching); `sessionHasMore` drives the
    // scroll-to-load; `sessionLoading` guards against firing overlapping load-more
    // requests; `sessionQuery` is the query the loaded page belongs to (so a stale
    // page from a previous keystroke is ignored).
    sessionTotal: 0,
    sessionHasMore: false,
    sessionLoading: false,
    sessionQuery: "",
    // Index offset for the next load-more (from the host's `nextOffset` — slots
    // consumed, not entries shown; hidden subagent sessions occupy slots).
    sessionNextOffset: null,
    replaying: false,
    // Live ask_user_question tool calls (toolCallId → {questions, fromReplay}).
    // grok emits a tool_call alongside the live x.ai/ask_user_question request; we
    // stash it to suppress the generic tool chip (the interactive card from
    // `questionRequest` stands in).
    questionToolCalls: new Map(),
    // Subagent delegation rows (toolCallId → card element) so the completed
    // tool_call_update finds its row (title refinement, duration, result)
    // instead of leaking into the generic tool group.
    subagentCards: new Map(),
    // Deep Research / Workflow / Goal progress cards (P2-10) — keyed by run/goal id.
    runProgressCards: new Map(),
    // The current turn's agent-message footer (copy + timestamp). Only the
    // turn's LAST narration segment keeps one — see addMessage.
    turnAgentActionsEl: null,
    // Turn-level file-change summary: per-tool-call edit stats for the open
    // agent turn (path-deduped into a "Changed N files" card). Cleared on
    // agentStart / next user message; the card itself stays in the transcript.
    turnEditsByToolCallId: new Map(),
    turnDiffSummaryEl: null,
    // Host turn id (agentStart.turnId) + baseline *metadata* per turn (content
    // stays on the host). Powers View deleted / Undo on the summary card.
    currentTurnId: 0,
    baselineMetaByTurn: new Map(), // turnId → [{ path, kind, reason? }]
    // Restored question cards on resume (toolCallId → card element). On replay grok
    // sends a tool_call per question (with rawInput.questions); we render the card
    // immediately and fill the answer in whenever it arrives — on the tool_call
    // snapshot or a later update with the same toolCallId.
    restoredCardsByToolCallId: new Map(),
    // Saved plan cards waiting to be rendered inline as the conversation replays.
    // Each entry has { text, verdict, afterUserMessage? }. We drain entries whose
    // afterUserMessage matches the current userMsgCount as user messages stream
    // in, and dump anything left (legacy plans w/o position, or plans after the
    // last replayed user msg) at the end of replay.
    planHistoryQueue: [],
    // Answered permission cards from a resumed session, drained inline like plans
    // (each { title, outcome, afterUserMessage? }). The CLI doesn't replay the
    // request, so the host persists + re-queues these.
    permissionHistoryQueue: [],
    userMsgCount: 0,
    // Element rendered below a resolved plan card while the host is waiting on
    // grok's response to the verdict (or its comment). Visible only between
    // the verdict click and the first incoming agent chunk; cleared by any
    // arriving content or by reset.
    planProcessingEl: null,
    // The "Grokking…" placeholder shown while a user-initiated turn is waiting on
    // grok — from the moment the user sends (agentStart) until the first real
    // content arrives (a thought, message, tool card, …), which replaces it in
    // place. Same font + animated dots as the Thinking header, minus the expand
    // chevron. Covers the held-behind-primer gap too: the message shows as sent,
    // this spins, then the real Thinking block takes over. Never shown for the
    // silent primer turn (which emits no agentStart). One at a time with
    // planProcessing (each hides the other).
    grokkingEl: null,
    // When true, the busy state is "locked" (e.g. session-start priming): the
    // send button shows a spinner and is disabled. When false, busy is
    // "stoppable" (regular prompts, verdict afterTurn) and the send button
    // shows a stop icon that the user can click to cancel grok mid-stream.
    // Starts true so the very first paint is the disabled spinner (see `busy`).
    busyLocked: true,
    // grok CLI version from the ACP `initialized` handshake, plus a flag marking
    // the session-start window: while startingPhase is true the welcome line
    // shows "starting…"; it flips to "connected · v<cliVersion>" only when the
    // priming spinner clears (setBusy:false). See the initialized/setBusy cases.
    cliVersion: "",
    startingPhase: false,
    // Extension version (from initialState) — shown in the gear → About panel.
    extVersion: "",
    // Which gear-popover view is showing ("main"|"model"|"about"|"config"), so an
    // async grokUpdateStatus only re-renders About when it's the visible view.
    gearView: "main",
    // Latest `grok update --check` result for the About panel: { checking } while
    // in flight, then { current, latest, updateAvailable, error }.
    grokUpdate: null,
    // While replaying, suppress everything from the start of the current user
    // message (a primer turn) through the end of grok's response to it — until
    // the next user message starts. Keeps the chat clean of our session-start
    // priming when the user resumes a session.
    suppressReplayTurn: false,
    // While replaying, suppress just the user bubble for a marker-only verdict
    // message ([Plan cancelled] with no comment) — grok's response to it still
    // renders. Distinct from suppressReplayTurn (which hides the whole turn).
    skipUserBubble: false,
    // Whether the chat is "pinned" to the bottom. A scroll listener flips this
    // off the moment the user scrolls up to read earlier messages; while it's
    // off, streaming thought/agent chunks no longer yank the view back down
    // (#16). Interactive activity (permission/question cards, the user's own
    // sent message) re-pins via forceScrollToBottom().
    stickToBottom: true,
    // grok.showThinking (#26). Thinking traces are hidden by default; when hidden
    // a lightweight "Thinking…" indicator stands in while grok reasons (and no
    // tool/Grokking indicator is already showing). Toggle lives in gear → Config
    // & debug. The host posts the real value on init and on config change.
    showThinking: false,
    thinkingIndicatorEl: null,
    // Command rows awaiting their output ({command, details, done}) — the
    // host's commandOutput (snapshotted at terminal/release, #41) attaches to
    // the oldest un-served row with the exact same command string (FIFO).
    pendingCommandDetails: [],
    // grok.expandCommandOutputs (persisted, global): the standing DEFAULT for
    // new content — command IN/OUT details pre-open, and command-bearing groups
    // auto-open. Command scope only (explore/edit groups stay collapsed).
    expandCommandOutputs: false,
    // grok.steerByDefault (persisted, global): when true a message sent while
    // grok is working SKIPS the queue and is interjected into the running turn.
    // False = today's behavior (queue, with an on-demand Steer button).
    steerByDefault: false,
    // grok.soundNotifications (persisted, global): when true a short synth tone
    // plays on turn completion / error, but only when the Grok panel isn't
    // focused (#59). Off by default. Host posts the value on init + config change.
    soundNotifications: false,
    // grok.worktree — true when the focused session runs in an isolated git
    // worktree (from the `session` message). Gates the gear Apply/Remove items.
    isWorktree: false,
    // Whether the host machine holds a relay device token (`remoteStatus`).
    // Drives the gear AFK Pilot items; never sent to remote clients.
    remoteLinked: false,
    // toolExpandOverride (per-session, in-memory): the Command Palette
    // Expand/Collapse All latch. null = follow the setting above; true/false =
    // force ALL groups + details open/closed for this session, and keep applying
    // to new content as it streams in (last action wins vs the setting). Rides
    // the session's replay buffer, so it survives focus-swaps but resets on a
    // cold reopen from history — see resetForNewSession + the emit in sidebar.ts.
    toolExpandOverride: null,
  };

  // Matches any version of the extension's primer (v1, v2, …). Used during
  // session replay to detect and hide the primer + grok's ack from the
  // restored conversation.
  const PRIMER_PATTERN = /^\s*\[grok-build-vscode primer v\d+\]/;

  // The CLI feeds background-task notices (and similar plumbing) back to the
  // agent as a user_message_chunk wrapped in <system-reminder>…</system-reminder>.
  // It's agent-facing context the user never typed — keep it out of the chat
  // on replay (the host surfaces task completion as a one-shot notification).
  const SYSTEM_REMINDER_PATTERN = /^\s*<system-reminder>/;

  // The host prepends a plan-verdict protocol marker ([Plan approved|rejected|
  // cancelled]) to the wire-level prompt so grok can recognize the verdict. It's
  // grok-only plumbing — never shown live. On replay grok echoes the raw prompt,
  // so strip the marker here to keep the restored view consistent with live.
  const PLAN_MARKER_PATTERN = /^\s*\[Plan (approved|rejected|cancelled)\]\s*/i;
  function stripPlanMarker(text) {
    const m = PLAN_MARKER_PATTERN.exec(text || "");
    if (!m) return { matched: false, rest: text };
    return { matched: true, rest: (text || "").slice(m[0].length) };
  }

  // ---------- icons ----------

  const ICON = {
    eye: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`,
    eyeOff: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>`,
    file: `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>`,
    panelLeft: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></svg>`,
    panelRight: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/></svg>`,
    panelBottom: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 15h18"/></svg>`,
    image: `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>`,
    cpu: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/></svg>`,
    squarePen: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/></svg>`,
    arrowUp: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>`,
    arrowDown: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>`,
    brain: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4"/><path d="M9 13a4.5 4.5 0 0 0 3-4"/></svg>`,
    orbit: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.341 6.484A10 10 0 0 1 10.266 21.85"/><path d="M3.659 17.516A10 10 0 0 1 13.74 2.152"/><circle cx="12" cy="12" r="3"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/></svg>`,
    square: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>`,
    spinner: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`,
    gear: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`,
    shield: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/></svg>`,
    bot: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>`,
    listTree: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12h-8"/><path d="M21 6H8"/><path d="M21 18h-8"/><path d="M3 6v4c0 1.1.9 2 2 2h3"/><path d="M3 10v6c0 1.1.9 2 2 2h3"/></svg>`,
    zap: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/></svg>`,
    copy: `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`,
    check: `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
    chevronRight: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>`,
    chevronDown: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`,
    clock: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    plus: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>`,
    x: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
    upload: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m17 8-5-5-5 5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/></svg>`,
    download: `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="m7 10 5 5 5-5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/></svg>`,
    trash: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>`,
    pencil: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>`,
    folder: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h5l2 3h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/></svg>`,
    pin: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="m5 17 2-7V5l-2-2h14l-2 2v5l2 7Z"/></svg>`,
    mic: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>`,
    cornerDownRight: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 10 20 15 15 20"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/></svg>`,
    gitBranch: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>`,
    gitFork: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"/><path d="M12 12v3"/></svg>`,
    // Undo / rewind — used on user-bubble action row (P2-9).
    undo: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6.7 3L3 13"/></svg>`,
    // Remote Control gear section (sign in / account / sign out / how it works).
    user: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
    logOut: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/></svg>`,
    info: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`,
    // Animated equalizer bars shown while listening (CSS drives the bounce).
    micWaves: `<span class="mic-waves" aria-hidden="true"><i></i><i></i><i></i><i></i></span>`,
  };

  const MODE_META = {
    agent: {
      icon: ICON.bot,
      label: "Agent mode",
      desc: "Grok acts directly, asking approval only for changes it judges sensitive",
    },
    plan: {
      icon: ICON.listTree,
      label: "Plan mode",
      desc: "Grok explores and proposes a plan; file writes and commands are blocked until you approve it",
    },
    yolo: {
      icon: ICON.zap,
      label: "Auto accept",
      desc: "Grok automatically approves all permission requests (YOLO)",
    },
  };

  // Three blinking dots — the tool rows' in-progress animation, reused by every
  // progress indicator (Grokking / Thinking) so they all pulse the same way
  // instead of the old morphing "…" ellipsis (#26 follow-up).
  const BLINK_DOTS = `<span class="blink-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>`;

  // ---------- helpers ----------

  function capitalize(s) {
    if (!s) return "";
    if (s === "xhigh") return "XHigh";
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // ---------- sound notifications (#59) ----------
  // Synth tones via Web Audio — no bundled assets, CSP-safe, offline. Two cues:
  // a rising two-note chime for completion, a lower falling tone for errors. The
  // AudioContext is created lazily and unlocked on the first user gesture (the
  // autoplay policy starts it "suspended"); the send/keypress that starts a turn
  // is that gesture, so a later completion beep is allowed.
  let audioCtx = null;
  function ensureAudioCtx() {
    if (audioCtx) return audioCtx;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = AC ? new AC() : null;
    } catch (_e) { audioCtx = null; }
    return audioCtx;
  }
  function unlockAudio() {
    const ctx = ensureAudioCtx();
    if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
  }
  function playNotificationTone(kind) {
    const ctx = ensureAudioCtx();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const t0 = ctx.currentTime;
    // { frequency Hz, start-offset s, duration s }
    const notes = kind === "error"
      ? [{ f: 311, s: 0, d: 0.18 }, { f: 233, s: 0.15, d: 0.26 }]  // falling, darker
      : [{ f: 587, s: 0, d: 0.14 }, { f: 880, s: 0.13, d: 0.20 }]; // rising, bright
    const master = ctx.createGain();
    master.gain.value = 0.08; // gentle — a cue, not an alarm
    master.connect(ctx.destination);
    for (const n of notes) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = n.f;
      // Tiny attack + exponential decay so each note doesn't click.
      g.gain.setValueAtTime(0.0001, t0 + n.s);
      g.gain.exponentialRampToValueAtTime(1, t0 + n.s + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.s + n.d);
      osc.connect(g);
      g.connect(master);
      osc.start(t0 + n.s);
      osc.stop(t0 + n.s + n.d + 0.03);
    }
  }
  // Play only when the user isn't looking at the Grok panel — the "notify me when
  // I've stepped away" case (#59). A focused, visible panel means they'll see the
  // result without a beep. hasFocus() is false when the editor/another app has
  // focus; visibilityState covers a fully collapsed panel.
  function maybeNotifySound(kind) {
    if (!state.soundNotifications) return;
    const away = document.visibilityState === "hidden" || !document.hasFocus();
    if (!away) return;
    playNotificationTone(kind);
  }
  // Unlock on the first user gesture anywhere in the webview (typing/clicking to
  // send qualifies), so the first completion beep isn't blocked by autoplay.
  document.addEventListener("pointerdown", unlockAudio, { passive: true });
  document.addEventListener("keydown", unlockAudio, { passive: true });

  function toK(n) {
    return Math.round(n / 1000) + "K";
  }

  function truncate(s, max) {
    return s.length > max ? s.slice(0, max) + "…" : s;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function formatTime(ts) {
    const d = new Date(ts);
    let h = d.getHours();
    const m = d.getMinutes();
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${h}:${m.toString().padStart(2, "0")} ${ampm}`;
  }

  function updateModeBtn(modeId) {
    const meta = MODE_META[modeId] || MODE_META.agent;
    modeBtn.innerHTML = `${meta.icon}<span class="btn-label">${escapeHtml(meta.label)}</span>`;
    modeBtn.classList.toggle("plan-active", modeId === "plan");
    modeBtn.classList.toggle("yolo-active", modeId === "yolo");
  }

  newBtn.innerHTML = ICON.squarePen;
  historyBtn.innerHTML = ICON.clock;
  updateSendButton(); // spinner by default — session is starting up (busy+locked)
  gearBtn.innerHTML = ICON.gear;
  addBtn.innerHTML = ICON.plus;
  scrollBottomBtn.innerHTML = `${ICON.arrowDown}<span class="scroll-bottom-label">Scroll to bottom</span>`;
  updateModeBtn("agent");

  // ---------- markdown ----------

  const { looksLikeFileRef, formatRelativeTime, modelDisplayName, nextMicState, trailingSendPhrase, buildQuestionAnswers, isSubagentToolCall, subagentLabel, cleanSubagentOutput, parseSubagentTaskResult, shouldStickToBottom, splitMath, stripUnsupportedTex, toolFailureText, commandProgramLabel, commandTextPreview, extractToolResultOutput, computeLineDiff, aggregateTurnEdits, turnDiffSummaryTitle, parseShellDeletePaths, parseAttachmentContext, parseSelectionBlocks, parseImageTags, isKnownHostMessage, getMentionQuery, applyMentionPick, orderPermissionOptions, defaultPermissionIndex, shouldFocusPermissionCard, isTypeThroughKey, isInterjectionText } = globalThis.GrokWebviewHelpers;

  function escapeAttr(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/"/g, "&quot;")
      .replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // Hover-overlay markup shared by display math and rendered mermaid diagrams:
  // Copy the source, Download as PNG/SVG, or Open as PNG. The host element carries
  // the source in data-export-src and the kind in data-export-kind; clicks are
  // handled by delegation (see the .expr-btn branch in the click listener), so this
  // can be plain HTML re-created on every streaming frame without leaking handlers.
  function exprActionsHtml(kind) {
    const label = kind === "mermaid" ? "diagram" : "LaTeX";
    // Remote clients download the PNG in-browser and have no host to "Open as
    // PNG" on — drop that action there and label the download for what it does.
    // Copy (the source) and Download work in both the webview and the browser.
    const dlTitle = IS_REMOTE ? "Download PNG" : "Download as PNG / SVG";
    return (
      `<span class="expr-actions" contenteditable="false">` +
        `<button class="expr-btn" type="button" data-expr-act="copy" title="Copy ${label}">${ICON.copy}</button>` +
        `<button class="expr-btn" type="button" data-expr-act="download" title="${dlTitle}">${ICON.download}</button>` +
        (IS_REMOTE ? "" : `<button class="expr-btn" type="button" data-expr-act="open" title="Open as PNG">${ICON.file}</button>`) +
      `</span>`
    );
  }

  // Render one LaTeX span to an SVG string via the vendored MathJax (loaded
  // before this script as a global). MathJax outputs self-contained SVG, which
  // lets us export equations later; on a parse error it renders an <merror> node
  // rather than throwing, so one bad expression never blanks the message. Until
  // MathJax's async startup completes — or if it never loads (happy-dom unit
  // tests) — fall back to the escaped raw TeX so the text is at least readable.
  let mathReady = false;

  function initMathJax() {
    const MJ = globalThis.MathJax;
    if (!MJ) return;
    if (typeof MJ.tex2svg === "function") { mathReady = true; return; }
    // tex2svg is wired up by MathJax's startup; gate on its promise, then upgrade
    // any math that already rendered as a raw fallback before startup finished.
    const p = MJ.startup && MJ.startup.promise;
    if (p && typeof p.then === "function") {
      p.then(() => { mathReady = true; upgradeMathInDom(); }).catch(() => {});
    }
  }

  function rawMath(src, display) {
    const esc = escapeHtml(src);
    return display
      ? `<span class="math-raw math-display">${esc}</span>`
      : `<span class="math-raw">${esc}</span>`;
  }

  function renderMath(latex, display) {
    const orig = (latex == null ? "" : String(latex)).trim();
    const src = stripUnsupportedTex(orig);
    const MJ = globalThis.MathJax;
    let inner = null;
    if (mathReady && MJ && typeof MJ.tex2svg === "function") {
      try {
        const node = MJ.tex2svg(src, { display: !!display });
        if (node && node.outerHTML) inner = node.outerHTML;
      } catch (_) {
        // fall through to the raw fallback
      }
    }
    if (inner == null) inner = rawMath(src, display);
    // Inline math flows in the text with no chrome. Display math becomes an export
    // host carrying the original TeX (for Copy) and the hover actions. The dm block
    // branch in renderMarkdown emits the placeholder, and .math-export is block.
    if (!display) return inner;
    return `<span class="math-export" data-export-kind="latex" data-export-src="${escapeAttr(orig)}">` +
      inner + exprActionsHtml("latex") + `</span>`;
  }

  // MathJax startup is async, so math rendered during page boot (welcome screen,
  // a restored session) may have landed as raw fallback. Once startup resolves,
  // re-typeset those in place: display math from its host's stored TeX (replacing
  // the whole .math-export host so we don't double-wrap), inline from its text.
  function upgradeMathInDom() {
    document.querySelectorAll(".math-raw").forEach((span) => {
      const display = span.classList.contains("math-display");
      // Display fallbacks live inside a .math-export host — replace the host (and
      // re-render from its faithful, un-stripped TeX), not just the inner span.
      const host = display ? (span.closest(".math-export") || span) : span;
      const srcAttr = host.getAttribute && host.getAttribute("data-export-src");
      const src = (display && srcAttr != null) ? srcAttr : span.textContent;
      const tmp = document.createElement("div");
      tmp.innerHTML = renderMath(src, display);
      const node = tmp.firstChild;
      if (node && host.parentNode) host.parentNode.replaceChild(node, host);
    });
  }

  // ---------- mermaid diagrams ----------
  // Grok emits ```mermaid fenced blocks. renderMarkdown turns each into a
  // .mermaid-block placeholder (showing the source as a fallback code block);
  // this pass renders it to SVG with the vendored mermaid lib. mermaid.render is
  // async and needs the live DOM (it measures text), so unlike the synchronous
  // math render we can't do it inline in renderMarkdown — we post-process the
  // inserted element instead.
  //
  // The streaming agent bubble re-runs renderMarkdown (and rebuilds the DOM) on
  // every animation frame, so the SVG is destroyed and the placeholder recreated
  // each frame. Two module-level caches keyed by the diagram source keep that
  // flicker-free and cheap: `mermaidSvgCache` lets a re-render re-apply the SVG
  // synchronously in the same frame (cache hit → no flash), and `mermaidInFlight`
  // stops the same diagram being rendered dozens of times before the first async
  // render resolves. A failed render caches null and leaves the readable source.
  const mermaidSvgCache = new Map(); // src -> svg string, or null if render failed
  const mermaidInFlight = new Set(); // src currently being rendered
  let mermaidIdSeq = 0;
  let mermaidReady = false;

  function initMermaid() {
    const m = globalThis.mermaid;
    if (!m || typeof m.initialize !== "function") return;
    const light = document.body.classList.contains("vscode-light");
    try {
      m.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        theme: light ? "default" : "dark",
        fontFamily: "var(--vscode-font-family, sans-serif)",
      });
      mermaidReady = true;
    } catch (_) {
      mermaidReady = false;
    }
  }

  function mermaidSourceOf(block) {
    const codeEl = block.querySelector(".mermaid-src code") || block.querySelector(".mermaid-src");
    return (codeEl ? codeEl.textContent : "").trim();
  }

  // Swap the rendered SVG into a mermaid block and turn it into an export host:
  // retain the source (for Copy) and add the Copy/Download/Open hover actions. The
  // streaming re-render rebuilds the block (with its .mermaid-src fallback) each
  // frame, so this re-runs per frame from the cache — keep it idempotent.
  function decorateMermaid(block, svg, src) {
    block.innerHTML = svg + exprActionsHtml("mermaid");
    block.setAttribute("data-export-kind", "mermaid");
    block.setAttribute("data-export-src", src);
    block.setAttribute("data-mermaid-state", "done");
  }

  // Replace every still-unrendered placeholder whose source matches `src` with the
  // cached SVG. Scans the live document because the streaming re-render may have
  // swapped out the element that originally kicked off the render.
  function applyCachedMermaid(src) {
    const svg = mermaidSvgCache.get(src);
    if (!svg) return;
    document.querySelectorAll(".mermaid-block").forEach((block) => {
      if (block.getAttribute("data-mermaid-state") === "done") return;
      if (mermaidSourceOf(block) === src) {
        decorateMermaid(block, svg, src);
      }
    });
  }

  function renderMermaidIn(root) {
    if (!root || typeof root.querySelectorAll !== "function") return;
    const blocks = root.querySelectorAll(".mermaid-block");
    if (!blocks.length) return;
    const m = globalThis.mermaid;
    if (!mermaidReady || !m || typeof m.render !== "function") return; // not loaded → readable fallback stays
    blocks.forEach((block) => {
      if (block.getAttribute("data-mermaid-state") === "done") return;
      const src = mermaidSourceOf(block);
      if (!src) return;
      if (mermaidSvgCache.has(src)) {
        const svg = mermaidSvgCache.get(src);
        if (svg) decorateMermaid(block, svg, src);
        return; // null → render failed earlier; keep the source fallback
      }
      if (mermaidInFlight.has(src)) return; // already rendering; the cache will fill in shortly
      mermaidInFlight.add(src);
      const id = "grok-mmd-" + (mermaidIdSeq++);
      Promise.resolve()
        .then(() => m.render(id, src))
        .then((res) => { mermaidSvgCache.set(src, (res && res.svg) || null); })
        .catch(() => { mermaidSvgCache.set(src, null); })
        .then(() => {
          mermaidInFlight.delete(src);
          applyCachedMermaid(src);
        });
    });
  }

  // ---------- math / diagram export ----------
  // Display math and rendered mermaid both end up as a self-contained <svg> in an
  // export host (.math-export / .mermaid-block) carrying the source. From the hover
  // actions we Copy that source, or render the SVG to a file: SVG verbatim, or a
  // PNG rasterized via canvas. Exports match the VS Code theme (sidebar background +
  // foreground) so a saved image looks like what's on screen — a dark diagram stays
  // dark — and so math (currentColor) resolves to the theme text color rather than
  // rasterizing as the default black on a transparent background.

  function canRasterize() {
    try { return !!document.createElement("canvas").getContext("2d"); } catch (_) { return false; }
  }

  function themeVar(name, fallback) {
    try {
      const v = getComputedStyle(document.body).getPropertyValue(name).trim();
      return v || fallback;
    } catch (_) { return fallback; }
  }

  // The on-screen surface colors, so exports are WYSIWYG. The chat sits on
  // --vscode-sideBar-background with --vscode-foreground text (see chat.css).
  function exportColors() {
    return {
      bg: themeVar("--vscode-sideBar-background", "#1e1e1e"),
      fg: themeVar("--vscode-foreground", "#cccccc"),
    };
  }

  // Clone the on-screen SVG into a standalone one. `color` resolves the math
  // currentColor (pass null to leave mermaid's own palette alone); `bg` paints a
  // solid background, or null/"" for transparent (reusable on any surface).
  function themedSvg(svgEl, color, bg) {
    const clone = svgEl.cloneNode(true);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    let style = clone.getAttribute("style") || "";
    if (color) style += `;color:${color}`;
    if (bg) style += `;background:${bg}`;
    clone.setAttribute("style", style);
    return new XMLSerializer().serializeToString(clone);
  }

  // Re-render a mermaid diagram with a specific built-in theme for export, so a
  // "for light background" file gets mermaid's light palette instead of the
  // on-screen dark one. The %%{init}%% directive themes just this render without
  // touching the global config. Transparent bg; falls back to the on-screen SVG.
  async function mermaidThemedSvg(src, theme, fallbackEl) {
    const m = globalThis.mermaid;
    if (m && typeof m.render === "function" && src) {
      try {
        const id = "grok-mmd-exp-" + (mermaidIdSeq++);
        const res = await m.render(id, `%%{init: {'theme':'${theme}'}}%%\n` + src);
        if (res && res.svg) {
          const tmp = document.createElement("div");
          tmp.innerHTML = res.svg;
          const el = tmp.querySelector("svg");
          if (el) return themedSvg(el, null, null);
        }
      } catch (_) { /* fall back to the on-screen render */ }
    }
    return fallbackEl ? themedSvg(fallbackEl, null, null) : "";
  }

  // Rasterize an SVG string to a PNG data URL via an offscreen canvas (theme bg).
  function svgToPng(svgStr, w, h, scale, bg) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(w * scale));
          canvas.height = Math.max(1, Math.round(h * scale));
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = bg;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/png"));
        } catch (e) { reject(e); }
      };
      img.onerror = reject;
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgStr);
    });
  }

  function copyExprSource(src, btn) {
    navigator.clipboard.writeText(src || "").then(() => {
      const prev = btn.innerHTML;
      btn.innerHTML = ICON.check;
      btn.classList.add("copied");
      setTimeout(() => { btn.innerHTML = prev; btn.classList.remove("copied"); }, 1500);
    });
  }

  // Build the export payload and hand it to the host. "open" → a WYSIWYG PNG (VS
  // Code theme background, like on screen). "download" → that same PNG plus two
  // transparent SVGs (light-ink for dark backgrounds, dark-ink for light ones);
  // the host quick-picks which to save. Math recolors via currentColor; mermaid is
  // re-rendered in each theme since its palette is baked into the SVG.
  async function exportExpr(host, action) {
    const svgEl = host.querySelector("svg");
    if (!svgEl) return;
    const kind = host.getAttribute("data-export-kind") || "latex";
    const colors = exportColors();
    const rect = svgEl.getBoundingClientRect();
    const w = rect.width || 320, h = rect.height || 100;

    // PNG always keeps the VS Code theme background — what you see in the sidebar.
    const wysiwyg = themedSvg(svgEl, colors.fg, colors.bg);
    let png = null;
    if (canRasterize()) {
      try { png = await svgToPng(wysiwyg, w, h, 3, colors.bg); } catch (_) { png = null; }
    }

    if (action === "open") {
      vscode.postMessage({ type: "exportExpr", action, kind, svg: wysiwyg, png });
      return;
    }

    // Download: also produce transparent SVGs for dark and light backgrounds.
    let svgDark, svgLight;
    if (kind === "mermaid") {
      const src = host.getAttribute("data-export-src") || "";
      svgDark = await mermaidThemedSvg(src, "dark", svgEl);
      svgLight = await mermaidThemedSvg(src, "default", svgEl);
    } else {
      svgDark = themedSvg(svgEl, "#e8e8e8", null);  // light ink for a dark surface
      svgLight = themedSvg(svgEl, "#1f1f1f", null); // dark ink for a light surface
    }
    const current = document.body.classList.contains("vscode-light") ? "light" : "dark";
    vscode.postMessage({ type: "exportExpr", action, kind, png, svgDark, svgLight, current });
  }

  // Trigger the browser's own downloader for a data: URL. Remote clients only —
  // the VS Code webview has no download surface, so it routes saves through the
  // host (exportExpr) instead. Kept tiny and self-contained (no host round-trip).
  async function remoteDownload(url, filename) {
    if (!url) return;
    // Multi-MB data: URLs (generated images, big diagram PNGs) download
    // unreliably on mobile; a blob: URL is dependable. Fall back to the raw URL
    // if the conversion fails (e.g. CSP blocks the data: fetch).
    let href = url, objectUrl = null;
    if (/^data:/i.test(url)) {
      try {
        const blob = await (await fetch(url)).blob();
        href = objectUrl = URL.createObjectURL(blob);
      } catch (_) { href = url; }
    }
    const a = document.createElement("a");
    a.href = href;
    a.download = filename || "download";
    a.rel = "noopener";
    // chat.js installs a document-wide click handler that preventDefaults EVERY
    // anchor click (it routes file/URL links to the host). Stop our synthetic
    // click from bubbling into it, or the browser never runs the download.
    a.addEventListener("click", (e) => e.stopPropagation());
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
  }

  // Brief green-check acknowledgement on an action button (mirrors the copy
  // buttons' feedback) — on a phone the browser's own download chrome is easy
  // to miss, so confirm the tap registered.
  function ackBtn(btn) {
    if (!btn) return;
    const prev = btn.innerHTML;
    btn.innerHTML = ICON.check;
    btn.classList.add("copied");
    setTimeout(() => { btn.innerHTML = prev; btn.classList.remove("copied"); }, 1500);
  }

  // Remote-client counterpart to exportExpr: there is no host to save through, so
  // rasterize the on-screen SVG (math or mermaid) to a themed PNG right here and
  // hand it to the browser. PNG only by product decision — one self-contained,
  // universally-openable file, no format quick-pick to run on a touch screen.
  async function exportExprBrowser(host, btn) {
    const svgEl = host.querySelector("svg");
    if (!svgEl || !canRasterize()) return;
    const kind = host.getAttribute("data-export-kind") || "latex";
    const colors = exportColors();
    const rect = svgEl.getBoundingClientRect();
    const w = rect.width || 320, h = rect.height || 100;
    const wysiwyg = themedSvg(svgEl, colors.fg, colors.bg);
    let png = null;
    try { png = await svgToPng(wysiwyg, w, h, 3, colors.bg); } catch (_) { png = null; }
    if (!png) return;
    await remoteDownload(png, (kind === "mermaid" ? "diagram" : "equation") + ".png");
    ackBtn(btn);
  }

  function renderDiffCode(code) {
    const lines = code.replace(/\n+$/, "").split("\n");
    const body = lines.map((ln) => {
      let cls = "diff-line";
      if (/^@@/.test(ln)) cls += " diff-hunk";
      else if (/^(\+\+\+|---|diff |index )/.test(ln)) cls += " diff-meta";
      else if (ln[0] === "+") cls += " diff-add";
      else if (ln[0] === "-") cls += " diff-del";
      return `<span class="${cls}">${escapeHtml(ln) || "&nbsp;"}</span>`;
    }).join("");
    return `<code class="diff-code">${body}</code>`;
  }

  function renderMarkdown(raw) {
    const codeBlocks = [];
    // Fence is 3+ backticks; the closing fence must be the SAME length (\1
    // backreference). This lets an outer block fenced by 4/5 backticks wrap an
    // inner ``` block — the shorter inner fences can't close the longer outer one
    // (CommonMark nested code blocks, issue #20). A plain ``` block is the N=3 case.
    let s = raw.replace(/(`{3,})(\w*)\n?([\s\S]*?)\1`*/g, (_, _fence, lang, code) => {
      const i = codeBlocks.length;
      // Mermaid: keep the source as a normal-looking code block (so it shows as
      // readable text if mermaid never loads or the diagram is malformed), but
      // tag it so the post-render pass can swap in the rendered SVG. The closing
      // ``` is required by this regex, so a half-streamed diagram never reaches
      // mermaid — it stays raw text until the block completes.
      if (lang === "mermaid") {
        codeBlocks.push(
          `<div class="code-block mermaid-block">` +
            `<button class="code-copy-btn" type="button" title="Copy code" aria-label="Copy code">` +
              `<span class="code-copy-glyph">${ICON.copy}</span>` +
            `</button>` +
            `<pre class="mermaid-src"><code>${escapeHtml(code).trimEnd()}</code></pre>` +
          `</div>`
        );
        return `\x00B${i}\x00`;
      }
      // A ```math / ```latex / ```tex fence is display math, not literal code —
      // render it as a real equation (only ```mermaid was special-cased before;
      // every other language stayed a code block). Peel one layer of display
      // delimiters the model may have wrapped around it so tex2svg gets the bare
      // expression; a malformed body just falls back to MathJax's own error node.
      if (lang === "math" || lang === "latex" || lang === "tex") {
        let tex = code.replace(/\n+$/, "").trim();
        const wrap = tex.match(/^\\\[([\s\S]*)\\\]$/) || tex.match(/^\$\$([\s\S]*)\$\$$/);
        if (wrap) tex = wrap[1].trim();
        codeBlocks.push(renderMath(tex, true));
        return `\x00B${i}\x00`;
      }
      const isDiff = lang === "diff";
      const inner = isDiff
        ? renderDiffCode(code)
        : `<code>${escapeHtml(code).trimEnd()}</code>`;
      codeBlocks.push(
        `<div class="code-block${isDiff ? " diff" : ""}">` +
          `<button class="code-copy-btn" type="button" title="Copy code" aria-label="Copy code">` +
            `<span class="code-copy-glyph">${ICON.copy}</span>` +
          `</button>` +
          `<pre>${inner}</pre>` +
        `</div>`
      );
      return `\x00B${i}\x00`;
    });

    // Pull LaTeX out before any HTML-escaping or inline-markdown — math is full
    // of \ { } & < > * _ that the inline() pass would mangle. Display math gets a
    // \x00D placeholder (handled as its own block, like tables); inline math gets
    // \x00M. Both restore from the same mathHtml array at the end. Runs after
    // code-block extraction so a \( inside a fenced block stays literal.
    const mathHtml = [];
    s = splitMath(s).map((seg) => {
      if (seg.type !== "math") return seg.value;
      const i = mathHtml.length;
      mathHtml.push(renderMath(seg.value, seg.display));
      return seg.display ? `\x00D${i}\x00` : `\x00M${i}\x00`;
    }).join("");

    function inline(t) {
      return t
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/`([^`\n]+)`/g, (_, code) => {
          if (looksLikeFileRef(code)) {
            const safe = code.replace(/"/g, "&quot;");
            return `<a href="${safe}" class="file-ref-link"><code>${code}</code></a>`;
          }
          return `<code>${code}</code>`;
        })
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => {
          const safe = url.replace(/"/g, "&quot;");
          return `<a href="${safe}">${text}</a>`;
        })
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    }

    // GFM tables: header row | separator row (|---|---|) | data rows
    const tables = [];
    {
      const isTableRow = (l) => /^\s*\|.+\|\s*$/.test(l);
      const isSep = (l) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(l);
      const splitRow = (l) =>
        l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
      const srcLines = s.split('\n');
      const kept = [];
      let i = 0;
      while (i < srcLines.length) {
        if (i + 1 < srcLines.length && isTableRow(srcLines[i]) && isSep(srcLines[i + 1])) {
          const headers = splitRow(srcLines[i]);
          const sepCells = splitRow(srcLines[i + 1]);
          if (headers.length === sepCells.length) {
            const aligns = sepCells.map(c => {
              const L = c.startsWith(':'), R = c.endsWith(':');
              return L && R ? 'center' : R ? 'right' : L ? 'left' : '';
            });
            const rows = [];
            let j = i + 2;
            while (j < srcLines.length && isTableRow(srcLines[j])) {
              const cells = splitRow(srcLines[j]);
              while (cells.length < headers.length) cells.push('');
              rows.push(cells.slice(0, headers.length));
              j++;
            }
            const styleFor = (k) => aligns[k] ? ` style="text-align:${aligns[k]}"` : '';
            let html = '<div class="md-table-wrap"><table><thead><tr>';
            headers.forEach((h, k) => { html += `<th${styleFor(k)}>${inline(h)}</th>`; });
            html += '</tr></thead><tbody>';
            for (const row of rows) {
              html += '<tr>';
              row.forEach((c, k) => { html += `<td${styleFor(k)}>${inline(c)}</td>`; });
              html += '</tr>';
            }
            html += '</tbody></table></div>';
            const idx = tables.length;
            tables.push(html);
            kept.push(`\x00T${idx}\x00`);
            i = j;
            continue;
          }
        }
        kept.push(srcLines[i]);
        i++;
      }
      s = kept.join('\n');
    }

    // Expand inline numbered lists: "1. A 2. B 3. C" on one line → separate lines
    function expandInline(line) {
      if (!/^\s*\d+\. /.test(line)) return [line];
      const indent = line.match(/^(\s*)/)[1];
      const parts = line.trim().split(/(?<=\S)\s+(?=\d+\. )/);
      if (parts.length <= 1) return [line];
      const nums = parts.map(p => parseInt(p.match(/^(\d+)\./)?.[1] ?? '0'));
      const sequential = nums.every((n, i) => n === i + 1);
      return sequential ? parts.map(p => indent + p) : [line];
    }

    const rawLines = s.split('\n');
    const lines = [];
    for (const ln of rawLines) lines.push(...expandInline(ln));

    let out = '';
    // stack: { tag:'ul'|'ol', indent:number, liOpen:boolean }[]
    let stack = [];
    let pendingBreak = false;
    let lastWasBlock = false;
    let lastPara = false;

    function closeLiAt(i) {
      if (stack[i].liOpen) { out += '</li>'; stack[i].liOpen = false; }
    }
    function closeFrom(depth) {
      for (let i = stack.length - 1; i >= depth; i--) {
        closeLiAt(i);
        out += `</${stack[i].tag}>`;
      }
      stack = stack.slice(0, depth);
    }

    for (const line of lines) {
      if (!line.trim()) {
        if (stack.length === 0 && !lastWasBlock) pendingBreak = true;
        lastPara = false;
        continue;
      }
      lastWasBlock = false;

      const tm = line.trim().match(/^\x00T(\d+)\x00$/);
      if (tm) {
        closeFrom(0);
        out += `\x00T${tm[1]}\x00`;
        lastWasBlock = true;
        lastPara = false;
        pendingBreak = false;
        continue;
      }

      // Display math alone on a line → emit as its own block (no paragraph wrap).
      const dm = line.trim().match(/^\x00D(\d+)\x00$/);
      if (dm) {
        closeFrom(0);
        out += `\x00D${dm[1]}\x00`;
        lastWasBlock = true;
        lastPara = false;
        pendingBreak = false;
        continue;
      }

      // Fenced code block alone on a line → emit as its own block. Without this it
      // falls through to the paragraph path and gets wrapped in <br><br> before and
      // after; on top of the .code-block div's own 8px margin that reads as TWO
      // blank lines around a code block (the model only sent one). Mirrors the
      // table/math branches above so spacing is just the div's margin.
      const bm = line.trim().match(/^\x00B(\d+)\x00$/);
      if (bm) {
        closeFrom(0);
        out += `\x00B${bm[1]}\x00`;
        lastWasBlock = true;
        lastPara = false;
        pendingBreak = false;
        continue;
      }

      const hm = line.match(/^(#{1,3}) (.+)$/);
      if (hm) {
        closeFrom(0);
        out += `<h${hm[1].length}>${inline(hm[2])}</h${hm[1].length}>`;
        lastWasBlock = true;
        lastPara = false;
        pendingBreak = false;
        continue;
      }

      const lm = line.match(/^( *)([-*]|\d+\.) (.+)$/);
      if (lm) {
        const indent = lm[1].length;
        const isOl = /\d/.test(lm[2][0]);
        const tag = isOl ? 'ol' : 'ul';
        const content = lm[3];

        while (stack.length > 0 && stack[stack.length - 1].indent > indent) {
          closeLiAt(stack.length - 1);
          out += `</${stack[stack.length - 1].tag}>`;
          stack.pop();
        }

        if (stack.length === 0 || stack[stack.length - 1].indent < indent) {
          out += `<${tag}>`;
          stack.push({ tag, indent, liOpen: false });
        } else {
          closeLiAt(stack.length - 1);
          if (stack[stack.length - 1].tag !== tag) {
            out += `</${stack[stack.length - 1].tag}><${tag}>`;
            stack[stack.length - 1].tag = tag;
          }
        }

        out += `<li>${inline(content)}`;
        stack[stack.length - 1].liOpen = true;
        lastPara = false;
        pendingBreak = false;
        continue;
      }

      closeFrom(0);
      if (pendingBreak) { out += '<br><br>'; pendingBreak = false; }
      else if (lastPara) out += '<br>';
      out += inline(line);
      lastPara = true;
    }

    closeFrom(0);
    return out
      .replace(/\x00B(\d+)\x00/g, (_, i) => codeBlocks[+i])
      .replace(/\x00T(\d+)\x00/g, (_, i) => tables[+i])
      .replace(/\x00D(\d+)\x00/g, (_, i) => mathHtml[+i])
      .replace(/\x00M(\d+)\x00/g, (_, i) => mathHtml[+i]);
  }

  // RTL content support, half one: dir="auto" on every block element
  // renderMarkdown emits, so each takes its direction from its own first
  // strong character — an Arabic list right-aligns with markers on the right
  // while an English block in the same message stays LTR. Loose paragraph
  // text can't be covered here (renderMarkdown emits it bare with <br>
  // breaks, not <p>) — that half is `unicode-bidi: plaintext` on the
  // containers in chat.css. Code deliberately never gets dir=auto: chat.css
  // pins pre/code LTR. Runs after every innerHTML = renderMarkdown(...).
  function applyAutoDir(root) {
    for (const el of root.querySelectorAll("ul, ol, li, h1, h2, h3, td, th")) {
      el.setAttribute("dir", "auto");
    }
  }

  // ---------- popovers ----------

  function closePopovers() {
    modePopover.hidden = true;
    gearPopover.hidden = true;
    addPopover.hidden = true;
    historyPopover.hidden = true;
    repoPopover.hidden = true;
    contextPopover.hidden = true;
  }

  // Context details on demand (donut click): what's in the window, what the turns
  // cost, and the one action that changes either (#39, #53).
  //
  // Context and billing are DIFFERENT quantities and are deliberately kept in
  // separate sections. `usedTokens` is how full the window is; `usage.*` is what
  // the prompts billed (one probed turn: 16,371 context vs 32,488 billed). They
  // don't decompose into each other, so the donut arc stays context-only and the
  // usage rows never pretend to explain it.
  // Webview-local UI state (VS Code's own getState/setState) — survives reloads
  // and the view being hidden. Used for disclosure state that is UI memory, not a
  // preference: a `grok.*` setting would put a collapse triangle in the Settings
  // UI forever. Defensive: getState is undefined until something has been stored.
  function uiState() {
    try {
      return vscode.getState() || {};
    } catch {
      return {};
    }
  }
  function setUiState(patch) {
    try {
      vscode.setState({ ...uiState(), ...patch });
    } catch {
      // no-op: state persistence is a nicety, never a correctness dependency
    }
  }

  function openContextPopover() {
    closePopovers();
    contextPopover.innerHTML = "";
    // A `↳ ` label marks a sub-row (a component of the line above it) — indented
    // via CSS rather than padding the string, so the value column stays aligned.
    const info = (label, value, parent) => {
      const sub = label.startsWith("↳");
      const el = document.createElement("div");
      el.className = "popover-info" + (sub ? " popover-info-sub" : "");
      el.innerHTML = `<span>${escapeHtml(label)}</span><span>${escapeHtml(value)}</span>`;
      (parent || contextPopover).appendChild(el);
      return el;
    };
    const section = (label, parent) => {
      const el = document.createElement("div");
      el.className = "popover-section";
      el.textContent = label;
      (parent || contextPopover).appendChild(el);
    };
    const tok = (n) => Number(n).toLocaleString();

    const used = state.usedTokens || 0;
    const pct = Math.min(100, Math.round((used / state.contextWindow) * 100));
    info("Context used", `${tok(used)} / ${tok(state.contextWindow)} (${pct}%)`);

    // Compact sits directly under the context line — it is the action ON that
    // number, so it belongs to it, not stranded below the billing sections.
    // Every popover row is a DIV: a <button> here drags in native chrome
    // (background + border) that reads as a stray box in the popover.
    const act = document.createElement("div");
    act.className = "toolbar-popover-item popover-action context-compact" + (used ? "" : " disabled");
    act.textContent = "Compact conversation";
    act.title = used ? "Summarize the conversation so far to free up context" : "Nothing to compact yet";
    if (used) {
      act.onclick = (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: "send", text: "/compact", bare: true });
        closePopovers();
      };
    }
    contextPopover.appendChild(act);

    // Billing rows only when the CLI actually reported usage — an older build or
    // a session with no completed turn shows the context row alone rather than a
    // wall of zeros. Cache-CREATION is absent everywhere in the CLI, so it is
    // simply not a row (no fake zero).
    const turn = state.lastTurnUsage;
    const sess = state.sessionUsage;
    const row = (u, label, key, fmt, parent) => (u && u[key] != null ? info(label, (fmt || tok)(u[key]), parent) : null);

    // Session total leads: it's the number you act on (what this conversation has
    // cost). Last turn is diagnostics, so it's a collapsed disclosure below it —
    // present when you want it, out of the way when you don't.
    if (sess) {
      section("Session total");
      row(sess, "Input", "inputTokens");
      row(sess, "↳ cache read", "cachedReadTokens");
      row(sess, "Output", "outputTokens");
    }
    if (turn) {
      const open = !!uiState().lastTurnOpen;
      const hdr = document.createElement("div");
      hdr.className = "popover-section popover-section-toggle" + (open ? " expanded" : "");
      hdr.innerHTML = `<span>Last turn</span><span class="popover-chevron">›</span>`;
      contextPopover.appendChild(hdr);
      const body = document.createElement("div");
      body.hidden = !open;
      contextPopover.appendChild(body);
      row(turn, "Input", "inputTokens", null, body);
      row(turn, "↳ cache read", "cachedReadTokens", null, body);
      row(turn, "Output", "outputTokens", null, body);
      row(turn, "↳ reasoning", "reasoningTokens", null, body);
      // The row that makes the arithmetic legible: a turn re-sends the whole
      // conversation on EVERY model call, so billed input ≈ context × calls and
      // routinely dwarfs "Context used". Without this the two numbers look like
      // a bug (they aren't — they're different quantities).
      row(turn, "Model calls", "modelCalls", String, body);
      hdr.onclick = (e) => {
        e.stopPropagation();
        const next = body.hidden;
        body.hidden = !next;
        hdr.classList.toggle("expanded", next);
        setUiState({ lastTurnOpen: next }); // remembered across opens + reloads
      };
    }

    const fine = document.createElement("div");
    fine.className = "popover-fineprint";
    fine.textContent = turn || sess
      ? "Context is how full the window is. Token counts are billed usage tracked by the extension — each model call re-sends the conversation, so a turn bills far more than the context it holds."
      : "Counted by the CLI at the end of each turn.";
    contextPopover.appendChild(fine);

    positionPopover(contextPopover, donutEl);
    contextPopover.hidden = false;
  }

  function positionPopover(popover, btn) {
    const composerRect = popover.parentElement.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    popover.style.top = "auto";
    popover.style.bottom = (composerRect.bottom - btnRect.top + 4) + "px";
    popover.style.left = (btnRect.left - composerRect.left) + "px";
    popover.style.right = "auto";
    requestAnimationFrame(() => {
      const pw = popover.getBoundingClientRect().width;
      const leftOffset = btnRect.left - composerRect.left;
      if (leftOffset + pw > composerRect.width) {
        popover.style.left = Math.max(0, composerRect.width - pw) + "px";
      }
    });
  }

  function positionDropdownPopover(popover, btn) {
    const parentRect = popover.parentElement.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    const EDGE = 6; // gap kept from the panel's right edge (and minimum gap on the left)
    popover.style.bottom = "auto";
    popover.style.top = (btnRect.bottom - parentRect.top + 4) + "px";
    // Right-align to the panel edge (respecting padding) and grow leftward. The width
    // isn't settled when it opens — session rows stream in asynchronously (requestSessions
    // → "sessions" message → render) and widen it from min-width toward max-width — so a
    // left-anchor + one-shot overflow clamp (measured before those rows arrived) spilled
    // off the right edge and only looked right on reopen. Right-anchoring is width-
    // independent: no measurement, no reflow jump. We also cap the width to the panel
    // (overriding the CSS min/max) so a long session name ellipsizes instead of
    // overflowing the LEFT edge in a narrow panel — common-case sizing, not extreme.
    popover.style.left = "auto";
    popover.style.right = EDGE + "px";
    const available = Math.max(0, parentRect.width - EDGE * 2);
    popover.style.maxWidth = Math.min(360, available) + "px";
    popover.style.minWidth = Math.min(280, available) + "px";
  }

  function positionRepoPopover() {
    const parentRect = repoPopover.parentElement.getBoundingClientRect();
    const btnRect = repoBtn.getBoundingClientRect();
    const EDGE = 6;
    const available = Math.max(0, parentRect.width - EDGE * 2);
    const maxWidth = Math.min(360, available);
    const chipLeft = btnRect.left - parentRect.left;
    const left = Math.min(
      Math.max(EDGE, chipLeft),
      Math.max(EDGE, parentRect.width - EDGE - maxWidth),
    );
    repoPopover.style.bottom = "auto";
    repoPopover.style.top = (btnRect.bottom - parentRect.top + 4) + "px";
    repoPopover.style.left = left + "px";
    repoPopover.style.right = "auto";
    repoPopover.style.maxWidth = maxWidth + "px";
    repoPopover.style.minWidth = Math.min(280, available) + "px";
  }

  // ---------- gear popover ----------

  function addSection(label) {
    const el = document.createElement("div");
    el.className = "popover-section";
    el.textContent = label;
    gearPopover.appendChild(el);
  }

  function addGearItem(labelHtml, onclick) {
    const el = document.createElement("div");
    el.className = "toolbar-popover-item";
    el.innerHTML = labelHtml;
    el.onclick = (e) => { e.stopPropagation(); onclick(); };
    gearPopover.appendChild(el);
  }

  // A non-clickable, muted info row (e.g. version lines in the About panel).
  function addGearInfo(labelHtml) {
    const el = document.createElement("div");
    el.className = "popover-info";
    el.innerHTML = labelHtml;
    gearPopover.appendChild(el);
  }

  // A thin horizontal divider between sections of a popover panel.
  function addGearSep() {
    const el = document.createElement("div");
    el.className = "popover-sep";
    gearPopover.appendChild(el);
  }

  // Promise<boolean> confirm dialog rendered in-page (chat.css .confirm-*).
  // Replaces the host's native modals for chat-triggered destructive actions,
  // so they confirm identically on desktop and in the browser client — where a
  // host-side modal would stall invisibly on the desk's screen.
  function uiConfirm(opts) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "confirm-overlay";
      const panel = document.createElement("div");
      panel.className = "confirm-panel";
      const title = document.createElement("div");
      title.className = "confirm-title";
      title.textContent = opts.title;
      panel.appendChild(title);
      if (opts.body) {
        const body = document.createElement("div");
        body.className = "confirm-body";
        body.textContent = opts.body;
        panel.appendChild(body);
      }
      const actions = document.createElement("div");
      actions.className = "confirm-actions";
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "confirm-btn";
      cancelBtn.textContent = "Cancel";
      const okBtn = document.createElement("button");
      okBtn.type = "button";
      okBtn.className = "confirm-btn " + (opts.danger ? "confirm-danger" : "confirm-primary");
      okBtn.textContent = opts.confirmLabel || "OK";
      const done = (v) => {
        document.removeEventListener("keydown", onKey, true);
        overlay.remove();
        resolve(v);
      };
      const onKey = (e) => {
        if (e.key === "Escape") { e.stopPropagation(); done(false); }
      };
      document.addEventListener("keydown", onKey, true);
      cancelBtn.onclick = (e) => { e.stopPropagation(); done(false); };
      okBtn.onclick = (e) => { e.stopPropagation(); done(true); };
      // A click on the backdrop (not the panel) cancels, same as Escape.
      overlay.onclick = (e) => { if (e.target === overlay) { e.stopPropagation(); done(false); } };
      actions.appendChild(cancelBtn);
      actions.appendChild(okBtn);
      panel.appendChild(actions);
      overlay.appendChild(panel);
      document.body.appendChild(overlay);
      okBtn.focus();
    });
  }

  function renderGearMain() {
    state.gearView = "main";
    gearPopover.innerHTML = "";

    // ── Model + effort header ─────────────────────────────────────────────
    const modelEffortSection = document.createElement("div");
    modelEffortSection.className = "popover-section popover-section-first";
    modelEffortSection.textContent = "Model and Effort";
    gearPopover.appendChild(modelEffortSection);

    // ── Model + effort row ────────────────────────────────────────────────
    const row = document.createElement("div");
    row.className = "model-effort-row";

    // Model + effort both restart or race the session, so they're locked while
    // a turn is in flight or the session is still priming (the hidden primer) —
    // the same `busy` signal that disables send/submit.
    const settingsLocked = state.busy;

    // Until the session's model info arrives (its name + advertised effort menu),
    // don't show a guessed model or a stale effort ladder — show a Loading state.
    const modelLoaded = state.availableModels.length > 0 && !!state.currentModelId;

    const nameBtn = document.createElement("button");
    nameBtn.className = "toolbar-btn model-name-btn" + (settingsLocked || !modelLoaded ? " disabled" : "");
    const modelName = modelLoaded ? (modelDisplayName(state.currentModelId, state.availableModels) || "Grok Build") : "Loading…";
    nameBtn.innerHTML = `<span class="btn-label">${escapeHtml(truncate(modelName, 16))}</span>`;
    nameBtn.disabled = settingsLocked || !modelLoaded;
    nameBtn.title = !modelLoaded
      ? "Loading the session…"
      : (settingsLocked ? `${modelName} — available once the session is ready` : `${modelName} — click to change`);
    if (!settingsLocked && modelLoaded) nameBtn.onclick = (e) => { e.stopPropagation(); renderModelPicker(); };
    row.appendChild(nameBtn);

    const dotsEl = document.createElement("span");
    dotsEl.className = "effort-dots" + (settingsLocked || !modelLoaded ? " disabled" : "");
    if (!modelLoaded) {
      // Loading: neutral placeholder dots — we don't know the model's menu yet,
      // so show a fixed skeleton rather than the (stale) fallback ladder.
      for (let i = 0; i < 5; i++) {
        const dot = document.createElement("span");
        dot.className = "effort-dot loading disabled";
        dot.title = "Loading the session…";
        dotsEl.appendChild(dot);
      }
    } else {
      const effortLevels = effortLevelsForModel();
      const currentIdx = effortLevels.indexOf(state.effort);
      effortLevels.forEach((id, i) => {
        const dot = document.createElement("span");
        dot.className = "effort-dot" + (i <= currentIdx ? " active" : "") + (settingsLocked ? " disabled" : "");
        // Render the dot as a CSS-shaped span (see chat.css). Avoids the classic
        // ● vs ○ Unicode size mismatch where the empty glyph is visibly larger.
        dot.title = settingsLocked
          ? "Available once the session is ready"
          : (EFFORT_TOOLTIPS[id] || capitalize(id));
        if (!settingsLocked) dot.onclick = (e) => {
          e.stopPropagation();
          state.effort = state.effort === id ? "" : id;
          vscode.postMessage({ type: "setEffort", level: state.effort });
          renderGearMain();
          gearPopover.hidden = false;
        };
        dotsEl.appendChild(dot);
      });
    }
    row.appendChild(dotsEl);
    gearPopover.appendChild(row);

    // ── Remote Control ────────────────────────────────────────────────────
    // The hosted relay account, on the machine that links itself — above
    // Session on purpose (it's about reaching this machine at all). Hidden in
    // the browser client: a remote can't (un)link the desktop it's driving.
    if (!IS_REMOTE) {
      addSection("Remote Control");
      if (state.remoteLinked) {
        addGearItem(`<span class="gear-lead">${ICON.user}<span>Your account</span></span>`, () => {
          vscode.postMessage({ type: "openRemotePortal" });
          closePopovers();
        });
        addGearItem(`<span class="gear-lead">${ICON.logOut}<span>Sign out (unlink this device)</span></span>`, () => {
          closePopovers();
          uiConfirm({
            title: "Sign out and unlink this device?",
            body: "This machine will no longer be reachable from your other devices. To use it again, link it from VS Code again.",
            confirmLabel: "Sign out",
            danger: true,
          }).then((ok) => { if (ok) vscode.postMessage({ type: "remoteSignOut" }); });
        });
      } else {
        addGearItem(`<span class="gear-lead">${ICON.user}<span>Sign in (link this device)</span></span>`, () => {
          vscode.postMessage({ type: "remoteSignIn" });
          closePopovers();
        });
        addGearItem(`<span class="gear-lead">${ICON.info}<span>How it works</span></span>`, () => {
          vscode.postMessage({ type: "openRemotePortal" });
          closePopovers();
        });
      }
    }

    // ── Session ───────────────────────────────────────────────────────────
    // Session-LIFECYCLE actions live here; context actions (Compact) live on the
    // context donut, next to the number that motivates them.
    addSection("Session");
    // Fork copies the CONVERSATION (not files). It's fine on a worktree too — the
    // fork shares that checkout, the same as the Agent Dashboard already running
    // parallel sessions on one repo; Remove worktree disposes both.
    addGearItem(`<span class="gear-lead">${ICON.gitFork}<span>Fork conversation</span></span>`, () => {
      vscode.postMessage({ type: "forkSession" });
      closePopovers();
    });
    // Rewind needs a conversation to roll back — hide it on an empty session.
    // Rewind + worktrees are desktop-only: their host flows still run native
    // VS Code UI (QuickPick / input box / progress) a browser user can't see.
    if (!IS_REMOTE && messagesEl.querySelector(".msg.user")) {
      addGearItem(`<span class="gear-lead">${ICON.undo}<span>Rewind conversation</span></span>`, () => {
        vscode.postMessage({ type: "rewindSession" });
        closePopovers();
      });
    }
    // Worktree = an isolated git checkout, in the one Session menu. New is hidden
    // INSIDE a worktree (no worktree-from-worktree — checkouts stay singular);
    // Apply merges edits back and Remove deletes the checkout, so both apply only
    // to a worktree session. Apply/Remove confirm here (uiConfirm) — the host
    // skips its native modal for the webview path.
    if (!IS_REMOTE) {
      if (!state.isWorktree) {
        addGearItem(`<span class="gear-lead">${ICON.gitBranch}<span>New worktree session</span></span>`, () => {
          vscode.postMessage({ type: "newWorktreeSession" });
          closePopovers();
        });
      } else {
        addGearItem(`<span class="gear-lead">${ICON.gitBranch}<span>Apply worktree</span></span>`, () => {
          closePopovers();
          uiConfirm({
            title: "Apply worktree?",
            body: "Merges this worktree's edits back into the main checkout.",
            confirmLabel: "Apply",
          }).then((ok) => { if (ok) vscode.postMessage({ type: "applyWorktree" }); });
        });
        addGearItem(`<span class="gear-lead">${ICON.gitBranch}<span>Remove worktree</span></span>`, () => {
          closePopovers();
          uiConfirm({
            title: "Remove worktree?",
            body: "This deletes the isolated checkout. Unapplied edits are lost.",
            confirmLabel: "Remove",
            danger: true,
          }).then((ok) => { if (ok) vscode.postMessage({ type: "removeWorktree" }); });
        });
      }
    }


    // ── Other ─────────────────────────────────────────────────────────────
    // Collapses the former Config / Account / Debug sections into sub-views
    // (mirrors the Model picker), keeping the main menu short.
    addSection("Other");
    addGearItem('<span>Version &amp; about</span><span class="popover-chevron">›</span>', () => renderAboutPanel(true));
    addGearItem('<span>Config &amp; debug</span><span class="popover-chevron">›</span>', () => renderConfigDebugPanel());
    addGearItem("<span>Log out</span>", () => {
      vscode.postMessage({ type: "logout" });
      closePopovers();
    });
  }

  // About: extension + Grok Build versions, update availability, and an action to
  // update the CLI on demand. `check` triggers a fresh `grok update --check`; the
  // async grokUpdateStatus reply re-renders this view (check=false) to fill it in.
  function renderAboutPanel(check) {
    state.gearView = "about";
    if (check) {
      state.grokUpdate = { checking: true };
      vscode.postMessage({ type: "checkGrokUpdate" });
    }
    const u = state.grokUpdate || {};
    gearPopover.innerHTML = "";
    addGearItem('<span class="popover-back">← Version &amp; about</span>', renderGearMain);

    // Updates can be paused for compatibility (issue #22): the host blocks moving
    // the CLI onto an unsupported build on Windows.
    const blocked = u.policy && u.policy.allow === false;

    // ── Compatibility note (top) ─────────────────────────────────────────
    if (blocked) {
      addGearInfo(`<span class="popover-warn">${escapeHtml(u.policy.note || "Updates are paused for compatibility.")}</span>`);
      addGearSep();
    }

    // ── Versions + update status ─────────────────────────────────────────
    addGearInfo(`<span>This extension</span><span class="popover-ver">v${escapeHtml(state.extVersion || "?")}</span>`);
    // The CLI version comes from the ACP `initialize` handshake, but the native
    // Windows build doesn't report one there — so fall back to the version the
    // update check returns (its `currentVersion`), which is always populated.
    const cliVer = state.cliVersion || u.current || "";
    addGearInfo(`<span>Grok Build CLI</span><span class="popover-ver">${cliVer ? "v" + escapeHtml(cliVer) : "—"}</span>`);

    let statusHtml, canUpdate = false;
    if (u.checking) {
      statusHtml = '<span class="loading-dots">Checking for updates</span>';
    } else if (blocked) {
      statusHtml = '<span class="popover-ver">On the supported version</span>';
    } else if (u.error) {
      statusHtml = '<span class="popover-warn">Couldn’t check — try updating anyway</span>';
      canUpdate = true;
    } else if (u.updateAvailable) {
      statusHtml = `<span class="popover-update-avail">Update available · v${escapeHtml(u.latest || "")}</span>`;
      canUpdate = true;
    } else if (u.current || u.latest) {
      statusHtml = '<span class="popover-ver">CLI is up to date</span>';
    } else {
      statusHtml = '<span class="popover-ver">—</span>';
    }
    addGearInfo(statusHtml);

    if (blocked) {
      // Disabled action — the reason note is shown at the top.
      const btn = document.createElement("div");
      btn.className = "toolbar-popover-item popover-action disabled";
      btn.setAttribute("aria-disabled", "true");
      btn.innerHTML = "<span>Update Grok Build CLI</span>";
      gearPopover.appendChild(btn);
    } else if (canUpdate) {
      // The update action only appears when there's actually something to do —
      // when the CLI is up to date the grayed status line above says so on its own.
      const btn = document.createElement("div");
      btn.className = "toolbar-popover-item popover-action";
      btn.innerHTML = "<span>Update Grok Build CLI</span>";
      btn.onclick = (e) => { e.stopPropagation(); vscode.postMessage({ type: "updateGrok" }); closePopovers(); };
      gearPopover.appendChild(btn);
    }

    // ── Unofficial + trademark fine print ────────────────────────────────
    addGearSep();
    const fine = document.createElement("div");
    fine.className = "popover-fineprint";
    fine.textContent =
      "Unofficial · community-built · MIT | " +
      "A VS Code UI for xAI’s Grok Build CLI - not affiliated with or endorsed by xAI. " +
      "Grok, Grok Build, and xAI are trademarks of xAI; this project uses those names only to describe what it’s compatible with.";
    gearPopover.appendChild(fine);

    // ── Repository link (bottom) ─────────────────────────────────────────
    addGearSep();
    const ghIcon = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" style="vertical-align:-2px"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';
    addGearItem(
      `<span class="popover-gh">${ghIcon} phuryn/grok-build-vscode</span><span class="popover-external">↗</span>`,
      () => {
        const repoUrl = "https://github.com/phuryn/grok-build-vscode";
        // openUrl is host-local (dropped on remotes) — open it in the browser
        // directly there; the VS Code webview keeps routing through the host.
        if (IS_REMOTE) window.open(repoUrl, "_blank", "noopener");
        else vscode.postMessage({ type: "openUrl", url: repoUrl });
        closePopovers();
      },
    );
  }

  // Config & debug: the former Config + Debug items behind one sub-view.
  function renderConfigDebugPanel() {
    state.gearView = "config";
    gearPopover.innerHTML = "";
    addGearItem('<span class="popover-back">← Config &amp; debug</span>', renderGearMain);
    // Show thinking traces (#26) — a switcher; off by default keeps grok's
    // reasoning out of the way, on reveals it (incl. on already-loaded sessions).
    addGearItem(
      `<span>Show thinking traces</span><span class="popover-switch${state.showThinking ? " on" : ""}" role="switch" aria-checked="${state.showThinking}"><span class="popover-switch-knob"></span></span>`,
      () => {
        state.showThinking = !state.showThinking;
        applyThinkingVisibility();
        vscode.postMessage({ type: "setShowThinking", value: state.showThinking });
        renderConfigDebugPanel(); // re-render so the switch reflects the new state
      },
    );
    // Expand tool details (#41/#45) — the persisted default: pre-open every tool
    // detail surface (a command's IN/OUT block, an edit's inline diff) + the
    // groups that hold one. Named to match the "Expand/Collapse All Tool Details"
    // commands. Flipping it clears the per-session Expand/Collapse All latch so the
    // setting takes over (last action wins). Persisted via grok.expandCommandOutputs
    // (the key is unchanged — only the user-facing label widened).
    addGearItem(
      `<span>Expand tool details</span><span class="popover-switch${state.expandCommandOutputs ? " on" : ""}" role="switch" aria-checked="${state.expandCommandOutputs}"><span class="popover-switch-knob"></span></span>`,
      () => {
        state.expandCommandOutputs = !state.expandCommandOutputs;
        state.toolExpandOverride = null;
        applyExpandCommandOutputs();
        vscode.postMessage({ type: "setExpandCommandOutputs", value: state.expandCommandOutputs });
        renderConfigDebugPanel();
      },
    );
    // Steer by default (#52) — how a message sent mid-turn behaves. Off keeps
    // the queue (and the per-message Steer button); on skips the queue entirely.
    // Hidden when the CLI can't interject: offering a switch that silently does
    // nothing is worse than not offering it.
    if (state.steerSupported) {
      addGearItem(
        `<span title="Send straight into Grok's running turn instead of queueing until it finishes. Steering does not cancel the turn or discard work in progress. Plain text only — no attached files, editor context, or /commands.">Steer by default</span><span class="popover-switch${state.steerByDefault ? " on" : ""}" role="switch" aria-checked="${state.steerByDefault}"><span class="popover-switch-knob"></span></span>`,
        () => {
          state.steerByDefault = !state.steerByDefault;
          vscode.postMessage({ type: "setSteerByDefault", value: state.steerByDefault });
          renderConfigDebugPanel();
        },
      );
    }
    // Sound notifications (#59) — a short tone on turn completion / error, played
    // only when the Grok panel isn't focused (notify me when I've stepped away).
    addGearItem(
      `<span title="Play a short sound when Grok finishes or errors — only when the Grok panel isn't focused. A rising chime for done, a lower tone for errors.">Sound notifications</span><span class="popover-switch${state.soundNotifications ? " on" : ""}" role="switch" aria-checked="${state.soundNotifications}"><span class="popover-switch-knob"></span></span>`,
      () => {
        state.soundNotifications = !state.soundNotifications;
        vscode.postMessage({ type: "setSoundNotifications", value: state.soundNotifications });
        // Unlock the audio context on this user gesture so the first later beep
        // is allowed (autoplay policy). A no-op when already running.
        if (state.soundNotifications) unlockAudio();
        renderConfigDebugPanel();
      },
    );
    // Opening host config files, the MCP list, and the extension log channel are
    // all host-local (the messages are policy-dropped on remotes) — hide the whole
    // section in the browser client rather than show dead links.
    if (!IS_REMOTE) {
      addGearSep();
      addGearItem('<span>Open global config</span><span class="popover-external">↗</span>', () => {
        vscode.postMessage({ type: "openGlobalConfig" });
        closePopovers();
      });
      addGearItem('<span>Open project config</span><span class="popover-external">↗</span>', () => {
        vscode.postMessage({ type: "openProjectConfig" });
        closePopovers();
      });
      addGearItem('<span>MCP servers</span><span class="popover-external">↗</span>', () => {
        vscode.postMessage({ type: "runMcpList" });
        closePopovers();
      });
      addGearItem("<span>Show extension logs</span>", () => {
        vscode.postMessage({ type: "showLogs" });
        closePopovers();
      });
    }
    // One-click view relocation (each destination is a direct move into an
    // extension-owned container — see src/view-move.ts). Our own mover because
    // Cursor's primary-side-bar context menu hides the built-in "Move To".
    // Relocating the VS Code view is host-local (the moveView messages are
    // policy-dropped on remotes) — hide the whole section in the browser client.
    if (!IS_REMOTE) {
      // No addGearSep() here: .popover-section draws its own border-top, so a
      // separator in front of a section header renders two rules.
      addSection("Move view");
      addGearItem(`<span class="popover-icon-label">${ICON.panelRight} To Secondary Side Bar</span>`, () => {
        vscode.postMessage({ type: "moveView", location: "auxiliarybar" });
        closePopovers();
      });
      addGearItem(`<span class="popover-icon-label">${ICON.panelLeft} To Primary Side Bar</span>`, () => {
        vscode.postMessage({ type: "moveView", location: "sidebar" });
        closePopovers();
      });
      addGearItem(`<span class="popover-icon-label">${ICON.panelBottom} To Panel</span>`, () => {
        vscode.postMessage({ type: "moveView", location: "panel" });
        closePopovers();
      });
    }
  }

  function renderModelPicker() {
    state.gearView = "model";
    gearPopover.innerHTML = "";
    addGearItem('<span class="popover-back">← Model</span>', renderGearMain);
    const models = state.availableModels.length
      ? state.availableModels
      : [{ modelId: state.currentModelId || "grok-build", name: state.currentModelId || "grok-build" }];
    for (const m of models) {
      const el = document.createElement("div");
      const active = m.modelId === state.currentModelId;
      el.className = "toolbar-popover-item" + (active ? " active" : "");
      el.innerHTML = `<span>${escapeHtml(truncate(m.name || m.modelId, 28))}</span>${active ? '<span class="popover-check">✓</span>' : ""}`;
      el.title = m.modelId;
      el.onclick = (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: "setModel", modelId: m.modelId });
        closePopovers();
      };
      gearPopover.appendChild(el);
    }
  }

  function openGearPopover() {
    if (!gearPopover.hidden) { closePopovers(); return; }
    closePopovers();
    renderGearMain();
    positionPopover(gearPopover, gearBtn);
    gearPopover.hidden = false;
  }

  // Open the gear popover straight to the Version & about panel (used by the
  // welcome screen's "about" link). No-op if it's already showing About.
  function openAboutPanel() {
    if (!gearPopover.hidden && state.gearView === "about") return;
    closePopovers();
    renderAboutPanel(true);
    positionPopover(gearPopover, gearBtn);
    gearPopover.hidden = false;
  }

  function openModePopover() {
    if (!modePopover.hidden) { closePopovers(); return; }
    modePopover.innerHTML = "";
    for (const [id, meta] of Object.entries(MODE_META)) {
      const el = document.createElement("div");
      const active = id === state.currentModeId;
      el.className = "toolbar-popover-item mode-popover-item" +
        (active ? " active" : "") +
        (meta.disabled ? " disabled" : "");
      el.innerHTML =
        `<span class="mode-item-icon">${meta.icon}</span>` +
        `<span class="mode-item-body">` +
          `<span class="mode-item-label">${escapeHtml(meta.label)}</span>` +
          `<span class="mode-item-desc">${escapeHtml(meta.desc)}</span>` +
          (meta.disabledNote ? `<span class="mode-item-disabled-note">${escapeHtml(meta.disabledNote)}</span>` : "") +
        `</span>` +
        (active ? '<span class="popover-check">✓</span>' : "");
      el.onclick = (e) => {
        e.stopPropagation();
        if (meta.disabled) return;
        vscode.postMessage({ type: "setMode", modeId: id });
        closePopovers();
      };
      modePopover.appendChild(el);
    }
    positionPopover(modePopover, modeBtn);
    modePopover.hidden = false;
  }

  function openAddPopover() {
    if (!addPopover.hidden) { closePopovers(); return; }
    closePopovers();
    addPopover.innerHTML = "";
    const item = document.createElement("div");
    item.className = "toolbar-popover-item";
    item.innerHTML = `<span class="add-item-icon">${ICON.upload}</span><span>Upload from computer</span>`;
    item.onclick = (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: "pickFile" });
      closePopovers();
    };
    addPopover.appendChild(item);
    positionPopover(addPopover, addBtn);
    addPopover.hidden = false;
  }

  // Dashboard dot in the history dropdown. Gray (the `none` default) at rest; the
  // labels double as the dot's tooltip (none → no tooltip).
  const DOT_LABEL = {
    working: "Working",
    "needs-you": "Needs you",
    unread: "Finished — unopened",
    error: "Finished with an error — unopened",
  };

  function applySessionDot(dot, value) {
    const v = DOT_LABEL[value] ? value : "none";
    dot.className = "history-row-dot dot-" + v;
    dot.title = DOT_LABEL[value] || "";
  }

  // Cheap incremental update for a single dot when a `sessionDot` arrives while the
  // popover is open — no full re-render.
  function patchSessionDot(id) {
    const sel = "[data-session-dot=\"" + (window.CSS && CSS.escape ? CSS.escape(id) : id) + "\"]";
    const dot = historyPopover.querySelector(sel);
    if (dot) applySessionDot(dot, state.dots[id]);
  }

  const cwdKey = (cwd) => String(cwd || "").replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  const sameCwd = (a, b) => cwdKey(a) === cwdKey(b);
  const cwdLeaf = (cwd) => {
    const parts = String(cwd || "").replace(/[\\/]+$/, "").split(/[\\/]+/).filter(Boolean);
    return parts[parts.length - 1] || "Repository";
  };

  // The repo switcher is a REMOTE-only affordance, and even there only once the
  // host has proved it speaks `repos`. Two independent reasons:
  //  - In VS Code the window already IS the repo — you switch by opening a
  //    folder, and a second, weaker switcher beside it is just confusing.
  //  - A remote client is served by the relay and can outrun the extension a
  //    user has installed. An older host never sends `repos`, so an
  //    unconditional chip would render empty with a menu saying "no
  //    repositories" — a dead control that looks broken. Waiting for the frame
  //    makes the chip appear only where it works.
  function repoSwitcherAvailable() {
    return IS_REMOTE && state.reposKnown;
  }

  function applyRepoSwitcherVisibility() {
    const on = repoSwitcherAvailable();
    repoBtn.hidden = !on;
    if (!on) repoPopover.hidden = true;
  }

  function renderRepoChip() {
    applyRepoSwitcherVisibility();
    if (!repoSwitcherAvailable()) return;
    const selected = state.repos.find((r) => sameCwd(r.cwd, state.selectedRepoCwd));
    const label = selected?.label || cwdLeaf(state.selectedRepoCwd || state.activeRepoCwd);
    const browsing = !!state.selectedRepoCwd && !!state.activeRepoCwd &&
      !sameCwd(state.selectedRepoCwd, state.activeRepoCwd);
    repoBtn.classList.toggle("browsing", browsing);
    repoBtn.innerHTML =
      `<span class="repo-chip-icon">${selected?.worktreeLabel ? ICON.gitBranch : ICON.folder}</span>` +
      `<span class="repo-chip-label"></span>${ICON.chevronDown}`;
    repoBtn.querySelector(".repo-chip-label").textContent = label;
    repoBtn.title = browsing
      ? `Browsing ${state.selectedRepoCwd}; live session is in ${state.activeRepoCwd}`
      : (state.selectedRepoCwd || "Choose repository");
  }

  function renderRepoPopover() {
    repoPopover.innerHTML = "";
    if (!state.repos.length) {
      const empty = document.createElement("div");
      empty.className = "history-empty";
      empty.textContent = "No repositories with Grok sessions.";
      repoPopover.appendChild(empty);
      return;
    }
    for (const repo of state.repos) {
      const row = document.createElement("div");
      const selected = sameCwd(repo.cwd, state.selectedRepoCwd);
      const live = sameCwd(repo.cwd, state.activeRepoCwd);
      row.className = "repo-row" + (selected ? " selected" : "") + (repo.available ? "" : " unavailable");
      row.title = repo.cwd;

      const main = document.createElement("button");
      main.type = "button";
      main.className = "repo-row-main";
      main.disabled = !repo.available;
      main.innerHTML = `<span class="repo-row-icon">${repo.worktreeLabel ? ICON.gitBranch : ICON.folder}</span><span class="repo-row-copy"><span class="repo-row-name"></span><span class="repo-row-meta"></span></span>`;
      main.querySelector(".repo-row-name").textContent = repo.label || cwdLeaf(repo.cwd);
      const meta = main.querySelector(".repo-row-meta");
      meta.textContent = repo.available
        ? [repo.worktreeLabel, live ? "Live" : ""].filter(Boolean).join(" · ")
        : "Unavailable";
      main.onclick = (e) => {
        e.stopPropagation();
        if (!repo.available) return;
        vscode.postMessage({ type: "selectRepo", cwd: repo.cwd });
        closePopovers();
      };
      row.appendChild(main);

      const actions = document.createElement("div");
      actions.className = "history-row-actions repo-row-actions";
      const pin = document.createElement("button");
      pin.type = "button";
      pin.className = "history-action-btn" + (repo.pinned ? " active" : "");
      pin.innerHTML = ICON.pin;
      pin.title = repo.pinned ? "Unpin repository" : "Pin repository";
      pin.onclick = (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: "toggleRepoPin", cwd: repo.cwd, pinned: !repo.pinned });
      };
      actions.appendChild(pin);
      row.appendChild(actions);
      repoPopover.appendChild(row);
    }
  }

  function openRepoPopover() {
    if (!repoSwitcherAvailable()) return;
    if (!repoPopover.hidden) { closePopovers(); return; }
    closePopovers();
    renderRepoPopover();
    positionRepoPopover();
    repoPopover.hidden = false;
  }

  // Live references to the popover's list + footer, so a `sessions` message can repaint
  // just the rows (without rebuilding the search input, which would drop focus mid-type).
  let historyListEl = null;
  let historyFooterEl = null;
  let sessionSearchTimer = null;

  // Ask the host for a page of history. offset 0 = fresh list/search (host replaces);
  // offset > 0 = load-more (host appends). The query rides along so search runs
  // server-side across ALL sessions on disk, not just the page already loaded.
  function requestSessions(offset) {
    state.sessionLoading = true;
    vscode.postMessage({ type: "listSessions", offset, query: state.sessionSearch });
  }

  function renderHistoryList() {
    historyPopover.innerHTML = "";

    const searchWrap = document.createElement("div");
    searchWrap.className = "history-search-wrap";
    const search = document.createElement("input");
    search.type = "text";
    search.className = "history-search";
    search.placeholder = "Search sessions…";
    search.value = state.sessionSearch;
    search.oninput = () => {
      state.sessionSearch = search.value;
      if (sessionSearchTimer) clearTimeout(sessionSearchTimer);
      // Debounce so each keystroke doesn't fan out a host read pass; the host filters
      // by display name across every session and returns the first matching page.
      sessionSearchTimer = setTimeout(() => requestSessions(0), 180);
    };
    search.onkeydown = (e) => { e.stopPropagation(); };
    search.onclick = (e) => e.stopPropagation();
    searchWrap.appendChild(search);
    historyPopover.appendChild(searchWrap);

    const list = document.createElement("div");
    list.className = "history-list";
    // Auto-load the next page as the user nears the bottom. The loading/hasMore guards
    // keep it to one request per page boundary.
    list.onscroll = () => {
      if (!state.sessionHasMore || state.sessionLoading) return;
      if (list.scrollTop + list.clientHeight >= list.scrollHeight - 48) {
        requestSessions(state.sessionNextOffset != null ? state.sessionNextOffset : state.sessions.length);
      }
    };
    historyPopover.appendChild(list);
    historyListEl = list;

    // Footer "Clear all" — shown whenever a non-active session exists (loaded or on a
    // later page). The active session can't be deleted (grok re-persists it); the
    // confirm is ours (uiConfirm), the host handles the empty case.
    const footer = document.createElement("div");
    footer.className = "history-footer";
    footer.hidden = true;
    const clearBtn = document.createElement("button");
    clearBtn.className = "history-clear-all";
    clearBtn.innerHTML = ICON.trash + "<span>Clear all history</span>";
    clearBtn.title = "Delete all sessions in this repository's history";
    clearBtn.onclick = (e) => {
      e.stopPropagation();
      closePopovers();
      const repo = state.repos.find((r) => sameCwd(r.cwd, state.selectedRepoCwd));
      const repoLabel = repo?.label || cwdLeaf(state.selectedRepoCwd);
      const repoPath = repo?.cwd || state.selectedRepoCwd;
      uiConfirm({
        title: `Clear history for “${repoLabel}”?`,
        body: `Deletes every session for:\n${repoPath}\n\nThe current session is kept. This cannot be undone.`,
        confirmLabel: "Delete All",
        danger: true,
      }).then((ok) => {
        if (ok) vscode.postMessage({ type: "clearAllSessions", cwd: repoPath });
      });
    };
    footer.appendChild(clearBtn);
    historyPopover.appendChild(footer);
    historyFooterEl = footer;

    renderSessionRows();
  }

  function updateHistoryFooter() {
    if (!historyFooterEl) return;
    // A non-active session exists if a loaded row isn't the active one, or there are
    // still-unloaded later pages (which sort after the active session, so they're all
    // non-active by construction).
    const loadedClearable = state.sessions.some((s) => s.id !== state.activeSessionId);
    const moreUnloaded = state.sessionTotal > state.sessions.length;
    historyFooterEl.hidden = !(loadedClearable || moreUnloaded);
  }

  function renderSessionRows() {
    const list = historyListEl;
    if (!list) return;
    list.innerHTML = "";
    if (state.sessions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "history-empty";
      empty.textContent = state.sessionSearch.trim() ? "No matches." : "No sessions yet.";
      list.appendChild(empty);
    } else {
      for (const s of state.sessions) list.appendChild(renderSessionRow(s));
      if (state.sessionHasMore) {
        const more = document.createElement("div");
        more.className = "history-more";
        more.textContent = state.sessionLoading ? "Loading…" : "Scroll for more";
        list.appendChild(more);
      }
    }
    updateHistoryFooter();
  }

  function renderSessionRow(s) {
      const row = document.createElement("div");
      const active = s.id === state.activeSessionId;
      row.className = "history-row" + (active ? " active" : "");

      const dot = document.createElement("span");
      dot.setAttribute("data-session-dot", s.id);
      applySessionDot(dot, state.dots[s.id]);
      row.appendChild(dot);

      const main = document.createElement("div");
      main.className = "history-row-main";

      if (state.renamingSessionId === s.id) {
        const inp = document.createElement("input");
        inp.type = "text";
        inp.className = "history-rename";
        inp.value = s.displayName;
        inp.onclick = (e) => e.stopPropagation();
        inp.onkeydown = (e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            vscode.postMessage({ type: "renameSession", id: s.id, name: inp.value });
            state.renamingSessionId = null;
          } else if (e.key === "Escape") {
            state.renamingSessionId = null;
            renderSessionRows();
          }
        };
        inp.onblur = () => {
          if (state.renamingSessionId === s.id) {
            vscode.postMessage({ type: "renameSession", id: s.id, name: inp.value });
            state.renamingSessionId = null;
          }
        };
        main.appendChild(inp);
        setTimeout(() => { inp.focus(); inp.select(); }, 0);
      } else {
        const name = document.createElement("div");
        name.className = "history-row-name";
        // Tooltip is the name the USER sees/gave — never the primer-derived
        // summary (rawSummary), which is an internal title on primed sessions.
        name.title = s.displayName || "";
        // A worktree session gets a branch icon (a TYPE marker in muted gray,
        // off the status-dot palette), not a "(WT)" text prefix like a fork's
        // "(Fork)" — it's an isolated checkout, not a renamed conversation.
        let displayName = s.displayName || "Untitled";
        if (s.worktreeLabel) {
          if (displayName.startsWith("(WT)")) displayName = displayName.slice(4).trim() || "Worktree";
          const branch = document.createElement("span");
          branch.className = "history-row-branch";
          branch.innerHTML = ICON.gitBranch;
          branch.title = "Worktree: " + s.worktreeLabel;
          name.appendChild(branch);
        }
        const txt = document.createElement("span");
        txt.className = "history-row-txt";
        txt.textContent = displayName;
        name.appendChild(txt);
        main.appendChild(name);

        const meta = document.createElement("div");
        meta.className = "history-row-meta";
        const parts = [];
        if (s.numMessages) parts.push(`${s.numMessages} msg`);
        parts.push(formatRelativeTime(s.updatedAt));
        meta.textContent = parts.join(" · ");
        main.appendChild(meta);

        // Whole row is the click target; the rename/delete buttons below
        // stopPropagation so they don't also trigger a resume.
        row.onclick = () => {
          if (active) { closePopovers(); return; }
          vscode.postMessage({ type: "resumeSession", id: s.id, cwd: s.cwd });
          closePopovers();
        };
      }

      row.appendChild(main);

      const actions = document.createElement("div");
      actions.className = "history-row-actions";
      const renameBtn = document.createElement("button");
      renameBtn.className = "history-action-btn";
      renameBtn.innerHTML = ICON.pencil;
      // A worktree session's name IS the worktree name (baked into the checkout
      // path), so renaming it would decouple the display from the real checkout.
      // Disable rename there; delete still works. The browser client allows the
      // rename (it only sets the display name; the branch icon keeps carrying
      // the real checkout name).
      if (s.worktreeLabel && !IS_REMOTE) {
        renameBtn.disabled = true;
        renameBtn.classList.add("disabled");
        renameBtn.title = "Worktree name is fixed to the checkout";
      } else {
        renameBtn.title = "Rename";
        renameBtn.onclick = (e) => {
          e.stopPropagation();
          state.renamingSessionId = s.id;
          renderSessionRows();
        };
      }
      actions.appendChild(renameBtn);
      // No delete for the active session: it's the live conversation and the CLI
      // re-persists it, so a delete wouldn't stick. Rename is still fine.
      if (!active) {
        const delBtn = document.createElement("button");
        delBtn.className = "history-action-btn history-action-danger";
        delBtn.innerHTML = ICON.trash;
        delBtn.title = "Delete";
        delBtn.onclick = (e) => {
          e.stopPropagation();
          uiConfirm({
            title: s.displayName ? `Delete "${s.displayName}"?` : "Delete this session?",
            body: "This cannot be undone.",
            confirmLabel: "Delete",
            danger: true,
          }).then((ok) => { if (ok) vscode.postMessage({ type: "deleteSession", id: s.id, name: s.displayName }); });
        };
        actions.appendChild(delBtn);
      }
      row.appendChild(actions);

      return row;
  }

  function openHistoryPopover() {
    if (!historyPopover.hidden) { closePopovers(); return; }
    closePopovers();
    state.sessionSearch = "";
    state.renamingSessionId = null;
    state.sessionLoading = false;
    state.sessionHasMore = false;
    renderHistoryList();
    positionDropdownPopover(historyPopover, historyBtn);
    historyPopover.hidden = false;
    requestSessions(0);
  }

  // ---------- messages ----------

  function clearWelcome() {
    if (!state.welcomeVisible) return;
    const welcome = $("welcome");
    if (welcome) welcome.hidden = true;
    state.welcomeVisible = false;
  }

  function resetForNewSession() {
    state.isWorktree = false; // re-set by the incoming session's `session` message
    // The caret belongs in the box after any session swap — new session, a
    // history-row re-focus, a disk restore (all funnel through here via the
    // host's clearMessages). Guarded on document.hasFocus(): user-initiated
    // swaps start with a click inside this webview, but a host-initiated clear
    // (an automatic restart) can arrive while the user is typing in the editor,
    // and focusing then would yank keyboard focus across panels.
    if (typeof document.hasFocus !== "function" || document.hasFocus()) input.focus();
    for (const child of Array.from(messagesEl.children)) {
      if (child.id !== "welcome") child.remove();
    }
    const welcome = $("welcome");
    if (welcome) {
      welcome.hidden = false;
      const onb = $("welcome-onboarding");
      if (onb) onb.innerHTML = "";
      const ver = $("welcome-version");
      if (ver) { ver.classList.add("loading-dots"); ver.textContent = "Starting"; }
    }
    state.welcomeVisible = true;
    state.pendingDiffByToolCallId.clear();
    state.toolItemsByToolCallId.clear();
    state.toolFailuresById.clear();
    state.subagentCards.clear();
    state.runProgressCards.clear();
    // Question/restored-card maps too, or a new session's tool updates could
    // attach to the previous session's (now-detached) cards by toolCallId.
    state.questionToolCalls.clear();
    state.restoredCardsByToolCallId.clear();
    state.pendingCommandDetails = [];
    state.toolExpandOverride = null; // the Expand/Collapse All latch is per-session; a swap/restore starts clean (the replay buffer re-applies it for a warm re-focus)
    state.turnAgentActionsEl = null;
    state.turnEditsByToolCallId.clear();
    state.turnDiffSummaryEl = null;
    state.currentTurnId = 0;
    state.baselineMetaByTurn.clear();
    state.activeAgentEl = null;
    state.activeAgentRaw = "";
    state.activeUserEl = null;
    state.activeUserRaw = "";
    state.activeThoughtEl = null;
    state.activeThoughtHdrEl = null;
    state.thoughtBuffer = "";
    state.activeToolGroupEl = null;
    state.replaying = false;
    state.planHistoryQueue = [];
    state.permissionHistoryQueue = [];
    state.userMsgCount = 0;
    state.suppressReplayTurn = false;
    state.skipUserBubble = false;
    state.stickToBottom = true; // a fresh/loaded session starts pinned
    updateScrollBtn();
    hidePlanProcessing();
    hideGrokking();
    hideThinkingIndicator();
    // Busy is per-session UI state — a swap must not leak the previous
    // session's send/stop affordance (#37: a stale Stop turned Enter into a
    // silent cancel; a stale arrow allowed a second prompt into a mid-turn
    // session, which cancels its running tools). Start false; the buffer
    // replay that follows re-derives the truth (agentStart sets busy,
    // agentEnd/agentError/exit clear it).
    state.busy = false;
    state.busyLocked = false;
    // The send queue is HOST-owned per session — do NOT post a clear here.
    // Reset only the local render mirror (the transcript wipe above removed the
    // blocks); the replay delivers the focused session's own queuedSends
    // snapshot, so its queued messages reappear when you swap back.
    state.sendQueue = [];
    state.queuedWrapEl = null;
    updateSendButton();
  }

  function showOnboarding(mode, info) {
    info = info || {};
    const welcome = $("welcome");
    if (welcome) welcome.hidden = false;
    state.welcomeVisible = true;
    const onb = $("welcome-onboarding");
    const ver = $("welcome-version");
    if (!onb) return;
    if (mode === "missing-cli") {
      if (ver) { ver.classList.remove("loading-dots"); ver.textContent = "CLI not installed"; }
      const installCmd = info.platform === "win32"
        ? "irm https://x.ai/cli/install.ps1 | iex"
        : "curl -fsSL https://x.ai/cli/install.sh | bash";
      onb.innerHTML =
        `<div class="onb">` +
          `<p class="onb-heading">Install the Grok CLI</p>` +
          `<div class="onb-cmd">` +
            `<code>${installCmd}</code>` +
            `<button class="onb-copy" type="button" title="Copy" data-cmd="${installCmd}">${ICON.copy}</button>` +
          `</div>` +
          `<button class="onb-action" type="button" data-act="runInstall">Open terminal &amp; run</button>` +
          `<button class="onb-action onb-secondary" type="button" data-act="recheck">Re-check connection</button>` +
        `</div>`;
    } else if (mode === "auth-required") {
      if (ver) { ver.classList.remove("loading-dots"); ver.textContent = "Authentication required"; }
      onb.innerHTML =
        `<div class="onb">` +
          `<p class="onb-heading">Sign in to continue</p>` +
          `<p class="onb-desc"><strong>SuperGrok or X Premium+ subscription</strong> &mdash; either unlocks the <em>Grok Build</em> entitlement.</p>` +
          `<button class="onb-action" type="button" data-act="runLogin">Open terminal &amp; run <code>grok login</code></button>` +
          `<p class="onb-or">or</p>` +
          `<p class="onb-desc"><strong>API key</strong> &mdash; pay per token. Get a key at <a href="https://console.x.ai" class="onb-link">console.x.ai</a>, then add to your shell or a workspace <code>.env</code>:</p>` +
          `<div class="onb-cmd">` +
            `<code>XAI_API_KEY=your-key-here</code>` +
            `<button class="onb-copy" type="button" title="Copy" data-cmd="XAI_API_KEY=">${ICON.copy}</button>` +
          `</div>` +
          `<p class="onb-desc">A cached sign-in takes precedence over the API key &mdash; run <code>grok logout</code> first to use the key. If signing in succeeds but prompts still fail, check the error in the chat: your account may lack the Grok Build entitlement.</p>` +
          `<button class="onb-action onb-secondary" type="button" data-act="recheck">Re-check connection</button>` +
        `</div>`;
    } else {
      onb.innerHTML = "";
    }
  }

  function makeCollapsible(el, container) {
    el.classList.add("collapsible");
    const expandBtn = document.createElement("button");
    expandBtn.className = "msg-expand-btn";
    expandBtn.textContent = "Show more";
    container.appendChild(expandBtn);
    expandBtn.onclick = () => {
      el.classList.remove("collapsible");
      expandBtn.style.display = "none";
      const collapseBtn = document.createElement("button");
      collapseBtn.className = "msg-collapse-btn";
      collapseBtn.textContent = "Show less";
      container.appendChild(collapseBtn);
      collapseBtn.onclick = () => {
        el.classList.add("collapsible");
        expandBtn.style.display = "";
        collapseBtn.remove();
      };
    };
  }

  // A file chip for a user message bubble: basename only (split on both separators
  // so a file outside the workspace shows its name, not its full Windows path),
  // with the full path on the tooltip. A selection range rides the label in the
  // composer chip's format (`name:8-15`, single line `name:8`) — full text kept,
  // overflow is CSS ellipsis. Shared by the live bubble (addMessage) and the
  // restore path (appendUserChunk, reconstructed from the parsed prompt).
  function makeMsgChipTag(pathStr, chip) {
    const tag = document.createElement("span");
    tag.className = "msg-chip";
    const name = chip?.imageIndex != null ? `Image #${chip.imageIndex}` : (pathStr.split(/[\\/]/).pop() || pathStr);
    const icon = chip?.imageIndex != null ? ICON.image : ICON.file;
    const hasSel = chip?.selectionStart && chip?.selectionEnd;
    const range = hasSel
      ? chip.selectionStart === chip.selectionEnd
        ? `:${chip.selectionStart}`
        : `:${chip.selectionStart}-${chip.selectionEnd}`
      : "";
    const lineNote = hasSel
      ? chip.selectionStart === chip.selectionEnd
        ? ` (line ${chip.selectionStart})`
        : ` (lines ${chip.selectionStart}-${chip.selectionEnd})`
      : "";
    tag.innerHTML = icon + `<span>${escapeHtml(name + range)}</span>`;
    tag.title = (chip?.originRelPath || chip?.path || pathStr) + lineNote;
    return tag;
  }

  function addMessage(role, text, chips, opts) {
    clearWelcome();
    const el = document.createElement("div");
    el.className = `msg ${role}`;
    el._copyText = text || "";
    // A steered (interjected) message rides inside the turn that was already
    // running — it is not its own prompt and has no rewind point, so it must be
    // excluded from the bubble→rewind-point mapping (see refreshUserRewindButtons).
    if (opts && opts.steer) el.dataset.steer = "1";

    let contentParent = el;
    if (role === "user") {
      const bubble = document.createElement("div");
      bubble.className = "msg-bubble";
      el.appendChild(bubble);
      contentParent = bubble;
      // 0-based index among visible user bubbles — host maps this to a rewind
      // prompt_index (skipping the hidden primer). Set after userMsgCount bump.
      if (state.userMsgCount > 0) {
        el.dataset.userBubbleIndex = String(state.userMsgCount - 1);
      }
    }

    const body = document.createElement("div");
    body.className = "body";
    if (text) { body.innerHTML = renderMarkdown(text); applyAutoDir(body); renderMermaidIn(body); }
    contentParent.appendChild(body);

    if (role === "user" && chips && chips.length > 0) {
      const chipsRow = document.createElement("div");
      chipsRow.className = "msg-chips";
      for (const chip of chips) chipsRow.appendChild(makeMsgChipTag(chip.relPath, chip));
      contentParent.appendChild(chipsRow);
    }

    if (role === "user" || role === "agent") {
      const actions = document.createElement("div");
      actions.className = "msg-actions";
      const copyBtn = document.createElement("button");
      copyBtn.className = "msg-action-btn msg-copy-btn";
      copyBtn.type = "button";
      copyBtn.title = "Copy message";
      copyBtn.innerHTML = `<span class="msg-action-glyph">${ICON.copy}</span>`;
      actions.appendChild(copyBtn);
      // Rewind sits next to Copy on user bubbles only (P2-9). Latest message
      // has nothing after it to discard — hidden via refreshUserRewindButtons.
      // Desktop-only: the host rewind flow runs native VS Code UI.
      if (role === "user" && !IS_REMOTE) {
        const rewindBtn = document.createElement("button");
        rewindBtn.className = "msg-action-btn msg-rewind-btn";
        rewindBtn.type = "button";
        rewindBtn.title = "Rewind to this message";
        rewindBtn.setAttribute("aria-label", "Rewind to this message");
        rewindBtn.innerHTML = `<span class="msg-action-glyph">${ICON.undo}</span>`;
        actions.appendChild(rewindBtn);
        // Edit lives only on the LATEST user message (#56) — the one Rewind
        // can't target. Together they cover the whole conversation: Rewind for
        // "go back to there", Edit for "that last one came out wrong".
        const editBtn = document.createElement("button");
        editBtn.className = "msg-action-btn msg-edit-btn";
        editBtn.type = "button";
        editBtn.title = "Edit and send again";
        editBtn.setAttribute("aria-label", "Edit and send again");
        editBtn.innerHTML = `<span class="msg-action-glyph">${ICON.pencil}</span>`;
        actions.appendChild(editBtn);
      }
      const ts = document.createElement("span");
      ts.className = "msg-timestamp";
      ts.textContent = formatTime(Date.now());
      actions.appendChild(ts);
      el.appendChild(actions);
      if (role === "agent") {
        // ONE footer per turn, not per narration segment: a turn's prose is
        // split into several .msg.agent blocks by interleaved tool groups, and
        // a copy/timestamp row under each is noise. Keep only the newest
        // segment's footer — the turn's conclusion — and keep it HIDDEN while
        // the turn is still running (revealTurnFooter shows it at turn end,
        // with the end-of-turn time). Code blocks keep their own copy buttons.
        actions.hidden = true;
        if (state.turnAgentActionsEl && state.turnAgentActionsEl !== actions) {
          state.turnAgentActionsEl.remove();
        }
        state.turnAgentActionsEl = actions;
      } else {
        // A user message starts a new turn; the previous turn's footer (if the
        // replay never emitted an explicit turn end) becomes final now.
        revealTurnFooter();
        state.turnAgentActionsEl = null;
      }
    }

    messagesEl.appendChild(el);
    if (role === "user") refreshUserRewindButtons();
    scrollToBottom();
    if (role === "user" && text) {
      requestAnimationFrame(() => {
        if (body.scrollHeight > 56) makeCollapsible(el, contentParent);
      });
    }
    return body;
  }

  /**
   * Keep each user bubble's Rewind button + data-user-bubble-index in sync.
   * The latest user message can't be a rewind target (CLI tip); earlier ones can.
   * Queued (not-yet-sent) blocks are excluded.
   */
  // How many user messages the user can actually SEE (steers excluded, exactly
  // as the rewind map counts them). Sent with every rewind/edit so the host can
  // verify its point list still lines up before acting — see bubbleMapIsConsistent.
  function visibleUserBubbleCount() {
    return [...messagesEl.querySelectorAll(".msg.user:not(.queued)")]
      .filter((el) => el.dataset.steer !== "1").length;
  }

  function refreshUserRewindButtons() {
    // Steered messages are NOT prompts and have no rewind point, so they get no
    // index — counting them shifted every later bubble by one, which pointed
    // Rewind at the wrong turn (and reverted the wrong files) and made Edit
    // fail outright. Both actions are hidden on a steer bubble for the same
    // reason: there is nothing on the wire to roll back to.
    const users = [...messagesEl.querySelectorAll(".msg.user:not(.queued)")]
      .filter((el) => el.dataset.steer !== "1");
    for (const el of messagesEl.querySelectorAll('.msg.user[data-steer="1"]')) {
      delete el.dataset.userBubbleIndex;
      const r = el.querySelector(".msg-rewind-btn");
      const ed = el.querySelector(".msg-edit-btn");
      if (r) r.hidden = true;
      if (ed) ed.hidden = true;
    }
    users.forEach((el, i) => {
      el.dataset.userBubbleIndex = String(i);
      const isLast = i === users.length - 1;
      const btn = el.querySelector(".msg-rewind-btn");
      if (btn) {
        // Hide on the tip: that message is Edit's, which does the same rewind
        // and returns the text. Not a wire limitation — execute accepts the tip.
        btn.hidden = users.length <= 1 || isLast;
      }
      // Edit is the exact complement: only the tip, which is the message a
      // rewind can't remove and the one you most often want to retype (#56).
      const edit = el.querySelector(".msg-edit-btn");
      if (edit) edit.hidden = !isLast;
    });
  }

  // Show the current turn's (single) agent footer — called at every turn-end
  // signal: promptComplete/agentEnd/agentError live, the next user message or
  // replay end on restore. Stamps the time at reveal so it reads as the
  // turn's END time, not the moment the last segment happened to start.
  function revealTurnFooter() {
    const a = state.turnAgentActionsEl;
    if (!a || !a.hidden) return;
    a.hidden = false;
    const ts = a.querySelector(".msg-timestamp");
    if (ts && !state.replaying) ts.textContent = formatTime(Date.now());
    // Same boundary as the copy/timestamp footer: pin the turn's file-change
    // list under the last content so it reads as the turn's conclusion.
    pinTurnDiffSummary();
  }

  // ---- Turn-level file change summary ----
  // Aggregates edit-tool diffs + delete mutations (kind:delete or shell
  // Remove-Item/rm/del) across every tool group in the open turn into one
  // "Changed N files" card. Edit data is the same wire diffs the rows already
  // paint; deletes are inferred from tool kind / command text — no disk re-diff.

  function startTurnDiffTracking() {
    // Leave any previous turn's card in the transcript; only drop the live
    // pointer + per-call map so this turn starts empty.
    state.turnEditsByToolCallId.clear();
    state.turnDiffSummaryEl = null;
  }

  function pinTurnDiffSummary() {
    const el = state.turnDiffSummaryEl;
    if (el && el.isConnected) messagesEl.appendChild(el);
  }

  /** Workspace-relative path for the summary list (falls back to the raw path). */
  function turnEditDisplayPath(p) {
    if (!p) return "Unknown file";
    let s = String(p).replace(/\\/g, "/");
    const cwd = (state.cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (cwd) {
      const sl = s.toLowerCase();
      const cl = cwd.toLowerCase();
      if (sl === cl) return s.split("/").pop() || s;
      if (sl.startsWith(cl + "/")) s = s.slice(cwd.length + 1);
    }
    return s || "Unknown file";
  }

  function recordTurnEdit(toolCallId, path, added, removed, openDiff, oldText, newText) {
    if (!toolCallId) return;
    state.turnEditsByToolCallId.set(toolCallId, {
      kind: "edit",
      path: path || "",
      added: typeof added === "number" ? added : 0,
      removed: typeof removed === "number" ? removed : 0,
      openDiff: openDiff || null,
      // Block-level strings for multi-edit chaining (first.old → last.new).
      oldText: typeof oldText === "string" ? oldText : undefined,
      newText: typeof newText === "string" ? newText : undefined,
    });
    refreshTurnDiffSummaryUi();
  }

  function recordTurnDelete(toolCallId, path) {
    if (!toolCallId || !path) return;
    state.turnEditsByToolCallId.set(toolCallId, {
      kind: "delete",
      path,
      added: 0,
      removed: 0,
      openDiff: null,
    });
    refreshTurnDiffSummaryUi();
  }

  // kind:delete tools + shell Remove-Item/rm/del — the only ways grok deletes
  // files today (there is no dedicated ACP delete in the write path).
  function maybeRecordTurnDelete(call) {
    if (!call || !call.toolCallId) return;
    const kind = toolKind(call);
    if (kind === "delete" || /^delete\b/i.test(String(call.title || "").trim())) {
      const p = toolFilePath(call);
      if (p) recordTurnDelete(call.toolCallId, p);
      return;
    }
    if (kind === "execute" || categorize(call) === "command") {
      const r = call.rawInput || call.input || {};
      const cmd = r.command || r.cmd || "";
      const paths = parseShellDeletePaths(cmd);
      for (let i = 0; i < paths.length; i++) {
        // One tool call can name several paths; key each so they don't clobber.
        recordTurnDelete(call.toolCallId + "::del::" + i, paths[i]);
      }
    }
  }

  function baselineKey(p) {
    return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  }

  /** Find host baseline meta for a summary path (case/slash-insensitive). */
  function baselineMetaForPath(turnId, filePath) {
    const files = state.baselineMetaByTurn.get(turnId);
    if (!files || !files.length) return null;
    const want = baselineKey(filePath);
    const wantBase = want.split("/").pop();
    let hit = files.find((f) => baselineKey(f.path) === want);
    if (hit) return hit;
    // Wire paths may be abs vs relative — match on basename as fallback.
    if (wantBase) hit = files.find((f) => baselineKey(f.path).split("/").pop() === wantBase);
    return hit || null;
  }

  function makeTurnActionBtn(label, title, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "turn-diff-action";
    btn.textContent = label;
    btn.title = title;
    btn.onclick = (e) => {
      e.stopPropagation();
      onClick();
    };
    return btn;
  }

  function refreshTurnDiffSummaryUi() {
    const agg = aggregateTurnEdits(state.turnEditsByToolCallId.values());
    if (!agg.files.length) {
      if (state.turnDiffSummaryEl) {
        state.turnDiffSummaryEl.remove();
        state.turnDiffSummaryEl = null;
      }
      return;
    }
    let el = state.turnDiffSummaryEl;
    if (!el || !el.isConnected) {
      el = document.createElement("div");
      el.className = "turn-diff-summary";
      el.setAttribute("role", "region");
      el.setAttribute("aria-label", "Files changed this turn");
      state.turnDiffSummaryEl = el;
    }
    const turnId = state.currentTurnId || 0;
    el.dataset.turnId = String(turnId);
    while (el.firstChild) el.removeChild(el.firstChild);

    const hdr = document.createElement("div");
    hdr.className = "turn-diff-summary-header";
    const title = document.createElement("span");
    title.className = "turn-diff-summary-title";
    title.textContent = turnDiffSummaryTitle(agg);
    hdr.appendChild(title);
    if (agg.totalAdded > 0 || agg.totalRemoved > 0) {
      hdr.appendChild(document.createTextNode(" · "));
      hdr.appendChild(makeDiffStat(agg.totalAdded, agg.totalRemoved));
    }
    const hdrActions = document.createElement("span");
    hdrActions.className = "turn-diff-summary-actions";
    // Undo all when the host has any baseline for this turn.
    const baselined = state.baselineMetaByTurn.get(turnId);
    if (turnId && baselined && baselined.length && !IS_REMOTE) {
      hdrActions.appendChild(
        makeTurnActionBtn("Undo all", "Restore every file changed this turn to its pre-turn state", () => {
          vscode.postMessage({ type: "undoTurnFiles", turnId });
        }),
      );
    }
    hdr.appendChild(hdrActions);
    el.appendChild(hdr);

    const list = document.createElement("div");
    list.className = "turn-diff-summary-list";
    for (const f of agg.files) {
      const isDel = f.action === "deleted";
      const row = document.createElement("div");
      row.className = "turn-diff-file" + (isDel ? " is-deleted" : "");
      if (f.path) row.dataset.path = f.path;

      const name = document.createElement(
        f.openDiff && !isDel ? "button" : "span",
      );
      name.className = "turn-diff-file-path" + (f.openDiff && !isDel ? " has-diff" : "");
      name.textContent = turnEditDisplayPath(f.path);
      if (f.path) name.title = f.path;
      if (f.openDiff && !isDel) {
        name.type = "button";
        name.title = (f.path || "") + " — open diff";
        const payload = f.openDiff;
        name.onclick = (e) => {
          e.stopPropagation();
          vscode.postMessage(payload);
        };
      }
      row.appendChild(name);

      const right = document.createElement("span");
      right.className = "turn-diff-file-right";
      if (isDel) {
        const tag = document.createElement("span");
        tag.className = "turn-diff-file-action deleted";
        tag.textContent = "Deleted";
        right.appendChild(tag);
      } else {
        right.appendChild(makeDiffStat(f.added, f.removed));
      }

      if (turnId && !IS_REMOTE) {
        const meta = baselineMetaForPath(turnId, f.path);
        if (meta && (meta.kind === "content" || isDel)) {
          if (isDel && meta.kind === "content") {
            right.appendChild(
              makeTurnActionBtn("View", "Show the file content from before it was deleted", () => {
                vscode.postMessage({ type: "viewTurnBaseline", turnId, path: meta.path || f.path });
              }),
            );
          }
          if (meta.kind === "content" || meta.kind === "absent") {
            right.appendChild(
              makeTurnActionBtn("Undo", "Restore this file to its pre-turn state", () => {
                vscode.postMessage({
                  type: "undoTurnFiles",
                  turnId,
                  paths: [meta.path || f.path],
                });
              }),
            );
          }
        }
      }
      row.appendChild(right);
      list.appendChild(row);
    }
    el.appendChild(list);
    messagesEl.appendChild(el); // live: always ride at the end of the turn
    scrollToBottom();
  }

  const TOOL_VERB = {
    read_file: "Read", file_read: "Read",
    write_file: "Write", file_write: "Write", write: "Write",
    bash: "Run", execute: "Run", run_command: "Run", run_terminal_command: "Run",
    shell: "Run", run_bash: "Run",
    list_dir: "List", list_directory: "List",
    search_files: "Search", grep: "Search", ripgrep: "Search",
    search_replace: "Edit", edit_file: "Edit", str_replace: "Edit",
    web_search: "Web search", search_web: "Web search",
    web_fetch: "Fetch", webfetch: "Fetch",
  };

  // Verb by ACP kind — the fallback when the tool name isn't in TOOL_VERB (a tool
  // we didn't predict still gets a sensible verb from its kind).
  const KIND_VERB = {
    read: "Read", search: "Search", edit: "Edit", write: "Write",
    delete: "Delete", execute: "Run", fetch: "Generate",
  };

  function toolName(call) {
    return call.tool || call.name || call.title || "";
  }
  function toolFilePath(call) {
    const r = call.rawInput || call.input || {};
    // `target_directory` is list_dir's path field (verified against real sessions);
    // without it, "List" rendered with no target.
    return r.target_file || r.filePath || r.file_path || r.path ||
      r.target_directory || r.directory || r.dir ||
      (Array.isArray(r.paths) ? r.paths[0] : "");
  }
  function prettyPath(p) {
    if (!p) return "";
    if (p === "." || p === "./") return "root folder";
    return p.split("/").pop() || p;
  }
  // Directory target for a list_dir call. Unlike prettyPath (basename only, right
  // for files), a folder reads better as its full *relative* path with a trailing
  // slash — "docs/screenshots/" not "screenshots". grok passes list_dir paths
  // relative to cwd, so we can show them whole; an absolute path (rare — the
  // webview can't know the workspace root) falls back to its leaf so we never
  // render a long machine path.
  function prettyDir(p) {
    if (!p) return "";
    let s = String(p).replace(/\\/g, "/").replace(/\/+$/, "").replace(/^\.\//, "");
    if (s === "" || s === ".") return "root folder";
    const isAbs = s.startsWith("/") || /^[A-Za-z]:\//.test(s);
    if (isAbs) s = s.split("/").pop();
    return s + "/";
  }
  // grok finalizes a tool call's kind over an update, but the *initial* tool_call
  // (and the persisted replay form) often arrives with `kind` missing and only a
  // leading-verb title ("Shell", "Grep", "Glob", "Read", "Write", "Delete").
  // Recover the ACP kind from that title so categorization/labels don't fall
  // through to the "command" catch-all.
  function titleKind(call) {
    const t = (call.title || "").trim().toLowerCase();
    if (/^read\b/.test(t)) return "read";
    if (/^(grep|glob|search|ripgrep)\b/.test(t)) return "search";
    if (/^(shell|execute|run|bash)\b/.test(t)) return "execute";
    if (/^(write|create)\b/.test(t)) return "write";
    if (/^edit\b/.test(t)) return "edit";
    if (/^delete\b/.test(t)) return "delete";
    if (/^generate/.test(t)) return "fetch";
    return "";
  }
  function toolKind(call) {
    return call.kind || titleKind(call);
  }
  // Coarse bucket for the rollup summary, driven by the ACP kind (then the title,
  // then the legacy name map). Reads and searches (grep/glob) are both read-only
  // "exploration"; edits/writes are file changes; delete and execute stand alone.
  // This is the fix for "ran 5 commands" when grok actually read 5 files / ran 5
  // globs — those are `read`/`search`, not `execute`.
  function categorize(call) {
    const n = toolName(call);
    // Web search/fetch first: grok ships these with a "Web search: …" title and no
    // `kind`, so they'd otherwise fall through to the command catch-all (the exact
    // "ran N commands" miscount the user saw).
    if (/web.?search|web.?fetch|search_web/i.test(n)) return "web";
    switch (toolKind(call)) {
      case "read": case "search": return "explore";
      case "edit": case "write": return "edit";
      case "delete": return "delete";
      case "fetch": return "generate";
      case "execute": return "command";
    }
    const v = TOOL_VERB[n];
    if (v === "Read" || v === "List" || v === "Search") return "explore";
    if (v === "Edit" || v === "Write") return "edit";
    if (v === "Web search" || v === "Fetch") return "web";
    return "command";
  }
  function summarizeTools(calls) {
    const n = { explore: 0, edit: 0, delete: 0, generate: 0, web: 0, command: 0 };
    // Edits are counted by UNIQUE file path (grok emits one edit call per change,
    // so two edits to one file must read "Edited 1 file", not 2). Pathless edits
    // stay distinct via a synthetic key.
    const editFiles = new Set();
    for (const c of calls) {
      const cat = categorize(c);
      if (cat === "edit") editFiles.add(toolFilePath(c) || "__anon" + editFiles.size);
      else n[cat]++;
    }
    n.edit = editFiles.size;
    const parts = [];
    if (n.explore) parts.push(`explored ${n.explore} item${n.explore === 1 ? "" : "s"}`);
    if (n.edit) parts.push(`edited ${n.edit} file${n.edit === 1 ? "" : "s"}`);
    if (n.delete) parts.push(`deleted ${n.delete} file${n.delete === 1 ? "" : "s"}`);
    if (n.generate) parts.push(`generated ${n.generate} item${n.generate === 1 ? "" : "s"}`);
    if (n.web) parts.push("searched web");
    if (n.command) parts.push(`ran ${n.command} command${n.command === 1 ? "" : "s"}`);
    return parts.length ? parts.join(", ").replace(/^./, (c) => c.toUpperCase()) : "Tool calls";
  }

  function inProgressLabel(call) {
    const name = toolName(call);
    const kind = toolKind(call);
    const filePath = toolFilePath(call);
    if (/^(list_dir|list_directory)$/.test(name)) {
      return filePath ? `Listing ${prettyDir(filePath)}` : "Listing files";
    }
    if (/^(read_file|file_read)$/.test(name) || kind === "read") {
      return filePath ? `Reading ${prettyPath(filePath)}` : "Reading file";
    }
    if (/^(web_search|search_web)$/.test(name)) return "Searching web";
    if (/^(web_fetch|webfetch)$/.test(name)) return "Fetching page";
    if (/^(grep|ripgrep|search_files)$/.test(name) || kind === "search") return "Searching";
    if (/^(write_file|file_write|write|edit_file|search_replace|str_replace)$/.test(name) || kind === "edit" || kind === "write") {
      return filePath ? `Editing ${prettyPath(filePath)}` : "Editing file";
    }
    if (kind === "delete") return filePath ? `Deleting ${prettyPath(filePath)}` : "Deleting file";
    if (kind === "fetch") return "Generating";
    if (/^(bash|execute|run_command|run_terminal_command|shell|run_bash)$/.test(name) || kind === "execute") {
      return "Running command";
    }
    // A tool we didn't predict still shows — but never echo a long title verbatim.
    return name && name.length < 30 ? `Running ${name}` : "Running tool";
  }

  function toolLabel(call) {
    const name = toolName(call);
    const kind = toolKind(call);
    const verb = TOOL_VERB[name] || KIND_VERB[kind] || null;
    const r = call.rawInput || call.input || {};
    const filePath = toolFilePath(call);
    const command = r.command || r.cmd;
    const pattern = r.glob_pattern || r.pattern || r.query || r.regex || r.search;
    const url = r.url || r.uri;
    // Deliberate short trim (40 chars): collapsed rows read as a scannable
    // summary, not a wall of shell — the full command lives one click away in
    // the IN/OUT detail. (CSS still single-line-ellipsizes whatever remains.)
    const clamp = (s) => (s && s.length > 40 ? s.slice(0, 40) + "…" : s);
    // A search tool's *pattern* is the useful target — prefer it over the path it
    // searched (grep ships both `pattern` and `path:"."`, which would otherwise
    // render the unhelpful "root folder"). Match by kind OR name so it still wins
    // when the first tool_call arrives before grok finalizes `kind`.
    const isSearch =
      kind === "search" || /\b(grep|glob|ripgrep|search_files|web_search|search_web)\b/i.test(name);

    let target = "";
    if (isSearch && pattern) {
      target = clamp(pattern);
    } else if (url) {
      target = clamp(url.replace(/^https?:\/\//i, ""));
    } else if (filePath) {
      const isList = /^(list_dir|list_directory)$/.test(name) || verb === "List";
      const isRead = name === "read_file" || name === "file_read" || kind === "read";
      if (isList) {
        target = prettyDir(filePath);
      } else if (isRead && r.offset != null && r.limit != null) {
        const end = Number(r.offset) + Number(r.limit) - 1;
        target = `${prettyPath(filePath)} lines ${r.offset}-${end}`;
      } else {
        target = prettyPath(filePath);
      }
    } else if (command) {
      // Program name (+ a non-flag subcommand), not the raw command — the full
      // text is in the row's IN/OUT detail. "Run git status", "Run node", etc.
      target = commandProgramLabel(command);
    } else if (pattern) {
      target = clamp(pattern);
    }
    // Deliberately NO scrape of arbitrary rawInput values: that leaked raw regexes
    // and globs (e.g. "image_edit|/imagine") as bare labels. For a tool we didn't
    // predict, fall back to grok's own already-formatted title, which is safe and
    // human-readable, so the call still shows — just without a synthesized target.

    if (verb && target) return `${verb} ${target}`;
    if (verb) return verb;
    const title = (call.title || "").trim();
    if (title) return title.length > 50 ? title.slice(0, 47) + "…" : title;
    return name || "tool";
  }

  // Category icon for a tool row (lucide outline; sized + colored by CSS via
  // currentColor). One icon per row/group, picked by the strongest action present:
  // square-terminal (command/delete/generate/other) > pencil (edit/write) >
  // folder-search (search) > file (read) — so a Read+Generate batch reads as a
  // terminal action. Mirrors `toolKind`, the same signal the summary uses.
  const TOOL_ICON = {
    file: `<svg class="tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>`,
    search: `<svg class="tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v3.5"/><circle cx="16.5" cy="16.5" r="2.5"/><path d="M21 21l-1.6-1.6"/></svg>`,
    pencil: `<svg class="tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.17 6.81a1 1 0 0 0-3.98-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/><path d="M15 5l4 4"/></svg>`,
    terminal: `<svg class="tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="m7 11 2-2-2-2"/><path d="M11 13h4"/></svg>`,
  };
  function toolIconRank(call) {
    const k = toolKind(call);
    if (k === "execute" || k === "delete" || k === "fetch") return 4;
    if (k === "edit" || k === "write") return 3;
    if (k === "search") return 2;
    if (k === "read") return 1;
    if (/web.?search|web.?fetch|search_web/i.test(toolName(call))) return 2;
    return 4; // unpredicted tool → square-terminal catch-all
  }
  const TOOL_ICON_BY_RANK = { 1: TOOL_ICON.file, 2: TOOL_ICON.search, 3: TOOL_ICON.pencil, 4: TOOL_ICON.terminal };
  function toolIconFor(calls) {
    let rank = 1;
    for (const c of calls) rank = Math.max(rank, toolIconRank(c));
    return TOOL_ICON_BY_RANK[rank];
  }

  function closeToolGroup() {
    if (!state.activeToolGroupEl) return;
    const el = state.activeToolGroupEl;
    const calls = el._calls || [];

    // A lone edit/write is NOT flattened to a `.tool-flat` (icon + label only). The
    // edit's review surface (the `+A −R` stat + the expandable inline diff) is
    // attached to the tool-item in the group body; on restore
    // renderRestoredPermissionForTool closes the group BEFORE the toolCallUpdate
    // carrying the diff arrives, so a flattened lone edit would drop it. Keeping the
    // group (chevron + body + header totals) makes a single edit behave exactly like
    // a multi-tool batch, in both the live and replay orderings (#30).
    if (calls.length === 1 && categorize(calls[0]) !== "edit") {
      const flat = document.createElement("div");
      flat.className = "tool-flat";
      flat.innerHTML = toolIconFor(calls); // icon first
      const lbl = document.createElement("span");
      lbl.className = "tool-label";
      lbl.textContent = toolLabel(calls[0]);
      flat.appendChild(lbl);
      // #41: a lone command's expandable detail (full command + output) moves
      // into the flat row — moving the NODES keeps the pendingCommandDetails
      // reference valid, so an output that lands after the flatten still
      // attaches.
      const detailsEl = el.querySelector(".tool-item-details");
      if (detailsEl) {
        const chev = el.querySelector(".tool-item .tool-chevron");
        if (chev) flat.appendChild(chev);
        flat.appendChild(detailsEl);
        wireCommandToggle(flat, detailsEl);
      }
      el.replaceWith(flat);
      const fail = calls[0].toolCallId && state.toolFailuresById.get(calls[0].toolCallId);
      if (fail) applyToolFailure(flat, fail); // a single tool that failed carries its error
    } else {
      el.classList.remove("in-progress");
      const hdr = el.querySelector(".tool-group-header");
      const label = hdr.querySelector(".tool-group-label");
      label.textContent = summarizeTools(calls); // wipes the totals slot…
      paintGroupDiffTotals(el); // …so "Edited N files" re-gains its "· +A −R" roll-up
      // Settle the finished group to its effective expand state: the latch if
      // set, else auto-open when it has a command/diff detail (Expand tool details).
      // Skipped once the user has toggled this group themselves — expanding a
      // running batch to watch it must not be undone the moment it finishes.
      if (!el._userToggled) setGroupExpanded(el, groupShouldExpand(el));
    }
    state.activeToolGroupEl = null;
    pinTurnDiffSummary();
  }

  function addToToolGroup(call) {
    clearWelcome();
    hideGrokking(); // a tool card is the first content of this turn
    hideThinkingIndicator(); // a running tool now conveys the activity
    // Deletes never carry a type:"diff" block — catch kind:delete + shell
    // Remove-Item/rm here (and on restore's completed tool_call).
    maybeRecordTurnDelete(call);
    if (!state.activeToolGroupEl) {
      // Starting a fresh batch of tools after some agent narration: detach the
      // active agent bubble so the NEXT narration opens a new bubble *below* this
      // group, rather than coalescing back into the bubble above it. grok narrates
      // each step then runs its tools (narrate → tools → narrate → tools …); this
      // keeps that order so each summary sits under the sentence that introduced it
      // instead of all narration piling above N consecutive summaries. Flush first
      // — agent rendering is deferred to a rAF, so detaching without flushing would
      // discard the buffered narration (leaving an empty bubble).
      flushAgent();
      state.activeAgentEl = null;
      state.activeAgentRaw = "";
      const el = document.createElement("div");
      el.className = "tool-group in-progress";
      el._calls = [];
      const hdr = document.createElement("div");
      hdr.className = "tool-group-header";
      const body = document.createElement("div");
      body.className = "tool-group-body";
      body.hidden = true;
      el.appendChild(hdr);
      el.appendChild(body);
      messagesEl.appendChild(el);
      state.activeToolGroupEl = el;
      // Expand-all latched → open the group the moment it appears, mid-run
      // (setGroupExpanded's `.expanded` class also reveals the chevron via CSS).
      if (state.toolExpandOverride === true) setGroupExpanded(el, true);
    }

    const el = state.activeToolGroupEl;
    el._calls.push(call);
    const hdr = el.querySelector(".tool-group-header");
    const body = el.querySelector(".tool-group-body");

    const item = document.createElement("div");
    item.className = "tool-item";
    // Label in its own span so it can single-line ellipsize (long grep
    // patterns / commands must truncate, not wrap) while the details block
    // still breaks onto its own full-width row.
    const itemLabel = document.createElement("span");
    itemLabel.className = "tool-item-label";
    itemLabel.textContent = toolLabel(call);
    item.appendChild(itemLabel);
    body.appendChild(item);
    if (call.toolCallId) state.toolItemsByToolCallId.set(call.toolCallId, item);
    // #41: a shell command's row carries an expandable detail — the FULL
    // command text immediately (grok truncates its titles), and the complete
    // captured output once the terminal finishes.
    const cmd = call.rawInput && typeof call.rawInput.command === "string" ? call.rawInput.command.trim() : "";
    if (cmd) attachCommandDetails(item, cmd, call.toolCallId);

    hdr.innerHTML =
      toolIconFor(el._calls) +
      `<span class="tool-group-label">${escapeHtml(inProgressLabel(call))}</span>` +
      `<span class="tool-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>` +
      `<span class="tool-chevron" aria-hidden="true">${ICON.chevronRight}</span>`;
    // The rebuild above wipes the header's totals slot — re-paint it, or an edit
    // whose diff already landed would lose its "· +A −R" the moment the NEXT tool in
    // the batch starts (and only get it back at batch close).
    paintGroupDiffTotals(el);
    // A lone in-progress COMMAND is expandable immediately — its chevron shows
    // now (multi-tool groups keep theirs until the batch closes), and
    // expanding also opens the row's IN/OUT detail so one click reveals the
    // full command mid-run.
    el.classList.toggle(
      "cmd-single",
      el._calls.length === 1 && !!(call.rawInput && (call.rawInput.command || call.rawInput.cmd)),
    );
    hdr.onclick = () => {
      const expanded = !body.hidden;
      // The user has stated an intent for THIS group: don't let closeToolGroup's
      // automatic settle undo it when the batch finishes. An explicit global
      // action (the gear setting or the Expand/Collapse All latch) still wins —
      // that runs through applyExpandCommandOutputs, which force-applies.
      el._userToggled = true;
      body.hidden = expanded;
      el.classList.toggle("expanded", !expanded);
      if (!expanded && el.classList.contains("cmd-single")) {
        const d = body.querySelector(".tool-item-details");
        const row = body.querySelector(".tool-item.has-details");
        if (d && d.hidden) {
          d.hidden = false;
          if (row) row.classList.add("expanded");
        }
      }
    };
    scrollToBottom();
  }

  // #41: expandable per-command detail — a Claude-Code-style IN/OUT block on
  // the shared code-chip surface. Created with the full command the moment the
  // row appears (grok truncates its titles); the captured output (host-side
  // snapshot at terminal/release — the same bytes grok received) lands later
  // via the commandOutput message. Always available, collapsed by default;
  // the row carries the same chevron + hover affordance as a tool-group
  // header. Shared by grouped rows and the lone flat row (closeToolGroup
  // moves the chevron + details nodes into the flat form).
  // Effective expand state, given the per-session latch (toolExpandOverride)
  // takes precedence over the persisted grok.expandCommandOutputs default.
  //   - override set  → force everything to the override (all groups, all boxes).
  //   - override null → the setting: every detail box (command IN/OUT, edit diff)
  //                     opens, and only GROUPS that HOLD a detail auto-open —
  //                     command or edit groups, but not read/explore-only ones.
  // `groupShouldExpand` needs the element to decide the has-detail case;
  // `detailShouldExpand` is group-agnostic.
  function groupShouldExpand(el) {
    if (state.toolExpandOverride !== null) return state.toolExpandOverride;
    return state.expandCommandOutputs && !!(el && el.querySelector(".has-details"));
  }
  function detailShouldExpand() {
    if (state.toolExpandOverride !== null) return state.toolExpandOverride;
    return state.expandCommandOutputs;
  }
  // Open/close a group's body + chevron (safe on an in-progress group — the CSS
  // shows the chevron once `.expanded` is set even mid-run).
  function setGroupExpanded(el, open) {
    const body = el.querySelector(".tool-group-body");
    if (!body) return;
    body.hidden = !open;
    el.classList.toggle("expanded", open);
  }
  function setDetailExpanded(row, open) {
    const d = row.querySelector(".tool-item-details");
    if (!d) return;
    d.hidden = !open;
    row.classList.toggle("expanded", open);
  }

  // Re-apply the effective expand state to the WHOLE transcript. Called when the
  // persisted setting changes (gear/config) and when the latch flips. Respects
  // the latch via the effective helpers; touches the in-progress group too so a
  // running batch opens/closes live (the reported gap).
  function applyExpandCommandOutputs() {
    for (const row of messagesEl.querySelectorAll(".has-details")) {
      setDetailExpanded(row, detailShouldExpand());
    }
    for (const group of messagesEl.querySelectorAll(".tool-group")) {
      setGroupExpanded(group, groupShouldExpand(group));
    }
  }

  // Command Palette: Grok: Expand/Collapse All Tool Details (This Session). Sets
  // the per-session latch, then re-applies it everywhere — so it (a) opens the
  // batch that's still executing and (b) keeps applying to tool calls that
  // arrive later this session, until you collapse-all or change the gear setting
  // (last action wins). Broader than the setting: it opens EVERY group, incl.
  // explore/edit-only ones.
  function setAllToolDetails(open) {
    state.toolExpandOverride = !!open;
    applyExpandCommandOutputs();
  }

  function wireCommandToggle(rowEl, details, title) {
    rowEl.classList.add("has-details"); // hover highlight + chevron = "this one is clickable"
    rowEl.classList.toggle("expanded", !details.hidden);
    rowEl.title = title || "Show full command and output";
    rowEl.addEventListener("click", (e) => {
      if (e.target.closest("a, button")) return; // preview links keep their own click
      if (e.target.closest(".tool-item-details")) return; // selecting text inside must not collapse
      details.hidden = !details.hidden;
      rowEl.classList.toggle("expanded", !details.hidden); // › ↔ v
    });
  }

  const MAX_COMMAND_PREVIEW_LINES = 6;

  function makeInlineExpandToggle(collapsedText, className, onToggle) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = className;
    toggle.textContent = collapsedText;
    toggle.setAttribute("aria-expanded", "false");
    toggle.onclick = (e) => {
      e.stopPropagation();
      const expanding = toggle.getAttribute("aria-expanded") !== "true";
      onToggle(expanding);
      toggle.textContent = expanding ? "Show less" : collapsedText;
      toggle.setAttribute("aria-expanded", String(expanding));
    };
    return toggle;
  }

  function appendCommandPreview(container, text, className, language) {
    const fullText = text == null ? "" : String(text);
    const preview = commandTextPreview(fullText, MAX_COMMAND_PREVIEW_LINES);
    const pre = document.createElement("pre");
    pre.className = className;
    pre.textContent = preview.text;
    container.appendChild(pre);
    if (!preview.truncated) return;
    const label = `View all (${preview.lineCount} lines) →`;
    const viewAll = IS_REMOTE
      ? makeInlineExpandToggle(label, "msg-collapse-btn command-view-all", (expanding) => {
          pre.textContent = expanding ? fullText : preview.text;
        })
      : document.createElement("button");
    if (!IS_REMOTE) {
      viewAll.type = "button";
      viewAll.className = "preview-link command-view-all";
      viewAll.textContent = label;
      viewAll.onclick = (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: "openText", content: fullText, language });
      };
    }
    container.appendChild(viewAll);
  }

  function attachCommandDetails(item, command, toolCallId) {
    // Chevron at the END of the (possibly ellipsized) command line: › when
    // collapsed, rotated to v while expanded.
    const chevron = document.createElement("span");
    chevron.className = "tool-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.innerHTML = ICON.chevronRight;
    item.appendChild(chevron);

    const details = document.createElement("div");
    details.className = "tool-item-details";
    details.hidden = !detailShouldExpand(); // latch, else grok.expandCommandOutputs, opens new rows pre-expanded
    const block = document.createElement("div");
    block.className = "cmd-block";
    const inRow = document.createElement("div");
    inRow.className = "cmd-io";
    const inTag = document.createElement("span");
    inTag.className = "cmd-io-tag";
    inTag.textContent = "IN";
    inRow.appendChild(inTag);
    const body = document.createElement("div");
    body.className = "cmd-in-body";
    appendCommandPreview(body, command, "tool-cmd", "shellscript");
    inRow.appendChild(body);
    block.appendChild(inRow);
    details.appendChild(block);
    item.appendChild(details);

    wireCommandToggle(item, details);
    // toolCallId lets the completed tool_call_update attach output by id (the
    // cursor/Composer path); command lets the terminal commandOutput attach by
    // string (the grok-build path). Both reference the same `details` node.
    state.pendingCommandDetails.push({ command, details, done: false, toolCallId });
  }

  function attachCommandOutput(details, msg) {
    const block = details.querySelector(".cmd-block");
    if (!block || block.querySelector(".cmd-out")) return; // idempotent (buffer replay)
    const outRow = document.createElement("div");
    outRow.className = "cmd-io cmd-out";
    const tag = document.createElement("span");
    tag.className = "cmd-io-tag";
    tag.textContent = "OUT";
    outRow.appendChild(tag);
    const body = document.createElement("div");
    body.className = "cmd-out-body";
    const output = typeof msg.output === "string" ? msg.output : "";
    const hasOutput = output.trim() !== "";
    // Success is silent (exit 0 = just the output); failure gets an [Error]
    // marker + error tint; a kill is not an error.
    if (msg.exitCode != null && msg.exitCode !== 0) {
      outRow.classList.add("failed");
      const mark = document.createElement("div");
      mark.className = "cmd-out-marker";
      mark.textContent = `[Error] exit ${msg.exitCode}`;
      body.appendChild(mark);
      // Roll the failure up to the ROW + GROUP so a non-zero command reads as an
      // error at a glance — consistent with a status:"failed" tool (markToolFailed).
      // The `[Error] exit N` above is the OUT-block detail; this is the summary
      // signal. No extra `.tool-error` text — the OUT marker already carries it.
      const row = details.closest && details.closest(".tool-item, .tool-flat");
      if (row) {
        row.classList.add("tool-failed");
        const group = row.closest && row.closest(".tool-group");
        if (group) group.classList.add("has-error");
      }
    } else if (msg.exitCode == null) {
      const mark = document.createElement("div");
      mark.className = "cmd-out-marker muted";
      mark.textContent = "[Cancelled] no exit code";
      body.appendChild(mark);
    } else if (!hasOutput) {
      // exit 0 with nothing on stdout: a bare "(no output)" pre read as broken.
      // A muted "done" marker (process success, not a claim about the task) is
      // clearer, and there's no empty <pre> to feel like a gap.
      const mark = document.createElement("div");
      mark.className = "cmd-out-marker ok";
      mark.textContent = "✓ done · no output";
      body.appendChild(mark);
    }
    // Only render the output <pre> when there's actually output — a marker alone
    // carries the empty cases (success/error/cancel).
    if (hasOutput) {
      appendCommandPreview(body, output, "tool-cmd-output", "plaintext");
    }
    if (msg.truncated) {
      const note = document.createElement("div");
      note.className = "cmd-out-marker muted";
      note.textContent = "output truncated — grok saw the same cut";
      body.appendChild(note);
    }
    outRow.appendChild(body);
    block.appendChild(outRow);
  }

  // #41 for the cursor/Composer agent: it runs commands in its own CLI-side shell
  // (no terminal/create), so `commandOutput` never fires for its rows. Its output
  // rides the completed `tool_call_update` instead — attach it to the row by
  // toolCallId (reliable + order-independent; Composer completes out of order).
  // Returns true only when it actually filled an empty command row, so the caller
  // skips the generic failure/diff path for it. A no-op for grok-build, whose
  // terminal `commandOutput` already populated the row before this update arrives.
  function maybeAttachToolResultOutput(call) {
    const id = call && call.toolCallId;
    if (!id) return false;
    // Use the pendingCommandDetails entry (a direct `details` node reference that
    // survives a lone command's flatten-move) rather than re-querying the item —
    // the item's details node is relocated to the .tool-flat wrapper.
    const entry = state.pendingCommandDetails.find((p) => p.toolCallId === id);
    if (!entry) return false;
    const block = entry.details.querySelector(".cmd-block");
    if (!block || block.querySelector(".cmd-out")) return false; // OUT already present (grok-build)
    const res = extractToolResultOutput(call);
    if (!res) return false;
    attachCommandOutput(entry.details, res);
    return true;
  }

  // Render one edit region as a colored inline diff on the shared code-block
  // surface (`.code-block.diff` + `.diff-line`, the same styling ` ```diff `
  // message fences use). grok only sends the replaced region (old/new strings),
  // so computeLineDiff produces the +/-/context lines; a "+"/"-"/" " gutter goes
  // in front of each so the diff reads (and copies) as a real unified diff even
  // for colorblind users. Long regions start as a short preview and can grow
  // inline; the native editor remains one "open diff →" click away.
  const DIFF_PREVIEW_LINES = 12;
  const MAX_INLINE_DIFF_LINES = 400;
  // A wire line number is only usable if it's a real 1-based file line; anything
  // else (absent, 0, negative, non-integer) falls back to the old region-relative 1.
  function fileLineOr1(v) {
    return typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1;
  }
  // A quiet hairline marking a jump in file lines between two hunks of the SAME
  // edit — a replace_all's sites sit at scattered lines (3, 5, 7…), so without it
  // two hunks read as one continuous run. The line numbers say where we jumped to;
  // this only has to stop the eye from joining them.
  function makeHunkSeparator() {
    const sep = document.createElement("div");
    sep.className = "tdl-sep";
    sep.setAttribute("aria-hidden", "true");
    return sep;
  }

  // Render ONE diff block as a single region containing one hunk per replaced
  // SITE (`hunks` = [{site, result}] — see extractDiffSites). One region per
  // BLOCK, never per site.
  //
  // Codex-style rows: a line-number gutter + a colored left-border stripe + a subtle
  // per-line background (green add / red del). A small +/- glyph sits right by the
  // border for color-blind readability. A del shows the OLD-side number, an
  // add/context the NEW-side number -- unified-diff local numbering.
  //
  // The numbers are REAL file lines: each site carries its position (1-based), so
  // the counters seed from it. Falls back to 1 when absent (older builds, the
  // whole-file-Write echo, hand-built fixtures) -- the region-relative numbering we
  // used to always emit.
  function buildInlineDiffRegion(hunks) {
    const wrap = document.createElement("div");
    wrap.className = "tool-diff-region";
    let widest = 0;
    let rendered = 0;
    let total = 0;
    const previewOverflow = [];
    for (const h of hunks) {
      total += h.result.lines.length;
    }
    // MAX_INLINE_DIFF_LINES is a budget ACROSS the block's hunks, not per hunk —
    // 1000 sites must not paint 2000 rows. The +N −M stat is summed over EVERY
    // site regardless (attachDiffPreviewToToolItem), so capping the render never
    // understates the change.
    let prevNewEnd = null;
    for (const { site, result } of hunks) {
      if (rendered >= MAX_INLINE_DIFF_LINES) break;
      const rows = result.lines;
      let oldNo = fileLineOr1(site && site.oldLine);
      let newNo = fileLineOr1(site && site.newLine);
      // Only between hunks, and only when the new side actually skipped lines.
      if (prevNewEnd !== null && newNo !== prevNewEnd) {
        const sep = makeHunkSeparator();
        if (rendered >= DIFF_PREVIEW_LINES) {
          sep.hidden = true;
          previewOverflow.push(sep);
        }
        wrap.appendChild(sep);
      }
      const shown = Math.min(rows.length, MAX_INLINE_DIFF_LINES - rendered);
      for (let i = 0; i < shown; i++) {
        const ln = rows[i];
        const isAdd = ln.type === "add";
        const isDel = ln.type === "del";
        const row = document.createElement("div");
        row.className = "tdl" + (isAdd ? " tdl-add" : isDel ? " tdl-del" : "");
        const sign = document.createElement("span");
        sign.className = "tdl-sign";
        sign.textContent = isAdd ? "+" : isDel ? "-" : "";
        const num = document.createElement("span");
        num.className = "tdl-num";
        let shownNo;
        if (isAdd) shownNo = newNo++;
        else if (isDel) shownNo = oldNo++;
        else { shownNo = newNo++; oldNo++; }
        num.textContent = String(shownNo);
        if (shownNo > widest) widest = shownNo;
        const code = document.createElement("span");
        code.className = "tdl-code";
        code.textContent = ln.text === "" ? " " : ln.text;
        row.appendChild(sign);
        row.appendChild(num);
        row.appendChild(code);
        if (rendered + i >= DIFF_PREVIEW_LINES) {
          row.hidden = true;
          previewOverflow.push(row);
        }
        wrap.appendChild(row);
      }
      rendered += shown;
      prevNewEnd = newNo;
    }
    // Size the gutter to the widest number actually rendered, +1ch of slack so a
    // number never butts against the code column. Floored at 4ch, which is exactly
    // today's look for everything up to 999; only a 1000+ line file grows it. A
    // fixed track would instead overflow — 5 digits would collide with the +/- glyph.
    wrap.style.setProperty("--tdl-num-w", Math.max(4, String(widest).length + 1) + "ch");
    const remaining = total - rendered;
    if (remaining > 0) {
      const more = document.createElement("div");
      more.className = "tool-diff-more";
      more.textContent = "... " + remaining + " more line(s) - open diff for the full change";
      more.hidden = true;
      previewOverflow.push(more);
      wrap.appendChild(more);
    }
    if (rendered > DIFF_PREVIEW_LINES) {
      const toggle = makeInlineExpandToggle(
        "Show more",
        "msg-collapse-btn tool-diff-toggle",
        (expanding) => {
          for (const el of previewOverflow) el.hidden = !expanding;
        },
      );
      wrap.appendChild(toggle);
    }
    return wrap;
  }

  // Attach an edit's review surface to its tool row: an always-visible `+A −R`
  // count (so a collapsed group is still auditable) plus an expandable detail
  // holding the inline diff(s) + the native "open diff →" link. Rides the exact
  // same expand machinery as a command's IN/OUT block — the row becomes
  // `has-details`, governed by grok.expandCommandOutputs / the Expand-All latch /
  // a per-row click (wireCommandToggle). `diffs` is an ARRAY: a single tool call
  // can carry more than one region.
  function attachDiffPreviewToToolItem(toolCallId, diffs) {
    const item = state.toolItemsByToolCallId.get(toolCallId);
    if (!item) return;
    // grok reports an edit's diff TWICE (research/edit-diff.md § Two updates per
    // edit): first an optimistic pre-write echo, then the authoritative completed
    // update. For a search_replace the two are byte-identical, but a whole-file
    // Write's echo carries oldText:"" — it hasn't read the old content yet — while
    // the completed one carries the real prior content. So a repaint with a
    // DIFFERENT diff must WIN (an overwrite otherwise renders as pure adds forever,
    // since the echo lands first); a byte-identical repaint is a no-op, which is
    // what keeps buffer replay idempotent.
    const sig = JSON.stringify(diffs);
    if (item._diffSig === sig) return;
    const existing = item.querySelector(".tool-item-details");
    if (existing && !existing.classList.contains("tool-item-diff")) return; // a command's IN/OUT owns this row
    item._diffSig = sig;

    // Count over EVERY site of every block — that's the whole point of expanding
    // details[]: a 148-occurrence replace_all is +148 −148, not the "+1 −1" the
    // token-sized block-level oldText/newText would report. The render is capped
    // (buildInlineDiffRegion), the counts never are.
    let added = 0;
    let removed = 0;
    const blocks = [];
    for (const diff of diffs) {
      const hunks = [];
      for (const site of diff.sites) {
        const result = computeLineDiff(site.oldText, site.newText);
        added += result.added;
        removed += result.removed;
        hunks.push({ site, result });
      }
      blocks.push({ diff, hunks });
    }
    item._diffStat = { added, removed, path: diffs[0] && diffs[0].path };

    // Turn-level summary: same counts as the row, keyed by toolCallId so an
    // echo→completed repaint replaces rather than double-counts. Block-level
    // old/new text enable chained multi-edit net recompute (first→last).
    // openDiff uses the first block (matches the row's "open diff →").
    const d0 = diffs[0];
    recordTurnEdit(
      toolCallId,
      d0 && d0.path,
      added,
      removed,
      openDiffMessage(d0),
      d0 ? d0.oldText : undefined,
      d0 ? d0.newText : undefined,
    );

    // Always-visible +A −R on the row (and the roll-up onto the group header).
    const stat = makeDiffStat(added, removed);
    const prevStat = item.querySelector(".diff-stat");
    if (prevStat) prevStat.replaceWith(stat);
    else item.appendChild(stat);
    recomputeGroupDiffTotals(item);

    // On a repaint, REUSE the existing detail node: swapping in a new one would
    // leave wireCommandToggle's click listener bound to the detached node (and
    // double-bind a second), and reusing it preserves whatever expand state the row
    // is already in.
    let details = existing;
    const fresh = !details;
    if (fresh) {
      const chevron = document.createElement("span");
      chevron.className = "tool-chevron";
      chevron.setAttribute("aria-hidden", "true");
      chevron.innerHTML = ICON.chevronRight;
      item.appendChild(chevron);

      details = document.createElement("div");
      details.className = "tool-item-details tool-item-diff";
      details.hidden = !detailShouldExpand();
    }
    while (details.firstChild) details.removeChild(details.firstChild);
    // One region + ONE "open diff →" per BLOCK (not per site). The message keeps
    // the block's oldText/newText and adds positioned sites for whole-file
    // reconstruction in the native editor.
    for (const { diff, hunks } of blocks) {
      details.appendChild(buildInlineDiffRegion(hunks));
      const preview = document.createElement("button");
      preview.className = "preview-link";
      preview.textContent = "open diff →";
      preview.onclick = (e) => {
        e.stopPropagation(); // don't toggle the row/group expand
        vscode.postMessage(openDiffMessage(diff));
      };
      details.appendChild(preview);
    }
    if (fresh) {
      item.appendChild(details);
      wireCommandToggle(item, details, "Show the diff");
    }
    scrollToBottom();
  }

  // "+A −R" pill for an edit row (green additions, red removals). Uses a real
  // minus sign; 0 sides still render so the change magnitude is unambiguous.
  function makeDiffStat(added, removed) {
    const sub = document.createElement("span");
    sub.className = "tool-item-subtitle diff-stat";
    const a = document.createElement("span");
    a.className = "diff-stat-add";
    a.textContent = `+${added}`;
    const d = document.createElement("span");
    d.className = "diff-stat-del";
    d.textContent = `−${removed}`;
    sub.appendChild(a);
    sub.appendChild(document.createTextNode(" "));
    sub.appendChild(d);
    return sub;
  }

  // Roll the group's edit counts up onto its header so it can show totals
  // ("Edited 1 file · +7 −2"), and re-paint them immediately — the counts track each
  // edit AS IT LANDS, not only once the batch closes. Files are de-duped by path —
  // grok emits one edit call per change, so two edits to one file must still read
  // "Edited 1 file" (matching summarizeTools' path-dedup), not 2.
  //
  // Recomputed from the rows' current `_diffStat` rather than accumulated
  // incrementally, so a row REPAINTED with the authoritative diff (see
  // attachDiffPreviewToToolItem) replaces its earlier counts instead of
  // double-counting them into the group.
  function recomputeGroupDiffTotals(item) {
    const group = item.closest && item.closest(".tool-group");
    if (!group) return;
    const t = { added: 0, removed: 0, files: new Set() };
    let anon = 0;
    for (const row of group.querySelectorAll(".tool-item")) {
      const s = row._diffStat;
      if (!s) continue;
      t.added += s.added;
      t.removed += s.removed;
      t.files.add(s.path || "__anon" + anon++);
    }
    group._diffTotals = t;
    paintGroupDiffTotals(group);
  }

  // Paint the group's rolled-up edit totals onto its header label, so "Editing
  // x.ts"/"Edited N files" is auditable at a glance without expanding. Runs in BOTH
  // states — while the batch is still in progress (each edit's counts show the
  // moment its diff lands) and after closeToolGroup rewrites the label.
  //
  // The totals live in their own span so a re-paint REPLACES them instead of
  // appending a second copy. Two things wipe the slot, and both re-paint right
  // after: addToToolGroup rebuilds the header's innerHTML on every new call in the
  // batch, and closeToolGroup resets the label's textContent. No-op for a group with
  // no edits.
  function paintGroupDiffTotals(group) {
    if (!group) return;
    const labelEl = group.querySelector(".tool-group-label");
    if (!labelEl) return;
    const prev = labelEl.querySelector(".tool-group-diff-totals");
    if (prev) prev.remove();
    const t = group._diffTotals;
    if (!t || (t.added === 0 && t.removed === 0)) return;
    const slot = document.createElement("span");
    slot.className = "tool-group-diff-totals";
    slot.appendChild(document.createTextNode(" · "));
    slot.appendChild(makeDiffStat(t.added, t.removed));
    labelEl.appendChild(slot);
  }

  // Extract every `type:"diff"` block from a tool call's `content` and render the
  // inline edit diff. grok delivers the diff differently by path: LIVE it rides the
  // `tool_call_update`s (the `tool_call` carries the edit's rawInput args but no
  // `content`), but on session/load REPLAY the whole edit collapses into a single
  // completed `tool_call` that carries the diff itself — no separate update. So this
  // must run for BOTH message kinds, else a restored edit shows an expandable group
  // with no diff inside it (#30).
  // Expand a diff block into one hunk per replaced SITE.
  //
  // The block's own oldText/newText is the search *pattern*, so for a replace_all it
  // is token-sized by design — rendering it alone shows a 148-occurrence rename as a
  // single meaningless "+1 −1" hunk. `_meta.details[]` is the only complete account:
  // one entry per site, each with its real 1-based file lines. The THREE delivery
  // shapes carry it differently:
  //   echo (pre-write)  → no details[]; block _meta {old_line,new_line} is the FIRST
  //                       site only → one approximate hunk, upgraded by the completed
  //                       update (a different _diffSig, so the repaint wins)
  //   completed         → details[], one entry per site (block _meta has no lines)
  //   session/load      → same as completed
  //   whole-file Write  → echo _meta is {} (seed 1); completed details[] length 1
  //
  // `line_prefix` is the text BEFORE the match on that line, so prepending it turns a
  // bare "PLACEHOLDER" into "item 1: the token is PLACEHOLDER". There is NO
  // line_suffix on the wire — the tail of the line is genuinely unavailable, and
  // reconstructing it from a neighbour's context_before is fragile (and impossible for
  // the last site), so the hunk is prefix-only. Still strictly better than the token.
  //
  // Note `old_line` is a POST-edit coordinate; it equals `new_line` in every capture
  // so far, so it's only a true old-side line for line-count-neutral edits (the common
  // token-rename case). See research/edit-diff.md § Line numbers + replace-all.
  function extractDiffSites(meta, oldText, newText) {
    const details = meta && Array.isArray(meta.details) ? meta.details : null;
    if (details && details.length) {
      const sites = [];
      for (const d of details) {
        // An entry that names no strings doesn't describe a site — it can't be
        // expanded, only positioned (handled below).
        if (!d || (typeof d.old_string !== "string" && typeof d.new_string !== "string")) continue;
        const old = typeof d.old_string === "string" ? d.old_string : "";
        const nw = typeof d.new_string === "string" ? d.new_string : "";
        // A creation (no prior content — a new file's details[0] is old_string:"")
        // has no line to prefix; keep "" so it reads as a pure add instead of
        // inventing a deleted line out of the prefix.
        const pre = old === "" || typeof d.line_prefix !== "string" ? "" : d.line_prefix;
        sites.push({ oldText: old === "" ? "" : pre + old, newText: pre + nw, oldLine: d.old_line, newLine: d.new_line });
      }
      if (sites.length) return sites;
      const first = details[0] || {};
      return [{ oldText, newText, oldLine: first.old_line, newLine: first.new_line }];
    }
    return [{ oldText, newText, oldLine: meta && meta.old_line, newLine: meta && meta.new_line }];
  }

  function openDiffMessage(diff, requestId) {
    const positionedSites = diff.sites.filter(
      (site) => Number.isInteger(site.oldLine) || Number.isInteger(site.newLine),
    );
    return {
      type: "openDiff",
      path: diff.path,
      oldText: diff.oldText,
      newText: diff.newText,
      ...(requestId !== undefined ? { requestId } : {}),
      ...(diff.replaceAll ? { replaceAll: true } : {}),
      ...(positionedSites.length ? { sites: positionedSites } : {}),
    };
  }

  function applyToolDiffs(call) {
    const c = call?.content;
    if (!Array.isArray(c)) return;
    const diffs = [];
    for (const item of c) {
      if (item?.type === "diff") {
        const oldText = item.oldText ?? "";
        const newText = item.newText ?? "";
        diffs.push({
          path: item.path,
          oldText, // block-level: the "open diff →" payload + the permission card's line count
          newText,
          sites: extractDiffSites(item._meta, oldText, newText),
          replaceAll: call?.rawInput?.replace_all === true,
        });
      }
    }
    if (!diffs.length) return;
    state.pendingDiffByToolCallId.set(call.toolCallId, diffs[0]); // permission card / openDiff use the first
    attachDiffPreviewToToolItem(call.toolCallId, diffs);
  }

  // Render a tool failure on its row: the row goes error-colored and the reason
  // (grok's "image reference not readable: …" etc.) shows beneath it. Idempotent.
  function applyToolFailure(rowEl, message) {
    if (!rowEl || rowEl.classList.contains("tool-failed")) return;
    rowEl.classList.add("tool-failed");
    const err = document.createElement("div");
    err.className = "tool-error";
    err.textContent = message;
    rowEl.appendChild(err);
  }

  function markToolFailed(toolCallId, message) {
    if (!toolCallId) return;
    state.toolFailuresById.set(toolCallId, message); // so a single-call group carries it onto the flat
    const item = state.toolItemsByToolCallId.get(toolCallId);
    if (item) {
      applyToolFailure(item, message);
      const group = item.closest && item.closest(".tool-group");
      if (group) group.classList.add("has-error"); // collapsed group still signals the failure
      scrollToBottom();
    }
  }

  function addSessionContextBanner() {
    clearWelcome();
    const existing = document.getElementById("summarizing-indicator");
    if (existing) existing.remove();
    const el = document.createElement("div");
    el.className = "session-context-banner";
    el.textContent = "Context from previous session applied";
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  function addError(text) {
    clearWelcome();
    const el = document.createElement("div");
    el.className = "msg error";
    el.textContent = text;
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  // Hover actions for an inlined image/video, anchored top-right like the
  // code-block copy button: copy the on-disk path, or open it in VS Code. Both
  // are the only way to reach a *video's* file (its click drives playback
  // controls, so the click-to-open we give images can't apply there).
  function buildMediaActions(path, src) {
    const actions = document.createElement("div");
    actions.className = "generated-media-actions";

    // Remote clients: there is no host to copy a path to or open a file in — the
    // one action that means anything on a phone is saving the image, which
    // arrives inlined as a self-contained data: URI. Show only Download; the
    // copy-path / open-in-VS-Code buttons would post host-local messages the
    // relay drops.
    if (IS_REMOTE) {
      const dlBtn = document.createElement("button");
      dlBtn.type = "button";
      dlBtn.className = "generated-media-btn";
      dlBtn.title = "Download image";
      dlBtn.innerHTML = ICON.download;
      dlBtn.onclick = async (e) => {
        e.stopPropagation();
        await remoteDownload(src, (String(path || "").split(/[\\/]/).pop() || "image.png"));
        ackBtn(dlBtn);
      };
      actions.appendChild(dlBtn);
      return actions;
    }

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "generated-media-btn";
    copyBtn.title = "Copy path";
    copyBtn.innerHTML = ICON.copy;
    copyBtn.onclick = (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(path).then(() => {
        copyBtn.innerHTML = ICON.check;
        copyBtn.classList.add("copied");
        setTimeout(() => { copyBtn.innerHTML = ICON.copy; copyBtn.classList.remove("copied"); }, 1500);
      });
    };

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "generated-media-btn";
    openBtn.title = "Open in VS Code";
    openBtn.innerHTML = ICON.file;
    openBtn.onclick = (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: "openFile", path });
    };

    actions.appendChild(copyBtn);
    actions.appendChild(openBtn);
    return actions;
  }

  // Render generated media (grok `/imagine` image or `/imagine-video` video).
  // `src` is a renderable source the host resolved for a generated file — a
  // webview URI streamed from disk (big videos) or a base64 data: URI; `url` is
  // a remote link we open externally. Clicking an image opens its source file in
  // VS Code; video gets native <video> controls. Both expose hover icons (copy
  // path / open in VS Code) over the top-right corner.
  function addGeneratedMedia(msg) {
    if (state.suppressReplayTurn) return;
    const isVideo = msg.media === "video";
    closeToolGroup();
    clearWelcome();
    hideGrokking();
    const el = document.createElement("div");
    el.className = "generated-image" + (isVideo ? " generated-video" : "");
    if (msg.src) {
      if (isVideo) {
        const video = document.createElement("video");
        video.src = msg.src;
        video.controls = true;
        video.preload = "metadata";
        video.playsInline = true;
        el.appendChild(video);
      } else {
        const img = document.createElement("img");
        img.src = msg.src;
        img.alt = "Generated image";
        img.loading = "lazy";
        // Click-to-open is a host action (opens the file in VS Code); on a remote
        // client it's dead, so leave the image inert there and let the Download
        // button below be the one affordance.
        if (msg.path && !IS_REMOTE) {
          img.title = "Open " + msg.path;
          img.style.cursor = "pointer";
          img.onclick = () => vscode.postMessage({ type: "openFile", path: msg.path });
        }
        el.appendChild(img);
      }
      if (msg.path) el.appendChild(buildMediaActions(msg.path, msg.src));
    } else if (msg.url) {
      const link = document.createElement("button");
      link.className = "preview-link";
      link.textContent = isVideo ? "open generated video ↗" : "open generated image ↗";
      link.onclick = () => vscode.postMessage({ type: "openUrl", url: msg.url });
      el.appendChild(link);
    }
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  // Distinct row for a subagent delegation (grok's spawn_subagent tool) — the
  // task reads as "Subagent · <description>" with the shared blink-dots while
  // the child works, then a duration stamp and a click-to-expand result once
  // the completed tool_call_update lands (its rawOutput.SubagentCompleted
  // carries output + stats — research/subagents.md). Keyed by toolCallId in
  // state.subagentCards; a replayed one-shot tool_call that already carries
  // the final state renders completed immediately.

  // Human title for the row: the task description grok puts in rawInput, else
  // a non-generic call title (updates re-title the call from the literal
  // "spawn_subagent" to the description; some builds title the call just
  // "Subagent"/"Task" — noise, not a title), else the first line of the task
  // prompt, else the classifier's label (subagent type / background command).
  function subagentTitleFor(call) {
    const d = call && call.rawInput && call.rawInput.description;
    if (typeof d === "string" && d.trim()) return d.trim();
    const t = typeof call?.title === "string" ? call.title.trim() : "";
    if (t && !/^(spawn_subagent|run_terminal_command|subagent|task)$/i.test(t)) return t;
    const p = call && call.rawInput && call.rawInput.prompt;
    if (typeof p === "string" && p.trim()) {
      const first = p.trim().split(/\r?\n/)[0].trim();
      if (first) return truncate(first, 80);
    }
    return subagentLabel(call);
  }

  // "Subagent · Subagent" is noise — when the resolved title is empty or just
  // the word Subagent, show the label alone. Never DOWNGRADE: the Composer
  // agent's completion update arrives untitled (title "", no rawInput), and it
  // must not wipe the description set by the earlier records.
  function setSubagentTitle(el, call) {
    const t = subagentTitleFor(call) || "";
    const titleEl = el.querySelector(".subagent-title");
    if (!t || /^subagent$/i.test(t)) {
      if (!titleEl.textContent) {
        el.querySelector(".subagent-sep").hidden = true;
        titleEl.hidden = true;
      }
      return;
    }
    el.querySelector(".subagent-sep").hidden = false;
    titleEl.hidden = false;
    titleEl.textContent = t;
  }

  // Complete a card: stop the dots, stamp the duration, attach the expandable
  // result under an "Output of the subagent:" label. Completion can arrive
  // twice — a completed tool_call_update AND a subagent_finished lifecycle
  // event (and a re-focus replays both) — so this is idempotent, except that a
  // late duplicate may still fill in a missing duration (Composer's completed
  // update carries no duration_ms; its lifecycle event does).
  function finishSubagentCard(el, info) {
    const failed = !!info.failed;
    const cancelled = !!info.cancelled && !failed;
    const ms = typeof info.durationMs === "number" ? info.durationMs : null;
    const dur = ms != null ? `· ${Math.max(1, Math.round(ms / 1000))}s` : "";
    // A failure/cancel is visible on the row itself ("· failed"/"· cancelled",
    // red via .subagent-failed CSS, muted via .subagent-cancelled) — you
    // shouldn't have to expand the result to see it went wrong.
    const statusWord = failed ? "failed" : cancelled ? "cancelled" : "";
    const timeText = statusWord ? (dur ? `· ${statusWord} ${dur}` : `· ${statusWord}`) : dur;
    if (el.classList.contains("subagent-done")) {
      // Already finished (a tool-channel completion routinely races ahead of the
      // lifecycle finish for the SAME card) — upgrade a missing duration AND a
      // not-yet-shown failure/cancel marker, the two things a later event adds.
      if (failed) el.classList.add("subagent-failed");
      if (cancelled && !el.classList.contains("subagent-failed")) el.classList.add("subagent-cancelled");
      const timeEl = el.querySelector(".subagent-time");
      if (timeEl) {
        if (statusWord) timeEl.textContent = timeText;
        else if (ms != null && !timeEl.textContent) timeEl.textContent = dur;
      }
      return;
    }
    el.classList.add("subagent-done");
    if (failed) el.classList.add("subagent-failed");
    else if (cancelled) el.classList.add("subagent-cancelled");
    const dots = el.querySelector(".blink-dots");
    if (dots) dots.remove();
    const timeEl = el.querySelector(".subagent-time");
    if (timeEl) timeEl.textContent = timeText;
    // cleanSubagentOutput strips the CLI envelope (plumbing tags, boilerplate
    // lead-ins, one wrapping <response> pair, the trailing Agent ID hint) so
    // only the child's actual words render — as markdown, since subagent
    // answers routinely carry fences/bold/lists.
    const result = cleanSubagentOutput(info.output || "");
    if (result) {
      const body = el.querySelector(".subagent-result");
      body.innerHTML = `<div class="subagent-result-label">Output of the subagent:</div>` + renderMarkdown(result);
      applyAutoDir(body);
      const row = el.querySelector(".subagent-row");
      row.classList.add("expandable");
      row.title = "Show the subagent's result";
      row.onclick = () => { body.hidden = !body.hidden; };
    }
  }

  function addSubagentCard(call) {
    closeToolGroup();
    clearWelcome();
    hideGrokking();
    const el = document.createElement("div");
    el.className = "subagent-card";
    el.innerHTML =
      `<div class="subagent-row">` +
        `<span class="subagent-badge">${ICON.bot || "🤖"}</span>` +
        `<span class="subagent-label">Subagent</span>` +
        `<span class="subagent-sep">·</span>` +
        `<span class="subagent-title"></span>` +
        BLINK_DOTS +
        `<span class="subagent-time"></span>` +
      `</div>` +
      `<div class="subagent-result" hidden></div>`;
    setSubagentTitle(el, call);
    // Cards rebuilt by a cold restore never receive their own subagent_spawned
    // (session/load strips the lifecycle rail), so they'd sit permanently
    // untagged — a magnet for a LATER live spawn's FIFO tag, corrupting the old
    // card with the new run's duration/output. Mark them so live spawn-tagging
    // and the no-id finish fallback skip them.
    if (state.replaying) el.dataset.subagentReplayed = "1";
    messagesEl.appendChild(el);
    if (call && call.toolCallId) state.subagentCards.set(call.toolCallId, el);
    applySubagentUpdate(call, el); // a replayed call may already be completed
    scrollToBottom();
  }

  function applySubagentUpdate(call, elOpt) {
    const el = elOpt || state.subagentCards.get(call?.toolCallId);
    if (!el) return;
    setSubagentTitle(el, call);
    // A background spawn's updates carry the child's task_id — stash it so the
    // get_command_or_subagent_output poller's TaskOutput can find this card.
    const tid = call && call.rawInput && call.rawInput.task_id;
    if (tid && !el.dataset.taskId) el.dataset.taskId = String(tid);
    // Completion shapes: grok-build's spawn_subagent → status "completed" +
    // structured rawOutput.SubagentCompleted (output, duration_ms); Composer's
    // Task → status "completed" + rawOutput {type:"Text", text} with NO
    // duration (the subagent_finished lifecycle event fills that in).
    const out = call && call.rawOutput;
    const status = String(call?.status || "").toLowerCase();
    const finished = status === "completed" || status === "failed" || status === "cancelled" ||
      (out && out.type === "SubagentCompleted");
    if (!finished) return;
    // Output lives in rawOutput.output (SubagentCompleted), rawOutput.text
    // ({type:"Text"} — Composer + background acks), or the content text.
    const output = out && typeof out.output === "string" ? out.output
      : out && typeof out.text === "string" ? out.text
      : toolUpdateText(call);
    // A background spawn (rawInput.background: true) "completes" immediately
    // with a started-ack while the child keeps running — that's not the
    // result. Keep the dots; the real output arrives on the
    // get_command_or_subagent_output poller's TaskOutput, matched back to this
    // card by the child id parsed here (wire capture: accredia session).
    if (/^subagent started in background\b/i.test(String(output || "").trim())) {
      const ackId = /subagent_id:\s*([0-9a-f-]+)/i.exec(String(output));
      if (ackId && !el.dataset.subagentId) el.dataset.subagentId = ackId[1];
      return;
    }
    // Thread the failure/cancel through the tool-channel path too — not just the
    // lifecycle rail — since the tool-channel completion is the common ordering.
    finishSubagentCard(el, {
      durationMs: out && typeof out.duration_ms === "number" ? out.duration_ms : null,
      output,
      failed: status === "failed",
      cancelled: status === "cancelled",
    });
  }

  // A background delegation's result arrives on the poller tool
  // (get_command_or_subagent_output), whose completed update carries
  // rawOutput { type: "TaskOutput", Result: { task_id, duration_secs, status,
  // output, … } } — finish the matching card. Returns true when at least one
  // card matched, so the caller can drop the redundant poller row.
  function maybeFinishSubagentFromTaskOutput(call) {
    const out = call && call.rawOutput;
    if (!out || out.type !== "TaskOutput") return false;
    const results = [];
    if (out.Result) results.push(out.Result);
    if (Array.isArray(out.Results)) results.push(...out.Results);
    let matched = false;
    for (const res of results) {
      const tid = res && (res.task_id || res.taskId);
      if (!tid) continue;
      const el = [...state.subagentCards.values()].find(
        (c) => c.dataset.taskId === String(tid) || c.dataset.subagentId === String(tid),
      );
      if (!el) continue;
      matched = true;
      const status = String(res.status || "completed").toLowerCase();
      finishSubagentCard(el, {
        durationMs: typeof res.duration_secs === "number" ? Math.round(res.duration_secs * 1000)
          : typeof res.duration_ms === "number" ? res.duration_ms : null,
        output: typeof res.output === "string" ? res.output : "",
        failed: status === "failed",
        cancelled: status === "cancelled",
      });
    }
    return matched;
  }

  // Cold restore (session/load) flattens a background delegation's poller output
  // to a TEXT blob instead of the structured TaskOutput above (=== Task … === /
  // Command: [subagent:…] / … / === Output ===). Parse it back so a restored card
  // shows its result + duration; returns true so the caller drops the redundant
  // poller row. A backgrounded shell command polls through the same tool, so
  // parseSubagentTaskResult returns null for non-subagent blobs (row kept).
  function maybeFinishSubagentFromTaskText(call) {
    const out = call && call.rawOutput;
    const text = toolUpdateText(call)
      || (typeof out === "string" ? out : "")
      || (out && typeof out.text === "string" ? out.text : "")
      || (out && typeof out.output === "string" ? out.output : "");
    if (!text) return false;
    const parsed = parseSubagentTaskResult(text);
    if (!parsed) return false;
    const el = [...state.subagentCards.values()].find(
      (c) => c.dataset.taskId === String(parsed.taskId) || c.dataset.subagentId === String(parsed.taskId),
    );
    if (!el) return false;
    finishSubagentCard(el, {
      durationMs: parsed.durationMs,
      output: parsed.output,
      failed: parsed.status === "failed",
      cancelled: parsed.status === "cancelled",
    });
    return true;
  }

  // ---------- Workflow / Goal / Deep-research progress cards (P2-10) ----------
  // Host normalizes `_x.ai/session_notification` workflow_updated / goal_updated
  // into a stable shape; we upsert one card per id and stop the dots on done.

  function applyRunProgress(update) {
    if (!update || !update.id) return;
    clearWelcome();
    hideGrokking();
    const id = String(update.id);
    let el = state.runProgressCards.get(id);
    if (!el) {
      el = document.createElement("div");
      el.className = "run-progress-card";
      el.dataset.runId = id;
      el.innerHTML =
        `<div class="run-progress-row">` +
          `<span class="run-progress-badge">${ICON.orbit || ""}</span>` +
          `<span class="run-progress-kind"></span>` +
          `<span class="run-progress-sep">·</span>` +
          `<span class="run-progress-title"></span>` +
          BLINK_DOTS +
          `<span class="run-progress-phase"></span>` +
        `</div>` +
        `<div class="run-progress-sub" hidden></div>` +
        `<div class="run-progress-detail" hidden></div>` +
        `<div class="run-progress-actions" hidden></div>`;
      state.runProgressCards.set(id, el);
      messagesEl.appendChild(el);
    }

    const kindLabel = update.kind === "goal" ? "Goal" : "Workflow";
    el.querySelector(".run-progress-kind").textContent = kindLabel;
    const title = update.title || id;
    el.querySelector(".run-progress-title").textContent = title;
    el.querySelector(".run-progress-title").title = title;

    const phase = String(update.phase || "running");
    const pct =
      typeof update.progress === "number" && Number.isFinite(update.progress)
        ? ` ${Math.round(update.progress * 100)}%`
        : "";
    const phaseEl = el.querySelector(".run-progress-phase");
    const statusWord = update.failed
      ? "failed"
      : update.cancelled
        ? "cancelled"
        : update.done
          ? (phase === "completed" || phase === "success" ? "done" : phase)
          : phase;
    phaseEl.textContent = `· ${statusWord}${pct}`;

    const sub = el.querySelector(".run-progress-sub");
    if (update.subtitle) {
      sub.hidden = false;
      sub.textContent = update.subtitle;
    } else {
      sub.hidden = true;
      sub.textContent = "";
    }
    const detail = el.querySelector(".run-progress-detail");
    if (update.detail) {
      detail.hidden = false;
      detail.textContent = update.detail;
    } else {
      detail.hidden = true;
      detail.textContent = "";
    }

    el.classList.toggle("run-progress-failed", !!update.failed);
    el.classList.toggle("run-progress-cancelled", !!update.cancelled && !update.failed);
    el.classList.toggle("run-progress-done", !!update.done);

    const dots = el.querySelector(".blink-dots");
    if (update.done) {
      if (dots) dots.remove();
    } else if (!dots) {
      // Restarted (e.g. resume) — put dots back after the title.
      const titleEl = el.querySelector(".run-progress-title");
      if (titleEl) titleEl.insertAdjacentHTML("afterend", BLINK_DOTS);
    }

    // Workflow control buttons (pause/resume/stop) while running or paused.
    const actions = el.querySelector(".run-progress-actions");
    if (update.kind === "workflow" && update.displayName && !update.done) {
      actions.hidden = false;
      const paused = /paus/.test(phase);
      actions.innerHTML = "";
      const mk = (label, action) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "run-progress-btn";
        b.textContent = label;
        b.onclick = (e) => {
          e.stopPropagation();
          vscode.postMessage({
            type: "workflowControl",
            action,
            displayName: update.displayName,
          });
        };
        return b;
      };
      if (paused) actions.appendChild(mk("Resume", "resume"));
      else actions.appendChild(mk("Pause", "pause"));
      actions.appendChild(mk("Stop", "stop"));
    } else {
      actions.hidden = true;
      actions.innerHTML = "";
    }

    scrollToBottom();
  }

  function addPlanNotice(text) {
    clearWelcome();
    hideGrokking();
    const el = document.createElement("div");
    el.className = "plan-notice";
    el.innerHTML = `${ICON.listTree}<span>${escapeHtml(text)}</span>`;
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  // Automatic (context-full) compaction note. The CLI can compact at a turn's
  // START (no active bubble — clean) OR between tool-loop passes (an agent bubble
  // may be live). Finalize that bubble first so the notice sits BETWEEN prior
  // content and what follows — otherwise later answer tokens reuse the pre-notice
  // bubble and render ABOVE the notice. Text arrives as markdown (italic).
  function addAutoCompactNotice(text) {
    flushAgent();
    state.activeAgentEl = null;
    state.activeAgentRaw = "";
    clearWelcome();
    hideGrokking();
    const el = document.createElement("div");
    el.className = "plan-notice";
    el.innerHTML = `${ICON.zap}<span>${escapeHtml(text)}</span>`;
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  function appendThought(text) {
    if (state.suppressReplayTurn) return; // thinking inside the primer turn
    hidePlanProcessing(); // thought streaming → indicator obsolete
    hideGrokking(); // real content arrived — the Thinking block takes over
    // Traces hidden (the default): stand in with a "Thinking…" row. While
    // replaying a loaded session there's no live reasoning to indicate.
    if (!state.showThinking && !state.replaying) showThinkingIndicator();
    state.activeUserEl = null;
    state.skipUserBubble = false; // marker-only verdict turn is over
    clearWelcome();
    if (!state.activeThoughtEl) {
      if (!state.thoughtStartTime) state.thoughtStartTime = Date.now();
      state.thoughtBuffer = "";
      const el = document.createElement("div");
      el.className = "msg thinking";
      const hdr = document.createElement("div");
      hdr.className = "thinking-header";
      // Chevron on the RIGHT (after the label), same glyph as tool groups; expand
      // state is driven by the `.expanded` class (CSS rotates it), like tools.
      hdr.innerHTML = `<span class="thinking-icon">${ICON.brain}</span><span class="thinking-label">Thinking</span>${BLINK_DOTS}<span class="thinking-chevron" aria-hidden="true">${ICON.chevronRight}</span>`;
      const body = document.createElement("div");
      body.className = "thinking-body";
      body.hidden = true;
      hdr.onclick = () => {
        body.hidden = !body.hidden;
        el.classList.toggle("expanded", !body.hidden);
      };
      el.appendChild(hdr);
      el.appendChild(body);
      messagesEl.appendChild(el);
      state.activeThoughtEl = body;
      state.activeThoughtHdrEl = hdr;
    }
    state.thoughtBuffer += text;
    if (!state.thoughtRenderScheduled) {
      state.thoughtRenderScheduled = true;
      requestAnimationFrame(flushThought);
    }
  }

  function flushThought() {
    state.thoughtRenderScheduled = false;
    if (!state.activeThoughtEl) return;
    state.activeThoughtEl.textContent = state.thoughtBuffer;
    scrollToBottom();
  }

  function appendAgent(text) {
    if (state.suppressReplayTurn) return; // grok's response to the primer
    hidePlanProcessing(); // agent output started — clear the indicator
    hideGrokking(); // real content arrived — the message bubble takes over
    hideThinkingIndicator(); // a real message replaces the "Thinking…" stand-in
    state.activeUserEl = null;
    state.skipUserBubble = false; // marker-only verdict turn is over
    closeToolGroup();
    clearWelcome();
    if (!state.activeAgentEl) {
      state.activeAgentEl = addMessage("agent", "");
      state.activeAgentRaw = "";
    }
    state.activeAgentRaw += text;
    if (!state.agentRenderScheduled) {
      state.agentRenderScheduled = true;
      requestAnimationFrame(flushAgent);
    }
  }

  function flushAgent() {
    state.agentRenderScheduled = false;
    if (!state.activeAgentEl) return;
    state.activeAgentEl.innerHTML = renderMarkdown(state.activeAgentRaw);
    applyAutoDir(state.activeAgentEl);
    renderMermaidIn(state.activeAgentEl);
    const wrapper = state.activeAgentEl.parentElement;
    if (wrapper) wrapper._copyText = state.activeAgentRaw;
    scrollToBottom();
    pinTurnDiffSummary(); // narration after tools must not leave the summary mid-turn
  }

  // Finalize the current agent turn (flush buffers, stamp the "Thought for Ns"
  // label, close any open tool group) and clear the active-element handles so
  // the next chunk starts a fresh bubble. Used on promptComplete and at the
  // user-message boundary while replaying a loaded session.
  function commitAgentTurn() {
    flushAgent();
    flushThought();
    if (state.thoughtStartTime && state.activeThoughtHdrEl) {
      // Drop the blink-dots once the reasoning settles, and label it. Replayed
      // turns have no real elapsed time, so they omit the seconds.
      const dots = state.activeThoughtHdrEl.querySelector(".blink-dots");
      if (dots) dots.remove();
      const label = state.activeThoughtHdrEl.querySelector(".thinking-label");
      if (label) {
        label.textContent = state.replaying
          ? "Thought"
          : `Thought for ${Math.round((Date.now() - state.thoughtStartTime) / 1000)}s`;
      }
      state.thoughtStartTime = null;
    }
    closeToolGroup();
    hideThinkingIndicator();
    state.activeAgentEl = null;
    state.activeAgentRaw = "";
    state.activeThoughtEl = null;
    state.activeThoughtHdrEl = null;
    pinTurnDiffSummary();
  }

  // Replayed user prompts (session/load) arrive as user_message_chunk updates.
  // Commit any in-flight agent turn first, then accumulate into one user bubble.
  function appendUserChunk(text) {
    // Replay-only: live user bubbles come from the optimistic `userMessage`
    // post. grok ≥0.2.33 echoes the live prompt back as a user_message_chunk;
    // the host already drops those, but guard here too so a stray live echo
    // can never double the bubble.
    if (!state.replaying) return;
    if (state.activeAgentEl || state.activeThoughtEl || state.activeToolGroupEl) {
      commitAgentTurn();
    }
    // No clearWelcome() here: the primer / system-reminder checks below may
    // suppress this entire message, and a primer-only restore must KEEP the
    // welcome screen. addMessage() clears it when a real bubble renders.
    if (!state.activeUserEl && !state.skipUserBubble) {
      // A new user message is starting. If we're replaying and this message is
      // the extension's primer, suppress it AND grok's response to it — both
      // are extension plumbing the user never typed, and we don't want them
      // surfacing as fake user bubbles on every session restore.
      if (state.replaying && PRIMER_PATTERN.test(text)) {
        state.suppressReplayTurn = true;
        return;
      }
      // Background-task notices the CLI injects as <system-reminder> user turns
      // are agent plumbing, not user content — never bubble them on restore.
      // Grok's reply to them still renders. (Live ones are already dropped by
      // the !replaying guard above; this covers the replayed copy.)
      if (SYSTEM_REMINDER_PATTERN.test(text)) {
        state.skipUserBubble = true;
        return;
      }
      state.suppressReplayTurn = false;
      // Drain saved plan cards that should appear BEFORE this user message — the
      // verdict message that resolved a plan is the boundary, so drain first even
      // for a marker-only verdict that itself renders no bubble.
      drainPlanHistory(state.userMsgCount);
      drainPermissionHistory(state.userMsgCount);
      if (state.replaying) {
        const mk = stripPlanMarker(text);
        if (mk.matched) {
          // A plan-verdict protocol message. Live never counted or showed a
          // marker-only verdict (e.g. plain "[Plan cancelled]"), so skip it here
          // too — both to hide the grok-only marker and to keep userMsgCount
          // aligned with the afterUserMessage positions the host persisted.
          if (!mk.rest.trim()) {
            state.skipUserBubble = true;
            return;
          }
          // Marker + comment: drop the marker, keep the user's words. Live
          // counted this (the comment), so we count it here too.
          text = mk.rest;
        }
      }
      // Restore has no agentStart between turns — a new user bubble is the
      // turn boundary. Pin the previous turn's change list before clearing.
      pinTurnDiffSummary();
      startTurnDiffTracking();
      state.userMsgCount += 1;
      state.activeUserEl = addMessage("user", "");
      state.activeUserRaw = "";
    }
    if (state.skipUserBubble) return; // marker-only verdict: no user bubble
    if (state.suppressReplayTurn) return; // still inside the primer's user message
    state.activeUserRaw += text;
    // The replayed prompt carries the <vscode-context> envelope we sent; strip it
    // back out so the bubble shows the user's own words + filename-only chips (with
    // the full path on hover), matching the live send — not the raw paths inline.
    // Fenced selection snippets (buildPrompt's output for ranged chips) become
    // ranged chips (`a.ts:2-4`) the same way, and the [Image #N] tag lines
    // buildPromptWithImages appended become image chips — each parser only strips
    // the exact leading/trailing shapes we produce, so a look-alike string in the
    // middle of the user's own words stays put. The stripped body is also what
    // the copy button yields: the user's words, not the context plumbing.
    const parsed = parseAttachmentContext(state.activeUserRaw);
    const selBlocks = parseSelectionBlocks(parsed.body);
    const imageTags = parseImageTags(selBlocks.body);
    state.activeUserEl.innerHTML = renderMarkdown(imageTags.body);
    applyAutoDir(state.activeUserEl);
    // On restore, a steered message comes back wrapped in the CLI's own
    // interjection envelope. Mark it so it doesn't consume a rewind index — the
    // live path gets the same mark from `steer` on the userMessage.
    if (isInterjectionText(state.activeUserRaw)) {
      const steerEl = state.activeUserEl.closest(".msg");
      if (steerEl) {
        steerEl.dataset.steer = "1";
        refreshUserRewindButtons();
      }
    }
    const msgEl = state.activeUserEl.closest(".msg");
    if (msgEl) msgEl._copyText = imageTags.body;
    const chipTags = [
      ...parsed.files.map((f) => makeMsgChipTag(f)),
      ...selBlocks.selections.map((s) =>
        makeMsgChipTag(s.path, { selectionStart: s.start, selectionEnd: s.end })),
      ...imageTags.images.map((im) =>
        makeMsgChipTag(`Image #${im.index}`, { imageIndex: im.index, path: im.path })),
    ];
    if (chipTags.length) {
      const chipsRow = document.createElement("div");
      chipsRow.className = "msg-chips";
      for (const tag of chipTags) chipsRow.appendChild(tag);
      state.activeUserEl.appendChild(chipsRow);
    }
    scrollToBottom();
  }

  // Render and dequeue every saved plan whose `afterUserMessage` <= cutoff.
  // Plans without a saved position never drain here — they fall out at the end
  // of replay when we flush the rest of the queue.
  function drainPlanHistory(cutoff) {
    if (!state.planHistoryQueue.length) return;
    state.planHistoryQueue = state.planHistoryQueue.filter((p) => {
      if (typeof p.afterUserMessage === "number" && p.afterUserMessage <= cutoff) {
        addPlanHistoryCard(p.text, p.verdict, p.planPath, p.planName);
        return false;
      }
      return true;
    });
  }

  function flushPlanHistory() {
    if (!state.planHistoryQueue.length) return;
    for (const p of state.planHistoryQueue) addPlanHistoryCard(p.text, p.verdict, p.planPath, p.planName);
    state.planHistoryQueue = [];
  }

  // Render a restored permission card collapsed (no buttons) — the answer is
  // history. Reuses the live collapsed representation.
  function addRestoredPermissionCard(title, outcome) {
    clearWelcome();
    const el = document.createElement("div");
    collapsePermissionCard(el, outcome === "rejected" ? "reject_once" : "allow_once", title);
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  // Render a restored permission card at the exact tool it gated, the moment that
  // tool replays — so it lands where it was answered, not at the turn boundary.
  // Matches by toolCallId when we have it, else by exact title (the card title IS
  // the tool's title, so an older entry saved without an id still anchors). The
  // real title arrives on the tool_call_update (the tool_call is often a generic
  // "Shell"/"Grep"), so this is called from both. Closing the open tool group
  // first mirrors the live commitAgentTurn.
  function renderRestoredPermissionForTool(toolCallId, title) {
    if (!state.permissionHistoryQueue.length) return;
    const matches = state.permissionHistoryQueue.filter((p) =>
      (toolCallId && p.toolCallId === toolCallId) ||
      (!p.toolCallId && title && p.title === title));
    if (!matches.length) return;
    const matched = new Set(matches);
    state.permissionHistoryQueue = state.permissionHistoryQueue.filter((p) => !matched.has(p));
    closeToolGroup();
    for (const p of matches) addRestoredPermissionCard(p.title, p.outcome);
  }

  // Fallback for entries WITHOUT a toolCallId (legacy/unmatchable): position by
  // user-message boundary like plans. Tool-anchored entries are handled inline.
  function drainPermissionHistory(cutoff) {
    if (!state.permissionHistoryQueue.length) return;
    state.permissionHistoryQueue = state.permissionHistoryQueue.filter((p) => {
      if (!p.toolCallId && typeof p.afterUserMessage === "number" && p.afterUserMessage <= cutoff) {
        addRestoredPermissionCard(p.title, p.outcome);
        return false;
      }
      return true;
    });
  }

  function flushPermissionHistory() {
    if (!state.permissionHistoryQueue.length) return;
    for (const p of state.permissionHistoryQueue) addRestoredPermissionCard(p.title, p.outcome);
    state.permissionHistoryQueue = [];
  }

  function showPlanProcessing() {
    hidePlanProcessing(); // dedupe
    hideGrokking(); // one waiting indicator at a time
    hideThinkingIndicator();
    clearWelcome();
    const el = document.createElement("div");
    el.className = "plan-processing";
    el.innerHTML = '<span class="plan-processing-dots"><span></span><span></span><span></span></span>';
    el.setAttribute("aria-label", "Grok is processing");
    messagesEl.appendChild(el);
    state.planProcessingEl = el;
    scrollToBottom();
  }

  function hidePlanProcessing() {
    if (state.planProcessingEl && state.planProcessingEl.parentElement) {
      state.planProcessingEl.parentElement.removeChild(state.planProcessingEl);
    }
    state.planProcessingEl = null;
  }

  // "Grokking…" — the generic waiting indicator shown on every user-initiated
  // turn from agentStart until grok produces its first content (thought /
  // message / tool / card), which removes it and renders in its place. Mirrors
  // the Thinking header's look (loading-dots ellipsis, same muted font) without
  // the chevron, and is not expandable. Mutually exclusive with planProcessing.
  function showGrokking() {
    hideGrokking(); // dedupe
    hidePlanProcessing(); // one waiting indicator at a time
    hideThinkingIndicator();
    clearWelcome();
    const el = document.createElement("div");
    el.className = "grokking";
    // No blink-dots here — the spinning orbit icon is Grokking's "waiting" motion
    // (Thinking / tools use the dots for discrete progress instead).
    el.innerHTML = `<span class="grokking-icon">${ICON.orbit}</span><span class="grokking-label">Grokking</span>`;
    el.setAttribute("aria-label", "Grok is working");
    el.title = "Waiting for response";
    messagesEl.appendChild(el);
    state.grokkingEl = el;
    scrollToBottom();
  }

  function hideGrokking() {
    if (state.grokkingEl && state.grokkingEl.parentElement) {
      state.grokkingEl.parentElement.removeChild(state.grokkingEl);
    }
    state.grokkingEl = null;
  }

  // "Thinking…" — the stand-in shown while thinking traces are hidden (#26, the
  // default). grok's thought stream is suppressed from view, so this lightweight
  // row signals it's reasoning — but only when nothing else already conveys work
  // (no running tool group, no Grokking). Styled like a tool row: brain icon +
  // muted label + animated loading-dots. Stable while thoughts stream; removed
  // the moment a tool, agent message, or turn-end takes over.
  function showThinkingIndicator() {
    if (state.thinkingIndicatorEl) return; // already up — keep it stable
    if (state.activeToolGroupEl) return; // a running tool already indicates work
    hideGrokking();
    hidePlanProcessing();
    clearWelcome();
    const el = document.createElement("div");
    el.className = "thinking-indicator";
    el.innerHTML = `<span class="thinking-indicator-icon">${ICON.brain}</span><span class="thinking-indicator-label">Thinking</span>${BLINK_DOTS}`;
    el.setAttribute("aria-label", "Grok is thinking");
    messagesEl.appendChild(el);
    state.thinkingIndicatorEl = el;
    scrollToBottom();
  }

  function hideThinkingIndicator() {
    if (state.thinkingIndicatorEl && state.thinkingIndicatorEl.parentElement) {
      state.thinkingIndicatorEl.parentElement.removeChild(state.thinkingIndicatorEl);
    }
    state.thinkingIndicatorEl = null;
  }

  // Apply the show/hide-thinking setting. A single body class hides every
  // `.msg.thinking` block at once — so it covers replayed/old sessions too and
  // toggling is instant with no reload — and turning traces back on drops the
  // stand-in indicator.
  function applyThinkingVisibility() {
    document.body.classList.toggle("thinking-hidden", !state.showThinking);
    if (state.showThinking) hideThinkingIndicator();
  }

  // True when *something* already tells the user grok is mid-work or awaiting
  // them: a waiting indicator, a running tool group, streaming agent text, a
  // visible thinking block (only counts when traces are shown — hidden ones are
  // display:none), or an open permission/question/plan card.
  function turnHasVisibleActivity() {
    return !!(
      state.grokkingEl ||
      state.thinkingIndicatorEl ||
      state.planProcessingEl ||
      state.activeToolGroupEl ||
      (state.activeAgentEl && (state.activeAgentRaw || "").trim()) ||
      (state.showThinking && state.activeThoughtEl) ||
      messagesEl.querySelector(".card:not(.resolved)")
    );
  }

  // Guarantee a live turn never looks idle: while the user's turn is in flight
  // (busy, not the locked priming window, not replaying), at least one progress
  // affordance — Grokking / Tools / Thinking — must be on screen. If a step left
  // nothing visible, stand in with the generic "Grokking…"; the next real chunk
  // replaces it. Called after each mid-turn event the agent emits.
  function ensureActivityIndicator() {
    if (!state.busy || state.busyLocked || state.replaying) return;
    if (turnHasVisibleActivity()) return;
    showGrokking();
  }

  // Follow streaming output only while the user is pinned to the bottom. Once
  // they scroll up (the listener below clears state.stickToBottom) this becomes
  // a no-op, so they can read history while grok keeps thinking (#16).
  function scrollToBottom() {
    if (state.stickToBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // The floating "Scroll to bottom" button (#28) shows exactly when we've stopped
  // following the bottom — same threshold that gates auto-scroll, so it appears
  // the instant streaming output runs off-screen. It lives inside `.composer`
  // (position:absolute over the input), so it rides the chat's `--chat-zoom`
  // scale and stays pinned above the input area at any font scale.
  function updateScrollBtn() {
    scrollBottomBtn.classList.toggle("visible", !state.stickToBottom);
  }

  // Always pull the view to the bottom and re-pin. For interactive activity the
  // user needs to see regardless of where they've scrolled: permission/question
  // cards and their own just-sent message.
  function forceScrollToBottom() {
    state.stickToBottom = true;
    messagesEl.scrollTop = messagesEl.scrollHeight;
    updateScrollBtn();
  }

  // Keep the reader's place when the scrollport HEIGHT changes — the mobile
  // keyboard or URL bar collapsing (dvh), or the VS Code panel resizing.
  // Pinned readers get re-pinned (growth otherwise leaves a blank strip
  // below); scrolled-up readers keep their top line exactly where it was —
  // the resize must never be the thing that yanks the view to the bottom
  // (tapping a toolbar button on a phone collapses the keyboard, and that
  // used to jump the whole message area).
  let lastScrollportHeight = messagesEl.clientHeight;
  new ResizeObserver(() => {
    const h = messagesEl.clientHeight;
    if (h === lastScrollportHeight) return;
    lastScrollportHeight = h;
    if (state.stickToBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
  }).observe(messagesEl);

  // While a click-triggered smooth scroll is animating, the intermediate scroll
  // events would briefly re-show the button; suppress recompute until we land.
  let autoScrolling = false;
  messagesEl.addEventListener("scroll", () => {
    if (autoScrolling) {
      if (messagesEl.scrollTop + messagesEl.clientHeight >= messagesEl.scrollHeight - 4) {
        autoScrolling = false;
      } else {
        return;
      }
    }
    state.stickToBottom = shouldStickToBottom(
      messagesEl.scrollTop, messagesEl.scrollHeight, messagesEl.clientHeight);
    updateScrollBtn();
  });

  scrollBottomBtn.onclick = () => {
    autoScrolling = true;
    state.stickToBottom = true;
    updateScrollBtn();
    messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: "smooth" });
  };

  // ---------- permission card ----------

  // Verb shown on a resolved (minimized) permission card.
  const PERM_VERB = {
    allow_always: "Allowed",
    allow_once: "Allowed",
    reject_once: "Rejected",
  };

  // Replace a permission card with a single muted, non-interactive line once the
  // user answers — same minimized treatment as a resolved question/plan card.
  // `kind` drives the colour; `title` says what it applied to.
  function collapsePermissionCard(el, kind, title) {
    el.className = "card permission resolved perm-resolved";
    el.innerHTML = "";
    const line = document.createElement("div");
    line.className = "perm-resolved-line perm-" + (kind === "reject_once" ? "rejected" : "allowed");
    const verb = document.createElement("span");
    verb.className = "perm-resolved-verb";
    verb.textContent = PERM_VERB[kind] || "Answered";
    line.appendChild(verb);
    const what = document.createElement("span");
    what.className = "perm-resolved-what";
    what.textContent = title || "";
    line.appendChild(what);
    el.appendChild(line);
  }

  function addPermissionCard(req) {
    clearWelcome();
    hideGrokking();
    // Mirror the plan card: finalize any in-flight agent/thinking/tool turn so
    // grok's continuation after the answer renders BELOW this card, not appended
    // to the bubble that was streaming above it.
    commitAgentTurn();
    const cardTitle = req.toolCall?.title || `permission: ${req.toolCall?.kind || "tool"}`;
    const el = document.createElement("div");
    el.className = "card permission";
    // Tag the card so a buffered `permissionResolved` (replayed when this session
    // is re-focused) can find it and collapse it — the live collapse is a DOM-only
    // mutation that isn't in the session buffer, so without this an already-answered
    // card replays as active on every re-focus.
    el.dataset.permReqId = String(req.id);
    el._permOptions = req.options || [];
    el._permTitle = cardTitle;
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = cardTitle;
    el.appendChild(title);

    const diff = state.pendingDiffByToolCallId.get(req.toolCall?.toolCallId);
    if (diff) {
      const subtitle = document.createElement("div");
      subtitle.className = "card-subtitle";
      const oldLines = (diff.oldText || "").split("\n").length;
      const newLines = (diff.newText || "").split("\n").length;
      subtitle.textContent = `${diff.path} — ${oldLines} → ${newLines} lines`;
      el.appendChild(subtitle);

      const openDiff = () => vscode.postMessage(openDiffMessage(diff, req.id));
      const preview = document.createElement("button");
      preview.className = "preview-link";
      // Auto-opens below; the button stays so you can re-open if you closed it.
      preview.textContent = "open diff →";
      preview.onclick = openDiff;
      el.appendChild(preview);
      // Open the diff automatically when the card appears, so reviewing an edit
      // is one glance + one click on the decision — no "open diff" step (#21).
      openDiff();
    }

    const actions = document.createElement("div");
    actions.className = "card-actions";
    // Approve first, reject last — the CLI's own order isn't guaranteed, and the
    // keyboard default below must never land on a reject (#68).
    const options = orderPermissionOptions(req.options);
    const defaultIndex = defaultPermissionIndex(options);
    const buttons = [];
    options.forEach((opt, i) => {
      const btn = document.createElement("button");
      btn.textContent = opt.name;
      btn.type = "button";
      if (opt.kind === "allow_once") btn.classList.add("primary");
      if (opt.kind === "reject_once") btn.classList.add("danger");
      // Only the default button is in the tab order; the arrow keys move within
      // the group. Standard toolbar/radiogroup roving-tabindex, so Tab escapes
      // the card in one press instead of walking every option.
      btn.tabIndex = i === (defaultIndex >= 0 ? defaultIndex : 0) ? 0 : -1;
      btn.onclick = () => {
        vscode.postMessage({
          type: "permissionAnswer",
          requestId: req.id,
          optionId: opt.optionId,
        });
        // Collapse to one muted line and show the working indicator — grok
        // resumes the turn after the answer.
        collapsePermissionCard(el, opt.kind, cardTitle);
        showGrokking();
        // Return the caret to the composer so the next message can be typed
        // immediately — answering must not orphan focus on the collapsed card
        // (#68). Composer, not the editor: the webview iframe can only move
        // focus within itself, and the composer is where you continue anyway.
        input.focus();
      };
      buttons.push(btn);
      actions.appendChild(btn);
    });
    wirePermissionKeys(actions, buttons);
    el.appendChild(actions);
    messagesEl.appendChild(el);
    forceScrollToBottom(); // a pending permission must be visible (#16)

    // Take the keyboard ONLY when there's nothing to take it from — an empty,
    // idle composer. With type-through (below) this costs the user nothing: if
    // they'd rather type than answer, their first character still lands in the
    // composer and focus follows it.
    if (
      defaultIndex >= 0 &&
      shouldFocusPermissionCard({
        replaying: state.replaying,
        composing: state.composingIME,
        composerText: input.value,
        defaultIndex,
      })
    ) {
      focusPermissionButton(buttons, defaultIndex);
    }
  }

  /**
   * Keyboard model for a permission card's action row (#68).
   *
   * Enter/Space activate the focused button (the browser already does this) —
   * the value here is that focus is VISIBLE, so the same key always does the
   * same thing. That's the whole reason this isn't a "did you type in the last
   * second?" timer: the action a keystroke takes must never depend on state the
   * user can't see, least of all when the action is approving a command.
   */
  function wirePermissionKeys(actions, buttons) {
    actions.addEventListener("keydown", (e) => {
      const current = buttons.indexOf(document.activeElement);
      if (current < 0) return;

      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        focusPermissionButton(buttons, (current + 1) % buttons.length);
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        focusPermissionButton(buttons, (current - 1 + buttons.length) % buttons.length);
        return;
      }
      if (e.key === "Escape") {
        // Hand the keyboard back without answering. The card stays pending —
        // Escape is "not now", never an implicit reject.
        e.preventDefault();
        input.focus();
        return;
      }
      if (isTypeThroughKey(e)) {
        // The user started typing at a focused button. Don't swallow the
        // character and don't let it activate anything — move to the composer
        // and let the keystroke land there.
        e.preventDefault();
        input.focus();
        const pos = input.selectionStart ?? input.value.length;
        input.value = input.value.slice(0, pos) + e.key + input.value.slice(input.selectionEnd ?? pos);
        input.selectionStart = input.selectionEnd = pos + 1;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
  }

  function focusPermissionButton(buttons, index) {
    // `.chosen` is the VISIBLE armed marker (outline via .card-actions button.chosen).
    // It rides the roving button rather than :focus-visible, which browsers do NOT
    // paint on programmatic .focus() — that gap is why the default sometimes showed
    // no selected border (#68). Tie it to the roving focus so the border is
    // deterministic however focus arrived (default steal, arrow nav, or click).
    buttons.forEach((b, i) => {
      const on = i === index;
      b.tabIndex = on ? 0 : -1;
      b.classList.toggle("chosen", on);
    });
    buttons[index].focus();
  }

  // ---------- question card (ask_user_question) ----------

  // A "Grok is asking" label + the question text, prominent. Shared by the live
  // and restored cards so they look identical.
  function buildQuestionHead(el, headingText) {
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = headingText;
    el.appendChild(title);
    return title;
  }

  // The green "✓ <labels>" line shown once a question is answered (or "(skipped)").
  function answerLineEl(labels) {
    const ans = document.createElement("div");
    ans.className = "question-answer";
    ans.textContent = labels ? "✓ " + labels : "(skipped)";
    return ans;
  }

  // Inline card for grok's x.ai/ask_user_question. Renders each question with
  // its options; single-select with one question resolves on click (like the
  // permission card), otherwise the user picks across questions and submits.
  // The host replies with { outcome: "accepted", answers } — keyed by question
  // text — which unblocks grok's tool mid-turn. On answer the card COLLAPSES to
  // the question + a clear green "✓ <chosen>" so it's obvious grok received it
  // (the bare grey-out gave no such signal).
  function addQuestionCard(req) {
    clearWelcome();
    hideGrokking();
    const questions = Array.isArray(req.questions) ? req.questions : [];
    const el = document.createElement("div");
    el.className = "card question";

    const title = buildQuestionHead(el, "Grok is asking");

    // selections[i] = array of chosen labels for question i.
    const selections = questions.map(() => []);
    const oneClick = questions.length === 1 && !questions[0].multiSelect;

    let submitBtn;
    let skip;
    // Collapse the card to its answered/skipped representation: drop the option
    // buttons + Submit + Skip, retitle, and append the chosen answer per block.
    const collapse = (skipped) => {
      el.classList.add("resolved");
      title.textContent = skipped ? "Skipped" : "You answered";
      const actions = el.querySelector(".card-actions");
      if (actions) actions.remove();
      if (skip) skip.remove();
      [...el.querySelectorAll(".question-block")].forEach((block, qi) => {
        const opts = block.querySelector(".question-options");
        if (opts) opts.remove();
        block.appendChild(answerLineEl(skipped ? "" : (selections[qi] || []).join(", ")));
      });
    };
    const submit = () => {
      const { answers } = buildQuestionAnswers(questions, selections);
      vscode.postMessage({ type: "questionAnswer", requestId: req.id, answers, annotations: {} });
      collapse(false);
    };

    questions.forEach((q, qi) => {
      const block = document.createElement("div");
      block.className = "question-block";
      const qText = document.createElement("div");
      qText.className = "question-text";
      qText.textContent = questionText(q);
      block.appendChild(qText);

      const opts = document.createElement("div");
      opts.className = "question-options";
      for (const opt of q.options || []) {
        const btn = document.createElement("button");
        btn.className = "question-option";
        const lbl = document.createElement("span");
        lbl.className = "question-option-label";
        lbl.textContent = opt.label || "";
        btn.appendChild(lbl);
        if (opt.description) {
          const desc = document.createElement("span");
          desc.className = "question-option-desc";
          desc.textContent = opt.description;
          btn.appendChild(desc);
        }
        btn.onclick = () => {
          if (oneClick) {
            selections[qi] = [opt.label];
            submit();
            return;
          }
          if (q.multiSelect) {
            const i = selections[qi].indexOf(opt.label);
            if (i >= 0) { selections[qi].splice(i, 1); btn.classList.remove("selected"); }
            else { selections[qi].push(opt.label); btn.classList.add("selected"); }
          } else {
            selections[qi] = [opt.label];
            for (const sib of opts.querySelectorAll(".question-option")) sib.classList.remove("selected");
            btn.classList.add("selected");
          }
          if (submitBtn) {
            submitBtn.disabled = !buildQuestionAnswers(questions, selections).allAnswered;
          }
        };
        opts.appendChild(btn);
      }
      block.appendChild(opts);
      el.appendChild(block);
    });

    if (!oneClick) {
      const actions = document.createElement("div");
      actions.className = "card-actions";
      submitBtn = document.createElement("button");
      submitBtn.className = "primary";
      submitBtn.textContent = "Submit";
      submitBtn.disabled = true;
      submitBtn.onclick = submit;
      actions.appendChild(submitBtn);
      el.appendChild(actions);
    }

    skip = document.createElement("button");
    skip.className = "question-skip";
    skip.textContent = "Skip";
    skip.onclick = () => {
      vscode.postMessage({ type: "questionCancel", requestId: req.id });
      collapse(true);
    };
    el.appendChild(skip);

    messagesEl.appendChild(el);
    forceScrollToBottom(); // a pending question must be visible (#16)
  }

  // Extract the text payload from a tool_call_update's content array
  // (`[{ type:"content", content:{ type:"text", text } }]`, with a flatter
  // `{ text }` fallback).
  function toolUpdateText(call) {
    const c = call && call.content;
    if (Array.isArray(c)) {
      for (const item of c) {
        const t = (item && item.content && item.content.text) ?? (item && item.text);
        if (typeof t === "string") return t;
      }
    }
    return "";
  }

  // The ask_user_question tool is named differently per agent (grok-build:
  // `ask_user_question`, cursor/composer: `AskQuestion`), and on session REPLAY
  // grok relabels the tool_call's title to the display form "Ask: <question>".
  // So we detect by title OR by the presence of `rawInput.questions`.
  function isQuestionToolTitle(title) {
    const t = String(title || "").replace(/[_\s]/g, "").toLowerCase();
    return t === "askuserquestion" || t === "askquestion";
  }
  // Pull the question list from a (possibly replayed) ask tool_call. Falls back to
  // synthesizing one question from an "Ask: <question>" display title when the
  // structured rawInput.questions didn't survive the replay.
  function questionsFromCall(call) {
    const q = call && call.rawInput && call.rawInput.questions;
    if (Array.isArray(q) && q.length) return q;
    const title = String((call && call.title) || "");
    if (/^ask[:\s]/i.test(title)) return [{ question: title.replace(/^ask[:\s]+/i, "").trim() }];
    return null;
  }
  function isQuestionTool(call) {
    return isQuestionToolTitle(call && call.title) || questionsFromCall(call) != null;
  }

  // A question's display text (grok-build uses `question`, cursor uses `prompt`).
  function questionText(q) {
    return (q && (q.question || q.prompt)) || "";
  }

  // Resolve the chosen labels per question from grok's replayed tool result.
  // Two formats exist (the agents differ):
  //   grok-build: `User has answered your questions: "<question>"="<labels>", …`
  //   cursor:     `User questions responses:\nQuestion <qid>: Selected option(s) <oid>, <oid>`
  // Returns an array of label strings parallel to `questions` (empty = unmatched).
  function restoredLabelsByQuestion(questions, answerText) {
    const text = String(answerText || "");
    const out = questions.map(() => "");
    let m, matched = false;
    // Format A — quoted "question"="labels".
    const reA = /"([^"]+)"\s*=\s*"([^"]*)"/g;
    while ((m = reA.exec(text))) {
      const qi = questions.findIndex((q) => questionText(q) === m[1]);
      if (qi >= 0) { out[qi] = m[2]; matched = true; }
    }
    if (matched) return out;
    // Format B — option ids per question id; map ids back to labels.
    const reB = /Question\s+([^\s:]+)\s*:\s*Selected option\(s\)\s*([^\n]*)/gi;
    while ((m = reB.exec(text))) {
      const qid = m[1].trim();
      const qi = questions.findIndex((q) => String(q && q.id) === qid);
      if (qi < 0) continue;
      const opts = questions[qi].options || [];
      out[qi] = m[2].split(",").map((s) => s.trim()).filter(Boolean).map((id) => {
        const o = opts.find((x) => String(x && x.id) === id || (x && x.label) === id);
        return o ? o.label : id;
      }).join(", ");
    }
    return out;
  }

  function cleanAnswerText(text) {
    return String(text || "")
      .replace(/^User has answered your questions:\s*/i, "")
      .replace(/^User questions responses:\s*/i, "")
      .replace(/\s*You can now continue.*$/is, "")
      .trim();
  }

  // Read-only "You answered" card rebuilt during session resume. The questions
  // render immediately (they're always on the replayed tool_call); the answer is
  // filled in by `fillRestoredAnswer` when it lands (on the tool_call snapshot or
  // a later update). Handles both the grok-build and cursor/composer schemas.
  // Returns the card element so the update path can fill its answer later.
  function addRestoredQuestionCard(questions, answerText) {
    clearWelcome();
    const qs = Array.isArray(questions) ? questions : [];
    const el = document.createElement("div");
    el.className = "card question resolved";
    el._questions = qs;
    buildQuestionHead(el, "You answered");
    qs.forEach((q) => {
      const block = document.createElement("div");
      block.className = "question-block";
      const qText = document.createElement("div");
      qText.className = "question-text";
      qText.textContent = questionText(q);
      block.appendChild(qText);
      el.appendChild(block);
    });
    messagesEl.appendChild(el);
    if (answerText) fillRestoredAnswer(el, answerText);
    scrollToBottom();
    return el;
  }

  // Append the chosen answer(s) to a restored card once the result text is known.
  // Idempotent — the answer often arrives both on the tool_call and in an update.
  function fillRestoredAnswer(el, answerText) {
    if (!el || el._answered || !answerText) return;
    const qs = el._questions || [];
    const labels = restoredLabelsByQuestion(qs, answerText);
    const anyLabel = labels.some((l) => l);
    if (qs.length && anyLabel) {
      [...el.querySelectorAll(".question-block")].forEach((block, qi) => {
        if (!block.querySelector(".question-answer")) block.appendChild(answerLineEl(labels[qi]));
      });
    } else {
      const clean = cleanAnswerText(answerText);
      if (clean) el.appendChild(answerLineEl(clean));
    }
    el._answered = true;
  }

  // ---------- plan card ----------

  const VERDICT_LABEL = {
    approved: "Approved",
    rejected: "Rejected",
    abandoned: "Cancelled",
  };

  function pathBaseName(p) {
    return String(p || "").split(/[\\/]/).filter(Boolean).pop() || "plan.md";
  }

  function addPlanFileLink(el, planPath, planName) {
    if (!planPath) return;
    const planTools = document.createElement("div");
    planTools.className = "plan-tools";
    const link = document.createElement("a");
    link.className = "file-ref-link plan-file-link";
    link.href = planPath;
    link.title = planPath;
    const code = document.createElement("code");
    code.textContent = planName || pathBaseName(planPath);
    link.appendChild(code);
    planTools.appendChild(link);
    el.appendChild(planTools);
  }

  // "Show plan / Hide plan" toggle for a collapsed plan body — shared by the
  // restored history card and the live card once resolved, so both read
  // identically.
  function makePlanToggle(body) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "plan-toggle";
    const setToggle = () => { toggle.textContent = body.hidden ? "Show plan" : "Hide plan"; };
    setToggle();
    toggle.onclick = () => { body.hidden = !body.hidden; setToggle(); };
    return toggle;
  }

  // Collapse a live plan card to the same clean representation as a restored
  // history card: drop the buttons + comment box and show one colored verdict
  // label. A resolved plan drops its inline text entirely — the plan-file
  // link IS the plan (opens as an editor tab); the Show/Hide toggle survives
  // only as the no-file fallback so the text stays reachable. Shared by the
  // live button click and the buffered `planResolved` replay (re-focus), so a
  // resolved card can never come back actionable.
  function resolvePlanCardEl(el, verdict) {
    el.classList.add("resolved");
    const actions = el.querySelector(".card-actions");
    if (actions) actions.remove();
    const feedback = el.querySelector(".plan-feedback");
    if (feedback) feedback.remove();
    const body = el.querySelector(".plan-body");
    if (body) {
      if (el.querySelector(".plan-file-link")) {
        body.remove();
        const toggle = el.querySelector(".plan-toggle");
        if (toggle) toggle.remove();
      } else if (!el.querySelector(".plan-toggle")) {
        body.hidden = true;
        el.insertBefore(makePlanToggle(body), body);
      }
    }
    const status = document.createElement("div");
    status.className = "plan-verdict-label plan-verdict-" + verdict;
    status.textContent = VERDICT_LABEL[verdict] ?? "Resolved";
    el.appendChild(status);
  }

  function addPlanCard(req) {
    clearWelcome();
    hideGrokking();
    // Finalize any in-flight Thinking / agent / tool group so it doesn't sit
    // above the plan card showing "Thinking..." forever. Stamps "Thought for Ns"
    // on the header and closes the tool group.
    commitAgentTurn();
    const el = document.createElement("div");
    el.className = "card plan";
    el.dataset.planReqId = String(req.id);
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = "Plan ready for review";
    el.appendChild(title);

    const sub = document.createElement("div");
    sub.className = "card-subtitle";
    sub.textContent = "Nothing has been written yet. Approve, reject with feedback, or cancel to leave plan mode.";
    el.appendChild(sub);

    const planText = req.plan || "";
    addPlanFileLink(el, req.planPath, req.planName);

    const body = document.createElement("div");
    body.className = "plan-body";
    body.innerHTML = planText ? renderMarkdown(planText) : "(empty plan)";
    applyAutoDir(body);
    renderMermaidIn(body);
    el.appendChild(body);

    const feedback = document.createElement("textarea");
    feedback.className = "plan-feedback";
    feedback.rows = 2;
    feedback.setAttribute("dir", "auto");
    feedback.placeholder = "Optional comment — Grok decides what to do with it";
    el.appendChild(feedback);

    const actions = document.createElement("div");
    actions.className = "card-actions";
    const mk = (label, cls, verdict, withComment) => {
      const b = document.createElement("button");
      b.textContent = label;
      if (cls) b.classList.add(cls);
      b.dataset.verdict = verdict;
      b.onclick = () => {
        const comment = withComment ? feedback.value.trim() : "";
        vscode.postMessage({
          type: "exitPlanAnswer",
          requestId: req.id,
          verdict,
          ...(comment ? { comment } : {}),
        });
        // (The comment, if any, lands as its own user bubble below.)
        resolvePlanCardEl(el, verdict);
      };
      return b;
    };
    actions.appendChild(mk("Approve & implement", "primary", "approved", true));
    actions.appendChild(mk("Reject", "", "rejected", true));
    actions.appendChild(mk("Cancel", "secondary", "abandoned", true));
    el.appendChild(actions);
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  // Read-only plan card for resumed sessions. The original exit_plan_mode request
  // is long gone, so there's nothing to respond to — we just show the plan text
  // grok wrote during that session, recovered from ~/.grok/sessions/.../plan.md,
  // and the verdict the user gave it (persisted in globalState).
  function addPlanHistoryCard(text, verdict, planPath, planName) {
    clearWelcome();
    const el = document.createElement("div");
    el.className = "card plan plan-history";
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = "Plan from this session";
    el.appendChild(title);

    const sub = document.createElement("div");
    sub.className = "card-subtitle";
    const verdictLabel = VERDICT_LABEL[verdict];
    sub.textContent = verdictLabel
      ? `Restored from the previous session — you ${verdictLabel.toLowerCase()} this plan.`
      : "Restored from the previous session.";
    el.appendChild(sub);

    addPlanFileLink(el, planPath, planName);

    // Restored plans are reference material, not something to act on — and the
    // plan-file link IS the plan (opens as an editor tab), so no inline text at
    // all when it exists. Only without a link (snapshot creation failed /
    // legacy session) fall back to the collapsed body + Show/Hide toggle so
    // the text stays reachable.
    if (!planPath) {
      const body = document.createElement("div");
      body.className = "plan-body";
      body.hidden = true;
      body.innerHTML = text ? renderMarkdown(text) : "(empty plan)";
      applyAutoDir(body);
      renderMermaidIn(body);

      el.appendChild(makePlanToggle(body));
      el.appendChild(body);
    }

    if (verdictLabel) {
      const status = document.createElement("div");
      status.className = "plan-verdict-label plan-verdict-" + verdict;
      status.textContent = verdictLabel;
      el.appendChild(status);
    }

    messagesEl.appendChild(el);
    scrollToBottom();
  }

  // ---------- chips ----------

  function renderChips() {
    chipsEl.innerHTML = "";
    attachmentsEl.innerHTML = "";
    for (const chip of state.chips) {
      // Split on both separators — a file outside the workspace has an absolute
      // relPath (Windows backslashes), so split("/") alone would show the whole
      // path instead of just the name. The full path stays on the tooltip below.
      const fileName = (chip.relPath.split(/[\\/]/).pop() || chip.relPath);
      // A selection range shows on the label (`name:8-15`) and tooltip — the
      // full name is kept (CSS ellipsis handles pathological lengths, no JS cut).
      const hasSel = chip.selectionStart && chip.selectionEnd;
      const range = hasSel
        ? chip.selectionStart === chip.selectionEnd
          ? `${chip.selectionStart}`
          : `${chip.selectionStart}-${chip.selectionEnd}`
        : "";
      const rangeTitle = hasSel
        ? chip.selectionStart === chip.selectionEnd
          ? ` (line ${chip.selectionStart})`
          : ` (lines ${chip.selectionStart}-${chip.selectionEnd})`
        : "";
      const label = range ? `${fileName}:${range}` : fileName;
      // Explicit attachments — files, images, AND selections sent via the "Add
      // Selection to Grok" command — get their own removable row at the top,
      // like any other attached file. Only the ambient active-editor chip
      // (implicit — whole file, or its live selection) stays in the bottom
      // toolbar with the hide/eye toggle.
      const isExplicit = !chip.id.startsWith("implicit:");
      if (isExplicit) {
        const el = document.createElement("div");
        el.className = "attachment";
        // For a disk-imported image the interesting path is the ORIGINAL file,
        // not the staged copy the chip's path points at.
        el.title = (chip.originRelPath || chip.path) + rangeTitle;
        el.innerHTML = chip.imageIndex != null ? ICON.image : ICON.file;
        const span = document.createElement("span");
        span.textContent = label;
        el.appendChild(span);
        const rm = document.createElement("button");
        rm.type = "button";
        rm.className = "attachment-remove";
        rm.title = "Remove";
        rm.textContent = "×";
        rm.onclick = () => vscode.postMessage({ type: "removeChip", id: chip.id });
        el.appendChild(rm);
        attachmentsEl.appendChild(el);
        continue;
      }
      const el = document.createElement("div");
      el.className = "chip" + (chip.hidden ? " chip-hidden" : "");
      el.title = chip.path + rangeTitle;
      el.innerHTML = (chip.hidden ? ICON.eyeOff : ICON.file) +
        `<span>${escapeHtml(label)}</span>`;
      el.onclick = () => vscode.postMessage({ type: "toggleChip", id: chip.id });
      chipsEl.appendChild(el);
    }
  }

  // ---------- donut ----------

  function updateDonut(used) {
    // Remember the last usage so a later redraw (e.g. the context window changing
    // when the model switches) keeps the same "used" and just rescales the max.
    if (used != null) state.usedTokens = used;
    used = state.usedTokens || 0;
    const max = state.contextWindow;
    const pct = Math.min(100, Math.round((used / max) * 100));
    const circumference = 2 * Math.PI * 6; // must match the donut circles' r in getHtml
    const arc = (pct / 100) * circumference;
    donutArc.setAttribute("stroke-dasharray", `${arc} ${circumference}`);
    let color = "var(--vscode-charts-green, #4ec9b0)";
    if (pct > 90) color = "var(--vscode-charts-red, #f48771)";
    else if (pct > 70) color = "var(--vscode-charts-yellow, #d7ba7d)";
    donutArc.setAttribute("stroke", color);
    donutLabel.textContent = `${toK(used)}/${toK(max)}`;
    donutLabel.title = `${used.toLocaleString()} / ${max.toLocaleString()} tokens`;
  }

  // ---------- slash autocomplete ----------

  function updateSlash() {
    const m = (input.value.slice(0, input.selectionStart || 0)).match(/(?:^|\n)\/(\S*)$/);
    if (!m) { slashPopover.hidden = true; state.slashFiltered = []; return; }
    const q = m[1].toLowerCase();
    state.slashFiltered = state.commands.filter((c) => c.name.toLowerCase().startsWith(q));
    if (!state.slashFiltered.length) { slashPopover.hidden = true; return; }
    state.slashActive = 0;
    renderSlash();
    slashPopover.hidden = false;
  }

  function renderSlash() {
    slashPopover.innerHTML = "";
    let activeEl = null;
    state.slashFiltered.forEach((cmd, i) => {
      const el = document.createElement("div");
      el.className = `slash-item${i === state.slashActive ? " active" : ""}`;
      if (i === state.slashActive) activeEl = el;
      const name = document.createElement("div");
      name.className = "slash-name";
      name.textContent = `/${cmd.name}`;
      el.appendChild(name);
      if (cmd.description) {
        const d = document.createElement("div");
        d.className = "slash-desc";
        d.textContent = cmd.description;
        el.appendChild(d);
      }
      el.onclick = () => pickSlash(cmd);
      slashPopover.appendChild(el);
    });
    if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
  }

  function pickSlash(cmd) {
    input.value = input.value.replace(/(?:^|\n)\/(\S*)$/, (full) =>
      full.startsWith("\n") ? `\n/${cmd.name} ` : `/${cmd.name} `,
    );
    slashPopover.hidden = true;
    input.focus();
  }

  // ---------- "@" file autocomplete ----------
  // Typing `@` (at the start of a word) opens a workspace-file picker fed by the
  // host: every keystroke posts the token (mentionQuery), the host answers from
  // a TTL-cached findFiles index (mentionResults, ranked in src/mention.ts), and
  // a pick rewrites the token to `@rel/path ` AND attaches the file as an
  // explicit chip (addMentionFile) — the same pipeline as drop / the + picker,
  // so the prompt carries both the prose reference and the attachment.

  function hideMention() {
    if (mentionPopover) mentionPopover.hidden = true;
    state.mentionFiles = [];
    state.mentionQuery = null;
  }

  function updateMention() {
    if (!mentionPopover) return;
    const q = getMentionQuery(input.value, input.selectionStart || 0);
    if (q === null) { hideMention(); return; }
    state.mentionQuery = q;
    // No debounce: the host answers from an in-memory index (concurrent
    // keystrokes during a cold build share one findFiles pass), so a reply per
    // keystroke is cheap and keeps the popover snappy.
    vscode.postMessage({ type: "mentionQuery", query: q });
  }

  function renderMention() {
    mentionPopover.innerHTML = "";
    let activeEl = null;
    state.mentionFiles.forEach((rel, i) => {
      const el = document.createElement("div");
      el.className = `mention-item${i === state.mentionActive ? " active" : ""}`;
      if (i === state.mentionActive) activeEl = el;
      const cut = rel.lastIndexOf("/");
      const name = document.createElement("span");
      name.className = "mention-name";
      name.textContent = cut >= 0 ? rel.slice(cut + 1) : rel;
      el.appendChild(name);
      if (cut >= 0) {
        const dir = document.createElement("span");
        dir.className = "mention-dir";
        dir.textContent = rel.slice(0, cut);
        el.appendChild(dir);
      }
      el.title = rel;
      el.onclick = () => pickMention(rel);
      mentionPopover.appendChild(el);
    });
    if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
  }

  function pickMention(rel) {
    const r = applyMentionPick(input.value, input.selectionStart || 0, rel);
    input.value = r.text;
    if (input.setSelectionRange) input.setSelectionRange(r.caret, r.caret);
    hideMention();
    vscode.postMessage({ type: "addMentionFile", relPath: rel });
    input.focus();
    renderInputHighlight();
  }

  // ---------- send ----------

  function updateSendButton() {
    // Four states:
    //  - idle (!busy): send icon, enabled, click → send the typed message.
    //  - busy + locked: spinner icon, disabled, no click action. Used for
    //    session-start priming and other flows the user shouldn't interrupt.
    //  - busy + text typed: send icon, click → QUEUE the message for turn end.
    //    Typed text signals send-intent, so neither click nor Enter may cancel
    //    (#37 — a "send" that lands as Stop kills the running tools).
    //  - busy + empty composer: stop icon, click → cancel grok mid-stream.
    //    The only cancel affordance, mirroring Claude Code's model.
    sendBtn.classList.remove("stop", "initializing");
    // Steer (#52) only makes sense while a turn is actually running. Driven as a
    // body class rather than re-rendering the queued block: this runs on every
    // keystroke, and rebuilding the block would churn its DOM (and fight the
    // Edit/Remove buttons) for what is a pure visibility flip.
    document.body.classList.toggle("turn-busy", !!state.busy);
    // The mode switch (Agent/Plan/Auto-accept) stays available DURING a running
    // turn (#64): flipping to Auto-accept mid-run is the whole point, and the host
    // setMode gate is client-side (autoApprove) so it takes effect immediately.
    // Only the session-start window (busyLocked: spawn → session/new → priming) is
    // locked, where a setMode would throw "no session"; that flag always clears.
    modeBtn.disabled = state.busyLocked;
    modeBtn.classList.toggle("disabled", state.busyLocked);
    modeBtn.title = state.busyLocked ? "Mode — available once the session is ready" : "Pick mode";
    if (!state.busy) {
      sendBtn.innerHTML = ICON.arrowUp;
      sendBtn.title = "Send";
      sendBtn.disabled = false;
    } else if (state.busyLocked) {
      sendBtn.innerHTML = ICON.spinner;
      sendBtn.title = "Initializing…";
      sendBtn.classList.add("initializing");
      sendBtn.disabled = true;
    } else if (input.value.trim()) {
      sendBtn.innerHTML = ICON.arrowUp;
      sendBtn.title = "Queue — sends when Grok finishes";
      sendBtn.disabled = false;
    } else {
      sendBtn.innerHTML = ICON.square;
      sendBtn.title = "Stop";
      sendBtn.classList.add("stop");
      sendBtn.disabled = false;
    }
  }

  // Queue whatever is typed for send-at-turn-end. Returns true if something was
  // queued. The one busy-path helper both Enter and the button click funnel
  // through, so typed text can never turn into a cancel (#37).
  function queueFromComposer() {
    const t = input.value.trim();
    if (!t) return false;
    queueOutgoing(t);
    input.value = "";
    renderInputHighlight(); // also flips the busy button back to Stop (empty composer)
    updateSlash();
    updateMention();
    return true;
  }

  function sendOrStop() {
    if (state.busy) {
      // Typed text signals send-intent — queue it; text present never cancels.
      if (queueFromComposer()) return;
      if (state.busyLocked) return; // locked startup window has no cancel
      // Empty composer + the square Stop icon: the one explicit cancel
      // affordance. Stopping means "halt" — queued messages must not auto-fire
      // into the cancelled turn's wake, so hand them back to the composer for
      // the user to edit or re-send. clearQueuedSends precedes the cancel on
      // the same channel, so the host empties its queue before the turn
      // settles. We do NOT clear state.busy here — that happens when the
      // cancelled turn actually ends (agentEnd / agentError), so the button
      // stays as "Stop" until the CLI confirms.
      if (state.sendQueue.length) {
        input.value = state.sendQueue.join("\n\n");
        state.sendQueue = [];
        renderQueuedBlocks();
        vscode.postMessage({ type: "clearQueuedSends" });
        renderInputHighlight();
      }
      vscode.postMessage({ type: "cancel" });
      return;
    }
    // A clipboard image is still being read — its pasteImage post hasn't
    // reached the host yet, so sending now would detach it from this message.
    // The read settles in milliseconds; the next click/Enter goes through.
    if (state.pendingPaste > 0) return;
    const text = input.value.trim();
    // Sendable = typed text or any visible chip (file or image alike — image
    // chips render as remove-only attachment rows, so they're never hidden).
    if (!text && state.chips.every((c) => c.hidden)) return;
    state.busy = true;
    updateSendButton();
    state.activeAgentEl = null;
    state.activeAgentRaw = "";
    state.activeThoughtEl = null;
    state.activeThoughtHdrEl = null;
    state.thoughtStartTime = null;
    state.activeToolGroupEl = null;
    // Chips are host-owned state (every mutation routes through the host and
    // comes back via postChips) — the host snapshots its own copy on send.
    vscode.postMessage({ type: "send", text });
    input.value = "";
    renderInputHighlight();
    slashPopover.hidden = true;
    hideMention();
  }

  // ---------- voice control ----------

  // The mic button records in the extension host (webviews can't reach the mic)
  // and transcribes via xAI Speech-to-Text. We optimistically flip to
  // "listening" on click for instant feedback; the host confirms or, on any
  // setup failure (no API key, ffmpeg missing), sends "voiceError" to reset us.
  function renderMic() {
    if (!micBtn) return;
    micBtn.classList.toggle("listening", state.mic === "listening");
    micBtn.classList.toggle("transcribing", state.mic === "transcribing");
    micBtn.classList.toggle("connecting", state.mic === "connecting");
    if (state.mic === "listening") {
      micBtn.innerHTML = ICON.micWaves;
      micBtn.title = "Listening — say 'grok send' to submit, or click to stop";
      micBtn.disabled = false;
    } else if (state.mic === "connecting") {
      micBtn.innerHTML = ICON.spinner;
      micBtn.title = "Starting mic… wait for the waves before speaking";
      micBtn.disabled = false; // clickable to cancel
    } else if (state.mic === "transcribing") {
      micBtn.innerHTML = ICON.spinner;
      micBtn.title = "Transcribing…";
      micBtn.disabled = true;
    } else {
      micBtn.innerHTML = ICON.mic;
      micBtn.title = state.voiceConfigured
        ? "Voice control"
        : "Voice control — click to set up (needs an xAI API key)";
      micBtn.disabled = false;
    }
    // "needs setup" dot only when idle and no key is configured.
    micBtn.classList.toggle("needs-setup", state.mic === "idle" && !state.voiceConfigured);
  }

  function setMic(event) {
    state.mic = nextMicState(state.mic, event);
    renderMic();
  }

  function toggleMic() {
    if (state.mic === "idle") {
      // Skip the optimistic "listening" flash when we know no key is set — the
      // host will pop the setup guidance instead of recording. Still send
      // voiceStart so the host (the authority on the key) makes the call.
      if (state.voiceConfigured) {
        // Remember what's already typed; live partials replace only the tail.
        state.voiceBase = input.value;
        state.voiceLive = false;
        setMic("start");
      }
      vscode.postMessage({ type: "voiceStart" });
    } else if (state.mic === "listening" || state.mic === "connecting") {
      setMic("stop");
      vscode.postMessage({ type: "voiceStop" });
    }
    // "transcribing": ignore clicks until the transcript or an error arrives.
  }

  // Append a transcript to whatever's typed (batch mode — one-shot result).
  function insertTranscript(text) {
    const t = (text || "").trim();
    if (!t) return;
    const cur = input.value;
    const sep = cur && !/\s$/.test(cur) ? " " : "";
    input.value = cur + sep + t;
    input.focus();
    updateSlash();
    updateMention();
    renderInputHighlight();
  }

  // base + live transcript, with a separating space unless base already ends in
  // whitespace (or the tail is empty). Used for streaming partials/final.
  function composeVoiceTail(base, text) {
    const t = text || "";
    if (!base) return t;
    if (!t || /\s$/.test(base)) return base + t;
    return base + " " + t;
  }

  // Mirror the composer text onto the backdrop, wrapping a trailing send command
  // ("grok send") in an accent pill. Call whenever the input value changes.
  // Auto-grow the composer with its content: 2 lines at rest (Cursor-style,
  // matching the textarea's rows attribute), expanding to 5 as the user
  // types, then scrolling. The .input-highlight overlay is inset:0 in the
  // same wrap, so it tracks the height for free; its scrollTop is synced in
  // renderInputHighlight.
  function autosizeInput() {
    const cs = window.getComputedStyle(input);
    const line = parseFloat(cs.lineHeight) || 20;
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const min = Math.round(line * 2 + pad);
    const max = Math.round(line * 5 + pad);
    input.style.height = "auto";
    const content = input.scrollHeight;
    input.style.height = Math.max(min, Math.min(content, max)) + "px";
    input.style.overflowY = content > max ? "auto" : "hidden";
  }

  function renderInputHighlight() {
    // The busy button's face reads the composer too (text = queue-send arrow,
    // empty = Stop) — refresh it on every input change; this function's call
    // sites are exactly those.
    updateSendButton();
    autosizeInput();
    if (!inputHighlight) return;
    const text = input.value;
    const range = trailingSendPhrase(text, state.voiceSendPhrase);
    if (!range) {
      inputHighlight.textContent = "";
    } else {
      const before = text.slice(0, range.index);
      const cmd = text.slice(range.index, range.index + range.length);
      inputHighlight.innerHTML = escapeHtml(before) + '<span class="cmd-token">' + escapeHtml(cmd) + "</span>";
    }
    inputHighlight.scrollTop = input.scrollTop;
    inputHighlight.scrollLeft = input.scrollLeft;
  }

  // Submit a message with explicit text — the send half of sendOrStop without
  // reading the composer. Used by the busy-queue flush and by continuous voice
  // ("grok send"), whose composer is cleared separately so the mic can keep
  // listening for the next utterance.
  function submitMessage(text) {
    const t = (text || "").trim();
    if (!t) return;
    state.busy = true;
    updateSendButton();
    state.activeAgentEl = null;
    state.activeAgentRaw = "";
    state.activeThoughtEl = null;
    state.activeThoughtHdrEl = null;
    state.thoughtStartTime = null;
    state.activeToolGroupEl = null;
    vscode.postMessage({ type: "send", text: t });
  }

  // ---------- queued sends (#37) ----------
  // Messages composed while Grok is busy are HOST-owned per session (like
  // chips): the webview posts queueSend and re-renders from the queuedSends
  // snapshot, so the queue survives focus switches and the HOST flushes it as
  // ONE combined prompt when the session's turn ends — even while backgrounded.
  // The single choke point for "the user sent something while grok is working" —
  // typed Enter/click AND a dictated utterance both land here.
  //
  // grok.steerByDefault flips it from "wait for the turn" to "go in now". Three
  // guards, each for a case where there is nothing to steer INTO: a locked turn
  // (session-start priming — no session id to interject against yet), a CLI that
  // can't interject, and (defensively) not being busy at all. Any of those fall
  // back to the queue, which is the safe home for the text either way.
  function queueOutgoing(text) {
    if (state.steerByDefault && state.steerSupported && state.busy && !state.busyLocked) {
      vscode.postMessage({ type: "steerSend", text });
      return;
    }
    vscode.postMessage({ type: "queueSend", text });
  }

  // THE pending user block (the host keeps at most one queued message —
  // composing more appends to it), pinned to the end of the conversation.
  // Italic + dashed border + clock tag reads "not sent yet"; Edit pulls the
  // whole pending text back to the composer, Remove drops it.
  function renderQueuedBlocks() {
    let wrap = state.queuedWrapEl;
    // Defensive join: the host's invariant is a single entry, but render
    // whatever arrives the way the flush would send it.
    const text = state.sendQueue.join("\n\n");
    if (!text) {
      if (wrap) wrap.remove();
      state.queuedWrapEl = null;
      return;
    }
    if (!wrap || !wrap.isConnected) {
      wrap = document.createElement("div");
      wrap.className = "queued-msgs";
      state.queuedWrapEl = wrap;
    }
    wrap.innerHTML = "";
    const msg = document.createElement("div");
    msg.className = "msg user queued";
    const bubble = document.createElement("div");
    bubble.className = "msg-bubble";
    const hdr = document.createElement("div");
    hdr.className = "queued-hdr";
    const tag = document.createElement("span");
    tag.className = "queued-tag";
    tag.innerHTML = `${ICON.clock}<span>Queued</span>`;
    tag.title = "Sends when Grok finishes";
    const actions = document.createElement("span");
    actions.className = "queued-actions";
    const editBtn = document.createElement("button");
    editBtn.className = "queued-action";
    editBtn.title = "Edit — back to the composer";
    editBtn.innerHTML = ICON.pencil;
    // pointerdown for the same reason as Steer below — this whole block moves
    // under the cursor while the agent streams.
    editBtn.onpointerdown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      vscode.postMessage({ type: "dequeueSend", index: 0 });
      input.value = input.value.trim() ? text + "\n\n" + input.value : text;
      renderInputHighlight();
      input.focus();
    };
    const rmBtn = document.createElement("button");
    rmBtn.className = "queued-action";
    rmBtn.title = "Remove from queue";
    rmBtn.innerHTML = ICON.x;
    rmBtn.onpointerdown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      vscode.postMessage({ type: "dequeueSend", index: 0 });
    };
    // Steer (#52): send this into the RUNNING turn instead of waiting for it.
    // Rendered whenever the CLI supports it; `body.turn-busy` (updateSendButton)
    // does the show/hide, so a replay that delivers queuedSends before agentStart
    // still ends up with the button once busy lands.
    if (state.steerSupported) {
      const steerBtn = document.createElement("button");
      steerBtn.className = "queued-action queued-steer";
      steerBtn.title = "Steer — submit now without interrupting Grok";
      steerBtn.innerHTML = `${ICON.cornerDownRight}<span>Steer</span>`;
      // pointerdown, NOT click: the queued block is pinned to the end of the
      // chat and every streamed chunk runs scrollToBottom, so while the agent is
      // writing prose the button shifts under the cursor between mousedown and
      // mouseup — and a `click` only fires when both land on the SAME element.
      // That's why steering was a coin-flip mid-stream but fine during a tool
      // call (nothing reflows then). pointerdown fires on press, before the
      // reflow can move anything.
      steerBtn.onpointerdown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        vscode.postMessage({ type: "dequeueSend", index: 0 });
        vscode.postMessage({ type: "steerSend", text });
      };
      actions.appendChild(steerBtn);
    }
    actions.appendChild(editBtn);
    actions.appendChild(rmBtn);
    hdr.appendChild(tag);
    hdr.appendChild(actions);
    const body = document.createElement("div");
    body.className = "queued-text";
    body.textContent = text;
    body.title = text; // body is line-clamped; full text on hover
    bubble.appendChild(hdr);
    bubble.appendChild(body);
    msg.appendChild(bubble);
    wrap.appendChild(msg);
    messagesEl.appendChild(wrap); // (re)pin to the end of the conversation
    scrollToBottom();
  }

  // ---------- inbound ----------

  // Mid-turn events the agent emits while producing output. After each one we
  // re-assert that some progress indicator is visible (ensureActivityIndicator).
  // promptComplete is deliberately omitted — it's the turn-end boundary.
  const TURN_PROGRESS_MSGS = new Set([
    "agentStart", "thoughtChunk", "messageChunk", "toolCall", "toolCallUpdate", "media",
    // A finishing subagent is the classic "nothing left on screen" moment: its
    // dots stop, the card goes static, and if grok then works quietly the turn
    // looked dead.
    //
    // promptComplete is deliberately NOT here: it lands immediately before
    // agentEnd on an ordinary turn, so asserting an indicator there painted a
    // Grokking row after the final message and scrolled the view, for the one
    // frame before agentEnd removed it again.
    "subagentUpdate",
  ]);

  window.addEventListener("message", (e) => {
    const msg = e.data;
    switch (msg.type) {
      case "initialState":
        state.useCtrlEnter = msg.useCtrlEnter;
        state.effort = msg.effort || "";
        state.cwd = msg.cwd || "";
        state.extVersion = msg.extVersion || "";
        if (typeof msg.showThinking === "boolean") state.showThinking = msg.showThinking;
        if (typeof msg.expandCommandOutputs === "boolean") state.expandCommandOutputs = msg.expandCommandOutputs;
        if (typeof msg.steerByDefault === "boolean") state.steerByDefault = msg.steerByDefault;
        if (typeof msg.soundNotifications === "boolean") state.soundNotifications = msg.soundNotifications;
        applyThinkingVisibility();
        break;
      case "remoteStatus":
        state.remoteLinked = !!msg.linked;
        break;
      case "steerByDefault":
        // Live toggle (grok.steerByDefault). Pure policy for the next send —
        // nothing to re-render, the queued block's Steer button is unaffected.
        state.steerByDefault = !!msg.value;
        break;
      case "soundNotifications":
        // Live toggle (grok.soundNotifications). Only affects future turn-end/
        // error beeps; keep the gear switch in sync if it's open.
        state.soundNotifications = !!msg.value;
        if (state.gearView === "config") renderConfigDebugPanel();
        break;
      case "showThinking":
        // Live toggle (grok.showThinking). Initial value also arrives via
        // initialState + is baked into the <body class> by the host to avoid a flash.
        state.showThinking = !!msg.value;
        applyThinkingVisibility();
        if (state.gearView === "config") renderConfigDebugPanel(); // keep the switch in sync
        break;
      case "fontScale":
        // Live chat-only zoom (grok.chatFontScale). Initial value is baked into
        // <body style="--chat-zoom:…"> by the host; this just applies later edits.
        // The CSS derives both `zoom` and the viewport-height compensation from
        // this one variable, so the composer stays pinned to the bottom.
        document.body.style.setProperty("--chat-zoom", String(msg.value || 1));
        break;
      case "focusInput":
        // Send Selection / Send File / @-mention (#43): the host revealed the
        // panel taking focus; land the caret in the composer so the user can
        // type a prompt immediately.
        input.focus();
        break;
      case "uiConfirmRequest":
        // The host asks; the webview owns the dialog. Always answer, including
        // on dismissal — the host is awaiting this id and a rewind must fail
        // closed rather than hang.
        uiConfirm({
          title: msg.title,
          body: msg.body,
          confirmLabel: msg.confirmLabel,
          danger: msg.danger,
        }).then((ok) => {
          vscode.postMessage({ type: "uiConfirmAnswer", id: msg.id, ok: !!ok });
        });
        break;
      case "truncateMessages": {
        // Rewind/edit: drop only the discarded turns instead of clearing the
        // panel and replaying the whole conversation (which flashed the welcome
        // logo and re-rendered everything). The surviving messages are already
        // correct on screen — there is nothing to rebuild.
        const users = [...messagesEl.querySelectorAll(".msg.user:not(.queued)")]
          .filter((el) => el.dataset.steer !== "1");
        const firstGone = users[msg.surviving];
        if (firstGone) {
          // Remove that message and every sibling after it — agent replies, tool
          // groups, plan/permission cards, subagent rows all belong to the
          // discarded turns.
          while (messagesEl.lastElementChild && messagesEl.lastElementChild !== firstGone) {
            messagesEl.removeChild(messagesEl.lastElementChild);
          }
          if (messagesEl.lastElementChild === firstGone) messagesEl.removeChild(firstGone);
        }
        // Nothing streaming survives a truncation — drop the per-turn handles so
        // the next turn starts clean rather than appending into a removed node.
        state.userMsgCount = msg.surviving;
        state.activeAgentEl = null;
        state.activeAgentRaw = "";
        state.activeUserEl = null;
        state.activeUserRaw = "";
        state.activeThoughtEl = null;
        state.activeToolGroupEl = null;
        state.turnAgentActionsEl = null;
        state.turnEditsByToolCallId.clear();
        state.turnDiffSummaryEl = null;
        hideGrokking();
        hideThinkingIndicator();
        hidePlanProcessing();
        // The newest surviving agent message ends a finished turn, so its
        // copy/timestamp footer belongs visible.
        const agents = messagesEl.querySelectorAll(".msg.agent .msg-actions");
        const lastFooter = agents[agents.length - 1];
        if (lastFooter) lastFooter.hidden = false;
        refreshUserRewindButtons();
        forceScrollToBottom();
        break;
      }
      case "restoreComposer": {
        // Edit-and-resend (#56): the rewound message comes back so it can be
        // fixed and sent again. APPEND rather than overwrite — anything already
        // typed is the user's, and silently destroying it would be the same
        // class of bug as the one Edit exists to fix.
        const existing = input.value.trim();
        input.value = existing ? existing + "\n\n" + (msg.text || "") : (msg.text || "");
        input.focus();
        updateSlash();
        updateMention();
        renderInputHighlight();
        updateSendButton();
        // Caret to the end so typing continues the restored text.
        input.selectionStart = input.selectionEnd = input.value.length;
        break;
      }
      case "grokUpdateStatus":
        // Reply to the About panel's checkGrokUpdate. The check also reports the
        // CLI's current version — adopt it, since the ACP handshake doesn't always
        // give us one (native Windows build) and otherwise the panel would show a
        // bare "—" right next to a confident "CLI is up to date".
        state.grokUpdate = {
          current: msg.current, latest: msg.latest,
          updateAvailable: !!msg.updateAvailable, error: msg.error || null,
          policy: msg.policy || null,
        };
        if (msg.current) state.cliVersion = msg.current;
        if (!gearPopover.hidden && state.gearView === "about") renderAboutPanel(false);
        break;
      case "initialized": {
        // The ACP handshake is done, but grok isn't ready for the user until the
        // hidden primer turn lands. Stash the version and keep showing "starting…";
        // the line flips to "connected · v…" only when the spinner hides (the
        // setBusy:false at the end of priming). See the setBusy handler.
        state.cliVersion = msg.info.version || "";
        state.startingPhase = true;
        const verEl = $("welcome-version");
        if (verEl) { verEl.classList.add("loading-dots"); verEl.textContent = "Starting"; }
        const onb = $("welcome-onboarding");
        if (onb) onb.innerHTML = "";
        break;
      }
      case "cliUpdating": {
        // One-time hint while the silent `grok update` runs before the session
        // spawns; overwritten by "starting…" once grok connects, then
        // "connected · v<new version>" once the primer finishes.
        const verEl = $("welcome-version");
        if (verEl) { verEl.classList.add("loading-dots"); verEl.textContent = "Updating Grok Build CLI"; }
        break;
      }
      case "session": {
        state.currentModelId = msg.currentModelId;
        state.isWorktree = !!msg.worktree; // gates the gear Apply/Remove worktree items
        state.availableModels = msg.models || [];
        const m = state.availableModels.find((x) => x.modelId === msg.currentModelId);
        if (m?.totalContextTokens) state.contextWindow = m.totalContextTokens;
        updateDonut(0);
        break;
      }
      case "modelChanged": {
        state.currentModelId = msg.modelId;
        // The context window is model-specific (grok-build 512K vs Composer 200K).
        // The initial `session` event carries grok's *default* model, so when we
        // switch (e.g. to the configured default) recompute the max — otherwise the
        // donut keeps showing the wrong ceiling and an inflated percentage.
        const m = state.availableModels.find((x) => x.modelId === msg.modelId);
        if (m && m.totalContextTokens) { state.contextWindow = m.totalContextTokens; updateDonut(); }
        break;
      }
      case "modeChanged":
        state.currentModeId = msg.modeId;
        updateModeBtn(msg.modeId);
        break;
      case "openModePopover":
        openModePopover();
        break;
      case "voiceState":
        // Host confirms a transition (e.g. recording actually started). Only
        // accept the known states; ignore anything unexpected.
        if (msg.status === "listening" || msg.status === "transcribing") {
          state.mic = msg.status;
          renderMic();
        } else if (msg.status === "idle") {
          // Hard reset — the host stopped voice (e.g. session switch). Clear the
          // live flag and any queued messages too, not just the button.
          state.mic = "idle";
          state.voiceLive = false;
          renderMic();
        }
        break;
      case "voiceConfigured":
        state.voiceConfigured = !!msg.value;
        if (typeof msg.sendPhrase === "string") state.voiceSendPhrase = msg.sendPhrase;
        renderMic();
        renderInputHighlight();
        break;
      case "voicePartial":
        // Live streaming update: replace the tail after the pre-dictation base.
        state.voiceLive = true;
        input.value = composeVoiceTail(state.voiceBase, msg.text || "");
        renderInputHighlight();
        break;
      case "voiceSubmit": {
        // Continuous "grok send": submit now (or queue if Grok is mid-response),
        // clear the composer, and keep the mic listening for the next utterance.
        const t = (msg.text || "").trim();
        state.voiceBase = "";
        state.voiceLive = false;
        input.value = "";
        renderInputHighlight();
        if (t) {
          if (state.busy) queueOutgoing(t);
          else submitMessage(t);
        }
        break;
      }
      case "voiceTranscript":
        // Final result. Streaming replaces the live tail; batch appends.
        if (state.voiceLive) {
          input.value = composeVoiceTail(state.voiceBase, (msg.text || "").trim());
          input.focus();
          updateSlash();
          updateMention();
          renderInputHighlight();
        } else {
          insertTranscript(msg.text);
        }
        state.voiceLive = false;
        setMic("transcript");
        // "grok send" detected: submit hands-free — but only when idle, so it
        // never doubles as a "stop" on an in-flight turn.
        if (msg.send && !state.busy) sendOrStop();
        break;
      case "voiceError":
        // Setup/record/transcribe failed (the host already showed the reason).
        state.voiceLive = false;
        setMic("error");
        break;
      case "chips":
        state.chips = msg.chips;
        renderChips();
        break;
      case "commandsUpdate":
        state.commands = msg.commands || [];
        break;
      case "mentionResults": {
        // Only render rows that answer the token still under the caret — the
        // popover may have closed (query null) or the user typed further (query
        // moved on) while this reply was in flight.
        if (!mentionPopover || state.mentionQuery === null || msg.query !== state.mentionQuery) break;
        state.mentionFiles = msg.files || [];
        if (!state.mentionFiles.length) {
          // Keep the query: the token is still active, so more typing (or a
          // backspace) re-queries — only the empty row-list hides.
          mentionPopover.hidden = true;
          break;
        }
        state.mentionActive = 0;
        renderMention();
        mentionPopover.hidden = false;
        break;
      }
      case "userMessage":
        // Live send (or immediate verdict-feedback bubble): render and bump the
        // counter so any plan history queued for this position drains first.
        drainPlanHistory(state.userMsgCount);
        drainPermissionHistory(state.userMsgCount);
        state.userMsgCount += 1;
        // Previous agent turn is over: pin its change list and drop the live
        // tracker so this user message starts a clean turn boundary (restore
        // has no agentStart between turns — only user bubbles).
        pinTurnDiffSummary();
        startTurnDiffTracking();
        addMessage("user", msg.text, msg.chips || [], { steer: msg.steer });
        forceScrollToBottom(); // jump back to the bottom on the user's own send (#16)
        // If the indicator is showing and a NEW (live-send) user message comes
        // in, hide it. (When the host posts a userMessage as part of the verdict
        // flow, it then immediately posts planProcessing, which re-shows it
        // after we hide here — the net effect is correct: indicator below.)
        hidePlanProcessing();
        break;
      case "agentStart":
        // A user-initiated turn just began (live send, or a plan-verdict
        // follow-up). Show "Grokking…" until the first real content replaces it.
        // The silent primer never emits agentStart, so it never shows here.
        state.turnAgentActionsEl = null; // new turn → previous turn keeps its footer
        // Fresh tracker for this turn's edits (userMessage already closed the
        // previous card on a live send; this also covers afterTurn follow-ups
        // that emit agentStart without a new user bubble).
        startTurnDiffTracking();
        if (typeof msg.turnId === "number" && msg.turnId > 0) {
          state.currentTurnId = msg.turnId;
        } else {
          state.currentTurnId = (state.currentTurnId || 0) + 1; // older hosts
        }
        showGrokking();
        // Busy is event-sourced through the session buffer so a re-focus lands
        // on the true state: agentStart marks a turn in flight (a live send
        // already set busy before posting; a buffer REPLAY of a mid-turn
        // session relies on this), agentEnd/agentError clear it.
        state.busy = true;
        state.busyLocked = false;
        updateSendButton();
        break;
      case "turnBaselines":
        // Host first-touch snapshots (meta only). Refresh the live summary so
        // View / Undo buttons appear as files are baselined.
        if (typeof msg.turnId === "number" && Array.isArray(msg.files)) {
          state.baselineMetaByTurn.set(msg.turnId, msg.files);
          if (state.turnDiffSummaryEl && state.currentTurnId === msg.turnId) {
            refreshTurnDiffSummaryUi();
          } else if (state.turnDiffSummaryEl && String(state.turnDiffSummaryEl.dataset.turnId) === String(msg.turnId)) {
            refreshTurnDiffSummaryUi();
          }
        }
        break;
      case "thoughtChunk":
        appendThought(msg.text);
        break;
      case "messageChunk":
        appendAgent(msg.text);
        break;
      case "media":
        addGeneratedMedia(msg);
        break;
      case "userMessageChunk":
        appendUserChunk(msg.text);
        break;
      case "historyReplay":
        if (msg.active) {
          state.replaying = true;
          state.suppressReplayTurn = false; // fresh replay starts unsuppressed
        } else {
          commitAgentTurn(); // finalize the last turn while still flagged as replay
          state.replaying = false;
          state.suppressReplayTurn = false; // replay over → no longer suppressing
          // Anything left in the queue is either legacy (no afterUserMessage)
          // or was resolved after the final user message of the session. Render
          // it now at the bottom so we don't silently drop those plans.
          flushPlanHistory();
          flushPermissionHistory();
          // A replayed delegation whose completion never reached the tool
          // channel (Composer's Task completes only via live lifecycle events,
          // which the CLI doesn't replay) must not keep dots running on
          // history — settle any still-running subagent rows quietly.
          for (const el of state.subagentCards.values()) {
            const dots = el.querySelector(".blink-dots");
            if (dots) dots.remove();
          }
          // The final replayed turn has no explicit turn-end signal — its
          // footer becomes final here.
          revealTurnFooter();
        }
        break;
      case "permissionHistoryQueue":
        // Answered permission cards from the resumed session, interleaved inline
        // exactly like the plan queue. Does NOT reset userMsgCount — planHistoryQueue
        // owns that (and is posted right after this on resume).
        state.permissionHistoryQueue = (msg.permissions || []).slice();
        break;
      case "planHistoryQueue":
        // Sent by the host right before replay starts. Drives inline placement
        // of historical plan cards from appendUserChunk / live userMessage.
        state.planHistoryQueue = (msg.plans || []).slice();
        state.userMsgCount = 0;
        break;
      case "planProcessing":
        showPlanProcessing();
        break;
      case "toolCall":
        if (state.suppressReplayTurn) break; // tool calls inside the primer turn (unlikely but defensive)
        if (isQuestionTool(msg.call)) {
          // No generic tool chip — the question card stands in for it.
          if (state.replaying) {
            // Resume: render the read-only card NOW from the tool_call (the
            // questions are always present); the answer rides on this snapshot or
            // arrives in a later update keyed by the same toolCallId.
            const el = addRestoredQuestionCard(questionsFromCall(msg.call) || [], toolUpdateText(msg.call));
            if (msg.call.toolCallId) state.restoredCardsByToolCallId.set(msg.call.toolCallId, el);
          } else {
            // Live: the interactive card comes from `questionRequest`; just stash
            // so the matching update is recognized (and the chip stays suppressed).
            state.questionToolCalls.set(msg.call.toolCallId, { questions: questionsFromCall(msg.call) || [] });
          }
          break;
        }
        if (isSubagentToolCall(msg.call)) {
          addSubagentCard(msg.call);
          break;
        }
        // On session/load a background delegation's poller replays here as a
        // single completed `tool_call` (structured TaskOutput or, cold-restored,
        // a flattened text blob) — fold its result into the matching subagent
        // card and drop the redundant "[subagent:…]" poller row.
        if (maybeFinishSubagentFromTaskOutput(msg.call) || maybeFinishSubagentFromTaskText(msg.call)) break;
        addToToolGroup(msg.call);
        // On session/load a completed edit replays as a single `tool_call` that
        // already carries its diff (no follow-up update) — attach the preview here
        // or the restored edit has no "open diff →" (#30).
        applyToolDiffs(msg.call);
        // Resume: if this tool was permission-gated, drop the restored (collapsed)
        // card right here — exactly where it was answered — instead of at the turn
        // boundary.
        renderRestoredPermissionForTool(msg.call.toolCallId, msg.call.title);
        break;
      case "toolCallUpdate": {
        if (state.suppressReplayTurn) break;
        // Resume: anchor a restored permission card here — the update carries the
        // tool's real title (the tool_call is often a generic "Shell"/"Grep"), so
        // a card saved without a toolCallId still matches by title.
        renderRestoredPermissionForTool(msg.call?.toolCallId, msg.call?.title);
        // Resume: fill the answer into the matching restored card when it lands.
        const restoredEl = state.restoredCardsByToolCallId.get(msg.call?.toolCallId);
        if (restoredEl) {
          fillRestoredAnswer(restoredEl, toolUpdateText(msg.call));
          break;
        }
        // Live: the interactive card already handled the answer; drop the stash so
        // the chip stays suppressed and we don't fall through to the diff path.
        if (state.questionToolCalls.has(msg.call?.toolCallId)) {
          if (toolUpdateText(msg.call) || String(msg.call?.status).toLowerCase() === "completed") {
            state.questionToolCalls.delete(msg.call.toolCallId);
          }
          break;
        }
        // A subagent's update belongs to its own row (title refinement, then the
        // completed result + duration) — never the generic tool group.
        if (state.subagentCards.has(msg.call?.toolCallId)) {
          applySubagentUpdate(msg.call);
          break;
        }
        // Background-delegation results ride the poller's TaskOutput — finish
        // the matching card, then let the update flow on to the poller's own
        // generic row.
        maybeFinishSubagentFromTaskOutput(msg.call);
        // Fallback: a replayed answer update with no matching card (tool_call
        // missing/unmatched). Rebuild a card from the result text rather than
        // leaving the resumed turn blank.
        if (state.replaying) {
          const t = toolUpdateText(msg.call);
          if (/answered your questions|questions responses/i.test(t)) {
            addRestoredQuestionCard([], t);
            break;
          }
        }
        // A self-executed command (cursor/Composer runs it in its own shell and
        // reports the result here, not via terminal/create) — fill the row's #41
        // IN/OUT box by toolCallId. Takes precedence over the generic failure path
        // so a non-zero command reads as an [Error] exit N in its OUT box, matching
        // grok-build's terminal-fed rows. No-op (returns false) for grok-build,
        // whose row already has OUT.
        if (String(msg.call?.status).toLowerCase() === "completed" && maybeAttachToolResultOutput(msg.call)) {
          break;
        }
        // A failed tool (e.g. `image_to_video failed: image reference not readable`)
        // — surface the reason on its row instead of silently dropping it.
        const failure = toolFailureText(msg.call);
        if (failure) {
          markToolFailed(msg.call?.toolCallId, failure);
          break;
        }
        applyToolDiffs(msg.call);
        break;
      }
      case "subagentUpdate": {
        // Lifecycle stream (method _x.ai/session/update): subagent_spawned tags
        // the card with the child id; subagent_finished carries duration_ms +
        // the child's output — the duration Composer's completed
        // tool_call_update lacks, and a completion backstop if the tool
        // channel's update never lands.
        const u = msg.update || {};
        // A restore-built card CAN receive its own lifecycle when grok re-forwards
        // the `_x.ai/session/update` rail on session/load (fills Composer's missing
        // duration + the completion backstop). But a LATER LIVE spawn/finish must
        // never touch it (that would stamp the new run onto the old card). So skip
        // replayed cards only for live events — during replay they're eligible.
        const cards = [...state.subagentCards.values()].filter(
          (c) => state.replaying || !c.dataset.subagentReplayed,
        );
        if (u.sessionUpdate === "subagent_spawned") {
          // Strict FIFO: spawn events arrive in tool-call order. Done-ness is
          // deliberately IGNORED — a tool-channel completion routinely races
          // ahead of the lifecycle spawn for the SAME card, so a done-but-untagged
          // card must still be taggable by its own spawn. Only tag when there's a
          // real id — an empty id would leave the card falsy-untagged and let the
          // NEXT spawn steal it.
          if (u.subagent_id) {
            const el = cards.find((c) => !c.dataset.subagentId);
            if (el) el.dataset.subagentId = String(u.subagent_id);
          }
        } else if (u.sessionUpdate === "subagent_finished") {
          let el;
          if (u.subagent_id) {
            // With an id, ONLY an exact id match is safe — a stale/unknown id must
            // not fall through to a cardinality guess and finish an unrelated
            // running card.
            el = cards.find((c) => c.dataset.subagentId === String(u.subagent_id));
          } else {
            // No id at all: attribute only when exactly ONE card is unfinished;
            // otherwise a no-op beats guessing (the tool channel still completes
            // the card).
            const unfinished = cards.filter((c) => !c.classList.contains("subagent-done"));
            if (unfinished.length === 1) el = unfinished[0];
          }
          if (el) {
            // subagent_finished carries status ("completed"|"failed"|"cancelled")
            // + error (output omitted on failure) — render the outcome instead of
            // a silent empty "success". A cancel is a user stop, not a failure, so
            // it reads muted (not red). The synthesized note is markdown for
            // renderMarkdown (italic *…*, which also re-escapes &<> — so no
            // escapeHtml here or it double-escapes).
            const status = String(u.status || "completed").toLowerCase();
            const cancelled = status === "cancelled";
            const failed = !cancelled && status !== "completed";
            finishSubagentCard(el, {
              durationMs: typeof u.duration_ms === "number" ? u.duration_ms : null,
              output: typeof u.output === "string" && u.output ? u.output
                : (failed || cancelled) ? `*Subagent ${status}${u.error ? ": " + String(u.error) : ""}.*` : "",
              failed,
              cancelled,
            });
          }
        }
        break;
      }
      case "runProgress":
        applyRunProgress(msg.update);
        break;
      case "permissionRequest":
        addPermissionCard(msg.req);
        break;
      case "permissionResolved": {
        // Replayed (on re-focus) right after the buffered permissionRequest, or
        // live right after the user answers — collapse the matching card if it's
        // still active. Idempotent: a live click already collapsed it.
        const cards = [...messagesEl.querySelectorAll(".card.permission")];
        const el = cards.find((c) => c.dataset.permReqId === String(msg.requestId) && !c.classList.contains("perm-resolved"));
        if (el) {
          const opt = (el._permOptions || []).find((o) => o.optionId === msg.optionId);
          collapsePermissionCard(el, opt && opt.kind, el._permTitle);
        }
        break;
      }
      case "exitPlanRequest":
        addPlanCard(msg.req);
        break;
      case "planResolved": {
        // Replayed (on re-focus) right after the buffered exitPlanRequest, or
        // live right after the user's verdict — collapse the matching card if
        // it's still actionable. Idempotent: a live click already collapsed it.
        const cards = [...messagesEl.querySelectorAll(".card.plan")];
        const el = cards.find((c) => c.dataset.planReqId === String(msg.requestId) && !c.classList.contains("resolved"));
        if (el) resolvePlanCardEl(el, msg.verdict);
        break;
      }
      case "questionRequest":
        addQuestionCard(msg.req);
        break;
      case "planHistory":
        addPlanHistoryCard(msg.text, msg.verdict, msg.planPath, msg.planName);
        break;
      case "planNotice":
        addPlanNotice(msg.text);
        break;
      case "autoCompactNotice":
        addAutoCompactNotice(msg.text);
        break;
      case "planBlocked":
        addPlanNotice(
          msg.kind === "terminal"
            ? `Plan mode blocked a command: ${msg.target}`
            : `Plan mode blocked a write to ${msg.target}`,
        );
        break;
      case "promptComplete":
        // Finalize the Thinking block and update the token donut — but DO NOT
        // clear busy here. agentEnd is now the single authoritative "user can
        // send again" signal, so that the verdict → afterTurn flow can keep
        // busy=true across two consecutive client.prompt() calls (the original
        // turn ends emitting promptComplete; afterTurn's follow-up turn then
        // runs and emits its own agentEnd at the end, which clears busy).
        commitAgentTurn();
        // Deliberately NOT revealTurnFooter(): promptComplete ends one
        // client.prompt(), not necessarily the TURN. More tool calls and text
        // routinely follow (and a plan verdict runs a second prompt entirely),
        // so revealing here put a copy/timestamp footer mid-conversation that
        // then had content rendered below it — a footer that flickers in and
        // leaves a gap. agentEnd/agentError are the authoritative turn end and
        // already reveal it; the same signal that clears busy should be the one
        // that finalizes the footer.
        // The host strips totalTokens:0 before it gets here — grok reports 0
        // for /session-info (context untouched) AND /compact (context shrunk,
        // not emptied), so 0 is never a real measurement (gateZeroTokenMeta,
        // #39). Absent totalTokens = "no update": the donut keeps its last
        // real value — the CLI doesn't recompute the count until the NEXT
        // turn ends (research/signals-refresh-probe.cjs), which then updates
        // it via its own meta or the host's contextUsage read.
        if (msg.meta?.totalTokens != null) updateDonut(msg.meta.totalTokens);
        break;
      case "contextUsage":
        // Read from grok's on-disk signals.json by the host — a real count for
        // the cases the turn meta can't cover: cold restore (donut would sit
        // at 0 until the first turn) and zero-reporting turns where signals
        // holds a fresher count than the last meta (e.g. /session-info right
        // after a /compact).
        if (msg.window) state.contextWindow = msg.window;
        updateDonut(msg.used);
        break;
      case "expandCommandOutputs":
        // Live toggle (grok.expandCommandOutputs): applies to existing rows
        // too, and sets the default for rows still to come. Clears the
        // per-session Expand/Collapse All latch — last action wins.
        state.expandCommandOutputs = !!msg.value;
        state.toolExpandOverride = null;
        applyExpandCommandOutputs();
        if (state.gearView === "config") renderConfigDebugPanel(); // keep the switch in sync
        break;
      case "setAllToolDetails":
        // Command Palette: Grok: Expand/Collapse All Tool Details — one-shot,
        // current session only, doesn't touch the persisted expandCommandOutputs.
        setAllToolDetails(!!msg.open);
        break;
      case "commandOutput": {
        // A finished shell command's captured output (#41). grok-build delegates
        // commands via terminal/create, so this path fires for it — attach to the
        // oldest un-served row with the exact same command; if none matches
        // (title-only shape / a race) render a standalone row so output is never
        // dropped. (The cursor/Composer agent runs commands in its OWN CLI-side
        // persistent shell and never sends terminal/create, so this never fires
        // for it — its output arrives on the completed tool_call_update instead
        // and is attached by toolCallId; see maybeAttachToolResultOutput. Do NOT
        // FIFO-match here: Composer completes commands out of issue order, so any
        // order-based guess would misattribute outputs to the wrong rows.)
        const wanted = typeof msg.command === "string" ? msg.command.trim() : msg.command;
        const pending = state.pendingCommandDetails.find((p) => !p.done && p.command === wanted);
        let details = pending && pending.details;
        if (pending) pending.done = true;
        if (!details) {
          addToToolGroup({ title: truncate(`Run ${msg.command}`, 120), kind: "execute", rawInput: { command: msg.command } });
          const fallback = state.pendingCommandDetails[state.pendingCommandDetails.length - 1];
          if (fallback && !fallback.done && fallback.command === wanted) {
            fallback.done = true;
            details = fallback.details;
          }
        }
        if (details) attachCommandOutput(details, msg);
        break;
      }
      case "agentReset": {
        hidePlanProcessing(); // turn is being reset, indicator no longer applies
        hideGrokking();
        hideThinkingIndicator();
        // Drop the in-flight agent bubble entirely. Used when the host wants to
        // suppress the rest of the current turn (e.g. after Reject, where
        // grok's false "approved" response would otherwise leak through).
        if (state.activeAgentEl) {
          const wrapper = state.activeAgentEl.closest(".msg-wrapper") ?? state.activeAgentEl.parentElement;
          (wrapper ?? state.activeAgentEl).remove();
        }
        state.activeAgentEl = null;
        state.activeAgentRaw = "";
        state.activeThoughtEl = null;
        state.activeThoughtHdrEl = null;
        state.thoughtStartTime = null;
        // Also clear the rAF-scheduled flag so the next messageChunk arms its
        // own rAF instead of relying on the stale one that might fire on a
        // detached element.
        state.agentRenderScheduled = false;
        break;
      }
      case "agentError":
        hideGrokking(); // turn ended (possibly before any content)
        hideThinkingIndicator();
        hidePlanProcessing();
        revealTurnFooter();
        addError(msg.text);
        state.busy = false;
        state.busyLocked = false; // an error ends any startup lock too
        updateSendButton();
        maybeNotifySound("error"); // #59 — only when the panel isn't focused
        break;
      case "agentEnd":
        hideGrokking(); // turn ended (defensive — content normally clears it first)
        hideThinkingIndicator();
        // A turn that ends with NO content (grok's [Plan cancelled] ack can be
        // empty) would otherwise orphan the dots forever — content-based
        // clearing never fires.
        hidePlanProcessing();
        revealTurnFooter();
        state.busy = false;
        updateSendButton();
        maybeNotifySound("done"); // #59 — only when the panel isn't focused
        break;
      case "exit":
        hideGrokking();
        hidePlanProcessing();
        addError(`Grok exited (code ${msg.code}). Send a message to restart this session, or start a new one.`);
        state.busy = false;
        state.busyLocked = false; // a dead process ends any startup lock too
        updateSendButton();
        break;
      case "queuedSends":
        // Snapshot of the focused session's host-owned send queue — replayed on
        // re-focus like everything else, so queued blocks survive session swaps.
        state.sendQueue = Array.isArray(msg.items) ? msg.items : [];
        renderQueuedBlocks();
        break;
      case "steerUnavailable":
        // This CLI can't interject (#52). Latch the button off — the queue,
        // which already holds the text, is the fallback. Also force the policy
        // off, so a steerByDefault user silently gets queueing rather than a
        // failed send on every message.
        state.steerSupported = false;
        state.steerByDefault = false;
        renderQueuedBlocks();
        break;
      case "usage":
        // Billing split (#53). `turn` is absent on a restore (we only stored the
        // session total), so keep whatever we have rather than blanking it.
        if (msg.turn) state.lastTurnUsage = msg.turn;
        if (msg.session) state.sessionUsage = msg.session;
        if (!contextPopover.hidden) openContextPopover(); // live-refresh if open
        break;
      case "setBusy":
        // Host-driven busy state for flows where there's no natural agentEnd
        // (e.g. session-start priming). When `locked` is true the button shows
        // a spinner and is disabled (no interrupt option); when false (or
        // omitted) the button shows a stop icon and clicks cancel the in-flight
        // CLI work.
        state.busy = !!msg.value;
        state.busyLocked = !!msg.locked;
        updateSendButton();
        if (!state.busy) {
          // (Anything type-ahead-queued during the startup window is flushed by
          // the HOST once the primer acks — nothing to do here.)
          // Priming just finished: the first hidden message was sent and processed,
          // so grok is finally ready. Reveal the version now — not at "initialized",
          // which fires while the primer is still in flight (spinner still up).
          if (state.startingPhase) {
            state.startingPhase = false;
            const verEl = $("welcome-version");
            if (verEl) {
              const ver = state.cliVersion ? ` · v${state.cliVersion}` : "";
              verEl.classList.remove("loading-dots"); // settled — no animated dots
              verEl.textContent = `Connected${ver}`;
            }
          }
        }
        // Refresh the gear popover's model/effort lock state if it's open.
        if (!gearPopover.hidden) renderGearMain();
        break;
      case "summarizing": {
        clearWelcome();
        const si = document.createElement("div");
        si.id = "summarizing-indicator";
        si.className = "session-context-banner loading-dots";
        si.textContent = "Summarizing";
        messagesEl.appendChild(si);
        scrollToBottom();
        break;
      }
      case "sessionContext":
        addSessionContextBanner();
        break;
      case "clearMessages":
        resetForNewSession();
        break;
      case "onboarding":
        showOnboarding(msg.state, { platform: msg.platform });
        break;
      case "error":
        addError(msg.text);
        break;
      case "xaiNotification":
        break;
      case "sessions": {
        const entries = msg.entries || [];
        const offset = msg.offset || 0;
        const open = !historyPopover.hidden;
        // Sticky search: a host-driven refresh (rename/delete/new session) posts an
        // unfiltered first page. If the user has a search active, re-request with it
        // rather than clobbering their filtered view with the full list.
        if (open && offset === 0 && (msg.query || "") !== state.sessionSearch) {
          requestSessions(0);
          break;
        }
        if (offset > 0) {
          // Load-more: append the next page, de-duped by id. A page whose query no
          // longer matches the loaded list is stale (the user changed the search after
          // the request went out) — drop it; the newer request's page will arrive.
          if ((msg.query || "") !== state.sessionQuery) {
            state.sessionLoading = false;
            break;
          }
          const seen = new Set(state.sessions.map((s) => s.id));
          for (const e of entries) if (!seen.has(e.id)) state.sessions.push(e);
        } else {
          // Fresh list or new search result: replace.
          state.sessions = entries;
          state.sessionQuery = msg.query || "";
        }
        if (msg.activeId !== undefined) state.activeSessionId = msg.activeId || null;
        // Merge (not replace) so dots from earlier pages survive a load-more, which
        // only carries dots for the new page.
        state.dots = Object.assign({}, state.dots, msg.dots || {});
        if (msg.total !== undefined) state.sessionTotal = msg.total;
        state.sessionHasMore = !!msg.hasMore;
        // Where the next load-more should start: index slots CONSUMED by the host
        // (hidden subagent sessions occupy slots without producing rows), so a
        // filtered page never makes us re-request the same slice.
        state.sessionNextOffset = typeof msg.nextOffset === "number" ? msg.nextOffset : null;
        state.sessionLoading = false;
        if (open) renderSessionRows();
        break;
      }
      case "repos":
        state.reposKnown = true;
        state.repos = Array.isArray(msg.entries) ? msg.entries : [];
        state.selectedRepoCwd = msg.selectedCwd || "";
        state.activeRepoCwd = msg.activeCwd || "";
        renderRepoChip();
        if (!repoPopover.hidden) renderRepoPopover();
        break;
      case "sessionDot":
        if (msg.dot && msg.dot !== "none") state.dots[msg.id] = msg.dot;
        else delete state.dots[msg.id];
        if (!historyPopover.hidden) patchSessionDot(msg.id);
        break;
      default:
        // No case ran. Either the host posted a type outside the contract (drift
        // between src/protocol.ts and the webview-helpers.js copy — the sync test
        // is meant to catch this at CI, this is the runtime backstop) or a known
        // type is missing its handler. Warn rather than silently swallow it.
        console.warn(
          isKnownHostMessage(msg.type)
            ? "[grok] host message has no handler (missing switch case): " + msg.type
            : "[grok] unknown host message type (contract drift): " + msg.type,
        );
        break;
    }
    // After any step grok takes mid-turn, make sure the chat still shows it's
    // working — never a dead frame while a turn is unfinished (esp. with thinking
    // traces hidden). The turn-end boundary (promptComplete) is excluded so the
    // stand-in doesn't flash between it and agentEnd.
    if (TURN_PROGRESS_MSGS.has(msg.type)) {
      ensureActivityIndicator();
      // Queued blocks live at the END of the conversation — re-pin them under
      // freshly streamed content.
      if (state.sendQueue.length && state.queuedWrapEl) messagesEl.appendChild(state.queuedWrapEl);
    }
  });

  // ---------- wire ----------

  sendBtn.onclick = sendOrStop;
  updateSendButton();
  if (micBtn) {
    micBtn.onclick = (e) => { e.stopPropagation(); toggleMic(); };
    renderMic();
  }
  newBtn.onclick = () => {
    resetForNewSession();
    vscode.postMessage({ type: "newSession" });
  };
  modeBtn.onclick = (e) => { e.stopPropagation(); if (state.busyLocked) return; openModePopover(); };
  gearBtn.onclick = (e) => { e.stopPropagation(); openGearPopover(); };

  // Welcome screen's "about" link → open the gear popover's Version & about panel.
  const welcomeAboutLink = $("welcome-about-link");
  if (welcomeAboutLink) welcomeAboutLink.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openAboutPanel(); };
  addBtn.onclick = (e) => { e.stopPropagation(); openAddPopover(); };
  historyBtn.onclick = (e) => { e.stopPropagation(); openHistoryPopover(); };
  repoBtn.onclick = (e) => { e.stopPropagation(); openRepoPopover(); };
  // Hidden from the first paint: the chip has nothing to say until a `repos`
  // frame arrives, and in VS Code it never appears at all.
  applyRepoSwitcherVisibility();
  donutEl.onclick = (e) => {
    e.stopPropagation();
    if (contextPopover.hidden) openContextPopover(); else closePopovers();
  };
  modePopover.addEventListener("click", (e) => e.stopPropagation());
  gearPopover.addEventListener("click", (e) => e.stopPropagation());
  contextPopover.addEventListener("click", (e) => e.stopPropagation());
  repoPopover.addEventListener("click", (e) => e.stopPropagation());
  addPopover.addEventListener("click", (e) => e.stopPropagation());
  historyPopover.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", (e) => {
    // Math / mermaid export actions (Copy source, Download as PNG/SVG, Open as PNG).
    const exprBtn = e.target.closest(".expr-btn");
    if (exprBtn) {
      e.preventDefault();
      e.stopPropagation();
      const host = exprBtn.closest(".math-export, .mermaid-block");
      if (host) {
        const act = exprBtn.getAttribute("data-expr-act");
        if (act === "copy") copyExprSource(host.getAttribute("data-export-src"), exprBtn);
        else if (act === "download" && IS_REMOTE) void exportExprBrowser(host, exprBtn);
        else if (act === "download" || act === "open") void exportExpr(host, act);
      }
      return;
    }
    const copyBtn = e.target.closest(".code-copy-btn");
    if (copyBtn) {
      e.preventDefault();
      e.stopPropagation();
      const codeEl = copyBtn.parentElement && copyBtn.parentElement.querySelector("pre code");
      // innerText (not textContent) so diff blocks, whose lines are block-level
      // spans with no literal newlines, still copy as one line per row.
      const text = codeEl ? codeEl.innerText : "";
      navigator.clipboard.writeText(text).then(() => {
        const glyph = copyBtn.querySelector(".code-copy-glyph");
        const prevGlyph = glyph ? glyph.innerHTML : "";
        if (glyph) glyph.innerHTML = ICON.check;
        copyBtn.classList.add("copied");
        setTimeout(() => {
          if (glyph) glyph.innerHTML = prevGlyph;
          copyBtn.classList.remove("copied");
        }, 1500);
      });
      return;
    }
    const onbAction = e.target.closest(".onb-action");
    if (onbAction) {
      e.preventDefault();
      e.stopPropagation();
      const act = onbAction.dataset.act;
      if (act === "runInstall") vscode.postMessage({ type: "runInstallCmd" });
      else if (act === "runLogin") vscode.postMessage({ type: "runGrokLogin" });
      else if (act === "recheck") vscode.postMessage({ type: "recheckConnection" });
      return;
    }
    const onbCopy = e.target.closest(".onb-copy");
    if (onbCopy) {
      e.preventDefault();
      e.stopPropagation();
      const cmd = onbCopy.dataset.cmd || "";
      navigator.clipboard.writeText(cmd).then(() => {
        const prevHtml = onbCopy.innerHTML;
        onbCopy.innerHTML = ICON.check;
        onbCopy.classList.add("copied");
        setTimeout(() => {
          onbCopy.innerHTML = prevHtml;
          onbCopy.classList.remove("copied");
        }, 1500);
      });
      return;
    }
    const msgCopyBtn = e.target.closest(".msg-copy-btn");
    if (msgCopyBtn) {
      e.preventDefault();
      e.stopPropagation();
      const msgEl = msgCopyBtn.closest(".msg");
      const text = (msgEl && msgEl._copyText) || "";
      navigator.clipboard.writeText(text).then(() => {
        const glyph = msgCopyBtn.querySelector(".msg-action-glyph");
        const prevGlyph = glyph ? glyph.innerHTML : "";
        if (glyph) glyph.innerHTML = ICON.check;
        msgCopyBtn.classList.add("copied");
        setTimeout(() => {
          if (glyph) glyph.innerHTML = prevGlyph;
          msgCopyBtn.classList.remove("copied");
        }, 1500);
      });
      return;
    }
    const msgRewindBtn = e.target.closest(".msg-rewind-btn");
    if (msgRewindBtn) {
      e.preventDefault();
      e.stopPropagation();
      if (msgRewindBtn.hidden) return;
      const msgEl = msgRewindBtn.closest(".msg.user");
      const idx = msgEl ? Number(msgEl.dataset.userBubbleIndex) : NaN;
      if (!Number.isInteger(idx) || idx < 0) return;
      // Send the text too: rewind discards this message, so the host hands it
      // back to the composer exactly like Edit does (#56).
      vscode.postMessage({
        type: "rewindSession",
        userBubbleIndex: idx,
        text: (msgEl && msgEl._copyText) || "",
        totalUserBubbles: visibleUserBubbleCount(),
      });
      return;
    }
    const msgEditBtn = e.target.closest(".msg-edit-btn");
    if (msgEditBtn) {
      e.preventDefault();
      e.stopPropagation();
      if (msgEditBtn.hidden) return;
      // Blocked mid-turn: the rewind underneath needs a settled session, and the
      // host would only refuse. Say so here rather than round-trip for a warning.
      if (state.busy) return;
      const msgEl = msgEditBtn.closest(".msg.user");
      const idx = msgEl ? Number(msgEl.dataset.userBubbleIndex) : NaN;
      if (!Number.isInteger(idx) || idx < 0) return;
      // `_copyText` is the bubble's own words with the context envelope,
      // selection blocks and image tags already peeled off — the same text Copy
      // yields, and exactly what belongs back in the composer. NOT the rewind
      // result's `prompt_text` — that IS this message, but in raw wire form
      // (envelope + tags still attached).
      vscode.postMessage({
        type: "editLastMessage",
        userBubbleIndex: idx,
        text: (msgEl && msgEl._copyText) || "",
        totalUserBubbles: visibleUserBubbleCount(),
      });
      return;
    }
    closePopovers();
    const a = e.target.closest("a[href]");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") || "";
    if (/^https?:\/\//i.test(href)) {
      vscode.postMessage({ type: "openUrl", url: href });
    } else if (/^[a-zA-Z]:[\\/]/.test(href) || href.startsWith("\\\\") || !/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      vscode.postMessage({ type: "openFile", path: href });
    }
  });

  input.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    // Collect image FILES synchronously (getAsFile is sync) so the decision to
    // suppress the default paste is made before any async work. Raster types
    // only — the host re-checks, this is just the first gate.
    const blobs = [];
    for (const item of items) {
      if (item.kind !== "file" || !/^image\/(png|jpeg|gif|webp)$/i.test(item.type)) continue;
      const blob = item.getAsFile();
      if (blob) blobs.push(blob);
    }
    if (blobs.length === 0) return; // plain text (or unsupported) — default paste
    e.preventDefault();
    // A mixed clipboard (copy from a web page / Word) carries text alongside
    // the image; preventDefault killed the text half, so re-insert it manually.
    const pastedText = e.clipboardData.getData("text/plain");
    if (pastedText) {
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      input.setRangeText(pastedText, start, end, "end");
      updateSlash();
      updateMention();
      renderInputHighlight();
    }
    for (const blob of blobs) {
      state.pendingPaste += 1;
      const reader = new FileReader();
      const settle = () => { state.pendingPaste = Math.max(0, state.pendingPaste - 1); };
      reader.onerror = settle;
      reader.onload = () => {
        const dataUrl = String(reader.result || "");
        const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (m) vscode.postMessage({ type: "pasteImage", mimeType: m[1], data: m[2] });
        settle();
      };
      reader.readAsDataURL(blob);
    }
  });

  input.addEventListener("input", () => { updateSlash(); updateMention(); renderInputHighlight(); });
  input.addEventListener("scroll", () => {
    if (!inputHighlight) return;
    inputHighlight.scrollTop = input.scrollTop;
    inputHighlight.scrollLeft = input.scrollLeft;
  });
  renderInputHighlight();
  // A permission card must not steal focus mid-IME-composition (#68/#38): the
  // preedit buffer holds text that `input.value` doesn't show yet, so an empty
  // composer is NOT proof the user has nothing in flight.
  input.addEventListener("compositionstart", () => { state.composingIME = true; });
  input.addEventListener("compositionend", () => { state.composingIME = false; });
  input.addEventListener("keydown", (e) => {
    // IME composition (#38): while a CJK IME is composing (preedit underline /
    // candidate window open), Enter confirms the candidate and arrows navigate
    // it — the composer must not intercept ANY key, or a half-composed
    // fragment gets sent (or queued, #37). `isComposing` is the standard
    // signal; keyCode 229 is the legacy "IME processing" code some engines
    // still report on the confirming keydown itself.
    if (e.isComposing || e.keyCode === 229) return;
    if (!slashPopover.hidden && state.slashFiltered.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        state.slashActive = (state.slashActive + 1) % state.slashFiltered.length;
        renderSlash(); return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        state.slashActive = (state.slashActive - 1 + state.slashFiltered.length) % state.slashFiltered.length;
        renderSlash(); return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        pickSlash(state.slashFiltered[state.slashActive]); return;
      }
      if (e.key === "Escape") { slashPopover.hidden = true; return; }
    }
    // "@" popover nav — mutually exclusive with the slash popover (a slash token
    // can't contain whitespace, so `/cmd @file` never matches both).
    if (mentionPopover && !mentionPopover.hidden && state.mentionFiles.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        state.mentionActive = (state.mentionActive + 1) % state.mentionFiles.length;
        renderMention(); return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        state.mentionActive = (state.mentionActive - 1 + state.mentionFiles.length) % state.mentionFiles.length;
        renderMention(); return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        pickMention(state.mentionFiles[state.mentionActive]); return;
      }
      if (e.key === "Escape") { hideMention(); return; }
    }
    const sendKey = state.useCtrlEnter
      ? e.key === "Enter" && (e.metaKey || e.ctrlKey)
      : e.key === "Enter" && !e.shiftKey;
    if (sendKey) {
      e.preventDefault();
      if (state.busy) {
        // Enter while Grok is working must never act as a hidden Stop (#37) —
        // it silently cancelled in-flight tools ("Tool execution was cancelled
        // by the user"). Queue the typed message (empty composer: no-op); it
        // flushes when the turn ends. Cancelling is only the explicit click on
        // the square Stop button (shown while the composer is empty).
        queueFromComposer();
        return;
      }
      sendOrStop();
    }
  });

  document.addEventListener("dragenter", (e) => { e.preventDefault(); document.body.classList.add("dragging"); });
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("dragleave", () => document.body.classList.remove("dragging"));
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    document.body.classList.remove("dragging");
    const data = e.dataTransfer?.getData("text/uri-list");
    if (!data) return;
    const uris = data.split(/\r?\n/).filter((l) => l && !l.startsWith("#"));
    for (const uri of uris) {
      if (!/^file:\/\//i.test(uri)) continue;
      // Post the RAW URI — the host converts it with fileUriToPath, which
      // handles the Windows drive-letter (`file:///C:/x` → `C:/x`) and UNC
      // (`file://server/share`) forms that a naive `file://` strip broke
      // (the leading-slash path failed existsSync, so drops died silently).
      vscode.postMessage({ type: "dropFile", path: uri, shift: e.shiftKey });
    }
  });

  // Keep the open history popover correctly placed + sized as the panel resizes. Its
  // right-align and width cap depend on the panel width, so a resize while it's open would
  // otherwise leave it stale until close+reopen. Only the history dropdown is panel-width
  // dependent (the composer popovers are bottom-anchored), so just re-run its positioning.
  window.addEventListener("resize", () => {
    if (!historyPopover.hidden) positionDropdownPopover(historyPopover, historyBtn);
    if (!repoPopover.hidden) positionRepoPopover();
  });

  // A resize can also happen while Grok is hidden (another panel tab / extension focused),
  // where the webview gets no resize event and so can't re-measure. Close any open popover
  // when the view is hidden, so the history dropdown never reappears stale on refocus —
  // reopening it re-measures against the current panel width.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) closePopovers();
  });

  // Focus the input the moment the panel opens — the caret should already be
  // blinking in the box before the first click (matches Claude Code / Codex).
  // The webview is rebuilt on every re-show (no retainContextWhenHidden), so
  // the boot-time focus covers "reopened" too; the window-focus hook covers
  // clicking back into a panel that stayed alive. Only claim focus when it
  // landed on <body> (i.e. nowhere) — a click that focused a real control
  // (history button, popover row) keeps it.
  window.addEventListener("focus", () => {
    const el = document.activeElement;
    if (!el || el === document.body) input.focus();
  });
  input.focus();

  initMermaid();
  initMathJax();
  vscode.postMessage({ type: "ready" });
})();
