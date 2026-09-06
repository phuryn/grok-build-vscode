(function () {
  const vscode = acquireVsCodeApi();
  const CHAT_SCRIPT_URL = document.currentScript?.src || window.location.href;
  // True in the relay's browser client (its chat.html shim sets the flag before
  // loading this file); always false inside the VS Code webview. Gates the
  // host-only affordances: worktree/rewind actions (their host flows run native
  // VS Code UI a browser user can't see) and the AFK Pilot account section.
  const IS_REMOTE = !!window.grokRemoteClient;
  // Desktop Electron preload sets grokDesktopShell; VS Code webview never does.
  // Client-owned font scale (localStorage + keyboard/wheel) applies to remote AND desktop
  // — not the VS Code sidebar, which stays on host `grok.chatFontScale`.
  // Do not key off the file-tree bridge — that API is panel-only; chat.js must not call it.
  const IS_DESKTOP_CLIENT = !!window.grokDesktopShell;
  const CLIENT_OWNS_FONT_SCALE = IS_REMOTE || IS_DESKTOP_CLIENT;
  const REMOTE_FONT_SCALE_KEY = "grok.remote.fontScale";
  const DESKTOP_FONT_SCALE_KEY = "grok.desktop.fontScale";
  const CLIENT_FONT_SCALE_KEY = IS_REMOTE ? REMOTE_FONT_SCALE_KEY : DESKTOP_FONT_SCALE_KEY;
  /** Client zoom bounds (fraction of 1). Matches AFK Pilot's 80–160% slider. */
  const CLIENT_FONT_SCALE_MIN = 0.8;
  const CLIENT_FONT_SCALE_MAX = 1.6;
  const CLIENT_FONT_SCALE_STEP = 0.1;
  const REMOTE_TTS_KEY = "grok.remote.tts";
  const REMOTE_TTS_SUMMARY_KEY = "grok.remote.ttsSummary";
  const REMOTE_STORAGE_SUFFIX = (
    typeof location !== "undefined"
      ? new URLSearchParams(location.search || "").get("device") || "default"
      : "default"
  );
  const REMOTE_SESSION_KEY = "grok.remote.tabSession:" + REMOTE_STORAGE_SUFFIX;
  /**
   * "The user CHOSE to leave that conversation, and has not landed on another."
   *
   * The remembered identity is cleared both when a conversation is lost and
   * when the user deliberately switches repo, starts a new session, or opens a
   * row in another project. Downstream those two collapse into the same null,
   * so the relay page reported a deliberate switch as
   *   "1 queued action was not sent because this tab had no remembered
   *    conversation to restore"
   * — telling the owner his message had failed when he had simply moved on,
   * mid-turn, on a phone (2026-09-01).
   *
   * A sibling storage key rather than a field on the identity, because the
   * whole point is that there IS no identity at that moment. It is cleared the
   * instant a real one is saved, so it bounds itself on an EVENT rather than a
   * timer: it can only ever describe the gap between letting go and landing.
   */
  const REMOTE_SWITCH_KEY = "grok.remote.tabSwitchedByChoice:" + REMOTE_STORAGE_SUFFIX;
  // Set by the relay's page before this file loads. Only ever says "the host on
  // the other end is one the relay installed", which is why it can skip a
  // compatibility wait rather than change any behaviour.
  const IS_CLOUD_HOST = typeof window !== "undefined" && window.grokCloudHost === true;
  const REMOTE_TAB_TOKEN_KEY = "grok.remote.tabToken:" + REMOTE_STORAGE_SUFFIX;
  const REMOTE_TAB_OWNER_KEY = "grok.remote.tabOwner:" + REMOTE_STORAGE_SUFFIX;
  const REMOTE_TAB_CHANNEL = "grok.remote.tabClaim:" + REMOTE_STORAGE_SUFFIX;
  const REMOTE_TAB_CLAIM_TIMEOUT_MS = 250;
  let remoteTabToken = null;
  let priorRemoteTabOwner = null;
  let remoteTabInstanceId = null;
  let rememberedRemoteSession = null;

  function newRemoteTabToken() {
    try {
      const bytes = new Uint8Array(24);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    } catch (_) {
      try {
        return crypto.randomUUID().replace(/-/g, "");
      } catch (_) {
        return null;
      }
    }
  }

  if (IS_REMOTE) {
    try {
      remoteTabToken = sessionStorage.getItem(REMOTE_TAB_TOKEN_KEY);
      priorRemoteTabOwner = sessionStorage.getItem(REMOTE_TAB_OWNER_KEY);
      if (!remoteTabToken) {
        remoteTabToken = newRemoteTabToken();
        if (remoteTabToken) sessionStorage.setItem(REMOTE_TAB_TOKEN_KEY, remoteTabToken);
      }
    } catch (_) {
      remoteTabToken = newRemoteTabToken();
    }
    try {
      const saved = JSON.parse(sessionStorage.getItem(REMOTE_SESSION_KEY) || "null");
      if (
        saved &&
        typeof saved.id === "string" &&
        typeof saved.repoCwd === "string" &&
        (!saved.cwd || typeof saved.cwd === "string")
      ) rememberedRemoteSession = saved;
    } catch (_) { /* storage unavailable/private mode */ }
  }
  function saveRememberedRemoteSession(value) {
    if (!IS_REMOTE) return;
    rememberedRemoteSession = value;
    try {
      if (value) {
        sessionStorage.setItem(REMOTE_SESSION_KEY, JSON.stringify(value));
        // Landed. Whatever the user left behind is no longer the current story.
        sessionStorage.removeItem(REMOTE_SWITCH_KEY);
      } else sessionStorage.removeItem(REMOTE_SESSION_KEY);
    } catch (_) { /* storage unavailable/private mode */ }
  }

  /**
   * Let go of the remembered conversation BECAUSE THE USER ASKED TO.
   *
   * Same clearing as `saveRememberedRemoteSession(null)`, plus a note saying so.
   * Used only where a person acted: the repo chip, New session, and a rail row
   * or repo in another project. Host-driven clears (a session deleted under us,
   * a refused restore) deliberately keep the plain form — those really are
   * losses and should still read as such.
   */
  function forgetRememberedSessionByChoice() {
    saveRememberedRemoteSession(null);
    try { sessionStorage.setItem(REMOTE_SWITCH_KEY, "1"); } catch (_) { /* private mode */ }
  }

  function replaceRemoteTabIdentity() {
    const replacement = newRemoteTabToken();
    if (!replacement) return;
    remoteTabToken = replacement;
    saveRememberedRemoteSession(null);
    // Unsaved file edits go with the identity. They are in memory only now, so a
    // duplicated tab cannot inherit them in the first place — this is here so
    // the rule survives if they are ever made durable again, which is exactly
    // how the leak arrived the first time.
    state.filesBrowse.component?.clearMemory?.();
    try {
      sessionStorage.setItem(REMOTE_TAB_TOKEN_KEY, replacement);
    } catch (_) { /* storage unavailable/private mode */ }
  }

  function markRemoteTabClaimed() {
    if (!remoteTabInstanceId) return;
    try {
      sessionStorage.setItem(REMOTE_TAB_OWNER_KEY, remoteTabInstanceId);
    } catch (_) { /* storage unavailable/private mode */ }
  }

  function clearRemoteTabOwner() {
    if (!remoteTabInstanceId) return;
    try {
      if (sessionStorage.getItem(REMOTE_TAB_OWNER_KEY) === remoteTabInstanceId) {
        sessionStorage.removeItem(REMOTE_TAB_OWNER_KEY);
      }
    } catch (_) { /* storage unavailable/private mode */ }
  }

  function claimRemoteTabIdentity(done) {
    if (!IS_REMOTE || !remoteTabToken) {
      done(remoteTabToken || undefined);
      return;
    }
    remoteTabInstanceId = newRemoteTabToken();
    if (!remoteTabInstanceId) {
      if (priorRemoteTabOwner) replaceRemoteTabIdentity();
      done(remoteTabToken || undefined);
      return;
    }
    window.addEventListener("pagehide", clearRemoteTabOwner, { once: true });

    const finish = (replace) => {
      if (replace) replaceRemoteTabIdentity();
      markRemoteTabClaimed();
      done(remoteTabToken || undefined);
    };
    if (typeof BroadcastChannel !== "function") {
      finish(!!priorRemoteTabOwner);
      return;
    }
    let channel;
    try {
      channel = new BroadcastChannel(REMOTE_TAB_CHANNEL);
    } catch (_) {
      finish(!!priorRemoteTabOwner);
      return;
    }
    let claimed = false;
    let settled = false;
    let timer;
    const settle = (replace) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      claimed = true;
      finish(replace);
    };
    channel.onmessage = (event) => {
      const message = event && event.data;
      if (!message || message.token !== remoteTabToken || message.instanceId === remoteTabInstanceId) return;
      if (message.type === "probe") {
        if (claimed || remoteTabInstanceId < message.instanceId) {
          channel.postMessage({
            type: "occupied",
            token: remoteTabToken,
            instanceId: remoteTabInstanceId,
            target: message.instanceId,
          });
        } else {
          settle(true);
        }
      } else if (message.type === "occupied" && message.target === remoteTabInstanceId) {
        settle(true);
      }
    };
    if (priorRemoteTabOwner) {
      channel.postMessage({ type: "probe", token: remoteTabToken, instanceId: remoteTabInstanceId });
      timer = setTimeout(() => settle(false), REMOTE_TAB_CLAIM_TIMEOUT_MS);
    } else {
      settle(false);
    }
    window.addEventListener("pagehide", () => channel.close(), { once: true });
  }

  let resolveRemoteTabTokenReady;
  window.__grokTabTokenReady = new Promise((resolve) => {
    resolveRemoteTabTokenReady = resolve;
  });

  const SESSION_SUPERSEDED_CODE = "session-superseded";

  /** Explicit user actions set `claim`. Reconnect restore MUST omit it. */
  function postResumeSession(id, cwd, opts) {
    const msg = { type: "resumeSession", id, cwd: cwd || undefined };
    if (opts && opts.claim) msg.claim = true;
    vscode.postMessage(msg);
  }

  function restoreRememberedRemoteSession() {
    const saved = rememberedRemoteSession;
    if (!IS_REMOTE || !saved) return;
    if (saved.repoCwd && saved.repoCwd !== state.cwd) {
      vscode.postMessage({ type: "selectRepo", cwd: saved.repoCwd });
    }
    // Startup restore has no display name in the remembered payload, and the
    // page is already on the welcome/"Starting" hold. Treating it like a
    // user click would invent a title we do not have.
    // Deliberately NOT a claim: a thawing background tab must not steal the
    // conversation back from the tab that asked for it.
    postResumeSession(saved.id, saved.cwd || undefined);
  }
  const ttsAvailable = !!window.speechSynthesis && typeof window.SpeechSynthesisUtterance === "function";

  function storedNumber(key, fallback) {
    try {
      const value = Number(window.localStorage.getItem(key));
      return Number.isFinite(value) && value > 0 ? value : fallback;
    } catch {
      return fallback;
    }
  }

  function storedBool(key, fallback) {
    try {
      const value = window.localStorage.getItem(key);
      return value === null ? fallback : value === "true";
    } catch {
      return fallback;
    }
  }

  function storeRemotePref(key, value) {
    try { window.localStorage.setItem(key, String(value)); } catch { /* unavailable */ }
  }

  /** Clamp client zoom into [MIN, MAX]; non-finite → 1. Exported for tests via window.__grokFontScale. */
  function clampClientFontScale(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 1;
    return Math.min(CLIENT_FONT_SCALE_MAX, Math.max(CLIENT_FONT_SCALE_MIN, Math.round(v * 100) / 100));
  }

  function stepClientFontScale(current, delta) {
    return clampClientFontScale(Number(current) + Number(delta));
  }

  function remoteUsesTouchComposer() {
    return IS_REMOTE && typeof window.matchMedia === "function" &&
      window.matchMedia("(hover: none), (pointer: coarse)").matches;
  }

  /**
   * How tall the composer may grow, in lines (owner, 2026-09-04).
   *
   * A phone stops sooner than a desktop, because there the composer is not the
   * only thing competing for the screen: the keyboard already owns the bottom
   * half, and a box that grows to nine lines on top of it leaves nothing of the
   * conversation to read while you write about it. That is the same reason the
   * box grows at all (#144) — being able to see what you are writing — applied
   * to the other side of the trade.
   *
   * Coarse pointer AND no hover, the signal the add-project form already uses:
   * a touchscreen laptop still has a mouse and is not a phone. Not gated on
   * IS_REMOTE, because a phone is a phone whether it reached us through the
   * relay or the native shell.
   */
  const COMPOSER_MAX_LINES_TOUCH = 6;
  const COMPOSER_MAX_LINES_DESK = 10;
  function composerMaxLines() {
    return typeof window.matchMedia === "function"
      && window.matchMedia("(hover: none), (pointer: coarse)").matches
      ? COMPOSER_MAX_LINES_TOUCH
      : COMPOSER_MAX_LINES_DESK;
  }
  // Exported for tests: happy-dom does no layout, so a height assertion would
  // measure nothing. The decision is the testable part.
  window.__grokComposerMaxLines = composerMaxLines;

  const $ = (id) => document.getElementById(id);
  const messagesEl = $("messages");
  const input = $("input");
  const sendBtn = $("send-btn");
  const micBtn = $("mic-btn");
  const inputHighlight = $("input-highlight");
  const newBtn = $("new-btn");
  const historyBtn = $("history-btn");
  const remoteBtn = $("remote-btn");
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
  const GROK_ACTIVITY_VERB = "Grokking";
  const CODEX_ACTIVITY_VERB = "Opening AI";
  const CLAUDE_ACTIVITY_VERB = "Clauding";
  const COMPOSER_PLACEHOLDER = {
    grok: "Ask Grok\u2026",
    codex: "Ask GPT\u2026",
    claude: "Ask Claude\u2026",
  };
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
    const m = (state.availableModels || []).find((x) => x && x.modelId === state.currentModelId && (!x.provider || x.provider === state.activeProvider));
    const adv = m && Array.isArray(m.reasoningEfforts)
      ? m.reasoningEfforts.filter((v) => typeof v === "string" && v)
      : [];
    if (!adv.length) return EFFORT_LEVELS.slice();
    const known = EFFORT_LEVELS.filter((id) => adv.includes(id));
    const extra = adv.filter((id) => !EFFORT_LEVELS.includes(id)); // unknown advertised → keep as given
    return [...known, ...extra];
  }

  const storedRemoteTts = IS_REMOTE && storedBool(REMOTE_TTS_KEY, false);
  const storedRemoteTtsSummary = storedRemoteTts && storedBool(REMOTE_TTS_SUMMARY_KEY, true);
  if (IS_REMOTE && !storedRemoteTts) storeRemotePref(REMOTE_TTS_SUMMARY_KEY, false);

  const state = {
    welcomeVisible: true,
    currentModelId: null,
    activeProvider: "grok",
    providersKnown: false,
    providers: [],
    // Settings → Providers re-observation in flight. Host-owned; see the
    // `providerState` case for why the client never sets it on its own.
    providersChecking: false,
    githubState: null,
    githubRepos: null,
    onboardingMode: null,
    onboardingInfo: {},
    /** provider -> the device-login card last sent by the host. Mirrored into
     *  Settings so a connect started there reports where the click happened. */
    deviceLoginByProvider: {},
    codexInstall: { phase: "idle", receivedBytes: 0, totalBytes: 0, reason: "" },
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
    // otherwise; remote clients cannot configure the host themselves.
    voiceConfigured: true,
    // Dictation insertion point: text before and after the selection that was
    // active when the mic started. Live partials replace only the text between
    // these anchors.
    voiceBefore: "",
    voiceAfter: "",
    voiceInsertionActive: false,
    voiceLive: false,
    // Manual Send/Queue discards the active capture and blocks late results
    // until the next mic start.
    voiceDiscarded: false,
    // The configured send phrase (for highlighting it in the composer).
    voiceSendPhrase: "grok send",
    voiceKeyterms: [],
    telemetryEnabled: undefined,
    thumbsFeedback: false,
    // Client-owned zoom (remote + desktop). VS Code uses hostFontScale only.
    remoteFontScale: CLIENT_OWNS_FONT_SCALE
      ? clampClientFontScale(storedNumber(CLIENT_FONT_SCALE_KEY, 1))
      : 1,
    hostFontScale: Number(document.body.style.getPropertyValue("--chat-zoom")) || 1,
    remoteTts: storedRemoteTts,
    remoteSummarizeRepliesAloud: storedRemoteTtsSummary,
    readRepliesAloud: false,
    // The host posts the configured value immediately after initialState. Keep
    // the pre-sync render conservative so a read-aloud toggle cannot summon a
    // summary request before that config message arrives.
    summarizeRepliesAloud: false,
    remotePreferencesSupported: false,
    ttsTurnText: "",
    // Render MIRROR of the focused session's host-owned send queue (#37) —
    // messages typed/dictated while Grok was busy. Entries are `{text, chips}`.
    // All mutations route through the host (queueSend/dequeueSend/clearQueuedSends)
    // and come back as a queuedSends snapshot, so the queue survives focus
    // switches and the HOST flushes it (one combined prompt) when the session's
    // turn ends.
    sendQueue: [],
    queuedWrapEl: null, // the .queued-msgs container pinned to the end of the chat
    queuedSubmissionPending: false,
    queuedSubmissionRejected: false,
    submittedQueuedSendIds: new Set(),
    queuedSubmissionId: null,
    pendingSubmissionText: "",
    pendingSubmissionId: null,
    pendingSubmissionChipIds: [],
    rejectedSubmissionText: "",
    // Remote-only placeholder bubble shown between a send and the host's echo.
    optimisticSendEl: null,
    // Steer (#52). Optimistic: `_x.ai/interject` is unadvertised, so we can't ask
    // whether it works — we offer it and let the host latch this off the first
    // time the CLI answers -32601 (the text falls back to the queue, never lost).
    steerSupported: true,
    // Grok thumbs (#114). Off until the host advertises feedbackAvailability.
    // Only the live-process turn that just finished is rateable (not session/load).
    feedbackAvailable: false,
    turnRating: 0,
    // Claude Code has no mid-turn interject, so a message typed while it is
    // working is always SCHEDULED, never steered — whatever the steer-by-default
    // setting says (owner, 2026-08-17). Offering Steer there would promise the
    // running turn hears you now, and it does not. See steerableProvider().
    lastTurnUsage: null, // last prompt's billing split (#53), for the donut popover
    sessionUsage: null, // session-cumulative billing — summed by the host, not grok
    // Structured session/info addends, bound to the `used` they arrived with.
    // Occupancy-only frames keep this; an open popover re-fetches session/info.
    contextBreakdown: null,
    activeAgentEl: null,
    activeAgentRaw: "",
    activeUserEl: null,
    activeUserRaw: "",
    // Count of clipboard images still being read (FileReader in flight). Send
    // is held while > 0 so a paste-then-Enter can't race the image onto the
    // NEXT message — the pasteImage post must reach the host before send does.
    pendingPaste: 0,
    // Browser-owned data URLs for pasted image previews, keyed by opaque id.
    // previewId is random and globally unique; keeping one map lets a paste
    // survive the session id being assigned after the first send and survives
    // switching away from a conversation.
    imagePreviews: new Map(),
    // The full-size render the overlay is currently waiting on, so a late reply
    // for a closed or replaced preview is dropped rather than painted.
    pendingImageFullId: null,
    imageFullTimer: null,
    activeThoughtEl: null,
    activeThoughtHdrEl: null,
    thoughtStartTime: null,
    activeToolGroupEl: null,
    slashFiltered: [],
    slashQuery: "",
    slashActive: 0,
    // "@" file popover: the rows the host sent for the current token
    // (mentionResults), the highlighted row, and the token the rows answer —
    // null while no token is under the caret (stale replies are dropped
    // against it, so fast typing can't render an older query's rows).
    mentionFiles: [],
    mentionActive: 0,
    mentionQuery: null,
    pendingDiffByToolCallId: new Map(),
    // Permission requests whose diff has already been auto-opened once.
    //
    // NOT cleared by resetForNewSession, deliberately — like imagePreviews
    // above. Auto-open is meant to fire when a permission card ARRIVES, and
    // re-entering a conversation re-renders its pending cards from the
    // transcript, which is not an arrival. Clearing this per session would
    // reproduce exactly the bug it fixes: close the proposed diff, switch
    // chats, come back, and it reopens over the files you were working in
    // (#132).
    autoOpenedDiffRequests: new Set(),
    toolItemsByToolCallId: new Map(),
    toolFailuresById: new Map(), // toolCallId → error text, so a single-call group carries it onto the flat
    // Media-gen toolCallIds (isMediaGenToolCall on the initial tool_call). The
    // completed/failed update often has title:null, so ZDR hints need this set.
    mediaGenCallIds: new Set(),

    agentRenderScheduled: false,
    thoughtBuffer: "",
    thoughtRenderScheduled: false,
    sessions: [],
    repos: [],
    // Set by the first `repos` frame — the host's proof that it supports the
    // switcher at all. Older extensions never send one (see repoSwitcherAvailable).
    reposKnown: false,
    // A deliberate repo switch stays locked until its transition settles. The
    // replay bracket also keeps the lock honest for an old conversation load.
    repoSwitchPending: false,
    /** The cwd a rail selection is waiting on, so the catalog echo that
     *  confirms it can release the lock. Empty when nothing is pending. */
    repoSwitchTarget: "",
    selectedRepoCwd: "",
    activeRepoCwd: "",
    // Projects rail (browser client only). `repoPreviews` caches one page of
    // rows per NON-selected repo — the selected one always reads the live
    // `sessions` list instead. `repoPreviewsSupported` latches on the first
    // `repoSessions` frame: until a host has answered once, the rail probes with
    // a single request rather than one per repo, so an older host that ignores
    // the message costs one dead frame instead of a fan-out on every catalog push.
    // Pinned conversations across every repo — the rail's Pinned group. Host
    // pushes it; the client never has to ask, and an older host simply never
    // sends it, leaving the group absent rather than empty.
    pinnedSessions: [],
    // Capability latch: the host announces per-session pinning by sending the
    // frame at all — even empty. Without this the pin renders against a host
    // that drops `toggleSessionPin`, which is a control that looks broken
    // rather than absent (the same trap the repo chip avoids).
    pinnedSessionsKnown: false,
    // Remote tab lost this conversation to another tab's explicit claim.
    // Transcript stays; composer and turn controls freeze until Continue here
    // (a claim) or a different conversation is opened.
    sessionSuperseded: null,
    /** Desktop update rail — `updateAvailable` (notice) or `updateReady` (restart). */
    appUpdate: null,
    repoPreviews: {},
    repoPreviewsAsked: {},
    repoPreviewErrors: {},
    repoPreviewsSupported: false,
    // What the connected host says it can do (initialState.capabilities). Empty
    // until it says, so a control that needs one is withheld rather than offered
    // and then refused.
    hostCaps: {},
    // Host shell language for command View all (initialState.commandLanguage).
    // Empty on older hosts — View all then omits language.
    commandLanguage: "",
    // Remote file browse (list + open + optional edit). Capability-gated; never
    // mounted in the local VS Code / desktop webview even if the host flag is
    // true — those hosts already have a real explorer. Phone UI stays collapsed
    // by default (screen space is scarce; the rail is already a drawer).
    filesBrowse: {
      open: false,
      component: null,
    },
    railCollapsed: {},
    /** The project the live conversation was in at the last render. Only used to
     *  notice it MOVED, so a fold can be corrected once on arrival instead of
     *  being refused outright. */
    railLiveRepoKey: "",
    railExpanded: {},
    // Collapsible group headers (PINNED is never collapsible). Defaults:
    // Recent + Projects open; Archived folded away. Persisted in saveRailShape.
    railGroupCollapsed: { recent: true, projects: false, archived: true },
    // Compatibility alias for older railShape writes — mirrored from
    // railGroupCollapsed.archived on load/save.
    railArchiveOpen: false,
    // True between a catalog naming a new selected repo and the session list for
    // that repo arriving — the window in which `state.sessions` still describes
    // the repo we just left.
    railSessionsStale: false,
    // The selected repo's newest sessions AS THE RAIL SEES THEM — fed only by
    // unfiltered first pages, so an open history search never reshapes the rail.
    railSelectedRows: [],
    // Whether that list has ever arrived. An empty holder is otherwise
    // indistinguishable from a project that genuinely has no conversations, and
    // the two answer "when was this last worked in" very differently.
    railSelectedRowsKnown: false,
    // Renderer-local only. Drives the optimistic rail highlight + loading veil
    // while a resume/new click is in flight. NEVER written into activeSessionId
    // (that stays host-confirmed), never remembered, never used by rename /
    // delete / send / the session header. See railDisplayTarget.
    railTransition: null,
    // "We have asked the host to move and it has not told us where it landed."
    // Outlives railTransition deliberately — the watchdog and a stray error
    // tear that down without learning anything about the host. Gates the
    // session actions that carry no id. See railIdlessActionsAllowed.
    railIdentityUnknown: false,
    // WHAT we are waiting to hear about, kept alive past the watchdog. Giving up
    // on the optimistic paint says nothing about where the host went, and a
    // superseded resume stays queued host-side and can land later — so without
    // this, a stale confirmation for an abandoned click reads as authoritative.
    // `{ kind: "resume", sessionId }` or `{ kind: "new", previousSessionId }`.
    railExpectedIdentity: null,
    activeSessionId: null,
    // The host sends this independently of history pagination. The latch is
    // also the compatibility gate for the new inline rename affordance.
    sessionName: null,
    sessionNameEditing: null,
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
    sessionLastAutoPageKey: "",
    // Combined history keeps Grok's consumed-slot cursor opaque and remembers
    // the last emitted Codex (timestamp,id) tuple. The scalar offset remains the
    // append/legacy contract.
    sessionProviderCursor: null,
    replaying: false,
    replayDepth: 0,
    // Open-path window (#102): hold the replay stream and render only the last
    // HISTORY_WINDOW_USER_TURNS. Older turns live here as raw host messages and
    // prepend as the reader scrolls up. Live sessions never enter this path.
    replayHold: false,
    replayHeld: [],
    historyPrefix: [],
    historyPrefixUserCount: 0,
    historyPrefixPlans: [],
    historyPrefixPermissions: [],
    historyHydrating: false,
    // Host events this client has actually rendered — the export source. A
    // remote snapshot is only the recent window; exportWindowed labels that.
    exportEvents: [],
    exportWindowed: false,
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
    // Restored question cards on resume (toolCallId → card element). On replay grok
    // sends a tool_call per question (with rawInput.questions); we render the card
    // immediately and fill the answer in whenever it arrives — on the tool_call
    // snapshot or a later update with the same toolCallId.
    restoredCardsByToolCallId: new Map(),
    // Saved plan cards waiting to be rendered inline as the conversation replays.
    // `afterUserMessage` is the prompt coordinate; `afterInterjection` orders
    // repeated native reject/revise cycles inside one prompt.
    planHistoryQueue: [],
    // Answered permission cards from a resumed session, drained inline like plans
    // (each { title, outcome, afterUserMessage? }). The CLI doesn't replay the
    // request, so the host persists + re-queues these.
    permissionHistoryQueue: [],
    userMsgCount: 0,
    interjectionCount: 0,
    historyEventCount: 0,
    // The "Grokking…" placeholder shown while a user-initiated turn is waiting on
    // grok — from the moment the user sends (agentStart) until the first real
    // content arrives (a thought, message, tool card, …), which replaces it in
    // place. Same font + animated dots as the Thinking header, minus the expand
    // chevron. The real Thinking block replaces it once content arrives.
    grokkingEl: null,
    // When true, the busy state is "locked" (e.g. session-start priming): the
    // send button shows a spinner and is disabled. When false, busy is
    // "stoppable" (regular prompts) and the send button
    // shows a stop icon that the user can click to cancel grok mid-stream.
    // Starts true so the very first paint is the disabled spinner (see `busy`).
    busyLocked: true,
    // grok CLI version from the ACP `initialized` handshake, plus a flag marking
    // the session-start window: while startingPhase is true the welcome line
    // shows "starting…"; it flips to "connected · v<cliVersion>" only when the
    // priming spinner clears (setBusy:false). See the initialized/setBusy cases.
    cliVersion: "",
    startingPhase: false,
    planModeAvailable: true,
    planModeUnavailableReason: "",
    // Unverified version probe: Plan row stays clickable so a pick re-probes.
    planModeRecheckable: false,
    // Extension version (from initialState) — shown in Settings → About.
    extVersion: "",
    // Which GUI is on the other end and what the desk machine is called. Only a
    // remote needs these; a local webview is already looking at the thing.
    hostKind: "",
    hostName: "",
    // Which gear-popover view is showing ("main"|"model"|"config").
    gearView: "main",
    // Which button opened the popover: "composer" (this conversation — model,
    // effort, where it continues) or "rail" (the app — account, purpose,
    // settings, about). Only meaningful once a rail gear exists; in VS Code the
    // one composer button owns both and this stays inert.
    gearSurface: "composer",
    // Latest `grok update --check` result for Settings → About: { checking } while
    // in flight, then { current, latest, updateAvailable, error }.
    grokUpdate: null,
    mcpServers: [],
    mcpLoading: false,
    mcpError: "",
    mcpWarning: "",
    mcpConnectors: [],
    // While replaying an older session, suppress a legacy primer user turn and
    // grok's response until the next user message starts.
    suppressReplayTurn: false,
    // Replay-scoped: hide a marker-only / <system-reminder> user event.
    // Reset when the next user event begins, when thought/agent text arrives,
    // and when the outer replay starts/ends. Distinct from suppressReplayTurn
    // (which hides the whole turn).
    skipUserBubble: false,
    // Whether the chat is "pinned" to the bottom. A user gesture (wheel /
    // touch / scrollbar / keys) flips this off so they can read history
    // while grok keeps thinking (#16). Programmatic and focus-induced
    // scrolls must not clear it (#92). Interactive activity (permission/
    // question cards, the user's own sent message) re-pins via
    // forceScrollToBottom().
    stickToBottom: true,
    // grok.showThinking (#26). Thinking traces are hidden by default; when hidden
    // a lightweight "Thinking…" indicator stands in while grok reasons (and no
    // tool/Grokking indicator is already showing). Toggle lives in gear → Config
    // & debug. The host posts the real value on init and on config change.
    // Effective display also requires Coding app-purpose (see isCodingPurpose).
    showThinking: false,
    thinkingIndicatorEl: null,
    // Command rows awaiting their output ({command, details, done}) — the
    // host's commandOutput (snapshotted at terminal/release, #41) attaches to
    // the oldest un-served row with the exact same command string (FIFO).
    pendingCommandDetails: [],
    // grok.expandCommandOutputs (persisted, global): the standing DEFAULT for
    // new content — command IN/OUT details pre-open, and command-bearing groups
    // auto-open. Command scope only (explore/edit groups stay collapsed).
    // Effective expand also requires Coding app-purpose.
    expandCommandOutputs: false,
    // Global "Use this app for" — Knowledge work (default) | Coding. Absent from
    // an older host means Knowledge work (smaller surface). Stored on the host
    // in ~/.grok/client-state; never invent a second store.
    appPurpose: "knowledge",
    // CLI worktree RPCs assumed supported until create returns unsupported.
    worktreeSupported: true,
    // grok.steerByDefault (persisted, global): when true a message sent while
    // grok is working SKIPS the queue and is interjected into the running turn.
    // False = today's behavior (queue, with an on-demand Steer button).
    steerByDefault: false,
    // grok.soundNotifications (persisted, global): when true a short synth tone
    // plays on turn completion / error, but only when the Grok panel isn't
    // focused (#59). Off by default. Host posts the value on init + config change.
    soundNotifications: false,
    // grok.processingSound: a quiet repeating cue while a live turn is still
    // running. Separate from the completion/error notification and off by default.
    processingSound: false,
    // grok.worktree — true when the focused session runs in an isolated git
    // worktree (from the `session` message). Gates the gear Apply/Remove items.
    isWorktree: false,
    // Whether the host machine holds a relay device token (`remoteStatus`).
    // Drives the gear AFK Pilot items; never sent to remote clients.
    // THREE states, not two: null = not answered yet. The host reads the token
    // from secret storage asynchronously, so defaulting to false told an
    // already-linked machine to "Sign in (link this device)" for that window —
    // inviting the user to re-link a device that was working. Unknown shows
    // nothing at all.
    remoteLinked: null,
    // Display form of the one directory new and cloned projects land in
    // (`projectSetup.root`, e.g. `~/Grok Build`). Empty until the host says —
    // the Add project form shows the destination as you type, so it needs this
    // before anyone has typed anything.
    projectRoot: "",
    // Live `projectSetup.github` while the clone form is open. Closing or
    // reopening cancels the login; this is not a reason to pop the modal.
    projectGithub: null,
    // Empty-state tip facts from the host (`welcomeTips`): the two counts the
    // chat client never receives on its own plus the retired ids. null until
    // the frame lands, which suppresses the count-dependent tips rather than
    // reading an absent count as zero.
    welcomeTips: null,
    // Which eligible tip is showing. Advances only when the screen BECOMES
    // empty, so a repaint cannot shuffle the line under the reader.
    welcomeTipCursor: 0,
    // toolExpandOverride (per-session, in-memory): the Command Palette
    // Expand/Collapse All latch. null = follow the setting above; true/false =
    // force ALL groups + details open/closed for this session, and keep applying
    // to new content as it streams in (last action wins vs the setting). Rides
    // the session's replay buffer, so it survives focus-swaps but resets on a
    // cold reopen from history — see resetForNewSession + the emit in sidebar.ts.
    toolExpandOverride: null,
  };

  // Legacy primer / <system-reminder> / marker-only plan-verdict hide rules
  // live in replayedUserBubbleVerdict (webview-helpers) so display + export
  // cannot drift.

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
    // The empty state's advice mark. Lucide `lightbulb`, on this map's own
    // conventions — 24 viewBox, stroke 2, currentColor — so it sits in the
    // same drawn language as every other glyph in the product rather than
    // being the one filled outlier.
    idea: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>`,
    orbit: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.341 6.484A10 10 0 0 1 10.266 21.85"/><path d="M3.659 17.516A10 10 0 0 1 13.74 2.152"/><circle cx="12" cy="12" r="3"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/></svg>`,
    square: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>`,
    spinner: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`,
    gear: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`,
    // lucide settings-2 (sliders). The composer button wears this once the rail
    // has taken the app-level settings: sliders read as "adjust what's in front
    // of me", the gear as "configure the product". Two gears side by side read
    // as a duplicate; these two do not.
    settings2: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/></svg>`,
    shield: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/></svg>`,
    bot: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>`,
    listTree: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12h-8"/><path d="M21 6H8"/><path d="M21 18h-8"/><path d="M3 6v4c0 1.1.9 2 2 2h3"/><path d="M3 10v6c0 1.1.9 2 2 2h3"/></svg>`,
    zap: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/></svg>`,
    copy: `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`,
    thumbsUp: `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/></svg>`,
    thumbsDown: `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/></svg>`,
    check: `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
    squareChevronRight: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="m10 8 4 4-4 4"/></svg>`,
    chevronRight: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>`,
    chevronDown: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`,
    chevronUp: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>`,
    ellipsis: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>`,
    search: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`,
    clock: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    plus: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>`,
    x: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
    upload: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m17 8-5-5-5 5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/></svg>`,
    download: `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="m7 10 5 5 5-5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/></svg>`,
    trash: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>`,
    pencil: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>`,
    folder: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h5l2 3h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/></svg>`,
    // Lucide folder-closed / folder-open — project expand/collapse (replaces chevron).
    // Solid folder marks supplied by the owner (media/icons/folder-*.svg),
    // inlined because the rail sets them with innerHTML. `fill:currentColor`
    // is the change from the originals — it is what lets a project's colour
    // tint them, and what keeps them legible in a light theme.
    folderClosed: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 408 408" fill="currentColor" aria-hidden="true"><path d="M372,88.661H206.32l-33-39.24c-0.985-1.184-2.461-1.848-4-1.8H36c-19.956,0.198-36.023,16.443-36,36.4v240c-0.001,19.941,16.06,36.163,36,36.36h336c19.94-0.197,36.001-16.419,36-36.36v-199C408.001,105.08,391.94,88.859,372,88.661z"/></svg>`,
    folderOpen: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -57 511.99973 511" fill="currentColor" aria-hidden="true"><path d="m506.039062 180.988281c-7.78125-12.546875-21.53125-20.046875-36.78125-20.046875h-339.5625c-16.832031 0-32.140624 9.488282-39.011718 24.179688l-89.8125 188.308594c3.390625 13.789062 16.269531 24.089843 31.609375 24.089843h361.269531c15.445312 0 29.5625-8.734375 36.460938-22.554687l77.628906-155.59375c6.128906-12.3125 5.449218-26.660156-1.800782-38.382813zm0 0"/><path d="m72.402344 156.15625c6.863281-14.6875 22.175781-24.179688 39.011718-24.179688h319.753907v-40.898437c0-16.859375-14.222657-30.578125-31.703125-30.578125h-186.445313c-.273437 0-.460937-.070312-.53125-.121094l-33.371093-46.660156c-5.910157-8.277344-15.671876-13.21875-26.101563-13.21875h-121.304687c-17.488282 0-31.710938 13.71875-31.710938 30.578125v276.875zm0 0"/></svg>`,
    // Palette glyph for "Set color" — stroke-only so it inherits menu icon tint.
    palette: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r="0.5" fill="currentColor"/><circle cx="17.5" cy="10.5" r="0.5" fill="currentColor"/><circle cx="8.5" cy="7.5" r="0.5" fill="currentColor"/><circle cx="6.5" cy="12.5" r="0.5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg>`,
    pin: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="m5 17 2-7V5l-2-2h14l-2 2v5l2 7Z"/></svg>`,
    // Same Lucide pin path with a filled head (outline stroke kept for the needle).
    pinFilled: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="m5 17 2-7V5l-2-2h14l-2 2v5l2 7Z" fill="currentColor"/></svg>`,
    archive: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>`,
    archiveRestore: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h4"/><path d="M20 8v11a2 2 0 0 1-2 2h-4"/><path d="m9 15 3-3 3 3"/><path d="M12 12v9"/></svg>`,
    mic: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>`,
    cornerDownRight: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 10 20 15 15 20"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/></svg>`,
    gitBranch: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>`,
    gitFork: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"/><path d="M12 12v3"/></svg>`,
    // Undo / rewind — used on user-bubble action row (P2-9).
    undo: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6.7 3L3 13"/></svg>`,
    // Remote Control gear section (sign in / continue remotely / sign out / how it works).
    user: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
    smartphone: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/></svg>`,
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
  let composerPreferredColumn = null;
  const SPEECH_SUMMARY_FALLBACK_MS = 12_000;
  let speechRequestId = 0;
  let pendingSpeechSummary = null;

  // ---------- helpers ----------

  function capitalize(s) {
    if (!s) return "";
    if (s === "xhigh") return "XHigh";
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // ---------- sound notifications (#59) ----------
  // Synth tones via Web Audio — no bundled assets, CSP-safe, offline. Completion
  // rises, errors fall, and the in-flight reminder is a single soft pulse. The
  // AudioContext is created only while a sound setting is on, unlocked on the
  // first user gesture (autoplay starts it "suspended"), and suspended again
  // once the last note ends — a running-but-silent context holds the OS audio
  // session and blocks sleep. The send/keypress that starts a turn is the
  // gesture, so a later completion beep can resume().
  let audioCtx = null;
  let audioUnlocked = false;
  let audioToneGen = 0;
  let audioSuspendTimer = null;
  function soundFeaturesOn() {
    return !!(state.soundNotifications || state.processingSound);
  }
  function ensureAudioCtx() {
    if (audioCtx) return audioCtx;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = AC ? new AC() : null;
    } catch (_e) { audioCtx = null; }
    return audioCtx;
  }
  function suspendAudioCtx(ctx) {
    if (!ctx || ctx.state !== "running" || typeof ctx.suspend !== "function") return;
    const pending = ctx.suspend();
    if (pending && typeof pending.catch === "function") pending.catch(() => {});
  }
  function releaseAudioIfSilent() {
    if (soundFeaturesOn()) return;
    audioToneGen += 1;
    if (audioSuspendTimer != null) {
      clearTimeout(audioSuspendTimer);
      audioSuspendTimer = null;
    }
    suspendAudioCtx(audioCtx);
  }
  function unlockAudio() {
    if (!soundFeaturesOn()) {
      releaseAudioIfSilent();
      return;
    }
    const ctx = ensureAudioCtx();
    if (!ctx || audioUnlocked) return;
    audioUnlocked = true;
    const gen = audioToneGen;
    const afterUnlock = () => {
      if (gen !== audioToneGen) return;
      suspendAudioCtx(ctx);
    };
    if (ctx.state === "suspended") {
      const pending = ctx.resume();
      if (pending && typeof pending.then === "function") pending.then(afterUnlock).catch(() => {});
      else afterUnlock();
    } else {
      afterUnlock();
    }
  }
  function playNotificationTone(kind) {
    if (!soundFeaturesOn()) return;
    const ctx = ensureAudioCtx();
    if (!ctx) return;
    // Invalidate any pending suspend so a new tone isn't cut off mid-play.
    audioToneGen += 1;
    const gen = audioToneGen;
    if (audioSuspendTimer != null) {
      clearTimeout(audioSuspendTimer);
      audioSuspendTimer = null;
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const t0 = ctx.currentTime;
    // { frequency Hz, start-offset s, duration s }
    const notes = kind === "error"
      ? [{ f: 311, s: 0, d: 0.18 }, { f: 233, s: 0.15, d: 0.26 }]
      : kind === "processing"
        ? [{ f: 440, s: 0, d: 0.16 }]
        : [{ f: 587, s: 0, d: 0.14 }, { f: 880, s: 0.13, d: 0.20 }];
    const master = ctx.createGain();
    master.gain.value = kind === "processing" ? 0.035 : 0.08;
    master.connect(ctx.destination);
    let lastStop = 0;
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
      lastStop = Math.max(lastStop, n.s + n.d + 0.03);
    }
    audioSuspendTimer = setTimeout(() => {
      audioSuspendTimer = null;
      if (gen !== audioToneGen) return;
      suspendAudioCtx(ctx);
    }, Math.ceil(lastStop * 1000) + 20);
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

  function moveComposerCaret(direction) {
    if (document.activeElement !== input) return;
    const start = input.selectionStart ?? 0;
    const end = input.selectionEnd ?? start;
    const caret = input.selectionDirection === "backward" ? start : end;
    if (direction === "forward") {
      composerPreferredColumn = null;
      const next = Math.min(input.value.length, caret + 1);
      input.setSelectionRange(next, next);
      return;
    }
    const lineStart = input.value.lastIndexOf("\n", Math.max(0, caret - 1)) + 1;
    if (composerPreferredColumn == null) composerPreferredColumn = caret - lineStart;
    if (lineStart === 0) {
      input.setSelectionRange(0, 0);
      return;
    }
    const previousEnd = lineStart - 1;
    const previousStart = input.value.lastIndexOf("\n", Math.max(0, previousEnd - 1)) + 1;
    const previousLength = previousEnd - previousStart;
    const next = previousStart + Math.min(composerPreferredColumn, previousLength);
    input.setSelectionRange(next, next);
  }
  let processingCueTimer = null;
  let liveTurnInFlight = false;
  function stopProcessingCue() {
    liveTurnInFlight = false;
    if (processingCueTimer != null) {
      clearTimeout(processingCueTimer);
      processingCueTimer = null;
    }
  }
  function scheduleProcessingCue(delay = 7000) {
    if (processingCueTimer != null) clearTimeout(processingCueTimer);
    processingCueTimer = null;
    if (!state.processingSound || !liveTurnInFlight) return;
    processingCueTimer = setTimeout(() => {
      processingCueTimer = null;
      if (!state.processingSound || !liveTurnInFlight) return;
      playNotificationTone("processing");
      scheduleProcessingCue(8000);
    }, delay);
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

  // The title carries the mode name because the label beside the glyph is the
  // first thing dropped in a narrow composer — take the id from the caller so
  // the tooltip can never name a different mode than the icon is showing.
  function modeButtonTitle(modeId) {
    const meta = MODE_META[modeId] || MODE_META.agent;
    if (state.busyLocked) return `${meta.label} — available once the session is ready`;
    if (!state.planModeAvailable) return `${meta.label} — Pick mode — ${state.planModeUnavailableReason}`;
    return `${meta.label} — Pick mode`;
  }

  function updateModeBtn(modeId) {
    const meta = MODE_META[modeId] || MODE_META.agent;
    modeBtn.innerHTML = `${meta.icon}<span class="btn-label">${escapeHtml(meta.label)}</span>`;
    modeBtn.classList.toggle("plan-active", modeId === "plan");
    modeBtn.classList.toggle("yolo-active", modeId === "yolo");
    modeBtn.title = modeButtonTitle(modeId);
  }

  newBtn.innerHTML = ICON.squarePen;
  historyBtn.innerHTML = ICON.clock;
  ensureVisibleNewSession();
  // "Continue remotely", one tap from the chat instead of buried in the gear
  // menu — the desk is where someone decides to get up and keep going on
  // their phone. Local client only (a remote is already remote), and only
  // once this machine is linked; syncRemoteButton flips it live.
  if (remoteBtn) {
    remoteBtn.innerHTML = ICON.smartphone;
    remoteBtn.onclick = () => vscode.postMessage({ type: "openRemotePortal", withHint: true });
  }
  updateSendButton(); // spinner by default — session is starting up (busy+locked)
  gearBtn.innerHTML = ICON.gear;
  addBtn.innerHTML = ICON.plus;
  scrollBottomBtn.innerHTML = `${ICON.arrowDown}<span class="scroll-bottom-label">Scroll to bottom</span>`;
  updateModeBtn("agent");

  // ---------- markdown ----------

  const { formatWaitElapsed, looksLikeFileRef, formatRelativeTime, modelPickerLabel, modelDisplayName, nextMicState, trailingSendPhrase, versionedSiblingUrl, buildQuestionAnswers, isFreeTextOptionLabel, isSubagentToolCall, subagentLabel, cleanSubagentOutput, parseSubagentTaskResult, shouldStickToBottom, stickThresholdPx, splitMath, stripUnsupportedTex, toolFailureText, isMediaGenToolCall, mediaGenZeroRetentionHint, TOOL_LABEL_MAX, middleElide, isAdvertisedSkill, getSlashQuery, applySlashPick, filterCommands, appendHighlightedText, commandProgramLabel, commandTextPreview, extractToolResultOutput, commandOutputWasCancelled, commandOutputTruncationNote, computeLineDiff, parseAttachmentContext, parseSelectionBlocks, parseImageTags, isKnownHostMessage, composerHasSendIntent, explicitVisibleChips, normalizeQueuedSends, queuedSendsText, queuedSendsChips, contextOverheadTokens, nextContextBreakdown, contextBreakdownIsCurrent, createPendingOverlay, getMentionQuery, applyMentionPick, orderPermissionOptions, defaultPermissionIndex, shouldFocusPermissionCard, isTypeThroughKey, isInterjectionText, stripInterjectionEnvelope, spokenTextFromMarkdown, isRelaySendRejection, wireFullscreenSafeReclamp, distributeSidePanelWidths, chatZoomFactor, unzoomClientPx, exportSessionMarkdown, exportSessionFilename, isExportableSessionEvent, replayedUserBubbleVerdict, truncateExportEvents, flattenHistoryMessages, splitHistoryWindow, countHistoryReplayCounters, partitionHistoryCards } = globalThis.GrokWebviewHelpers;

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

  // Published for the desktop file panel, which is injected into THIS document
  // after load and previews `.md` files. It used to carry its own ~35-line
  // subset (h1–h3, fences, bold) so bullets and tables simply did not render.
  // One renderer, one set of behaviours — and it is safe for repo content
  // because `inline()` escapes &, < and > before doing anything else, so raw
  // HTML in a README cannot become live markup.
  window.__grokRenderMarkdown = (raw) => renderMarkdown(String(raw == null ? "" : raw));

  function renderMarkdown(raw) {
    // Normalise line endings FIRST. Everything below splits on a newline and
    // then tests each line with $-anchored patterns -- and a carriage return
    // is a line terminator in JS regex, so `.` cannot match one. On a CRLF
    // file every $-anchored rule therefore failed at the final character:
    // headings kept their hashes and bullets kept their dashes, falling
    // through to the paragraph path, while tables, links and bold (not
    // $-anchored) carried on working. That combination is what made it look
    // like the renderer was mostly fine.
    //
    // Surfaced in the desktop file panel because it renders whole files off
    // disk and most files on Windows are CRLF -- but it was never panel-only.
    raw = String(raw == null ? "" : raw).replace(/\r\n?/g, "\n");
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
      // A code span and a link's href are LITERAL — nothing inside either is
      // markdown. Both are pulled out to placeholders before the link and
      // emphasis passes run, exactly as fenced blocks and math are pulled out
      // of the document above, and restored at the end.
      //
      // Without this the passes run over their own output: `1*2` and `3*4`
      // renders as one <em> spanning from the first code span to the second,
      // because by then the asterisks are just characters in a string and the
      // <code> tags mean nothing to a regex (#143). Same shape reaches a URL
      // containing `*`, and a [link](x) written inside backticks.
      //
      // Link TEXT is deliberately left live: [**bold**](url) is valid markdown
      // and worked before, so only the href is held.
      const held = [];
      const hold = (html) => `\x00C${held.push(html) - 1}\x00`;
      return t
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/`([^`\n]+)`/g, (_, code) => {
          if (looksLikeFileRef(code)) {
            const safe = code.replace(/"/g, "&quot;");
            return hold(`<a href="${safe}" class="file-ref-link"><code>${code}</code></a>`);
          }
          return hold(`<code>${code}</code>`);
        })
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => {
          const safe = url.replace(/"/g, "&quot;");
          return `<a href="${hold(safe)}">${text}</a>`;
        })
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
        .replace(/\x00C(\d+)\x00/g, (_, i) => held[+i]);
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
    // The control-plane meter is independent of model prompts and is TTL-gated
    // by the host. Render the cached snapshot immediately, then re-render when
    // a fresh structured response arrives.
    vscode.postMessage({ type: "refreshContextDetails" });
    renderContextPopover();
  }

  function renderContextPopover() {
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
    // Grok's fixed-point billing unit is 10^10 ticks per USD (xAI's published
    // UsageTotals contract). Keep the divisor explicit; it is not cents/micros.
    const usdTicks = (ticks) => {
      const usd = Number(ticks) / 10_000_000_000;
      if (usd > 0 && usd < 0.000001) return "<$0.000001";
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 6,
      }).format(usd);
    };

    const used = state.usedTokens || 0;
    const pct = Math.min(100, Math.round((used / state.contextWindow) * 100));
    info(
      "Context used",
      `${tok(used)} / ${tok(state.contextWindow)} (${pct}%)`,
    );

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

    // KNOWLEDGE WORK STOPS HERE: the number and the action on it, nothing else.
    //
    // Everything below is the technical account — system prompt, reasoning
    // overhead, tool definitions, per-turn token and cost rows. That is the
    // same class of thing knowledge work already hides everywhere else; the
    // gear describes the mode as "Hides worktrees, thinking traces, and tool
    // details", and this popover was simply missed when that rule was applied.
    // Somebody writing a document does not need to know how many tokens the
    // tool definitions cost, and "Context used 12,400 / 128,000 (10%)" plus a
    // way to compact is the whole of what the donut is being asked.
    //
    // The two lines that make the popover VISIBLE are the last thing this
    // function does, so returning early skipped them and the donut simply did
    // nothing in the default mode. Found by review; my own test read
    // textContent off the hidden element and passed, which is the same mistake
    // as proving a package exists instead of proving the thing works.
    if (!isCodingPurpose()) { showContextPopover(); return; }

    // Snapshot addends are internally consistent (overhead from snapshot.used).
    // Occupancy that has moved does not hide the group: an open popover
    // re-fetches session/info so header and rows become current together.
    const breakdown = state.contextBreakdown;
    const hasBreakdown = breakdown && (
      breakdown.systemPromptTokens != null ||
      breakdown.toolDefinitionsTokens != null ||
      breakdown.messageTokens != null ||
      breakdown.freeTokens != null ||
      (breakdown.categories && breakdown.categories.length)
    );
    if (hasBreakdown) {
      // Same split as the CLI TUI: legend rows fill the bar; informational
      // rows sit below it because their tokens are already in those addends
      // (tool definitions in Reasoning/overhead, usage categories in Messages).
      // Overhead is derived from THIS snapshot's used, never live occupancy.
      const overheadTokens = contextOverheadTokens(
        breakdown.used,
        breakdown.systemPromptTokens,
        breakdown.messageTokens,
      );
      section("In this window");
      if (breakdown.systemPromptTokens != null) info("System", tok(breakdown.systemPromptTokens));
      if (breakdown.messageTokens != null) info("Messages", tok(breakdown.messageTokens));
      if (overheadTokens != null) info("Reasoning/overhead", tok(overheadTokens));
      if (breakdown.freeTokens != null) info("Free", tok(breakdown.freeTokens));
      if (breakdown.autoCompactPct != null) info("Auto-compact at", `${breakdown.autoCompactPct}%`);
      const hasCounted =
        breakdown.toolDefinitionsTokens != null ||
        (breakdown.categories && breakdown.categories.length);
      if (hasCounted) {
        section("Already counted above");
        if (breakdown.toolDefinitionsTokens != null) {
          const n = breakdown.toolDefinitionsCount;
          const toolsLabel = typeof n === "number"
            ? `Tool definitions (${n} ${n === 1 ? "tool" : "tools"})`
            : "Tool definitions";
          info(toolsLabel, tok(breakdown.toolDefinitionsTokens));
        }
        if (breakdown.categories) {
          for (const category of breakdown.categories) {
            info(category.detail ? `${category.label} (${category.detail})` : category.label, tok(category.tokens));
          }
        }
      }
    }

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
      row(sess, "↳ cache write", "cachedWriteTokens");
      row(sess, "Output", "outputTokens");
      row(sess, "Cost", "costUsdTicks", usdTicks);
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
      row(turn, "↳ cache write", "cachedWriteTokens", null, body);
      row(turn, "Output", "outputTokens", null, body);
      row(turn, "↳ reasoning", "reasoningTokens", null, body);
      row(turn, "Cost", "costUsdTicks", usdTicks, body);
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
      ? "Context is how full the window is. Token counts are billed usage tracked here — each model call re-sends the conversation, so a turn bills far more than the context it holds."
      : "Counted by the CLI at the end of each turn.";
    contextPopover.appendChild(fine);

    showContextPopover();
  }

  /** Size it to its content, then reveal it. Both halves, always — see the
   * knowledge-work return above for what happens when only some of it runs. */
  function showContextPopover() {
    positionPopover(contextPopover, donutEl);
    contextPopover.hidden = false;
  }

  function positionPopover(popover, btn) {
    // getBoundingClientRect is visual px; style offsets under body `zoom` are
    // layout px — unzoomClientPx converts (zoom 1 is a no-op).
    const z = chatZoomFactor();
    const composerRect = popover.parentElement.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    popover.style.top = "auto";
    popover.style.bottom = (unzoomClientPx(composerRect.bottom - btnRect.top, z) + 4) + "px";
    popover.style.left = unzoomClientPx(btnRect.left - composerRect.left, z) + "px";
    popover.style.right = "auto";
    requestAnimationFrame(() => {
      const pw = unzoomClientPx(popover.getBoundingClientRect().width, z);
      const leftOffset = unzoomClientPx(btnRect.left - composerRect.left, z);
      const parentW = unzoomClientPx(composerRect.width, z);
      if (leftOffset + pw > parentW) {
        popover.style.left = Math.max(0, parentW - pw) + "px";
      }
    });
  }

  function positionDropdownPopover(popover, btn) {
    const z = chatZoomFactor();
    const parentRect = popover.parentElement.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    const EDGE = 6; // gap kept from the panel's right edge (and minimum gap on the left)
    popover.style.bottom = "auto";
    popover.style.top = (unzoomClientPx(btnRect.bottom - parentRect.top, z) + 4) + "px";
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
    const available = Math.max(0, unzoomClientPx(parentRect.width, z) - EDGE * 2);
    popover.style.maxWidth = Math.min(360, available) + "px";
    popover.style.minWidth = Math.min(280, available) + "px";
  }

  function positionRepoPopover() {
    const z = chatZoomFactor();
    const parentRect = repoPopover.parentElement.getBoundingClientRect();
    const btnRect = repoBtn.getBoundingClientRect();
    const EDGE = 6;
    const parentW = unzoomClientPx(parentRect.width, z);
    const available = Math.max(0, parentW - EDGE * 2);
    const maxWidth = Math.min(360, available);
    const chipLeft = unzoomClientPx(btnRect.left - parentRect.left, z);
    const left = Math.min(
      Math.max(EDGE, chipLeft),
      Math.max(EDGE, parentW - EDGE - maxWidth),
    );
    repoPopover.style.bottom = "auto";
    repoPopover.style.top = (unzoomClientPx(btnRect.bottom - parentRect.top, z) + 4) + "px";
    repoPopover.style.left = left + "px";
    repoPopover.style.right = "auto";
    repoPopover.style.maxWidth = maxWidth + "px";
    repoPopover.style.minWidth = Math.min(280, available) + "px";
  }

  // ---------- gear popover ----------

  /** Coding purpose unlocks worktrees, thinking traces, and tool-detail toggles. */
  function isCodingPurpose() {
    return state.appPurpose === "coding";
  }

  /** Knowledge work always hides traces; Coding honours the user toggle. */
  function effectiveShowThinking() {
    return isCodingPurpose() && !!state.showThinking;
  }

  /** Knowledge work never pre-expands tool details; Coding honours the toggle. */
  function effectiveExpandCommandOutputs() {
    return isCodingPurpose() && !!state.expandCommandOutputs;
  }

  function setAppPurpose(value) {
    const next = value === "coding" ? "coding" : "knowledge";
    if (state.appPurpose === next) return;
    state.appPurpose = next;
    vscode.postMessage({ type: "setAppPurpose", value: next });
    applyThinkingVisibility();
    applyExpandCommandOutputs();
    if (!gearPopover.hidden && state.gearView === "main") renderGearMain();
    syncGearPlacement();
  }

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

  // Promise<boolean> confirm dialog rendered in-page (chat.css .confirm-*).
  // Replaces the host's native modals for chat-triggered destructive actions,
  // so they confirm identically on desktop and in the browser client — where a
  // host-side modal would stall invisibly on the desk's screen.
  function uiChoice(opts) {
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
      const done = (v) => {
        document.removeEventListener("keydown", onKey, true);
        overlay.remove();
        resolve(opts.booleanResult ? v === "confirm" : v);
      };
      const onKey = (e) => {
        if (e.key === "Escape") { e.stopPropagation(); done("cancel"); }
      };
      document.addEventListener("keydown", onKey, true);
      cancelBtn.onclick = (e) => { e.stopPropagation(); done("cancel"); };
      // A click on the backdrop (not the panel) cancels, same as Escape.
      overlay.onclick = (e) => { if (e.target === overlay) { e.stopPropagation(); done("cancel"); } };
      actions.appendChild(cancelBtn);
      const choices = Array.isArray(opts.actions) && opts.actions.length
        ? opts.actions
        : [{ id: "confirm", label: opts.confirmLabel || "OK", danger: !!opts.danger }];
      let focusButton = cancelBtn;
      for (const choice of choices) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "confirm-btn " + (choice.danger ? "confirm-danger" : "confirm-primary");
        button.textContent = choice.label;
        button.onclick = (e) => { e.stopPropagation(); done(choice.id); };
        actions.appendChild(button);
        focusButton = button;
      }
      panel.appendChild(actions);
      overlay.appendChild(panel);
      document.body.appendChild(overlay);
      focusButton.focus();
    });
  }

  function uiConfirm(opts) {
    // Resolve the original promise as a boolean instead of adding a second
    // `.then()` hop. Existing host confirm round-trips intentionally settle one
    // microtask after the click; file-panel callers use uiChoice's action ids.
    return uiChoice({ ...opts, booleanResult: true });
  }

  // In-app preview overlay. OPT-IN via capabilities.previewInApp (desktop).
  // Absent / remote / VS Code keep the host editor or inline-expand path.
  function hostPreviewsInApp() {
    return !IS_REMOTE && state.hostCaps && state.hostCaps.previewInApp === true;
  }

  const PREVIEW_EXT_BY_LANG = {
    powershell: ".ps1",
    shellscript: ".sh",
    bat: ".bat",
    cmd: ".cmd",
    javascript: ".js",
    typescript: ".ts",
    python: ".py",
    json: ".json",
    markdown: ".md",
    diff: ".diff",
    rust: ".rs",
    go: ".go",
    java: ".java",
    css: ".css",
    html: ".html",
    xml: ".xml",
  };

  function previewBasename(pathStr) {
    const raw = String(pathStr || "").replace(/\\/g, "/");
    const slash = raw.lastIndexOf("/");
    return slash >= 0 ? raw.slice(slash + 1) : raw;
  }

  function previewFilename(opts) {
    if (opts.filename) return previewBasename(opts.filename);
    if (opts.path) {
      const base = previewBasename(opts.path);
      if (opts.kind === "diff") return /\.diff$/i.test(base) ? base : base + ".diff";
      return base;
    }
    const ext = PREVIEW_EXT_BY_LANG[opts.language] || ".txt";
    return "Untitled" + ext;
  }

  function previewTitle(opts) {
    if (opts.path) return previewBasename(opts.path);
    if (opts.filename) return previewBasename(opts.filename);
    return opts.language ? `Untitled (${opts.language})` : "Untitled";
  }

  function previewLanguage(opts) {
    if (opts.language) return opts.language;
    const api = globalThis.GrokSyntaxHighlight;
    if (opts.path && api && typeof api.languageForPath === "function") {
      return api.languageForPath(opts.path) || "";
    }
    return "";
  }

  // Same `#Lstart-Lend` suffix parseFileRef accepts, kept local because the
  // webview cannot import src/file-ref.ts. Anchored at the end so a `#` earlier
  // in the path (C#/F# folders) stays in the path.
  function previewFileRef(raw) {
    const s = String(raw || "").trim();
    if (!s) return { path: "", range: null };
    const frag = s.match(/^(.*?)#L(\d+)(?:-L?(\d+))?$/i);
    if (!frag) return { path: s, range: null };
    const start = Number(frag[2]);
    const end = frag[3] ? Number(frag[3]) : start;
    return { path: frag[1], range: { start, end } };
  }

  // Workspace-relative path the file panel / readProjectFile will accept, or
  // "" when the path is out of cwd scope (~/Downloads, another drive, …).
  function workspaceRelPath(pathStr) {
    const raw = String(pathStr || "").replace(/\\/g, "/").trim();
    if (!raw || raw === "." || raw === "./") return "";
    if (raw === "~" || raw.startsWith("~/")) return "";
    const cwd = String(state.cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");
    const isAbs = raw.startsWith("/") || /^[A-Za-z]:\//.test(raw);
    if (!isAbs) return raw.replace(/^\.\//, "");
    if (!cwd) return "";
    const fold = /^[A-Za-z]:\//.test(cwd);
    const a = fold ? raw.toLowerCase() : raw;
    const c = fold ? cwd.toLowerCase() : cwd;
    if (a === c) return "";
    if (a.startsWith(c + "/")) return raw.slice(cwd.length).replace(/^\//, "");
    return "";
  }

  // One formula for every `.tdl` gutter: 4ch through 999, then digits+1.
  function tdlGutterCh(widest) {
    return Math.max(4, String(widest).length + 1) + "ch";
  }

  function previewFilePanelController() {
    if (!hostPreviewsInApp()) return null;
    const desk = window.__grokDeskFilePanel;
    if (desk && typeof desk.openPath === "function") return desk;
    const remote = state.filesBrowse && state.filesBrowse.component;
    if (remote && typeof remote.openPath === "function") return remote;
    return null;
  }

  let previewFileSeq = 0;
  let previewOverlayGen = 0;
  const previewFilePending = new Map();

  function fetchPreviewFile(relPath) {
    const cwd = state.cwd || "";
    if (!cwd || !relPath) return Promise.resolve({ ok: false, reason: "no path" });
    return new Promise((resolve) => {
      const requestId = "preview-" + (++previewFileSeq);
      const timer = setTimeout(() => {
        if (!previewFilePending.has(requestId)) return;
        previewFilePending.delete(requestId);
        resolve({ ok: false, reason: "timed out" });
      }, 15000);
      previewFilePending.set(requestId, { resolve, timer });
      vscode.postMessage({ type: "readProjectFile", cwd, relPath, requestId });
    });
  }

  function settlePreviewFileRequest(msg) {
    if (!msg || typeof msg.requestId !== "string") return false;
    const pending = previewFilePending.get(msg.requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    previewFilePending.delete(msg.requestId);
    pending.resolve(msg);
    return true;
  }

  // The host serves text files up to FILE_PREVIEW_MAX_BYTES (2 MiB), and a
  // 2 MiB file of one-character lines is a million rows — four DOM nodes each,
  // built synchronously on the UI thread. Rendering all of it would wedge the
  // renderer for a file the host considers perfectly ordinary. So a window is
  // rendered around the range the agent read, which is the only part anyone
  // opened this to see; the count says what was left out, because a silently
  // truncated file is the same lie as a silently substituted one.
  const PREVIEW_MAX_LINES = 4000;
  const PREVIEW_CONTEXT_LINES = 400;

  function previewLineWindow(total, range) {
    if (total <= PREVIEW_MAX_LINES) return { from: 1, to: total, clipped: false };
    const start = Math.min(Math.max(1, (range && range.start) || 1), total);
    const end = Math.min(Math.max(start, (range && range.end) || start), total);
    const span = end - start + 1;

    // The lines the agent READ are never trimmed to make room for context —
    // context is the thing that gives way. An earlier version computed a budget
    // that grew with the span and then clamped it straight back to the cap, so
    // a 4000-line read starting at 5000 rendered 4600-8599 and silently
    // dropped 400 lines the user had asked to see.
    if (span >= PREVIEW_MAX_LINES) {
      const to = Math.min(total, start + PREVIEW_MAX_LINES - 1);
      return { from: start, to, clipped: start > 1 || to < total };
    }

    // Spend whatever is left on context, split either side, and give the unused
    // half to the other when the range sits near a file boundary.
    const slack = PREVIEW_MAX_LINES - span;
    const before = Math.min(Math.floor(slack / 2), start - 1);
    const from = Math.max(1, start - before);
    const to = Math.min(total, from + PREVIEW_MAX_LINES - 1);
    return { from, to, clipped: from > 1 || to < total };
  }

  function buildNumberedFilePreview(text, language, pathStr, range) {
    const wrap = document.createElement("div");
    wrap.className = "tool-diff-region preview-file-region";
    const lines = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    const start = range && range.start;
    const end = range && range.end;
    const win = previewLineWindow(lines.length, range);
    let firstRead = null;
    for (let i = win.from - 1; i < win.to; i++) {
      const n = i + 1;
      const inRange = start != null && end != null && n >= start && n <= end;
      const row = document.createElement("div");
      row.className = "tdl" + (inRange ? " tdl-read" : "");
      row.dataset.line = String(n);
      const sign = document.createElement("span");
      sign.className = "tdl-sign";
      sign.textContent = "";
      const num = document.createElement("span");
      num.className = "tdl-num";
      num.textContent = String(n);
      const code = document.createElement("span");
      code.className = "tdl-code";
      const line = lines[i];
      if (line === "") code.textContent = " ";
      else code.innerHTML = highlightPreviewHtml(line, language, pathStr);
      row.appendChild(sign);
      row.appendChild(num);
      row.appendChild(code);
      if (inRange && !firstRead) {
        row.id = "preview-read-start";
        firstRead = row;
      }
      wrap.appendChild(row);
    }
    wrap.style.setProperty("--tdl-num-w", tdlGutterCh(win.to));
    wrap._firstRead = firstRead;
    wrap._window = win;
    wrap._totalLines = lines.length;
    return wrap;
  }

  function highlightPreviewHtml(text, language, pathStr) {
    const api = globalThis.GrokSyntaxHighlight;
    if (!api || typeof api.highlightCode !== "function") return escapeHtml(text);
    const fromId = typeof api.languageForId === "function" ? api.languageForId(language || "") : "";
    const fromPath = pathStr && typeof api.languageForPath === "function" ? api.languageForPath(pathStr) : "";
    return api.highlightCode(text, fromId || fromPath || "");
  }

  function unifiedDiffText(diff) {
    const sites = (diff.sites && diff.sites.length)
      ? diff.sites
      : [{ oldText: diff.oldText || "", newText: diff.newText || "" }];
    const parts = [];
    if (diff.path) {
      parts.push("--- " + diff.path, "+++ " + diff.path);
    }
    for (const site of sites) {
      const result = computeLineDiff(site.oldText, site.newText);
      for (const ln of result.lines) {
        const mark = ln.type === "add" ? "+" : ln.type === "del" ? "-" : " ";
        parts.push(mark + ln.text);
      }
    }
    return parts.join("\n");
  }

  function closePreviewOverlay() {
    const existing = document.getElementById("preview-overlay");
    if (!existing) return;
    if (existing._onKey) document.removeEventListener("keydown", existing._onKey, true);
    existing._closed = true;
    existing.remove();
  }

  function insertPreviewPanelButton(actions, saveBtn, relPath) {
    if (!hostPreviewsInApp() || !relPath) return null;
    const controller = previewFilePanelController();
    if (!controller) return null;
    if (actions.querySelector(".preview-open-panel")) return actions.querySelector(".preview-open-panel");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "preview-action-btn preview-open-panel";
    btn.textContent = "Open in file panel";
    btn.onclick = (e) => {
      e.stopPropagation();
      closePreviewOverlay();
      controller.openPath(relPath);
    };
    actions.insertBefore(btn, saveBtn);
    return btn;
  }

  function renderPreviewExcerpt(body, text, language, pathStr) {
    const pre = document.createElement("pre");
    pre.className = "preview-code";
    const code = document.createElement("code");
    code.innerHTML = highlightPreviewHtml(String(text ?? ""), language, pathStr);
    pre.appendChild(code);
    body.appendChild(pre);
  }

  function clearPreviewBody(body) {
    while (body.firstChild) body.removeChild(body.firstChild);
  }

  function renderPreviewFallback(body, excerpt, language, pathStr, reason) {
    clearPreviewBody(body);
    const notice = document.createElement("div");
    notice.className = "preview-notice";
    notice.textContent = reason;
    body.appendChild(notice);
    renderPreviewExcerpt(body, excerpt, language, pathStr);
  }

  function openPreviewOverlay(opts) {
    closePreviewOverlay();
    const payload = { text: opts.kind === "diff" ? unifiedDiffText(opts) : String(opts.content ?? "") };
    const filename = previewFilename(opts);
    const language = opts.kind === "diff" ? (opts.language || "diff") : previewLanguage(opts);
    const excerpt = String(opts.content ?? "");
    const relPath = workspaceRelPath(opts.path || "");

    const overlay = document.createElement("div");
    overlay.id = "preview-overlay";
    overlay.className = "preview-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");

    const panel = document.createElement("div");
    panel.className = "preview-panel";

    const header = document.createElement("div");
    header.className = "preview-header";
    const title = document.createElement("div");
    title.className = "preview-title";
    title.id = "preview-overlay-title";
    title.textContent = previewTitle(opts);
    overlay.setAttribute("aria-labelledby", "preview-overlay-title");
    header.appendChild(title);
    if (language) {
      const lang = document.createElement("div");
      lang.className = "preview-lang";
      lang.textContent = language;
      header.appendChild(lang);
    }
    const actions = document.createElement("div");
    actions.className = "preview-actions";
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "preview-action-btn";
    copyBtn.textContent = "Copy";
    copyBtn.onclick = (e) => {
      e.stopPropagation();
      if (!navigator.clipboard || !navigator.clipboard.writeText) return;
      navigator.clipboard.writeText(payload.text).then(() => {
        copyBtn.textContent = "Copied";
        setTimeout(() => { if (copyBtn.isConnected) copyBtn.textContent = "Copy"; }, 1200);
      });
    };
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "preview-action-btn";
    saveBtn.textContent = "Save As";
    saveBtn.onclick = (e) => {
      e.stopPropagation();
      const message = { type: "openText", content: payload.text, filename };
      if (language) message.language = language;
      vscode.postMessage(message);
    };
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "preview-action-btn preview-close-btn";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.innerHTML = ICON.x;
    closeBtn.onclick = (e) => { e.stopPropagation(); closePreviewOverlay(); };
    actions.appendChild(copyBtn);
    actions.appendChild(saveBtn);
    actions.appendChild(closeBtn);
    header.appendChild(actions);
    panel.appendChild(header);

    const body = document.createElement("div");
    body.className = "preview-body";
    if (opts.kind === "diff") {
      const sites = (opts.sites && opts.sites.length)
        ? opts.sites
        : [{ oldText: opts.oldText || "", newText: opts.newText || "" }];
      const hunks = sites.map((site) => ({
        site,
        result: computeLineDiff(site.oldText, site.newText),
      }));
      body.appendChild(buildInlineDiffRegion(hunks, { full: true }));
      insertPreviewPanelButton(actions, saveBtn, relPath);
    } else if (!opts.path) {
      renderPreviewExcerpt(body, excerpt, language, opts.path);
    } else if (!relPath) {
      renderPreviewFallback(
        body,
        excerpt,
        language,
        opts.path,
        "This file is outside the project, so only the excerpt the agent read is shown.",
      );
    } else {
      const notice = document.createElement("div");
      notice.className = "preview-notice";
      notice.textContent = "Loading file…";
      body.appendChild(notice);
      const token = ++previewOverlayGen;
      overlay._previewToken = token;
      fetchPreviewFile(relPath).then((result) => {
        if (overlay._closed || overlay._previewToken !== token) return;
        // `readProjectFile` PRETTY-PRINTS JSON (file-tree.ts: JSON.stringify of
        // the parsed value). That is right for the file panel, which edits and
        // writes it back, and wrong here: the numbers in our gutter would count
        // reformatted lines, and the highlighted range would mark the wrong
        // ones. A one-line `{"n":1e3}` becomes three lines reading `"n": 1000`.
        // The host tells us when it did this, so take the honest path instead
        // of numbering a file the user does not have.
        if (result && result.ok && result.reformatted) {
          clearPreviewBody(body);
          renderPreviewFallback(
            body,
            excerpt,
            language,
            opts.path,
            "This JSON file is reformatted when loaded, so line numbers would not match the file on disk — showing the excerpt the agent read.",
          );
        } else if (result && result.ok && typeof result.text === "string") {
          payload.text = result.text;
          clearPreviewBody(body);
          // The band marks the line numbers the agent asked for. That is a
          // POSITIONAL reference, exactly what an editor host does when it
          // opens the file at those lines, and it stays true whether or not the
          // file has moved on since.
          //
          // A guard that tried to verify the content still matched was removed
          // rather than tuned: the excerpt is the CLI's rendered transcript,
          // not the file's bytes. A ranged read arrives decorated —
          // `... 2219 lines not shown ...` and `  2220|  }` — so comparing it
          // against raw file lines never matched, and the guard fired on every
          // ordinary ranged read, stripped the markers, and announced a change
          // that had not happened. Parsing those decorations would mean
          // tracking a format that differs per CLI, to defend against a
          // staleness the editor host has always had and nobody minds.
          const region = buildNumberedFilePreview(result.text, language, opts.path, opts.range);
          body.appendChild(region);
          if (region._window && region._window.clipped) {
            const clip = document.createElement("div");
            clip.className = "preview-notice";
            clip.textContent =
              `Showing lines ${region._window.from}–${region._window.to} of ${region._totalLines} — the file is too long to render in full.`;
            body.insertBefore(clip, region);
          }
          insertPreviewPanelButton(actions, saveBtn, relPath);
          const startEl = region._firstRead;
          if (startEl && typeof startEl.scrollIntoView === "function") {
            startEl.scrollIntoView({ block: "center", inline: "nearest" });
          }
        } else {
          renderPreviewFallback(
            body,
            excerpt,
            language,
            opts.path,
            "Couldn't load the full file — showing the excerpt the agent read.",
          );
        }
      });
    }
    panel.appendChild(body);
    overlay.appendChild(panel);

    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        closePreviewOverlay();
      }
    };
    overlay._onKey = onKey;
    document.addEventListener("keydown", onKey, true);
    overlay.onclick = (e) => {
      if (e.target === overlay) {
        e.stopPropagation();
        closePreviewOverlay();
      }
    };
    document.body.appendChild(overlay);
    closeBtn.focus();
  }

  // Shared settings surface (media/settings.js). Desktop + remote open it as a
  // full-window overlay; VS Code posts openSettingsSurface for an editor tab.
  let settingsSurface = null;

  function hostOpensSettingsEditor() {
    return !IS_REMOTE && state.hostCaps && state.hostCaps.settingsEditor === true;
  }

  function settingsEnv() {
    return {
      isRemote: IS_REMOTE,
      isDesktop: isDesktopHostCaps(),
      deviceLogin: state.deviceLoginByProvider,
      clientOwnsFontScale: CLIENT_OWNS_FONT_SCALE,
      ttsAvailable,
      steerSupported: state.steerSupported !== false,
      providersKnown: !!state.providersKnown,
      remoteLinked: state.remoteLinked,
      hostCaps: state.hostCaps || {},
    };
  }

  function settingsSnapshot() {
    return {
      appPurpose: state.appPurpose === "coding" ? "coding" : "knowledge",
      showThinking: !!state.showThinking,
      expandCommandOutputs: !!state.expandCommandOutputs,
      steerByDefault: !!state.steerByDefault,
      fontScale: CLIENT_OWNS_FONT_SCALE ? state.remoteFontScale : state.hostFontScale,
      soundNotifications: !!state.soundNotifications,
      processingSound: !!state.processingSound,
      readRepliesAloud: IS_REMOTE ? !!state.remoteTts : !!state.readRepliesAloud,
      summarizeRepliesAloud: IS_REMOTE ? !!state.remoteSummarizeRepliesAloud : !!state.summarizeRepliesAloud,
      voiceConfigured: !!state.voiceConfigured,
      voiceSendPhrase: typeof state.voiceSendPhrase === "string" ? state.voiceSendPhrase : "grok send",
      voiceKeyterms: Array.isArray(state.voiceKeyterms) ? state.voiceKeyterms : [],
      telemetryEnabled: state.telemetryEnabled,
      thumbsFeedback: !!state.thumbsFeedback,
      providers: state.providers || [],
      providersChecking: !!state.providersChecking,
      githubState: state.githubState || undefined,
      extVersion: state.extVersion,
      cliVersion: state.cliVersion,
      hostKind: state.hostKind,
      hostName: state.hostName,
      grokUpdate: state.grokUpdate,
      mcpServers: state.mcpServers,
      mcpLoading: state.mcpLoading,
      mcpError: state.mcpError,
      mcpWarning: state.mcpWarning,
      mcpConnectors: state.mcpConnectors,
      mcpRemoteConnect: state.mcpRemoteConnect === true,
      mcpConnectorAuthorization: state.mcpConnectorAuthorization,
      routines: state.routines,
      routineProjects: state.routineProjects,
      routineModels: state.routineModels,
      routineError: state.routineError,
      routineErrorId: state.routineErrorId,
    };
  }

  function applySettingsChange(id, value, message) {
    switch (id) {
      case "appPurpose":
        state.appPurpose = value === "coding" ? "coding" : "knowledge";
        applyThinkingVisibility();
        applyExpandCommandOutputs();
        break;
      case "showThinking":
        state.showThinking = !!value;
        applyThinkingVisibility();
        break;
      case "expandCommandOutputs":
        state.expandCommandOutputs = !!value;
        state.toolExpandOverride = null;
        applyExpandCommandOutputs();
        break;
      case "steerByDefault":
        state.steerByDefault = !!value;
        break;
      case "chatFontScale":
        if (CLIENT_OWNS_FONT_SCALE) setClientFontScale(Number(value) / 100);
        return;
      case "readRepliesAloud":
        if (IS_REMOTE) {
          setRemoteTtsEnabled(!!value);
          return;
        }
        state.readRepliesAloud = !!value;
        if (!state.readRepliesAloud) {
          cancelPendingSpeech();
          if (state.summarizeRepliesAloud) {
            state.summarizeRepliesAloud = false;
            vscode.postMessage({ type: "setSummarizeRepliesAloud", value: false });
          }
        }
        break;
      case "summarizeRepliesAloud":
        if (IS_REMOTE) {
          setRemoteTtsSummaryEnabled(!!value);
          return;
        }
        state.summarizeRepliesAloud = !!value;
        invalidatePendingSpeechSummary();
        break;
      case "soundNotifications":
        state.soundNotifications = !!value;
        unlockAudio();
        break;
      case "processingSound":
        state.processingSound = !!value;
        unlockAudio();
        if (state.processingSound) {
          if (liveTurnInFlight) scheduleProcessingCue();
        } else if (processingCueTimer != null) {
          clearTimeout(processingCueTimer);
          processingCueTimer = null;
        }
        break;
      case "voiceSendPhrase":
        state.voiceSendPhrase = String(value ?? "");
        renderInputHighlight();
        break;
      case "voiceKeyterms":
        state.voiceKeyterms = Array.isArray(value) ? value.slice() : [];
        break;
      case "telemetryDesktop":
        state.telemetryEnabled = !!value;
        break;
      case "thumbsFeedback":
        state.thumbsFeedback = !!value;
        break;
      default:
        break;
    }
    if (message) vscode.postMessage(message);
  }

  let settingsOpener = null;

  function closeSettingsOverlay() {
    if (settingsSurface && settingsSurface.dispose) settingsSurface.dispose();
    settingsSurface = null;
    const existing = document.getElementById("settings-overlay");
    if (existing) existing.remove();
    const opener = settingsOpener;
    settingsOpener = null;
    if (opener && typeof opener.focus === "function" && document.contains(opener)) {
      try { opener.focus(); } catch { /* */ }
    }
  }

  function refreshSettingsOverlay() {
    if (!settingsSurface || !settingsSurface.update) return;
    settingsSurface.update(settingsSnapshot(), settingsEnv());
  }

  function resolveSettingsOpener(el) {
    if (el && typeof el.closest === "function" && el.closest("#gear-popover")) {
      return document.getElementById("gear-btn");
    }
    if (el && el !== document.body && document.contains(el)) return el;
    return document.getElementById("gear-btn");
  }

  function openSettingsOverlay(opener, opts) {
    const api = window.GrokSettings;
    if (!api || typeof api.mount !== "function") return;
    closeSettingsOverlay();
    closePopovers();
    settingsOpener = resolveSettingsOpener(opener || document.activeElement);
    const overlay = document.createElement("div");
    overlay.id = "settings-overlay";
    overlay.className = "settings-overlay";
    document.body.appendChild(overlay);
    settingsSurface = api.mount(overlay, {
      snapshot: settingsSnapshot(),
      env: settingsEnv(),
      category: opts && opts.category,
      post: (msg) => {
        // A refused save never reaches the host, so the host never answers and
        // the Routines page would sit there looking like the button did
        // nothing. Remember that one is outstanding; the relay's refusal below
        // is its answer.
        if (msg && msg.type === "saveRoutine") state.routineSavePending = true;
        vscode.postMessage(msg);
      },
      apply: applySettingsChange,
      onLocal: (name) => {
        if (name === "explainRemote") showRemoteExplainer();
        if (name === "openDeviceManager") window.open("/", "_blank", "noopener");
        // Settings → Providers → Connect. The overlay stays open behind the
        // wizard so closing it returns the reader where they were.
        if (typeof name === "string" && name.indexOf("connectWizard:") === 0) {
          openConnectWizard(name.slice("connectWizard:".length));
        }
      },
      closeOnAction: true,
      onClose: closeSettingsOverlay,
    });
    settingsSurface.focusSearch();
  }

  function openAllSettings() {
    openSettingsCategory();
  }

  function openSettingsCategory(category) {
    const opener = appSettingsButton() || document.getElementById("gear-btn") || document.activeElement;
    closePopovers();
    if (hostOpensSettingsEditor()) {
      const message = { type: "openSettingsSurface" };
      if (category) message.category = category;
      vscode.postMessage(message);
      return;
    }
    openSettingsOverlay(opener, category ? { category } : undefined);
  }

  // Public UI service consumed by media/file-panel.js in both renderer hosts.
  window.__grokFilePanelConfirm = uiChoice;

  /** uiConfirm with a single text field. Resolves to the string, or null on
   *  cancel — an empty string is a real answer the caller may want to reject on
   *  its own terms, so it is never conflated with "dismissed". */
  function uiPrompt(opts) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "confirm-overlay";
      const panel = document.createElement("div");
      panel.className = "confirm-panel";
      const title = document.createElement("div");
      title.className = "confirm-title";
      title.textContent = opts.title;
      panel.appendChild(title);

      const field = document.createElement("input");
      field.type = "text";
      field.className = "confirm-input";
      field.value = opts.value || "";
      if (opts.placeholder) field.placeholder = opts.placeholder;
      panel.appendChild(field);

      const actions = document.createElement("div");
      actions.className = "confirm-actions";
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "confirm-btn";
      cancelBtn.textContent = "Cancel";
      const okBtn = document.createElement("button");
      okBtn.type = "button";
      okBtn.className = "confirm-btn confirm-primary";
      okBtn.textContent = opts.confirmLabel || "OK";
      const done = (v) => {
        document.removeEventListener("keydown", onKey, true);
        overlay.remove();
        resolve(v);
      };
      const onKey = (e) => {
        if (e.key === "Escape") { e.stopPropagation(); done(null); }
      };
      document.addEventListener("keydown", onKey, true);
      field.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); done(field.value); }
        if (e.key === "Escape") done(null);
      };
      cancelBtn.onclick = (e) => { e.stopPropagation(); done(null); };
      okBtn.onclick = (e) => { e.stopPropagation(); done(field.value); };
      overlay.onclick = (e) => { if (e.target === overlay) { e.stopPropagation(); done(null); } };
      actions.appendChild(cancelBtn);
      actions.appendChild(okBtn);
      panel.appendChild(actions);
      overlay.appendChild(panel);
      document.body.appendChild(overlay);
      field.focus();
      field.select();
    });
  }

  function showRemoteExplainer() {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay remote-explainer-overlay";
    const panel = document.createElement("div");
    panel.className = "confirm-panel remote-explainer-panel";

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "remote-explainer-close";
    closeBtn.innerHTML = ICON.x;
    closeBtn.title = "Close";
    closeBtn.setAttribute("aria-label", "Close");

    const title = document.createElement("div");
    title.className = "confirm-title";
    title.textContent = "How AFK Pilot works";

    const body = document.createElement("div");
    body.className = "confirm-body remote-explainer-body";
    const steps = document.createElement("ol");
    const step1 = document.createElement("li");
    step1.textContent = "Link this device. Sign in with your account.";
    const step2 = document.createElement("li");
    step2.textContent = isDesktopHostCaps()
      ? "Keep this app open."
      : "Keep VS Code, Cursor, or Antigravity open.";
    const step3 = document.createElement("li");
    step3.append("Open ");
    const urlBtn = document.createElement("button");
    urlBtn.type = "button";
    urlBtn.className = "remote-url-copy";
    urlBtn.textContent = "afkpilot.com";
    urlBtn.title = "Copy afkpilot.com";
    const copied = document.createElement("span");
    copied.className = "remote-url-copied";
    copied.setAttribute("aria-live", "polite");
    step3.append(urlBtn, copied, " on your phone and sign in.");
    steps.append(step1, step2, step3);

    const note = document.createElement("p");
    note.textContent = "You can then work 100% remotely — it keeps this device awake, and never stores your prompts or code.";
    body.append(steps, note);

    const actions = document.createElement("div");
    actions.className = "confirm-actions";
    const moreBtn = document.createElement("button");
    moreBtn.type = "button";
    moreBtn.className = "confirm-btn confirm-primary";
    moreBtn.textContent = "More & FAQ";
    actions.appendChild(moreBtn);

    const done = () => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        done();
      }
    };
    document.addEventListener("keydown", onKey, true);
    closeBtn.onclick = (e) => { e.stopPropagation(); done(); };
    overlay.onclick = (e) => {
      if (e.target === overlay) {
        e.stopPropagation();
        done();
      }
    };
    urlBtn.onclick = (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText("https://afkpilot.com").then(() => {
        copied.textContent = "Copied";
        urlBtn.classList.add("copied");
      }).catch(() => {});
    };
    moreBtn.onclick = (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: "openRemotePortal" });
      done();
    };

    panel.append(closeBtn, title, body, actions);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    moreBtn.focus();
  }

  function renderGearMain() {
    state.gearView = "main";
    gearPopover.innerHTML = "";
    gearPopover.classList.remove("popover-centered");

    // Two surfaces, one popover. With a rail gear the composer holds what is
    // about THIS CONVERSATION (model, effort, where it continues) and the rail
    // holds what is about THE APP (account, purpose, settings, about). Without
    // one — VS Code — both flags are true and nothing is split, which is why
    // this needs no host branch.
    const split = railGearLive();
    const showConversation = !split || state.gearSurface !== "rail";
    const showApp = !split || state.gearSurface === "rail";

    if (showConversation) renderGearConversation();
    if (showApp) {
      renderGearApp();
      renderProviderAccounts();
    }
  }

  /** Model + effort, plus worktree controls that have no header-menu home. */
  function renderGearConversation() {
    // ── Model + effort header ─────────────────────────────────────────────
    const modelEffortSection = document.createElement("div");
    // When Text size leads, Model and Effort is no longer the first row — keep
    // the section rule so a separator appears under the slider.
    modelEffortSection.className = "popover-section" +
      (CLIENT_OWNS_FONT_SCALE ? "" : " popover-section-first");
    modelEffortSection.textContent = "Model and Effort";
    gearPopover.appendChild(modelEffortSection);

    // ── Model + effort row ────────────────────────────────────────────────
    const row = document.createElement("div");
    row.className = "model-effort-row";

    // Model + effort both restart or race the session, so they are locked while
    // a turn or session startup is in flight (the same busy signal as Send).
    //
    // Also locked when NOTHING can answer: with no usable agent there is no
    // model to choose between, and an enabled picker offering a list you cannot
    // act on is worse than one that plainly says not yet. Connect an agent and
    // it unlocks with that agent's own default selected (owner, 2026-08-17).
    const anyUsableProvider = !state.providersKnown
      || (state.providers || []).some((p) => p.connected && p.needsLogin !== true);
    const settingsLocked = state.busy || !anyUsableProvider;

    // Until the session's model info arrives (its name + advertised effort menu),
    // don't show a guessed model or a stale effort ladder — show a Loading state.
    const modelLoaded = state.availableModels.length > 0 && !!state.currentModelId;

    const nameBtn = document.createElement("button");
    nameBtn.className = "toolbar-btn model-name-btn" + (settingsLocked || !modelLoaded ? " disabled" : "");
    const ownModels = state.availableModels.filter((model) => !model.provider || model.provider === state.activeProvider);
    // With no agent able to answer, show that rather than the last model a
    // session happened to remember. "GPT-5.6 Sol" sitting under the composer
    // reads as a working selection when nothing can run at all.
    const modelName = !anyUsableProvider
      ? "Models unavailable"
      : (modelLoaded ? (modelDisplayName(state.currentModelId, ownModels) || "Grok Build") : "Loading…");
    nameBtn.innerHTML = `<span class="btn-label">${escapeHtml(truncate(modelName, 18))}</span>`;
    nameBtn.disabled = settingsLocked || !modelLoaded;
    nameBtn.title = !anyUsableProvider
      ? "Connect an agent to choose a model"
      : (!modelLoaded
        ? "Loading the session…"
        : (settingsLocked ? `${modelName} — available once the session is ready` : `${modelName} — click to change`));
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

    // ── Session ───────────────────────────────────────────────────────────
    // Conversation-wide actions live in the header's overflow on every
    // surface. Worktree Apply/Remove remain here because the VS Code overflow
    // contains exactly the two portable continuation/export actions.
    if (railGearLive()) return;
    // Worktree Apply/Remove only while already in a worktree (Coding or not —
    // you're already in one, so the controls must stay reachable). Never from a
    // remote: the host acts on its own focused session, not the requester's.
    if (state.isWorktree && !IS_REMOTE) {
      addSection("Session");
      addGearItem(`<span class="gear-lead">${ICON.gitBranch}<span>Apply worktree</span></span>`, () => {
        closePopovers();
        // Bind the conversation at dialog-OPEN time. Confirmation overlays
        // outlive a session swap, so reading state.activeSessionId after the
        // await would apply whichever conversation the user switched to; with
        // the open-time id a stale dialog gets a host refusal instead.
        const sessionId = state.activeSessionId;
        uiConfirm({
          title: "Apply worktree?",
          body: "Merges this worktree's edits back into the main checkout.",
          confirmLabel: "Apply",
        }).then((ok) => { if (ok) vscode.postMessage({ type: "applyWorktree", sessionId }); });
      });
      addGearItem(`<span class="gear-lead">${ICON.gitBranch}<span>Remove worktree</span></span>`, () => {
        closePopovers();
        // Same open-time binding as Apply — this one discards edits on the
        // wrong target, which is exactly the class the refusal exists for.
        const sessionId = state.activeSessionId;
        uiConfirm({
          title: "Remove worktree?",
          body: "This deletes the isolated checkout. Unapplied edits are lost.",
          confirmLabel: "Remove",
          danger: true,
        }).then((ok) => { if (ok) vscode.postMessage({ type: "removeWorktree", sessionId }); });
      });
    }
  }

  /** The app itself: what it is used for, settings, and about. */
  function renderGearApp() {
    // ── Use this app for ──────────────────────────────────────────────────
    // Progressive disclosure: Knowledge work (default) hides worktrees,
    // thinking traces and tool details; Coding unlocks them (still default off).
    // Icons here only. The same choice in Settings is a <select>, where an
    // option cannot carry markup — so it stays text and the two surfaces
    // differ deliberately rather than by neglect.
    addSection("Use this app for");
    addGearItem(
      `<span class="gear-lead" title="Hides worktrees, thinking traces, and tool details. The default for knowledge work.">${ICON.brain}<span>Knowledge work</span></span>${state.appPurpose !== "coding" ? '<span class="popover-check">✓</span>' : ""}`,
      () => { setAppPurpose("knowledge"); renderGearMain(); gearPopover.hidden = false; },
    );
    addGearItem(
      `<span class="gear-lead" title="Adds worktrees, thinking traces, and tool details (still off by default).">${ICON.squareChevronRight}<span>Coding</span></span>${state.appPurpose === "coding" ? '<span class="popover-check">✓</span>' : ""}`,
      () => { setAppPurpose("coding"); renderGearMain(); gearPopover.hidden = false; },
    );

    // ── Remote Control ────────────────────────────────────────────────────
    // Hidden in the browser client: a remote can't (un)link the desk.
    // `remoteLinked === null` = the host hasn't answered yet: show NOTHING
    // rather than guessing. Unlink lives only in Settings → Account.
    if (!IS_REMOTE && state.remoteLinked !== null) {
      addSection("Remote Control");
      if (state.remoteLinked) {
        addGearItem(`<span class="gear-lead">${ICON.smartphone}<span>Continue remotely</span></span>`, () => {
          vscode.postMessage({ type: "openRemotePortal", withHint: true });
          closePopovers();
        });
        addGearItem(`<span class="gear-lead">${ICON.user}<span>Your account</span></span>`, () => {
          vscode.postMessage({ type: "openRemotePortal" });
          closePopovers();
        });
      } else {
        addGearItem(`<span class="gear-lead">${ICON.user}<span>Sign in (link this device)</span></span>`, () => {
          vscode.postMessage({ type: "remoteSignIn" });
          closePopovers();
        });
        addGearItem(`<span class="gear-lead">${ICON.info}<span>How it works</span></span>`, () => {
          closePopovers();
          showRemoteExplainer();
        });
      }
    }

    addSection("Settings");
    addGearItem(`<span class="gear-lead">${ICON.gear}<span>Settings</span></span>`, () => openAllSettings());
    // Older hosts have no provider account frame; retain their existing action.
    if (!IS_REMOTE && !state.providersKnown) {
      addGearItem("<span>Log out</span>", () => {
        vscode.postMessage({ type: "logout" });
        closePopovers();
      });
    }
  }

  /**
   * Gear account rows: ONLY while nothing can answer. Once any agent is usable
   * the gear stops carrying accounts entirely and Settings → Providers owns
   * them (owner, 2026-08-17).
   *
   * This used to stay visible whenever any connected account needed a sign-in,
   * which meant a working setup with one lapsed extra account kept a
   * half-broken Accounts list in the quick menu forever. The gear's job is to
   * get someone unstuck; a second account that needs attention is management,
   * not a blocker.
   *
   * "Usable", not "connected" — a linked account whose credentials lapsed
   * cannot answer, so it must not count as the thing that hides this.
   */
  function gearShowsProviderAccounts() {
    if (IS_REMOTE || !state.providersKnown) return false;
    const list = state.providers || [];
    return !list.some((p) => p.connected && p.needsLogin !== true);
  }

  function renderProviderAccounts() {
    if (!gearShowsProviderAccounts()) return;
    addSection("Accounts");
    for (const provider of state.providers) {
      const connected = provider.connected === true;
      // A connected account whose agent answered an auth failure: the useful
      // action is the connect flow, not "Sign out" of credentials that are
      // already refused.
      const needsLogin = connected && provider.needsLogin === true;
      // Two states in the verb, not three. "Sign in again" told the user about
      // OUR bookkeeping — that this account was linked once and its credentials
      // lapsed — while "Connect" next to it meant the same thing to them: this
      // one does not work, press here to fix it. Both open the same login. The
      // stale case keeps its warning styling, so the difference is still
      // visible without inventing a second word for one action.
      const action = connected && !needsLogin ? "Sign out" : "Connect";
      const name = providerDisplayName(provider.id);
      addGearItem(
        `<span class="gear-lead"><span class="provider-glyph provider-${provider.id}">${providerLogoMarkup(provider.id)}</span><span>${name}</span></span><span class="popover-ver${needsLogin ? " popover-warn" : ""}">${action}</span>`,
        () => {
          vscode.postMessage(connected && !needsLogin
            ? { type: "logout", provider: provider.id }
            : { type: "runGrokLogin", provider: provider.id });
          closePopovers();
        },
      );
    }
  }

  /** Agents that answered an auth-shaped failure — their models are unknowable
   *  until someone signs in, so the picker must not offer any. */
  function providerNeedsLogin(id) {
    return state.providers.some((provider) =>
      provider.id === id && provider.connected && provider.needsLogin === true);
  }

  /**
   * Destinations under "Continue in a new chat".
   * Knowledge work / unsupported worktrees / already-in-worktree → workspace only.
   */
  function continueChatDestinations() {
    const dests = [
      {
        id: "workspace",
        label: "Use this workspace",
        description: "Continue from here in the current checkout",
      },
    ];
    // Desk-only: the host creates a worktree against its own workspace root
    // rather than the session that asked, so a remote tab working in another
    // repo would get a checkout somewhere it never chose. Offering the option
    // here would promise a placement the host does not honour.
    if (isCodingPurpose() && state.worktreeSupported && !state.isWorktree && !IS_REMOTE) {
      dests.push({
        id: "worktree",
        label: "Use a new worktree",
        description: "Continue from here in an isolated checkout",
      });
    }
    return dests;
  }

  /** One destination → go straight there; several → destination picker. */
  function beginContinueInNewChat(sessionId) {
    const dests = continueChatDestinations();
    if (dests.length <= 1) {
      runContinueDestination(dests[0] ? dests[0].id : "workspace", sessionId);
      return;
    }
    renderContinueDestinationPicker(dests, sessionId);
  }

  function runContinueDestination(id, sessionId) {
    closePopovers();
    if (id === "worktree") {
      vscode.postMessage({ type: "newWorktreeSession" });
    } else {
      vscode.postMessage({ type: "forkSession", sessionId });
    }
  }

  function renderContinueDestinationPicker(dests, sessionId) {
    state.gearView = "continue";
    gearPopover.innerHTML = "";
    // This panel used to be reachable only from the gear, so it could assume the
    // popover was already open and positioned. Its entry point moved to the
    // conversation's overflow menu, where it is not — so the picker rendered
    // into a hidden, unpositioned element: nothing happened at all, and when it
    // did show it sat in the corner of the window with no anchor.
    // Centred, and with no way "back". Both follow from where this is reached
    // from now: the conversation's ⋯ menu, in the top bar or the rail — never
    // the gear. A back arrow to the gear's main panel would return you to a
    // place you were not, and anchoring the panel to a gear button you did not
    // press puts it nowhere near the pointer. It is a question — where should
    // this continue? — so it behaves like one: centred, dismissed by clicking
    // away or Escape.
    gearPopover.classList.add("popover-centered");
    gearPopover.hidden = false;
    addSection("Continue in a new chat");
    dests.forEach((d, i) => {
      const el = document.createElement("div");
      el.className = "toolbar-popover-item" + (i === 0 ? " active" : "");
      el.innerHTML =
        `<span class="mode-item-body">` +
          `<span class="mode-item-label">${escapeHtml(d.label)}</span>` +
          `<span class="mode-item-desc">${escapeHtml(d.description)}</span>` +
        `</span>`;
      el.tabIndex = i === 0 ? 0 : -1;
      el.onclick = (e) => {
        e.stopPropagation();
        runContinueDestination(d.id, sessionId);
      };
      gearPopover.appendChild(el);
      if (i === 0) {
        // "Use this workspace" is the focused default so Enter does the common thing.
        requestAnimationFrame(() => { try { el.focus(); } catch { /* */ } });
      }
    });
  }

  function renderModelPicker() {
    state.gearView = "model";
    gearPopover.innerHTML = "";
    addGearItem('<span class="popover-back">← Model</span>', renderGearMain);
    let models = state.availableModels.length
      ? state.availableModels
      : [{ modelId: state.currentModelId || "grok-build", name: state.currentModelId || "grok-build" }];
    const hasConversation = visibleUserBubbleCount() > 0;
    if (state.providersKnown && hasConversation) {
      models = models.filter((model) => !model.provider || model.provider === state.activeProvider);
    }
    const grouped = state.providersKnown && !hasConversation && showProviderGlyphs();
    // A signed-out agent has no knowable model list, and the placeholder shown
    // in its place ("Codex default") reads as something you can select — so its
    // rows are replaced by the one action that can actually help.
    const signInProviders = ["grok", "codex", "claude"].filter(providerNeedsLogin);
    models = models.filter((model) => !signInProviders.includes(model.provider || state.activeProvider));
    if (grouped) {
      models = ["grok", "codex", "claude"].flatMap((provider) => models.filter((model) =>
        (model.provider || state.activeProvider) === provider));
    }
    let group = "";
    const addProviderHeading = (provider) => {
      if (!grouped || provider === group) return;
      group = provider;
      const heading = document.createElement("div");
      heading.className = "popover-section model-provider-heading";
      heading.textContent = providerDisplayName(provider);
      gearPopover.appendChild(heading);
    };
    // A provider that cannot answer is simply not in this list. It used to get
    // a heading and a "Sign in to load models" row, which put an agent you
    // cannot pick in the middle of the menu for picking one — and on a phone it
    // could not even be actioned, since the host refuses runGrokLogin from a
    // remote. Manage providers at the bottom is the way back for all three
    // (owner, 2026-08-17: "Not connected => Not visible").
    const renderModelRow = (m) => {
      const modelProvider = m.provider || state.activeProvider;
      addProviderHeading(modelProvider);
      const el = document.createElement("div");
      const active = m.modelId === state.currentModelId && (!m.provider || m.provider === state.activeProvider);
      const label = modelPickerLabel(m) || m.modelId;
      const glyphId = providerLogoId(modelProvider);
      el.className = "toolbar-popover-item model-picker-row";
      if (active) el.classList.add("active");
      el.innerHTML =
        `<span class="gear-lead">` +
          `<span class="provider-glyph provider-${glyphId}">${providerLogoMarkup(glyphId)}</span>` +
          `<span class="model-picker-name">${escapeHtml(truncate(label, 28))}</span>` +
        `</span>` +
        (active ? '<span class="popover-check">✓</span>' : "");
      el.title = m.modelId;
      el.onclick = (e) => {
        e.stopPropagation();
        const message = { type: "setModel", modelId: m.modelId };
        if (state.providersKnown && m.provider) message.provider = m.provider;
        vscode.postMessage(message);
        closePopovers();
      };
      gearPopover.appendChild(el);
    };
    const addManageProvidersRow = () => {
      const sep = document.createElement("div");
      sep.className = "popover-sep";
      gearPopover.appendChild(sep);
      const el = document.createElement("div");
      el.className = "toolbar-popover-item model-manage-providers";
      el.innerHTML = `<span class="gear-lead">${ICON.settings2}<span>Manage providers</span></span>`;
      el.onclick = (e) => {
        e.stopPropagation();
        openSettingsCategory("providers");
      };
      gearPopover.appendChild(el);
    };
    if (grouped) {
      for (const provider of ["grok", "codex", "claude"]) {
        for (const m of models) {
          if ((m.provider || state.activeProvider) === provider) renderModelRow(m);
        }
      }
      addManageProvidersRow();
      return;
    }
    for (const m of models) renderModelRow(m);
    addManageProvidersRow();
  }

  /** The trigger for the surface currently being rendered. */
  function activeGearButton() {
    if (state.gearSurface === "rail") return document.getElementById("rail-gear-btn") || gearBtn;
    return gearBtn;
  }

  /** Where app-level panels (settings, about) hang: the rail gear once it exists. */
  function appSettingsButton() {
    return document.getElementById("rail-gear-btn") || gearBtn;
  }

  /**
   * Position the gear popover. Composer gear uses the existing absolute
   * placement inside .composer; rail gear uses fixed coords so it is not
   * clipped by the rail scroller.
   */
  function positionGearPopover(btn) {
    const anchor = btn || activeGearButton();
    if (anchor && anchor.id === "rail-gear-btn") {
      const z = chatZoomFactor();
      const rect = anchor.getBoundingClientRect();
      // Fixed under body zoom: client rects are visual; style left/bottom are layout.
      const vw = unzoomClientPx(window.innerWidth, z);
      const vh = unzoomClientPx(window.innerHeight, z);
      gearPopover.style.position = "fixed";
      gearPopover.style.left = Math.min(vw - GEAR_POPOVER_WIDTH, Math.max(8, unzoomClientPx(rect.right, z) + 6)) + "px";
      gearPopover.style.bottom = Math.max(8, vh - unzoomClientPx(rect.bottom, z)) + "px";
      gearPopover.style.top = "auto";
      gearPopover.style.right = "auto";
      gearPopover.style.maxHeight = Math.min(420, vh - 24) + "px";
      // Fixed positioning with `right: auto` leaves the width shrink-to-fit and
      // uncapped, so the Version & about panel's long strings stretched it most
      // of the way across the window. The composer path is bounded by the
      // composer; this one has to say so. Same number the left-clamp above
      // reserves, so the popover can never be pushed off-screen.
      gearPopover.style.maxWidth = Math.min(GEAR_POPOVER_WIDTH, vw - 16) + "px";
      return;
    }
    gearPopover.style.position = "";
    gearPopover.style.maxHeight = "";
    gearPopover.style.maxWidth = "";
    positionPopover(gearPopover, gearBtn);
  }

  function openGearPopover(fromBtn) {
    gearPopover.classList.remove("popover-centered");
    // Which button was pressed decides which sections render. Without a rail
    // gear both surfaces collapse into the composer one, so this is inert there.
    const surface = fromBtn && fromBtn.id === "rail-gear-btn" ? "rail" : "composer";
    // Clicking the button that is already showing closes it — clicking the OTHER
    // one switches to it. Closing on any open popover made the two surfaces
    // cost two clicks to move between: the first only dismissed the other menu.
    if (!gearPopover.hidden) {
      const showingThis = state.gearSurface === surface;
      closePopovers();
      if (showingThis) return;
    }
    // One popover at a time (#148): the donut, mode and add menus stayed up
    // under the gear because only their own openers dismissed the others.
    closePopovers();
    state.gearSurface = surface;
    renderGearMain();
    positionGearPopover(fromBtn || activeGearButton());
    gearPopover.hidden = false;
  }

  // Welcome "about" link → Settings → About. VS Code opens the editor tab;
  // overlay clients land on the About category.
  function openAboutPanel() {
    closePopovers();
    if (hostOpensSettingsEditor()) {
      vscode.postMessage({ type: "openSettingsSurface", category: "about" });
      return;
    }
    openSettingsOverlay(appSettingsButton(), { category: "about" });
  }

  /**
   * Rail hosts (desktop getHtml / AFK Pilot page) put the gear in the rail
   * footer so web and desktop share one control by construction. VS Code has
   * no rail mount, so the composer gear stays. No IS_DESKTOP flag.
   */
  function ensureRailGear() {
    const foot = document.querySelector("#projects-rail .rail-foot");
    if (!foot) return null;
    let btn = document.getElementById("rail-gear-btn");
    if (!btn) {
      btn = document.createElement("button");
      btn.id = "rail-gear-btn";
      btn.type = "button";
      btn.className = "rail-icon-btn";
      btn.title = "Settings";
      btn.setAttribute("aria-label", "Settings");
      // Leftmost in the footer on BOTH hosts. Anchoring it to the theme toggle
      // instead only worked on desktop — the browser client's toggle carries no
      // id, so the gear was appended and landed on the opposite side. First
      // child needs nothing to look up.
      foot.insertBefore(btn, foot.firstChild);
    }
    if (!btn.dataset.railGearWired) {
      btn.dataset.railGearWired = "1";
      btn.innerHTML = ICON.gear;
      btn.title = "Settings";
      btn.setAttribute("aria-label", "Settings");
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        openGearPopover(btn);
      });
    }
    return btn;
  }

  /**
   * Update rail footer. Renders because the host sent `updateAvailable` or
   * `updateReady` — same capability pattern as pin control + `pinnedSessions`.
   * VS Code never posts either; no IS_DESKTOP gate.
   */
  function renderAppUpdateAffordance() {
    const foot = document.querySelector("#projects-rail .rail-foot");
    if (!foot) return;
    let btn = document.getElementById("rail-update-btn");
    let panel = document.getElementById("rail-update-panel");
    if (!state.appUpdate) {
      if (btn) btn.hidden = true;
      if (panel) panel.hidden = true;
      return;
    }
    if (!btn) {
      btn = document.createElement("button");
      btn.id = "rail-update-btn";
      btn.type = "button";
      btn.className = "rail-update-btn";
      // After gear (first child), before theme toggle (last → margin-left auto).
      const gear = document.getElementById("rail-gear-btn");
      if (gear && gear.nextSibling) foot.insertBefore(btn, gear.nextSibling);
      else if (gear) foot.appendChild(btn);
      else foot.insertBefore(btn, foot.firstChild);
    }
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "rail-update-panel";
      panel.className = "rail-update-panel";
      panel.hidden = true;
      // Sit above the foot so it does not push the scroll region.
      foot.parentElement?.insertBefore(panel, foot);
    }
    const ver = state.appUpdate.version;
    const url = state.appUpdate.url;
    const ready = !!state.appUpdate.ready;
    btn.hidden = false;
    btn.textContent = ready ? "Restart to update" : "Update available";
    btn.title = ready
      ? `Version ${ver} is downloaded — restart to install`
      : `Version ${ver} is available`;
    btn.setAttribute(
      "aria-label",
      ready ? `Restart to update to version ${ver}` : `Update available: version ${ver}`,
    );
    btn.setAttribute("aria-expanded", panel.hidden ? "false" : "true");
    if (!btn.dataset.wired) {
      btn.dataset.wired = "1";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const p = document.getElementById("rail-update-panel");
        if (!p) return;
        p.hidden = !p.hidden;
        btn.setAttribute("aria-expanded", p.hidden ? "false" : "true");
      });
    }
    panel.innerHTML = "";
    const title = document.createElement("div");
    title.className = "rail-update-title";
    title.textContent = ready
      ? `Version ${ver} is ready to install`
      : `Version ${ver} is available`;
    const body = document.createElement("p");
    body.className = "rail-update-body";
    body.textContent = ready
      ? "Finish any in-flight agent turn first — a restart does not keep it. The update also installs on the next normal quit, even if you choose Not now."
      : "Download the new installer and run it over the top of this app. Your settings and conversations are kept.";
    const actions = document.createElement("div");
    actions.className = "rail-update-actions";
    const primary = document.createElement("button");
    primary.type = "button";
    primary.className = "rail-update-open";
    if (ready) {
      primary.textContent = "Restart now";
      primary.addEventListener("click", (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: "restartToUpdate" });
      });
    } else {
      primary.textContent = "Open release page";
      primary.addEventListener("click", (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: "openUpdateRelease", url });
      });
    }
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "rail-update-dismiss";
    dismiss.textContent = "Not now";
    dismiss.addEventListener("click", (e) => {
      e.stopPropagation();
      panel.hidden = true;
      btn.setAttribute("aria-expanded", "false");
    });
    actions.appendChild(primary);
    actions.appendChild(dismiss);
    panel.appendChild(title);
    panel.appendChild(body);
    panel.appendChild(actions);
  }

  // ---------- draggable rail edge ----------
  //
  // The rail's own border, made draggable. Mounted here rather than in either
  // host's markup so desktop and the browser client get it by construction —
  // the same argument that put the gear in the rail. Inert in VS Code, which
  // has no rail mount at all.
  //
  // The phone drawer is excluded by CSS, not by JS: web/chat.html owns the
  // breakpoint that decides drawer-vs-docked, and that is the only place that
  // knows. One definition of "is this a phone", not two.
  // Width cap for the rail-anchored gear popover. Menu items and the About
  // panel's version lines both live in here, so it has to fit "Grok Build for
  // VS Code (Community)" wrapped without becoming a full-width sheet.
  const GEAR_POPOVER_WIDTH = 240;

  const RAIL_WIDTH_KEY = "rail-width";
  const RAIL_WIDTH_MIN = 180;
  const RAIL_CHAT_MIN = 360;
  // Shared conversation floor when both side panels compete for space. Matches
  // the rail's own floor so distribute and solo clamp agree on chat room.
  const SIDE_PANELS_CHAT_MIN = RAIL_CHAT_MIN;

  function clampRailWidth(px) {
    const total = window.innerWidth || 1200;
    // Whichever bites first: leave the chat a usable column, and never let the
    // rail past half the window even on a very wide one.
    const max = Math.max(RAIL_WIDTH_MIN, Math.min(Math.floor(total * 0.5), total - RAIL_CHAT_MIN));
    const n = Math.round(Number(px));
    if (!Number.isFinite(n)) return RAIL_WIDTH_MIN;
    return Math.min(max, Math.max(RAIL_WIDTH_MIN, n));
  }

  function applyRailWidth(px, persist) {
    const w = clampRailWidth(px);
    document.documentElement.style.setProperty("--rail-width", w + "px");
    if (persist) { try { localStorage.setItem(RAIL_WIDTH_KEY, String(w)); } catch (_) { /* */ } }
    return w;
  }

  /** Preferred (drag-saved) width; never the painted width after a shrink. */
  function preferredWidthFromStorage(key, fallback) {
    try {
      const s = localStorage.getItem(key);
      if (s != null && s !== "") {
        const n = Math.round(Number(s));
        if (Number.isFinite(n) && n > 0) return n;
      }
    } catch (_) { /* */ }
    return fallback;
  }

  /**
   * Extra side panels (desktop file panel) register here so a window-narrow
   * reclamp can share the deficit without chat.js naming desktop-only ids.
   * Provider: { id, min, maxFrac?, isOpen(), preferredWidth(), applyWidth(px) }.
   */
  const sidePanelProviders = [];
  window.__grokRegisterSidePanel = function registerSidePanel(provider) {
    if (!provider || !provider.id) return;
    // Replace same id on re-inject (panel boot tears down and remounts).
    const i = sidePanelProviders.findIndex((p) => p.id === provider.id);
    if (i >= 0) sidePanelProviders[i] = provider;
    else sidePanelProviders.push(provider);
  };

  /**
   * Window-narrow reclamp: shrink open side panels proportionally so the chat
   * keeps a floor. Uses stored drag widths (not painted) so growing the window
   * restores what the user set. Does not persist the temporary shrink.
   * Exposed as window.__grokReclampSidePanels so a desktop panel boot script
   * can share one path instead of racing a second independent clamp.
   */
  function reclampSidePanels() {
    const rail = railMount();
    const railOpen = !!(
      rail &&
      !rail.hidden &&
      !document.body.classList.contains("desk-rail-collapsed")
    );
    const total = window.innerWidth || 1200;
    const railMax = Math.max(RAIL_WIDTH_MIN, Math.floor(total * 0.5));
    let preferredRail = preferredWidthFromStorage(
      RAIL_WIDTH_KEY,
      rail ? (rail.getBoundingClientRect().width || 260) : 260,
    );
    preferredRail = Math.min(railMax, Math.max(RAIL_WIDTH_MIN, preferredRail));

    const panels = [
      { id: "rail", preferred: preferredRail, min: RAIL_WIDTH_MIN, open: railOpen },
    ];
    for (const p of sidePanelProviders) {
      try {
        const min = Math.max(0, Math.round(Number(p.min) || 0));
        const maxFrac = Number(p.maxFrac);
        const max = Number.isFinite(maxFrac) && maxFrac > 0
          ? Math.max(min, Math.floor(total * maxFrac))
          : total;
        let preferred = Math.max(min, Math.round(Number(p.preferredWidth && p.preferredWidth()) || min));
        preferred = Math.min(max, preferred);
        panels.push({
          id: p.id,
          preferred,
          min,
          open: !!(p.isOpen && p.isOpen()),
        });
      } catch (_) { /* provider best-effort */ }
    }
    if (!panels.some((p) => p.open)) return;

    const dist = typeof distributeSidePanelWidths === "function"
      ? distributeSidePanelWidths({
          available: total,
          chatMin: SIDE_PANELS_CHAT_MIN,
          panels,
        })
      : null;
    if (!dist) {
      if (railOpen) applyRailWidth(preferredRail, false);
      return;
    }
    if (railOpen && dist.rail > 0) {
      // Set the var directly: applyRailWidth's solo clamp does not know about
      // sibling panels and can re-expand the rail past the coordinated share.
      document.documentElement.style.setProperty("--rail-width", Math.round(dist.rail) + "px");
    }
    for (const p of sidePanelProviders) {
      try {
        if (dist[p.id] > 0 && p.applyWidth) p.applyWidth(dist[p.id]);
      } catch (_) { /* */ }
    }
  }
  window.__grokReclampSidePanels = reclampSidePanels;

  let railResizerWired = false;
  function ensureRailResizer() {
    const rail = railMount();
    if (!rail || !rail.parentElement) return null;
    let handle = document.getElementById("rail-resizer");
    if (!handle) {
      handle = document.createElement("div");
      handle.id = "rail-resizer";
      handle.className = "rail-resizer";
      handle.setAttribute("role", "separator");
      handle.setAttribute("aria-orientation", "vertical");
      handle.setAttribute("aria-label", "Resize projects rail");
      handle.title = "Drag to resize";
      rail.parentElement.insertBefore(handle, rail.nextSibling);
    }
    if (!railResizerWired) {
      railResizerWired = true;
      // Restore the persisted width before the rail is first painted wide.
      try {
        const saved = localStorage.getItem(RAIL_WIDTH_KEY);
        if (saved != null && saved !== "") applyRailWidth(saved, false);
      } catch (_) { /* */ }

      let dragging = false;
      let startX = 0;
      let startW = 0;
      let lastW = 0;
      // Body `--chat-zoom` scales VISUAL rects and clientX, while --rail-width
      // is layout px. Convert both ends of the gesture so the edge tracks the
      // cursor (a no-op at zoom 1). Converting only the delta jumps on grab.
      const zoomOf = typeof chatZoomFactor === "function" ? chatZoomFactor : () => 1;
      const unzoom = typeof unzoomClientPx === "function" ? unzoomClientPx : (px) => px;
      const layoutPx = (clientPx) => unzoom(clientPx, zoomOf());
      handle.addEventListener("pointerdown", (e) => {
        // getBoundingClientRect, not the stored value: the rail may be sitting
        // at its CSS default having never been dragged.
        startW = layoutPx(rail.getBoundingClientRect().width);
        if (!startW) return;
        dragging = true;
        startX = layoutPx(e.clientX);
        lastW = startW;
        document.body.classList.add("rail-resizing");
        handle.classList.add("rail-resizing");
        try { handle.setPointerCapture(e.pointerId); } catch (_) { /* */ }
        e.preventDefault();
      });
      handle.addEventListener("pointermove", (e) => {
        // Rail is on the left: drag right → wider.
        if (dragging) lastW = applyRailWidth(startW + (layoutPx(e.clientX) - startX), false);
      });
      const end = (e) => {
        if (!dragging) return;
        dragging = false;
        document.body.classList.remove("rail-resizing");
        handle.classList.remove("rail-resizing");
        try { handle.releasePointerCapture(e.pointerId); } catch (_) { /* */ }
        // Persist once, on release — not on every move. The value APPLIED, not
        // a fresh measurement: the element may not have reflowed to the last
        // move yet, and re-measuring would then persist a stale width.
        applyRailWidth(lastW, true);
      };
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
      // Re-clamp so shrinking the window cannot leave the rail overgrown —
      // and so the deficit is shared with the file panel when both are open.
      // Full-screen video fires resize mid-transition with a meaningless width;
      // wireFullscreenSafeReclamp skips those and re-clamps once on exit.
      wireFullscreenSafeReclamp(() => { reclampSidePanels(); });
    }
    return handle;
  }

  /**
   * True while the rail is showing its own gear — i.e. the app-level settings
   * have a home outside the composer. The one latch both the placement and the
   * icon derive from.
   */
  function railGearLive() {
    return !!document.getElementById("rail-gear-btn") && railAvailable();
  }

  /**
   * Split the settings surfaces rather than moving one button.
   *
   * The composer button NEVER disappears — Model and Effort is the highest-
   * frequency control in the app and belongs next to the thing you type in.
   * What changes is what it holds, and its icon follows that: sliders
   * (settings-2) once the rail owns the app settings, the gear when it owns
   * everything (VS Code, which has no rail). Derived from `railGearLive()`,
   * not from a host flag.
   */
  function syncGearPlacement() {
    const railGear = ensureRailGear();
    ensureRailResizer();
    const split = railGearLive();
    gearBtn.hidden = false;
    gearBtn.innerHTML = split ? ICON.settings2 : ICON.gear;
    gearBtn.title = split ? "Model, effort and session" : "Settings";
    gearBtn.setAttribute("aria-label", gearBtn.title);
    if (railGear) railGear.hidden = !split;
  }

  function openModePopover() {
    if (!modePopover.hidden) { closePopovers(); return; }
    closePopovers();
    modePopover.innerHTML = "";
    for (const [id, meta] of Object.entries(MODE_META)) {
      // Plan is Grok's extension-owned plan gate. Codex owns its own plan
      // review permission flow, so showing this item there is both inert and
      // misleading.
      if (id === "plan" && state.activeProvider === "codex") continue;
      const el = document.createElement("div");
      const active = id === state.currentModeId;
      // Verified-old CLI: hard-disable Plan. Unverified probe: keep it clickable
      // so the host re-checks on pick instead of forcing a session restart (#105).
      const planUnavailable = id === "plan" && !state.planModeAvailable;
      const planRecheckable = planUnavailable && state.planModeRecheckable;
      const disabled = !!meta.disabled || (planUnavailable && !planRecheckable);
      const disabledNote = planUnavailable ? state.planModeUnavailableReason : meta.disabledNote;
      el.className = "toolbar-popover-item mode-popover-item" +
        (active ? " active" : "") +
        (disabled ? " disabled" : "");
      el.innerHTML =
        `<span class="mode-item-icon">${meta.icon}</span>` +
        `<span class="mode-item-body">` +
          `<span class="mode-item-label">${escapeHtml(meta.label)}</span>` +
          `<span class="mode-item-desc">${escapeHtml(meta.desc)}</span>` +
          (disabledNote ? `<span class="mode-item-disabled-note">${escapeHtml(disabledNote)}</span>` : "") +
        `</span>` +
        (active ? '<span class="popover-check">✓</span>' : "");
      el.onclick = (e) => {
        e.stopPropagation();
        if (disabled) return;
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
    unread: "Finished while no view was watching",
    error: "Errored while no view was watching",
  };

  function applySessionDot(dot, value) {
    const v = DOT_LABEL[value] ? value : "none";
    const base = dot.classList.contains("provider-status-badge") ? "provider-status-badge" : "history-row-dot";
    dot.className = base + " dot-" + v;
    dot.dataset.dot = v;
    dot.title = DOT_LABEL[value] || "";
  }

  function showProviderGlyphs() {
    return state.providersKnown && state.providers.filter((provider) => provider.connected).length > 1;
  }

  /** Desktop host signature via capabilities — not IS_REMOTE, not body.desk
   *  (VS Code also sets body.desk). relocateView + showOutput both false. */
  function isDesktopHostCaps() {
    return !!(state.hostCaps &&
      state.hostCaps.relocateView === false &&
      state.hostCaps.showOutput === false);
  }

  // Provider marks from Lobe Icons (MIT), adapted to inherit currentColor.
  const PROVIDER_LOGO_PATHS = {
    grok: "M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815",
    codex: "M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z",
    // Four-point sparkle — distinct from the Grok/Codex marks, currentColor.
    claude: "M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z",
  };

  /**
   * Whether the agent running this session can hear a mid-turn message.
   *
   * Steer is `_x.ai/interject`, an xAI extension to ACP — so it is a GROK
   * capability, not an ACP one. Codex's adapter answers -32601 and the text
   * falls back to the queue, and Claude Code has no interject at all. Both
   * therefore schedule instead, and neither is offered a button that describes
   * something its agent cannot do.
   *
   * An absent provider means an older host that only ever ran Grok.
   */
  function steerableProvider() {
    return state.activeProvider !== "claude" && state.activeProvider !== "codex";
  }

  /**
   * Rewind and edit-and-resend ride grok's `_x.ai/rewind/*` extension. Codex
   * and Claude answer `unsupported`, and until 2026-09-01 the buttons rendered
   * for them anyway — clicking one produced a host-side warning, which is a
   * poor answer at a desk and NO answer at all on a cloud machine, where
   * nobody is at the screen to read it. Same shape as steerableProvider().
   */
  function rewindCapableProvider() {
    if (state.activeProvider === "claude" || state.activeProvider === "codex") return false;
    // A host older than 4.1.0 classifies rewindSession / editLastMessage as
    // host-local and drops them without a reply, so the buttons would be dead
    // for every remote user who has not updated — and the relay always ships
    // first. Field presence, never a version check; the desk is never gated.
    if (IS_REMOTE && !(state.hostCaps && state.hostCaps.remoteRewind)) return false;
    return true;
  }

  function providerDisplayName(provider) {
    if (provider === "codex") return "Codex";
    if (provider === "claude") return "Claude";
    return "Grok";
  }

  function providerLogoId(provider) {
    if (provider === "codex" || provider === "claude") return provider;
    return "grok";
  }

  function providerLogoMarkup(provider) {
    const id = providerLogoId(provider);
    return `<svg class="provider-logo" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${PROVIDER_LOGO_PATHS[id]}"></path></svg>`;
  }

  function makeProviderGlyph(provider, dotValue, sessionId) {
    const id = providerLogoId(provider);
    const glyph = document.createElement("span");
    glyph.className = "provider-glyph provider-" + id;
    glyph.innerHTML = providerLogoMarkup(id);
    glyph.title = providerDisplayName(id);
    glyph.setAttribute("aria-label", glyph.title);
    if (sessionId) {
      const badge = document.createElement("span");
      badge.className = "provider-status-badge";
      badge.setAttribute("data-session-dot", sessionId);
      applySessionDot(badge, dotValue);
      glyph.appendChild(badge);
    }
    return glyph;
  }

  // Cheap incremental update for a single dot when a `sessionDot` arrives while the
  // popover is open — no full re-render.
  // `root` defaults to the popover. The projects rail carries the same
  // `data-session-dot` attribute, and one id can be on screen in both at once,
  // so callers patch each surface they have rather than assuming one home.
  function patchSessionDot(id, root) {
    const host = root || historyPopover;
    if (!host) return;
    const sel = "[data-session-dot=\"" + (window.CSS && CSS.escape ? CSS.escape(id) : id) + "\"]";
    for (const dot of host.querySelectorAll(sel)) applySessionDot(dot, state.dots[id]);
  }

  // Repo identity, mirroring the host's own `normalizeRepoPath`: trailing
  // separators and slash direction never matter, but **case only folds on
  // Windows**. Folding it everywhere merged `/work/Foo` and `/work/foo` — two
  // genuinely different checkouts on Linux/macOS — into one identity, which the
  // projects rail turns into one project rendering the other's conversations and
  // a click acting on the wrong checkout. The host runs this same rule off
  // `process.platform`; a browser has no such thing, so infer it from the shape
  // of the path the host sent (drive letter, or backslashes).
  // Split on the ONE shape that is unambiguous: a repo cwd is always absolute
  // (the host only catalogues absolute paths), and an absolute path starting
  // with "/" is POSIX. There, case is significant AND a backslash is an ordinary
  // filename character — so neither may be normalised away. Everything else is a
  // Windows spelling (drive letter or UNC), where both fold. Testing for
  // backslashes instead would mis-read a legitimate POSIX directory such as
  // `/srv/Foo\bar` as a Windows path.
  const cwdKey = (cwd) => {
    const raw = String(cwd || "");
    if (raw.charAt(0) === "/") return raw.replace(/\/+$/, "");
    return raw.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  };
  const sameCwd = (a, b) => cwdKey(a) === cwdKey(b);

  // Optimistic writes. Local overlays only — the next frame that names the
  // entity is the authority (confirm, contradict, or refuse). A silent host
  // cannot leave a lie: the overlay expires and the last frame re-renders.
  const pendingRepoColor = createPendingOverlay({
    onExpire() { renderRail(); },
  });
  const pendingRename = createPendingOverlay({
    onExpire() { paintSessionSurfaces(); },
  });

  function repoColorOf(repo) {
    const painted = pendingRepoColor.valueFor(cwdKey(repo && repo.cwd));
    if (painted !== undefined) return painted;
    return typeof repo?.color === "string" ? repo.color : "";
  }

  function sessionRowName(s) {
    const painted = s && pendingRename.valueFor(s.id);
    if (painted !== undefined) return painted || "Untitled";
    return (s && s.displayName) || "Untitled";
  }

  function paintSessionSurfaces() {
    if (!historyPopover.hidden) renderSessionRows();
    renderSessionName();
    renderSessionHead();
    renderRail();
  }

  function paintPendingRepoColor(cwd, color) {
    pendingRepoColor.paint(cwdKey(cwd), color);
    renderRail();
  }

  function paintPendingRename(id, name) {
    if (!id) return;
    pendingRename.paint(id, name);
    paintSessionSurfaces();
  }

  function settlePendingRepoColor(entries) {
    pendingRepoColor.settleAny((entries || []).map((r) => r && cwdKey(r.cwd)).filter(Boolean));
  }

  function settlePendingRename(entries) {
    const pending = pendingRename.peek();
    if (!pending) return false;
    const hit = (entries || []).find((e) => e && e.id === pending.key);
    if (!hit) return false;
    pendingRename.settle(pending.key);
    // The list frame is the authority we just accepted. If the header is
    // still holding a pre-rename sessionName for this id, adopt the row so
    // a late name frame cannot snap the title back for a beat.
    if (state.sessionName && state.sessionName.sessionId === hit.id) {
      state.sessionName = {
        ...state.sessionName,
        name: String(hit.displayName || "New session"),
      };
    }
    return true;
  }
  const uniqueSessionRows = (entries) => {
    const byId = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || !entry.id || byId.has(entry.id)) continue;
      byId.set(entry.id, entry);
    }
    return [...byId.values()];
  };
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

  function repoSwitcherLocked() {
    return state.repoSwitchPending || state.replaying;
  }

  function applyRepoSwitcherVisibility() {
    const on = repoSwitcherAvailable();
    repoBtn.hidden = !on;
    if (!on || repoSwitcherLocked()) repoPopover.hidden = true;
  }

  function renderRepoChip() {
    applyRepoSwitcherVisibility();
    // The conversation header names the repo too, and a switch changes it.
    renderSessionHead();
    if (!repoSwitcherAvailable()) return;
    const locked = repoSwitcherLocked();
    const selected = state.repos.find((r) => sameCwd(r.cwd, state.selectedRepoCwd));
    const label = selected?.label || cwdLeaf(state.selectedRepoCwd || state.activeRepoCwd);
    const browsing = !!state.selectedRepoCwd && !!state.activeRepoCwd &&
      !sameCwd(state.selectedRepoCwd, state.activeRepoCwd);
    repoBtn.disabled = locked;
    repoBtn.classList.toggle("disabled", locked);
    repoBtn.setAttribute("aria-disabled", String(locked));
    repoBtn.classList.toggle("browsing", browsing);
    repoBtn.innerHTML =
      `<span class="repo-chip-icon">${selected?.worktreeLabel ? ICON.gitBranch : ICON.folder}</span>` +
      `<span class="repo-chip-label"></span>${ICON.chevronDown}`;
    repoBtn.querySelector(".repo-chip-label").textContent = label;
    repoBtn.title = locked
      ? "Loading conversation... repository switching is disabled until it finishes."
      : browsing
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
    // Same ordering as the rail — by name. Two lists of the same projects in two
    // different orders is worse than either order on its own.
    for (const repo of railRepos()) {
      const row = document.createElement("div");
      const selected = sameCwd(repo.cwd, state.selectedRepoCwd);
      const live = sameCwd(repo.cwd, state.activeRepoCwd);
      row.className = "repo-row" + (selected ? " selected" : "") + (repo.available ? "" : " unavailable");
      row.title = repo.cwd;

      const main = document.createElement("button");
      main.type = "button";
      main.className = "repo-row-main";
      main.disabled = !repo.available || repoSwitcherLocked();
      main.innerHTML = `<span class="repo-row-icon">${repo.worktreeLabel ? ICON.gitBranch : ICON.folder}</span><span class="repo-row-copy"><span class="repo-row-name"></span><span class="repo-row-meta"></span></span>`;
      main.querySelector(".repo-row-name").textContent = repo.label || cwdLeaf(repo.cwd);
      const meta = main.querySelector(".repo-row-meta");
      meta.textContent = repo.available
        ? [repo.worktreeLabel, live ? "Live" : ""].filter(Boolean).join(" · ")
        : "Unavailable";
      main.onclick = (e) => {
        e.stopPropagation();
        if (!repo.available || repoSwitcherLocked()) return;
        state.repoSwitchPending = true;
        renderRepoChip();
        forgetRememberedSessionByChoice();
        vscode.postMessage({ type: "selectRepo", cwd: repo.cwd });
        closePopovers();
      };
      row.appendChild(main);

      const actions = document.createElement("div");
      actions.className = "history-row-actions repo-row-actions";
      const pin = document.createElement("button");
      pin.type = "button";
      pin.className = "history-action-btn" + (repo.pinned ? " active" : "");
      pin.disabled = repoSwitcherLocked();
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
    const providerCursor = offset > 0 && state.sessionProviderCursor
      ? { providerCursor: state.sessionProviderCursor }
      : {};
    vscode.postMessage({ type: "listSessions", offset, query: state.sessionSearch, ...providerCursor });
  }

  function requestNextSessionsPageIfUnderfilled() {
    const list = historyListEl;
    if (!list || !state.sessionHasMore || state.sessionLoading) return;
    if (list.scrollHeight <= list.clientHeight) {
      const offset = state.sessionNextOffset != null ? state.sessionNextOffset : state.sessions.length;
      const pageKey = `${state.sessionSearch}\n${offset}`;
      if (state.sessionLastAutoPageKey === pageKey) return;
      state.sessionLastAutoPageKey = pageKey;
      requestSessions(offset);
      const more = list.querySelector(".history-more");
      if (more) {
        more.disabled = true;
        more.textContent = "Loading…";
      }
    }
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

  function renderSessionRows(autoPage = true) {
    const list = historyListEl;
    if (!list) return;
    list.innerHTML = "";
    if (state.sessions.length === 0 && !state.sessionHasMore) {
      const empty = document.createElement("div");
      empty.className = "history-empty";
      empty.textContent = state.sessionSearch.trim() ? "No matches." : "No sessions yet.";
      list.appendChild(empty);
    } else if (state.sessions.length > 0) {
      for (const s of state.sessions) list.appendChild(renderSessionRow(s));
    }
    if (state.sessionHasMore) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "history-more";
      more.textContent = state.sessionLoading ? "Loading…" : "Load more";
      more.disabled = state.sessionLoading;
      more.onclick = (event) => {
        event.stopPropagation();
        if (!state.sessionLoading) {
          requestSessions(state.sessionNextOffset != null ? state.sessionNextOffset : state.sessions.length);
          renderSessionRows();
        }
      };
      list.appendChild(more);
    }
    updateHistoryFooter();
    if (autoPage) requestNextSessionsPageIfUnderfilled();
  }

  function renderSessionRow(s) {
      const row = document.createElement("div");
      const displayId = (railDisplayTarget() && railDisplayTarget().id) || state.activeSessionId;
      const active = s.id === displayId;
      row.className = "history-row" + (active ? " active" : "");
      row.dataset.sessionId = s.id || "";

      if (showProviderGlyphs()) {
        row.appendChild(makeProviderGlyph(s.provider, state.dots[s.id], s.id));
      } else {
        const dot = document.createElement("span");
        dot.setAttribute("data-session-dot", s.id);
        applySessionDot(dot, state.dots[s.id]);
        row.appendChild(dot);
      }

      const main = document.createElement("div");
      main.className = "history-row-main";

      if (state.renamingSessionId === s.id) {
        const inp = document.createElement("input");
        inp.type = "text";
        inp.className = "history-rename";
        inp.value = s.displayName;
        inp.onclick = (e) => e.stopPropagation();
        const commit = () => {
          if (state.renamingSessionId !== s.id) return;
          const next = (inp.value || "").trim();
          // An empty box is not "nothing to do" — the host reads it as dropping
          // the custom name, which is the only way back to the title grok gives
          // the conversation. Escape is the cancel; clearing the field is a
          // deliberate act.
          if (next !== s.displayName) {
            vscode.postMessage({ type: "renameSession", id: s.id, name: next });
            paintPendingRename(s.id, next);
          }
          state.renamingSessionId = null;
          renderSessionRows();
        };
        inp.onkeydown = (e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            state.renamingSessionId = null;
            renderSessionRows();
          }
        };
        inp.onblur = commit;
        main.appendChild(inp);
        setTimeout(() => { inp.focus(); inp.select(); }, 0);
      } else {
        const name = document.createElement("div");
        name.className = "history-row-name";
        // Tooltip is the name the USER sees/gave — never a legacy primer-derived
        // summary (rawSummary), which is internal compatibility data.
        name.title = sessionRowName(s);
        // A worktree session gets a branch icon (a TYPE marker in muted gray,
        // off the status-dot palette), not a "(WT)" text prefix like a fork's
        // "(Fork)" — it's an isolated checkout, not a renamed conversation.
        let displayName = sessionRowName(s);
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
          startRailResumeTransition(s.id, s.cwd, s.cwd, s.displayName);
          postResumeSession(s.id, s.cwd, { claim: true });
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
      // The open conversation is deletable here too, where the host can do it:
      // it disposes the CLI before touching the disk — which is what used to
      // make the delete "not stick" — and then starts a fresh conversation in
      // the same project. Against a host that cannot, the button stays away
      // rather than posting a message that comes back refused.
      if (!active || canDeleteActiveSession()) {
      const delBtn = document.createElement("button");
      delBtn.className = "history-action-btn history-action-danger";
      delBtn.innerHTML = ICON.trash;
      delBtn.title = "Delete";
      delBtn.onclick = (e) => {
        e.stopPropagation();
        uiConfirm({
          title: s.displayName ? `Delete "${s.displayName}"?` : "Delete this session?",
          body: deleteSessionWarning(active),
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
    // Where the rail exists the app-wide bar is gone, so `historyBtn` has no box
    // to hang a dropdown off — the conversation header carries its own History
    // icon and that is the anchor. The browser page reparents the popover to
    // match.
    positionDropdownPopover(historyPopover, railHistoryAnchor() || historyBtn);
    historyPopover.hidden = false;
    requestSessions(0);
  }

  function railHistoryAnchor() {
    if (!railAvailable() || !document.body.classList.contains("has-rail")) return null;
    return document.getElementById("session-history") || document.getElementById("session-head-main");
  }

  // ---------- projects rail ----------
  //
  // A persistent left rail: every open project (or every repo with Grok history
  // on remote), each showing its newest few sessions.
  //
  // Gate (capability, not IS_REMOTE / not a host flag):
  //   1. The host shipped a `#projects-rail` mount (desktop getHtml / AFK Pilot
  //      page). VS Code getHtml does not — that absence alone keeps the extension
  //      single-column even when a `repos` frame arrives for clear-all naming.
  //   2. The host has sent a `repos` frame (`state.reposKnown`). An older host
  //      that never sends one gets the plain chat, not an empty sidebar.
  // Desktop is the exception: renderer and host ship together, so there is no
  // version skew. `body.desk` + the rail mount paints the layout chrome from
  // the first frame; catalog data fills in when it arrives. Remotes keep the
  // wait. VS Code never mounts the rail.
  //
  // Rows for a repo the client is NOT currently in arrive on `repoSessions`, a
  // frame older hosts never send. When it never arrives the rail still works:
  // the selected repo's rows come from the ordinary `sessions` frame and the
  // other repos simply stay empty until you open them.

  const RAIL_PREVIEW = 3;      // rows per list before "Show more"
  const RAIL_EXPANDED = 20;    // rows after it — the rail is a jump list, not history
  const RAIL_RECENT_EXPANDED = 10; // RECENT is a shorter cross-project shortcut list
  // Synthetic expand key for the RECENT group.
  const RAIL_RECENT_KEY = "__recent__";

  // A project nobody has touched in a month is not one you are choosing between
  // today, so it drops to Archived on its own — the list stays a list of what you
  // are working on without anyone having to tidy it.
  const RAIL_ARCHIVE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
  // …but never so far that Projects empties out. See railSections.
  const RAIL_ALWAYS_VISIBLE = 3;

  // Generous: the host answers by scanning the session store on disk, and a slow
  // first read must not be mistaken for an extension that cannot answer at all.
  const RAIL_PROBE_TIMEOUT_MS = 8000;
  // A silent host must not strand a highlight forever. 10s is long enough for a
  // cold session/load over a slow link and short enough that a dropped request
  // is still visibly "nothing happened" rather than a stuck selection.
  const RAIL_TRANSITION_TIMEOUT_MS = 10000;

  let railEl = null;
  let railResolved = false;
  const railProbeTimers = {};
  // Monotonic renderer-local counter for railTransition.token. Not a grok
  // session id — never sent to the host; only used so superseded timers and
  // late frames cannot complete a transition that a later click replaced.
  let railTransitionSeq = 0;
  let railTransitionTimer = null;

  /** Host shipped a rail surface (desktop multi-folder / AFK Pilot page). */
  function railMount() {
    return document.getElementById("projects-rail");
  }

  /**
   * Desktop large layout: the host baked `body.desk` and shipped the rail
   * mount. VS Code also uses body.desk but never mounts the rail. Remote
   * mounts the rail without body.desk and still waits for `repos`.
   */
  function desktopLargeLayout() {
    return document.body.classList.contains("desk") && !!railMount();
  }

  /** A cloud machine, as the page that served this client was told by the
   *  relay that provisioned it. */
  function cloudHostLayout() {
    return IS_CLOUD_HOST && !!railMount();
  }

  /**
   * May this surface paint the rail chrome BEFORE the catalog arrives?
   *
   * Only where there is no host version skew to protect against. Desktop
   * qualifies because renderer and host ship together; a cloud machine
   * qualifies because the relay installed that host itself. Everything else
   * waits for a `repos` frame, since an extension older than v2.0.5 never
   * sends one and an empty sidebar is worse than a plain column.
   */
  function railChromeBeforeCatalog() {
    return desktopLargeLayout() || cloudHostLayout();
  }

  /**
   * Rail is live when the mount exists AND (desktop first-frame chrome, or the
   * host has proven it feeds a multi-repo catalog). Never gated on IS_REMOTE.
   */
  function railAvailable() {
    return !!railMount() && (railChromeBeforeCatalog() || state.reposKnown);
  }

  /** The list body. The browser page wraps the rail in fixed chrome (brand,
   *  search, account) and gives the scrolling middle its own element, so the
   *  only thing this file may empty is that middle — clearing the whole aside
   *  would take the chrome with it on every render. Falls back to the aside so
   *  a page without the wrapper still works. */
  function rail() {
    if (!railResolved) {
      railResolved = true;
      const panel = railMount();
      railEl = panel
        ? (document.getElementById("rail-scroll") || panel)
        : null;
      // Once, before anything reads the fold state — renderRail() resolves the
      // mount before it renders a row, so this always lands first.
      if (railEl) loadRailShape();
    }
    return railEl;
  }

  /** The whole panel, chrome included — what gets hidden, and what the drawer
   *  slides. `rail()` is only its scrolling middle. */
  function railPanel() {
    return railMount();
  }

  /** Live filter over what the rail already holds: repo labels and the session
   *  rows already fetched. Deliberately NOT a host search — the host searches one
   *  repo at a time, so a cross-repo query would be one round-trip per project.
   *  History remains the place that reaches everything. */
  function railFilterText() {
    const input = document.getElementById("rail-search");
    return input ? input.value.trim().toLowerCase() : "";
  }

  function railMatches(text) {
    const q = railFilterText();
    if (!q) return true;
    return String(text || "").toLowerCase().includes(q);
  }

  function wireRailSearch() {
    const input = document.getElementById("rail-search");
    if (!input || input.dataset.railWired) return;
    input.dataset.railWired = "1";
    input.oninput = () => renderRail();
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === "Escape" && input.value) { input.value = ""; renderRail(); }
    };
  }

  // ---------- rail overflow menus ----------
  //
  // Anchored to the button but parented to <body> and position:fixed, because
  // the rail is an `overflow: hidden auto` scroller: a menu positioned inside it
  // would be clipped by the very rows it belongs to.
  let railMenuEl = null;

  // The element the open menu hangs off, so the outside-click listener can tell
  // a dismissal from a toggle. Deliberately the live node rather than a key: it
  // only has to survive a single click, and identity is exactly the question.
  let railMenuAnchorEl = null;

  // Project colour swatch popover (sibling of the overflow menu, same anchor
  // discipline). Closed together with the menu so Esc / outside-click never
  // leave a stranded picker after a rail rebuild.
  let railColorPickerEl = null;
  let railColorPickerAnchorEl = null;

  /** Palette the host accepts — keep ids in lockstep with REPO_COLOR_IDS in
   *  sessions.ts. Labels are accessible names for each swatch. */
  const REPO_COLOR_SWATCHES = [
    { id: "", label: "None" },
    { id: "blue", label: "Blue" },
    { id: "teal", label: "Teal" },
    { id: "green", label: "Green" },
    { id: "amber", label: "Amber" },
    { id: "coral", label: "Coral" },
    { id: "purple", label: "Purple" },
  ];

  function closeRailColorPicker() {
    railColorPickerAnchorEl = null;
    if (railColorPickerEl) { railColorPickerEl.remove(); railColorPickerEl = null; }
  }

  function closeRailMenu() {
    railMenuAnchorEl = null;
    if (railMenuEl) { railMenuEl.remove(); railMenuEl = null; }
    closeRailColorPicker();
  }

  /** Position a fixed popover under/above an anchor (shared by menu + colour
   *  picker so they never disagree about zoom/viewport edges). */
  function placeRailPopover(el, anchor, at) {
    const z = chatZoomFactor();
    const vh = unzoomClientPx(window.innerHeight, z);
    const vw = unzoomClientPx(window.innerWidth, z);
    // CSS is max-width: min(280px, 100vw - 16px). An inline max-width
    // overrides that, so the zoom-corrected calc must keep the 280px ceiling
    // and never let the 160px floor exceed the viewport (below 176px).
    const viewportCap = Math.max(0, vw - 16);
    const maxW = Math.min(280, Math.max(Math.min(160, viewportCap), viewportCap));
    el.style.maxWidth = `${Math.round(maxW)}px`;
    // CSS also declares min-width: 190px, and a CSS minimum BEATS an inline
    // maximum — on a tiny zoomed viewport the menu would still overflow. Drop
    // the floor with the cap when the cap falls under it.
    if (maxW < 190) el.style.minWidth = `${Math.round(maxW)}px`;
    const size = el.getBoundingClientRect();
    const gap = 4;
    const menuH = unzoomClientPx(size.height, z);
    const menuW = unzoomClientPx(size.width, z);
    // `at` is a pointer position (right-click); otherwise hang off the control.
    // Both arrive as VISUAL px — body `zoom` scales client rects and pointer
    // coordinates alike, while fixed top/left are layout px.
    const anchorTop = at ? unzoomClientPx(at.y, z) : unzoomClientPx(anchor.getBoundingClientRect().top, z);
    const anchorBottom = at ? anchorTop : unzoomClientPx(anchor.getBoundingClientRect().bottom, z);
    const anchorRight = at ? unzoomClientPx(at.x, z) + menuW : unzoomClientPx(anchor.getBoundingClientRect().right, z);
    let top = anchorBottom + gap;
    if (top + menuH > vh - 8) top = Math.max(8, anchorTop - menuH - gap);
    let left = anchorRight - menuW;
    left = Math.max(8, Math.min(left, vw - menuW - 8));
    el.style.top = `${Math.round(top)}px`;
    el.style.left = `${Math.round(left)}px`;
  }

  /** Right-click opens the same ⋯ menu, at the pointer.
   *
   *  Hover-capable pointers only. On touch a long-press synthesises
   *  `contextmenu`, so wiring it there would hijack the gesture the browser
   *  already uses for selection — and on a phone the rail is a drawer where the
   *  ⋯ buttons are permanently visible anyway (see the `hover: none` rules in
   *  chat.css), so there is nothing to reveal. */
  function wireRailRowContextMenu(row, getAnchor, items, menuKey) {
    if (!row || !window.matchMedia || !window.matchMedia("(hover: hover)").matches) return;
    row.addEventListener("contextmenu", (e) => {
      const anchor = getAnchor();
      if (!anchor) return;
      e.preventDefault();
      e.stopPropagation();
      // Close first so openRailMenu's same-key toggle cannot swallow this as a
      // "clicked the open menu again" and dismiss instead of repositioning.
      closeRailMenu();
      openRailMenu(anchor, typeof items === "function" ? items() : items, menuKey, {
        x: e.clientX,
        y: e.clientY,
      });
    });
  }

  /** Small swatch grid for a project's folder colour. Host-persisted via
   *  setRepoColor; capability-gated by railColorSupported. */
  function openRepoColorPicker(anchor, repo) {
    closeRailColorPicker();
    if (!anchor || !repo) return;
    railColorPickerAnchorEl = anchor;
    const current = repoColorOf(repo);
    const picker = document.createElement("div");
    picker.className = "rail-color-picker";
    picker.setAttribute("role", "listbox");
    picker.setAttribute("aria-label", "Project color");
    const swatches = [];
    for (const sw of REPO_COLOR_SWATCHES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rail-color-swatch" +
        (sw.id ? "" : " is-none") +
        (sw.id === current ? " is-selected" : "");
      if (sw.id) btn.dataset.repoColor = sw.id;
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-label", sw.label);
      btn.setAttribute("aria-selected", sw.id === current ? "true" : "false");
      btn.title = sw.label;
      btn.tabIndex = sw.id === current ? 0 : -1;
      btn.onclick = (e) => {
        e.stopPropagation();
        closeRailColorPicker();
        // Skip a no-op write: re-picking the current colour should not churn
        // the catalog (and a remote round-trip for nothing).
        if (sw.id === current) return;
        vscode.postMessage({ type: "setRepoColor", cwd: repo.cwd, color: sw.id });
        // Paint now. The next `repos` frame that names this cwd is the
        // authority — confirm, contradict, or a silent host's expiry.
        paintPendingRepoColor(repo.cwd, sw.id);
      };
      picker.appendChild(btn);
      swatches.push(btn);
    }
    // Arrow-key roving tabindex across the seven swatches (left/right/up/down
    // all advance in row order — a 7-wide grid is one row on desktop).
    picker.addEventListener("keydown", (e) => {
      const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
      if (!keys.includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      const i = swatches.indexOf(document.activeElement);
      if (i < 0) return;
      let next = i;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % swatches.length;
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + swatches.length) % swatches.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = swatches.length - 1;
      for (const b of swatches) b.tabIndex = -1;
      swatches[next].tabIndex = 0;
      swatches[next].focus();
    });
    document.body.appendChild(picker);
    railColorPickerEl = picker;
    placeRailPopover(picker, anchor);
    const focusBtn = swatches.find((b) => b.classList.contains("is-selected")) || swatches[0];
    if (focusBtn) focusBtn.focus();
  }

  /** items: [{ label, icon, danger, disabled, onSelect }] — a `null` entry is a
   *  separator, which is how the destructive tail is kept away from the thumb.
   *
   *  `at` ({x, y} in VISUAL client px, i.e. straight off a pointer event) opens
   *  the menu at the pointer instead of under the ⋯ button — the right-click
   *  path. The anchor is still passed so dismissal and the toggle keep working
   *  off the control the menu belongs to. */
  function openRailMenu(anchor, items, menuKey, at) {
    // Identify the menu by what it BELONGS to, not by the element it hangs off.
    // The rail re-renders freely and recreates these buttons, so an id stamped
    // on the node was gone by the second click: the toggle compared a fresh
    // element against the open menu, decided it was a different menu, and
    // reopened instead of closing. Clicking the same dots twice did nothing
    // visible, and only clicking elsewhere dismissed it.
    const key = menuKey || anchor.dataset.railMenuId || "";
    const wasMine = !!railMenuEl && !!key && railMenuEl.dataset.anchorId === key;
    closeRailMenu();
    if (wasMine) return;
    if (!anchor.dataset.railMenuId) anchor.dataset.railMenuId = key || String(++openRailMenu.seq);
    railMenuAnchorEl = anchor;

    const menu = document.createElement("div");
    menu.className = "rail-menu";
    menu.dataset.anchorId = key || anchor.dataset.railMenuId;
    menu.setAttribute("role", "menu");
    for (const item of items) {
      if (!item) {
        const sep = document.createElement("div");
        sep.className = "rail-menu-sep";
        menu.appendChild(sep);
        continue;
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rail-menu-item" + (item.danger ? " danger" : "");
      btn.setAttribute("role", "menuitem");
      btn.disabled = !!item.disabled;
      if (item.title) btn.title = item.title;
      // A description is optional and only the Add project menu uses one: its
      // three entries differ by a verb, and "New project" vs "Import a folder"
      // is not self-explanatory until you have used both.
      btn.innerHTML = `<span class="rail-menu-icon">${item.icon || ""}</span>` +
        (item.description
          ? `<span class="rail-menu-text"><span class="rail-menu-label"></span><small class="rail-menu-desc"></small></span>`
          : `<span></span>`);
      if (item.description) {
        btn.classList.add("rail-menu-item-rich");
        btn.querySelector(".rail-menu-label").textContent = item.label;
        btn.querySelector(".rail-menu-desc").textContent = item.description;
      } else {
        btn.lastChild.textContent = item.label;
      }
      btn.onclick = (e) => {
        e.stopPropagation();
        closeRailMenu();
        item.onSelect();
      };
      menu.appendChild(btn);
    }
    document.body.appendChild(menu);
    railMenuEl = menu;

    // Flip up / pull left rather than run off the viewport — the rail sits at the
    // left edge on desktop and the drawer covers the screen on a phone.
    // Body `zoom` scales visual rects; fixed style top/left are layout px.
    placeRailPopover(menu, anchor, at);
    const first = menu.querySelector(".rail-menu-item:not(:disabled)");
    if (first) first.focus();
  }
  openRailMenu.seq = 0;

  // Rail menus are fixed-position under <body>; close on outside click / Esc /
  // resize regardless of remote vs desktop once a rail mount exists (or may).
  document.addEventListener("click", (e) => {
    if (railColorPickerEl) {
      if (railColorPickerEl.contains(e.target)) return;
      if (railColorPickerAnchorEl && railColorPickerAnchorEl.contains(e.target)) return;
      closeRailColorPicker();
      // A colour picker and a menu are never open together (opening either
      // closes the other), so fall through only when no menu is up.
      if (!railMenuEl) return;
    }
    if (!railMenuEl || railMenuEl.contains(e.target)) return;
    // Not the button that owns this menu. That click is a TOGGLE, and this
    // listener is on the capture phase — it runs before the button's own
    // handler, so closing here would let the button reopen the menu it just
    // closed. That is why clicking the same dots twice appeared to do nothing
    // and only clicking elsewhere dismissed it.
    if (railMenuAnchorEl && railMenuAnchorEl.contains(e.target)) return;
    closeRailMenu();
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (railColorPickerEl) { closeRailColorPicker(); return; }
      closeRailMenu();
    }
  });
  window.addEventListener("resize", closeRailMenu);

  /** The ⋯ button itself — same shape for a project row, a conversation row and
   *  the conversation header, so one class carries all three. */
  function railMenuButton(label, items, menuKey) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rail-action-btn rail-menu-btn";
    btn.innerHTML = ICON.ellipsis;
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.setAttribute("aria-haspopup", "menu");
    // Stamped at build time (not only once a menu has been opened from it) so a
    // rebuild can find the replacement button for an already-open menu and
    // re-anchor to it instead of closing. See renderRail.
    if (menuKey) btn.dataset.railMenuKey = menuKey;
    btn.onclick = (e) => {
      e.stopPropagation();
      openRailMenu(btn, typeof items === "function" ? items() : items, menuKey);
    };
    btn.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") e.stopPropagation(); };
    return btn;
  }

  // ---------- remembered rail shape ----------
  //
  // Which projects are folded, and which have been expanded past their preview,
  // are answers to "how do I like my sidebar", not facts about the session — so
  // they outlive the tab. Kept in localStorage rather than the host: this is the
  // BROWSER's view of a catalog it merely reads, and two tabs on two machines
  // are entitled to different shapes. Keyed by device so a second device's rail
  // does not inherit the first one's folds.
  const RAIL_SHAPE_KEY = "grok.remote.railShape";

  function railShapeKey() {
    try {
      return RAIL_SHAPE_KEY + ":" + (new URLSearchParams(location.search).get("device") || "default");
    } catch (_) {
      return RAIL_SHAPE_KEY + ":default";
    }
  }

  function defaultRailGroupCollapsed() {
    return { recent: true, projects: false, archived: true };
  }

  function loadRailShape() {
    if (!railMount()) return;
    try {
      const raw = localStorage.getItem(railShapeKey());
      if (!raw) return;
      const saved = JSON.parse(raw);
      // Shapes only — anything else in there is a corrupted or foreign write and
      // is better ignored than trusted into the render path.
      if (saved && typeof saved === "object") {
        if (saved.collapsed && typeof saved.collapsed === "object") state.railCollapsed = saved.collapsed;
        if (saved.expanded && typeof saved.expanded === "object") state.railExpanded = saved.expanded;
        const groups = defaultRailGroupCollapsed();
        if (saved.groupCollapsed && typeof saved.groupCollapsed === "object") {
          for (const k of Object.keys(groups)) {
            if (typeof saved.groupCollapsed[k] === "boolean") groups[k] = saved.groupCollapsed[k];
          }
        } else if (saved.archiveOpen === true) {
          // Pre-redesign shape: only Archived remembered open/closed.
          groups.archived = false;
        } else if (saved.archiveOpen === false) {
          groups.archived = true;
        }
        state.railGroupCollapsed = groups;
        state.railArchiveOpen = !groups.archived;
      }
    } catch (_) { /* private mode, or a value we did not write */ }
  }

  function saveRailShape() {
    if (!railMount()) return;
    try {
      const groups = state.railGroupCollapsed || defaultRailGroupCollapsed();
      state.railArchiveOpen = !groups.archived;
      localStorage.setItem(railShapeKey(), JSON.stringify({
        collapsed: state.railCollapsed,
        expanded: state.railExpanded,
        groupCollapsed: groups,
        // Keep the legacy key so an older page shell reading this store still
        // understands Archived open/closed until it picks up the redesign.
        archiveOpen: !groups.archived,
      }));
    } catch (_) { /* private mode, or quota */ }
  }

  function railGroupIsCollapsed(name) {
    const groups = state.railGroupCollapsed || defaultRailGroupCollapsed();
    if (typeof groups[name] === "boolean") return groups[name];
    // Archived defaults folded; Recent / Projects default open.
    return name === "archived";
  }

  function setRailGroupCollapsed(name, collapsed) {
    if (!state.railGroupCollapsed) state.railGroupCollapsed = defaultRailGroupCollapsed();
    state.railGroupCollapsed[name] = !!collapsed;
    if (name === "archived") state.railArchiveOpen = !collapsed;
    saveRailShape();
  }


  /** Repos in rail order: the one holding the most recent CONVERSATION, first.
   *  The rail deliberately ignores repo pins, which the VS Code repo picker still
   *  offers — a pin only earns its complexity where recency is a poor answer, and
   *  for projects it never is: the one you touched last is the one you want.
   *  Conversations are different, and keep their pins. */
  /** Projects, by name.
   *
   *  Recency was the obvious ordering and the wrong one. The rail is a place you
   *  navigate by memory — a project sits where you last saw it — and sorting by
   *  activity means the list reorders itself underneath you as you work: start a
   *  conversation and the project you are in jumps to the top, taking every
   *  other row with it. A name does not move, so a click never lands on the row
   *  that slid into place. Recency is still visible where it belongs, on the
   *  conversations inside each project. */
  function railRepos() {
    return state.repos.slice().sort((a, b) =>
      String(a.label || a.cwd || "").localeCompare(
        String(b.label || b.cwd || ""),
        undefined,
        { sensitivity: "base", numeric: true },
      ));
  }

  /** When this project was last worked in, read from its conversations.
   *
   *  Deliberately NOT the catalog's own `updatedAt`, which is the mtime of the
   *  project's session DIRECTORY: emptying a project writes to that directory, so
   *  clearing a project's history shot it straight to the top of the rail — the
   *  one project that demonstrably had no recent activity, presented as the most
   *  recent. Last activity means the last conversation, and a project with none
   *  has none. Falls back to the catalog stamp only while the rows are still
   *  loading, where a settling guess beats an arbitrary order. */
  /** Projects split into the two sections the rail shows them in.
   *
   *  Archiving is derived, never a stored section: one timestamped choice per
   *  project plus an age rule, both read against the project's newest
   *  conversation. That is what makes "working in an archived project brings it
   *  back" need no bookkeeping at all — activity newer than the choice simply
   *  outranks it, and there is no flag left behind to go stale. */
  function railSections() {
    const ordered = railRepos();
    // Host without archive capability (older desktop builds): no Project
    // Archive group and no age rule. Presence of `archived` on rows is the
    // signal — see railArchiveSupported.
    if (!railArchiveSupported()) {
      return { active: ordered, archived: [] };
    }
    const now = Date.now();
    // The floor, and it is a REQUIREMENT rather than a rounding error: however
    // quiet things have been, the newest few projects stay in view. Coming back
    // from three weeks away would otherwise archive every project at once and
    // leave a rail that reads as broken. So yes, three projects can sit in
    // Projects with nothing recent in them — deliberately. It holds back the AGE
    // rule only; an explicit Archive still takes effect immediately, or the
    // control would silently do nothing on the projects you use most.
    // Ranked by ACTIVITY, not by the name order the rail displays. "The newest
    // few stay in view" is a statement about recency; taking the first few rows
    // of an alphabetical list would protect whichever projects happen to start
    // with an early letter and archive the ones actually in use. Display order
    // and this ranking answer different questions and must not share a list.
    const byActivity = state.repos.slice().sort((a, b) => railRepoActivity(b) - railRepoActivity(a));
    const floorKeys = new Set(
      byActivity
        .filter((r) => !sameCwd(r.cwd, state.selectedRepoCwd))
        .slice(0, RAIL_ALWAYS_VISIBLE)
        .map((r) => cwdKey(r.cwd)),
    );
    const active = [];
    const archived = [];
    for (const repo of ordered) (railRepoArchived(repo, floorKeys, now) ? archived : active).push(repo);
    return { active, archived };
  }

  function railRepoArchived(repo, floorKeys, now) {
    const known = railKnownRows(repo);
    const at = railRepoActivity(repo);
    // Your own last word, in force until the project is worked in again — and
    // without the project's own rows there is nothing that could have overruled
    // it, so it stands as given rather than being tested against a guess.
    if (repo.archivedAt > 0 && (!known || repo.archivedAt >= at)) return !!repo.archived;
    // Below here every rule is a GUESS about where you are or how long it has
    // been, and none of them may overrule the line above. The project you are
    // reading is exempt from being archived FOR you -- not from being archived
    // BY you. Ordering these the other way round is what made Archive look
    // broken on the project a machine boots into: the host stored the choice,
    // this returned false, and the row never moved.
    if (sameCwd(repo.cwd, state.selectedRepoCwd)) return false;
    // The age rule NEVER runs on a guess. Without the project's conversations we
    // do not know when it was last worked in: `repo.updatedAt` is the session
    // DIRECTORY's mtime, and that does not move when you continue an existing
    // conversation — only when one is added or removed. Against an extension too
    // old to list another project's sessions that stamp is all there is, and
    // trusting it files a project you use every day under Archived. Better to
    // leave every project in view than to hide the wrong one silently.
    if (!known) return false;
    if (floorKeys.has(cwdKey(repo.cwd))) return false;
    // No conversations at all — nothing to have been recent.
    return at > 0 ? now - at > RAIL_ARCHIVE_AFTER_MS : true;
  }

  /**
   * What the rail should paint as the current conversation.
   *
   * While a click is in flight this is the optimistic target from
   * `railTransition`; once the host confirms, it is the host-owned identity.
   * Callers must NOT write this back into `state.activeSessionId` — that field
   * stays strictly host-confirmed so rename/delete/send/remember cannot act on
   * a pending id.
   *
   * Why this is not `pendingSessionId || activeSessionId`:
   * `railRepoOwnsTarget` needs the full `{id, sessionCwd, repoCwd}` triple. A
   * cross-repo resume has a pending id whose project is not yet
   * `activeRepoCwd`, so an ownership check that only closed over the confirmed
   * globals returned false and the highlight never appeared. The display
   * target carries the project the user clicked so ownership can pass.
   */
  function railDisplayTarget() {
    const t = state.railTransition;
    if (t) {
      if (t.kind === "resume") {
        return {
          id: t.sessionId,
          sessionCwd: t.sessionCwd || t.repoCwd,
          repoCwd: t.repoCwd,
        };
      }
      // kind === "new": synthetic id until an identity frame binds the real one.
      return {
        id: t.resolvedSessionId || ("pending-new:" + t.token),
        sessionCwd: t.repoCwd,
        repoCwd: t.repoCwd,
      };
    }
    return railConfirmedTarget();
  }

  /**
   * The conversation the HOST is actually on — never optimistic.
   *
   * Separate from `railDisplayTarget` because the two answer different
   * questions, and conflating them is a work-loss bug rather than a cosmetic
   * one. Fork / apply / remove now send the conversation's `sessionId` and the
   * host refuses a mismatch, but `newWorktreeSession` is still untargeted, and
   * a mistimed click during a transition is still the wrong thing to offer.
   * Offer them on an optimistic row and clicking a cold session B while A is
   * open gives B a menu that would try to fork A, or remove A's worktree.
   *
   * So: paint with the display target, gate id-less actions on this one.
   */
  function railConfirmedTarget() {
    if (!state.activeSessionId) return null;
    // Confirmed path. Prefer the catalog project that actually lists this
    // session so a worktree's parent (not the worktree path) owns the highlight.
    let repoCwd = state.activeRepoCwd || state.selectedRepoCwd || "";
    for (const repo of state.repos || []) {
      if (sameCwd(repo.cwd, state.activeRepoCwd)) {
        repoCwd = repo.cwd;
        break;
      }
      const rows = railRowsFor(repo);
      if (rows && rows.entries.some(
        (s) => s.id === state.activeSessionId && sameCwd(s.cwd, state.activeRepoCwd),
      )) {
        repoCwd = repo.cwd;
        break;
      }
    }
    return {
      id: state.activeSessionId,
      sessionCwd: state.activeRepoCwd || repoCwd,
      repoCwd,
    };
  }

  /**
   * Whether the ⋯ menu may offer Continue / Apply / Remove.
   *
   * Those actions now name a `sessionId`, and the host refuses a mismatch, but
   * `openSessionReserved` reassigns `this.focused` BEFORE it switches the
   * workspace, starts the session, or emits `sessionName` / `sessions.activeId`.
   *
   * So for the whole length of a rail transition the client genuinely cannot
   * say which conversation these would hit: the clicked row is not confirmed
   * yet, and the previously confirmed row may already have been left. Neither
   * row may offer them. Remove worktree discards unapplied edits, so guessing
   * wrong here is work loss, not a cosmetic slip.
   *
   * Both directions of this were found the hard way: offering them on the
   * PENDING row let B's menu fork A, and the fix for that then let A's menu
   * fork B. The only safe answer is neither, until identity is confirmed.
   */
  function railIdlessActionsAllowed() {
    return !state.railTransition && !state.railIdentityUnknown;
  }

  /**
   * An identity frame arrived. Do we now know what the host is focused on?
   *
   * **Call this AFTER the noteRailTransition* handlers have had their say** —
   * the answer is read off whether a transition survived them. If one did, this
   * frame named some OTHER conversation, so it tells us where the host WAS, not
   * where it is: on rapid A→B→C, B's delayed `activeId` must not disarm the
   * latch while C is still unresolved, or C outliving the watchdog would reopen
   * the id-less actions with the renderer still showing B.
   *
   * With nothing in flight, any identity frame counts. That is what makes this
   * self-healing rather than a latch that sticks forever after a dropped
   * resume: the next ordinary catalog push clears it.
   */
  function noteHostIdentityKnown(sessionId) {
    if (state.railTransition || !state.railIdentityUnknown) return;
    // The paint may have been abandoned by the watchdog, but the REQUEST is
    // still out there — resumes are serialised host-side, so a superseded one
    // can confirm long afterwards. On rapid A→B→C where C outlives the
    // watchdog, B's late frame must not read as "we know where the host is":
    // C is still queued and may already be focused. Only a frame that answers
    // what we last asked for settles it.
    if (!railIdentitySatisfies(sessionId)) return;
    state.railIdentityUnknown = false;
    state.railExpectedIdentity = null;
    // Repaint. Each row's ⋯ menu is a closure that captured the gate value when
    // the row was BUILT, and the transition's own completion already
    // re-rendered before this ran — so without this the actions stay hidden
    // until something unrelated happens to re-render the rail.
    renderRail();
  }

  /** Every conversation id the client can currently see, across all groups. */
  function railKnownSessionIds() {
    const ids = new Set();
    for (const repo of state.repos || []) {
      const known = railKnownRows(repo);
      if (!known) continue;
      for (const s of known.entries) if (s && s.id) ids.add(s.id);
    }
    for (const s of state.sessions || []) if (s && s.id) ids.add(s.id);
    for (const s of state.pinnedSessions || []) if (s && s.id) ids.add(s.id);
    return ids;
  }

  /** Does this identity frame answer the question we last asked the host? */
  function railIdentitySatisfies(sessionId) {
    const e = state.railExpectedIdentity;
    if (!e) return true;
    if (!sessionId) return false;
    if (e.kind === "resume") return sessionId === e.sessionId;
    // New: must be an id we had never seen when the request went out. A
    // superseded resume names a conversation that already existed, so it can no
    // longer masquerade as the one being created.
    return sessionId !== e.previousSessionId
      && !(e.knownIds && e.knownIds.has(sessionId));
  }

  /** Whether THIS project owns the display target (confirmed or optimistic). */
  function railRepoOwnsTarget(repo, row, target) {
    if (!target || !target.id) return false;
    // Explicit catalog project wins — the pending cross-repo case sets this to
    // the row the user clicked before activeRepoCwd has moved.
    if (target.repoCwd && sameCwd(repo.cwd, target.repoCwd)) return true;
    if (sameCwd(repo.cwd, target.sessionCwd)) return true;
    if (row) return sameCwd(row.cwd, target.sessionCwd);
    const rows = railRowsFor(repo);
    return !!rows && rows.entries.some(
      (s) => s.id === target.id && sameCwd(s.cwd, target.sessionCwd),
    );
  }

  /** Whether the live (or pending) conversation is one of THIS project's.
   *
   *  `sessionCwd` is the live session's own cwd, and for a worktree session
   *  that is the worktree — a directory that is deliberately not a catalog row.
   *  So the parent project has to recognise its own conversation by the rows it
   *  actually draws, or the project holding the conversation you are reading
   *  claims to hold nothing. Takes an explicit target so a pending cross-repo
   *  selection still owns its project (see railDisplayTarget). */
  function railRepoOwnsActive(repo, row) {
    return railRepoOwnsTarget(repo, row, railDisplayTarget());
  }

  function isRailPendingSessionId(id) {
    return typeof id === "string" && id.startsWith("pending-new:");
  }

  function isRailPendingRow(s) {
    return !!(s && (s._railPending || isRailPendingSessionId(s.id)));
  }

  function clearRailTransitionTimer() {
    if (railTransitionTimer) {
      clearTimeout(railTransitionTimer);
      railTransitionTimer = null;
    }
  }

  /**
   * Replace any in-flight transition. One at a time; a new click bumps the
   * token so a late frame for the old one cannot complete or clear the new.
   * Navigation is deliberately NOT locked — supersession is the concurrency
   * model.
   */
  function startRailTransition(fields) {
    if (state.sessionSuperseded) clearSessionSuperseded();
    clearRailTransitionTimer();
    const token = ++railTransitionSeq;
    state.railTransition = { token, ...fields };
    // Separate from the transition on purpose. The transition is a UI state and
    // gets torn down by the watchdog and by any uncorrelated error — neither of
    // which tells us anything about the HOST. It reassigns `focused` up front
    // and can take longer than the watchdog on a cold resume, so treating
    // "transition gone" as "identities agree" would re-open the id-less actions
    // while we still do not know what the host is on. Only an identity frame
    // clears this. Fail closed.
    state.railIdentityUnknown = true;
    // Newest request wins: a superseded one may still land, but it no longer
    // answers the question we are asking.
    state.railExpectedIdentity = fields.kind === "resume"
      ? { kind: "resume", sessionId: fields.sessionId }
      : {
        kind: "new",
        previousSessionId: fields.previousSessionId || null,
        // A new conversation has no id until the host mints one, so the only
        // honest correlation is "an id that did not exist when we asked".
        // "Anything but the one we were on" is too weak: resume B, then New,
        // and B's delayed echo — a real id, and not the previous one — passed
        // as confirmation of a conversation the host had not created yet.
        knownIds: railKnownSessionIds(),
      };
    // Highlight without a veil would claim conversation X while Y is still on
    // screen and fully actionable. Pair them so the click is visibly owned.
    veilTranscriptForPendingOpen();
    setConversationLoading(true);
    if (fields.kind === "resume") {
      renderSessionName();
      renderSessionHead();
    }
    const ms = Number(window.__grokRailTransitionTimeoutMs) > 0
      ? Number(window.__grokRailTransitionTimeoutMs)
      : RAIL_TRANSITION_TIMEOUT_MS;
    railTransitionTimer = setTimeout(() => {
      railTransitionTimer = null;
      if (state.railTransition && state.railTransition.token === token) {
        abortRailTransition();
      }
    }, ms);
    renderRail();
  }

  function startRailResumeTransition(sessionId, sessionCwd, repoCwd, displayName) {
    startRailTransition({
      kind: "resume",
      sessionId,
      sessionCwd: sessionCwd || repoCwd,
      repoCwd,
      displayName: displayName || "",
    });
  }

  function startRailNewTransition(repoCwd, phase, previousSessionId) {
    startRailTransition({
      kind: "new",
      repoCwd,
      previousSessionId: previousSessionId || null,
      resolvedSessionId: null,
      phase: phase || "creating",
    });
  }

  /**
   * Drop the optimistic highlight. Does not touch activeSessionId — that is
   * host-owned and may still be the previous conversation, which is exactly
   * the state we want to fall back to when a click never confirms.
   */
  function abortRailTransition() {
    if (!state.railTransition) return;
    clearRailTransitionTimer();
    state.railTransition = null;
    // historyReplay owns the veil while a transcript is materialising; leave
    // it up if we are mid-replay so aborting a superseded click cannot blank a
    // real load still in progress.
    if (!state.replaying) {
      unveilTranscriptAfterFailedOpen();
      setConversationLoading(false);
    }
    renderRail();
    renderSessionName();
    renderSessionHead();
  }

  function completeRailTransition(token) {
    if (!state.railTransition || state.railTransition.token !== token) return;
    clearRailTransitionTimer();
    state.railTransition = null;
    // Identity is confirmed. The veil continues only while the host is still
    // replaying history — otherwise a silent empty new-session would leave
    // "Loading conversation" up forever.
    if (!state.replaying) setConversationLoading(false);
    renderRail();
  }

  /** True when the selected-repo catalog (or a known preview) already lists id. */
  function railCatalogHasSession(sessionId, repoCwd) {
    if (!sessionId || isRailPendingSessionId(sessionId)) return false;
    const has = (list) => Array.isArray(list) && list.some((e) => e && e.id === sessionId);
    if (has(state.railSelectedRows) && sameCwd(repoCwd, state.selectedRepoCwd)) return true;
    if (has(state.sessions) && sameCwd(repoCwd, state.selectedRepoCwd)) return true;
    const preview = state.repoPreviews[cwdKey(repoCwd)];
    if (preview && has(preview.entries)) return true;
    return false;
  }

  /**
   * Identity frames only — see the table on railTransition. A frame that
   * "usually arrives" during the op is not enough; it must name the result.
   */
  function noteRailTransitionSessionName(msg) {
    const t = state.railTransition;
    if (!t || !msg || !msg.sessionId) return;
    if (t.kind === "resume") {
      if (msg.sessionId === t.sessionId) completeRailTransition(t.token);
      return;
    }
    // kind === "new": bind the real id only when it is not the conversation we
    // left, and it lives in the project we asked to create in. Multi-tab:
    // another tab's sessionName for a different id must not bind ours.
    if (msg.sessionId === t.previousSessionId) return;
    const msgCwd = msg.cwd || "";
    if (msgCwd && t.repoCwd && !sameCwd(msgCwd, t.repoCwd)) return;
    t.resolvedSessionId = msg.sessionId;
    // Keep the synthetic row until the catalog actually contains this id so a
    // "placeholder next to the real row" is impossible: either we show the
    // synthetic, or the catalog row, never both.
    if (railCatalogHasSession(t.resolvedSessionId, t.repoCwd)) {
      completeRailTransition(t.token);
    } else {
      renderRail();
    }
  }

  function noteRailTransitionSessions(msg, entries) {
    const t = state.railTransition;
    if (!t || !msg || msg.activeId === undefined) return;
    const activeId = msg.activeId || null;
    if (t.kind === "resume") {
      // Confirm only when THIS tab's activeId is the one we asked to open.
      // Catalog refreshes fan out to every tab, but each tab gets its own
      // activeId — matching on presence of the row alone would let tab A's
      // echo clear tab B's pending highlight.
      if (activeId && activeId === t.sessionId) completeRailTransition(t.token);
      return;
    }
    // kind === "new"
    if (!activeId || activeId === t.previousSessionId) return;
    if (!t.resolvedSessionId) t.resolvedSessionId = activeId;
    const list = Array.isArray(entries) ? entries : [];
    const present = list.some((e) => e && e.id === t.resolvedSessionId)
      || railCatalogHasSession(t.resolvedSessionId, t.repoCwd);
    if (present && t.resolvedSessionId === activeId) {
      completeRailTransition(t.token);
    } else {
      renderRail();
    }
  }

  function noteRailTransitionRepos(msg) {
    const t = state.railTransition;
    if (!t || t.kind !== "new") return;
    // repos may advance a necessary project move; it never confirms a resume
    // and never finishes a new-session on its own.
    if (t.phase === "switching-repo" && sameCwd(msg.selectedCwd, t.repoCwd)) {
      t.phase = "creating";
    }
  }

  /**
   * Inject the new-conversation placeholder for the target project only.
   * Never mutates state.sessions / railSelectedRows — the synthetic row lives
   * only in the render path.
   */
  function railEntriesWithNewPlaceholder(repo, entries) {
    const t = state.railTransition;
    const list = Array.isArray(entries) ? entries.slice() : [];
    if (!t || t.kind !== "new" || !sameCwd(repo.cwd, t.repoCwd)) return list;
    if (t.resolvedSessionId && list.some((e) => e && e.id === t.resolvedSessionId)) {
      // Real row is here — no synthetic. Transition completion is handled by
      // the identity-frame notes; this only prevents a double paint.
      return list;
    }
    const id = t.resolvedSessionId || ("pending-new:" + t.token);
    // Already showing this id as a real row (above) or we are about to inject.
    if (list.some((e) => e && e.id === id)) return list;
    list.unshift({
      id,
      cwd: t.repoCwd,
      displayName: "New session",
      updatedAt: Date.now(),
      createdAt: Date.now(),
      numMessages: 0,
      rawSummary: "",
      provider: repo.defaultProvider || state.activeProvider,
      _railPending: true,
    });
    return list;
  }

  /** Whether the host can record an archive choice. `archived` rides on every
   *  catalog row from a host that knows about it, empty or not, so its presence
   *  is the capability — a version number would be the wrong question, and an
   *  absent field cannot be told from "nothing archived yet". */
  function railArchiveSupported() {
    return state.repos.some((r) => typeof r.archived === "boolean");
  }

  /** Whether the host can store a project folder colour. Same capability rule
   *  as archive: `color` is present (even as `""`) on every row from a host that
   *  knows about it, and omitted entirely by one that does not. */
  function railColorSupported() {
    return state.repos.some((r) => typeof r.color === "string");
  }

  /** Rows we can draw conclusions FROM, as opposed to rows we merely have none
   *  of yet. The selected project's holder starts empty and stays empty until
   *  its first list arrives, so an empty one proves nothing about the project —
   *  and every question the rail asks of it ("when was this last worked in",
   *  "is there anything here to clear") gets the wrong answer from that. One
   *  gate, because two of them drifted apart the first time. */
  function railKnownRows(repo) {
    const rows = railRowsFor(repo);
    if (!rows) return null;
    if (!rows.entries.length && rows.entries === state.railSelectedRows && !state.railSelectedRowsKnown) {
      return null;
    }
    return rows;
  }

  function railRepoActivity(repo) {
    const rows = railKnownRows(repo);
    if (!rows) return repo.updatedAt || 0;
    let newest = 0;
    for (const s of rows.entries) {
      const at = Number(s.updatedAt) || 0;
      if (at > newest) newest = at;
    }
    return newest;
  }

  /** Preview rows for a repo. The SELECTED repo reads the live `sessions` list
   *  rather than its cached preview: that list is the one the host keeps pushing
   *  on every rename/delete/new-session, so the repo you are working in stays
   *  correct without the rail asking for anything. */
  function railRowsFor(repo) {
    if (sameCwd(repo.cwd, state.selectedRepoCwd)) {
      // Deliberately NOT `state.sessions`: that list follows the history
      // popover's search, and it also still describes the PREVIOUS repo in the
      // beat between the catalog naming a new one and its list arriving —
      // rendering it then is cross-repo bleed, not a cosmetic lag. This holder
      // is written only by unfiltered first pages, so it always means "this
      // repo's newest conversations".
      // Mid-switch the holder still describes the repo we left, so fall back to
      // what we already know about THIS repo — the preview fetched while it was
      // a sibling. Blanking the section instead would throw away rows we hold
      // and make a switch look like a load; the controls are disabled during the
      // switch anyway, so showing them costs nothing and keeps the conversation
      // you just clicked on screen.
      if (state.railSessionsStale) {
        const known = state.repoPreviews[cwdKey(repo.cwd)];
        return known ? { entries: known.entries, total: known.total } : null;
      }
      return { entries: state.railSelectedRows, total: state.railSelectedRows.length };
    }
    const cached = state.repoPreviews[cwdKey(repo.cwd)];
    return cached ? { entries: cached.entries, total: cached.total } : null;
  }

  /** Ask the host for previews of the repos we have no rows for. Skipped
   *  entirely until the host proves it answers — one probe for the first repo,
   *  and the rest only once a `repoSessions` frame has come back. Without this
   *  an old host would be sent one dead request per repo on every catalog push. */
  function requestRailPreviews() {
    if (!rail() || !state.reposKnown) return;
    // Before capability proof there is exactly one probe. If it failed, only
    // the visible Retry may send it again; catalog repaints are not retries.
    if (!state.repoPreviewsSupported && Object.keys(state.repoPreviewErrors).length) return;
    const wanted = railRepos().filter(
      (r) => r.available
        && !sameCwd(r.cwd, state.selectedRepoCwd)
        && !state.repoPreviews[cwdKey(r.cwd)]
        && !state.repoPreviewErrors[cwdKey(r.cwd)],
    );
    if (!wanted.length) return;
    const ask = state.repoPreviewsSupported ? wanted : wanted.slice(0, 1);
    for (const r of ask) requestRailPreview(r);
  }

  function requestRailPreview(repo) {
    const key = cwdKey(repo.cwd);
    if (state.repoPreviewsAsked[key]) return;
    let accepted;
    try {
      accepted = vscode.postMessage({ type: "listRepoSessions", cwd: repo.cwd, limit: RAIL_EXPANDED });
    } catch (err) {
      failRailPreview(repo.cwd, "transport-refused");
      return;
    }
    if (accepted === false) {
      failRailPreview(repo.cwd, "transport-refused");
      return;
    }
    state.repoPreviewsAsked[key] = true;
    armRailProbeDeadline(repo.cwd);
    if (accepted && typeof accepted.then === "function") {
      accepted.then((sent) => {
        if (sent === false && state.repoPreviewsAsked[key]) failRailPreview(repo.cwd, "transport-refused");
      }, () => {
        if (state.repoPreviewsAsked[key]) failRailPreview(repo.cwd, "transport-refused");
      });
    }
  }

  function clearRailProbeDeadline(cwd) {
    const key = cwdKey(cwd);
    if (!railProbeTimers[key]) return;
    clearTimeout(railProbeTimers[key]);
    delete railProbeTimers[key];
  }

  function failRailPreview(cwd, reason) {
    const key = cwdKey(cwd);
    clearRailProbeDeadline(cwd);
    delete state.repoPreviewsAsked[key];
    state.repoPreviewErrors[key] = reason || "no-answer";
    console.warn(`[rail] listRepoSessions failed: ${state.repoPreviewErrors[key]}`);
    renderRail();
  }

  /** Every accepted request owns a deadline. Expiry is a load failure, never a
   *  version verdict, and releases the in-flight slot for the visible Retry. */
  function armRailProbeDeadline(cwd) {
    const key = cwdKey(cwd);
    clearRailProbeDeadline(cwd);
    const ms = Number(window.__grokRailProbeTimeoutMs) > 0
      ? Number(window.__grokRailProbeTimeoutMs)
      : RAIL_PROBE_TIMEOUT_MS;
    railProbeTimers[key] = setTimeout(() => {
      delete railProbeTimers[key];
      if (!state.repoPreviewsAsked[key]) return;
      failRailPreview(cwd, "deadline-expired");
    }, ms);
  }

  /** Open the project the live conversation just moved into, once. A fold is a
   *  preference set at some earlier moment and must not hide where you are now —
   *  but that is a correction owed when the conversation ARRIVES, not a reason to
   *  refuse the fold forever. Keyed on the repo changing, so re-collapsing the
   *  project you are working in sticks until you go somewhere else. */
  /** Reconnect abandons every old in-flight request; the new socket may retry. */
  function forgetRailProbeVerdict() {
    for (const timer of Object.values(railProbeTimers)) clearTimeout(timer);
    for (const key of Object.keys(railProbeTimers)) delete railProbeTimers[key];
    state.repoPreviewsAsked = {};
    state.repoPreviewErrors = {};
  }

  function railFollowLiveRepo() {
    // Via the display target (confirmed or pending), not the host-confirmed
    // active cwd alone: a worktree conversation reports the WORKTREE as its
    // cwd and a worktree is deliberately not a catalog row, so keying on the
    // path alone would never match the project that actually holds it — and
    // that project would stay folded. A pending cross-repo click must also
    // open the project it is about to land in.
    const target = railDisplayTarget();
    const owner = target
      ? (state.repos || []).find((repo) => railRepoOwnsTarget(repo, null, target))
      : undefined;
    const live = owner ? cwdKey(owner.cwd) : "";
    if (live === state.railLiveRepoKey) return;
    state.railLiveRepoKey = live;
    if (live) delete state.railCollapsed[live];
  }

  /**
   * Carry the pointer's hover across a wholesale rebuild.
   *
   * `renderRail()` empties the rail and builds it again, and one boot does that
   * a dozen times or more as each project's rows arrive. The browser recomputes
   * :hover only AFTER the lifecycle that paints the new nodes, so the row under
   * a cursor that never moved paints WITHOUT its hover fill and without its
   * action buttons for one frame, every time — which is the blinking the owner
   * saw while the rail loaded. .rail-rebuilding only silenced the fade; the
   * frame at the wrong state was still painted.
   *
   * So find the row the pointer is over in the same task that builds it and mark
   * it, before anything is painted. The mark is dropped on the next real pointer
   * move, which is exactly when :hover becomes authoritative again.
   */
  let railPointerXY = null;
  let railHoverHeld = null;

  function railDropHoverHold() {
    if (railHoverHeld) railHoverHeld.classList.remove("rail-hover-hold");
    railHoverHeld = null;
  }

  function railHoldHoverAfterRebuild() {
    railDropHoverHold();
    if (!railPointerXY || typeof document.elementFromPoint !== "function") return;
    const at = document.elementFromPoint(railPointerXY.x, railPointerXY.y);
    const row = at && at.closest ? at.closest(".rail-session, .rail-repo-head") : null;
    if (!row) return;
    row.classList.add("rail-hover-hold");
    railHoverHeld = row;
  }

  document.addEventListener("pointermove", (e) => {
    railPointerXY = { x: e.clientX, y: e.clientY };
    railDropHoverHold();
  }, true);
  // Leaving the window (or a touch ending) means there is no pointer to carry.
  // documentElement, and NOT capturing: pointerleave does not bubble, but a
  // capturing listener on document would still see the copy fired at every row
  // the pointer crosses, and switch the carry off on the first move.
  document.documentElement.addEventListener("pointerleave", () => { railPointerXY = null; railDropHoverHold(); });
  document.addEventListener("pointercancel", () => { railPointerXY = null; railDropHoverHold(); }, true);

  function renderRail() {
    const root = rail();
    if (!root) return;
    railFollowLiveRepo();
    // Mount + `repos` frame (+ non-empty catalog). A host that never sends
    // `repos` keeps the plain single-column chat; no mount (VS Code) never
    // lights the rail even when repos arrives for clear-all.
    // Desktop paints the rail chrome from the first frame (no catalog wait).
    // An empty catalog normally means "this host has nothing to show" — but on a
    // host that can ADD a project, an empty rail is the one screen where the
    // user most needs the rail, because it is where the only useful control
    // lives. Hiding it made the empty-state action unreachable and left the
    // File menu — which the desktop hides — as the sole route in.
    const on = railChromeBeforeCatalog() ||
      (railAvailable() && (state.repos.length > 0 || canAddProjectFolder()));
    const panel = railPanel();
    if (panel) panel.hidden = !on;
    root.hidden = !on;
    document.body.classList.toggle("has-rail", on);
    // The rail's arrival moves where conversation controls live — `.top-bar` is
    // hidden from here on — so the file button has to be re-homed with it. It is
    // usually built long before `repos` lands, i.e. while the top bar was still
    // the right answer. Re-place only: a full ensure() would re-render the file
    // panel on every rail rebuild, and a session load produces a burst of those.
    const filesBtn = document.getElementById("files-browse-btn");
    if (filesBtn) placeRemoteFilesButton(filesBtn);
    if (!on) {
      const openMenuKey = railMenuEl ? railMenuEl.dataset.anchorId || "" : "";
      renderSessionHead();
      reanchorOpenRailMenu(openMenuKey);
      return;
    }
    wireRailSearch();
    // The rail rebuilds itself wholesale, and a session load produces a burst of
    // frames that each trigger one. Closing the menu here meant an open ⋯ was
    // slammed shut repeatedly mid-load — the menu could not be kept open at all
    // while the thing you were opening was still opening. The menu is parented
    // to <body>, so the wipe below does not destroy it; only its anchor button
    // dies. Remember which one it belonged to and re-anchor after the rebuild.
    const openMenuKey = railMenuEl ? railMenuEl.dataset.anchorId || "" : "";
    // Same burst, same cause, second symptom: the hover action buttons start at
    // opacity 0 and fade in over .1s, so recreating them under a stationary
    // cursor replayed that fade on every rebuild — a blinking row. Suppress the
    // transition for this repaint only; hovering normally still fades.
    root.classList.add("rail-rebuilding");

    root.innerHTML = "";
    syncGearPlacement();
    const q = railFilterText();
    let shownAnything = false;

    // Four groups: PINNED (always open) → RECENT → PROJECTS → PROJECT ARCHIVE.
    // Labels are title-case in the DOM; CSS text-transform: uppercase paints them.
    // PINNED is not collapsible — that is what pinning means.
    // PROJECT ARCHIVE only mounts when ≥1 project qualifies (put-away or age-quiet);
    // an empty section is deliberately omitted rather than an always-on empty state.
    const pinned = uniqueSessionRows(state.pinnedSessions).filter(
      (s) => railMatches(s.displayName) || railMatches(railRepoLabelFor(s.cwd)),
    );
    if (pinned.length) {
      root.appendChild(railStaticGroupHead("Pinned"));
      const pinList = document.createElement("div");
      pinList.className = "rail-list rail-pinned";
      for (const s of pinned) {
        pinList.appendChild(renderRailSessionRow(s, { cwd: s.cwd, available: true }, { showRepo: true }));
      }
      root.appendChild(pinList);
      shownAnything = true;
    }

    // RECENT: most recent across every loaded project, including pinned rows.
    // Duplication with PINNED / PROJECTS is intentional — a shortcut, not a
    // partition. Dedupe is PER GROUP only (owner, 2026-08-13): a cross-group
    // claim made a session vanish from under its project while Recent held it.
    const recentAll = railRecentRows().filter(
      (s) => railMatches(s.displayName) || railMatches(railRepoLabelFor(s.cwd)),
    );
    if (recentAll.length) {
      const forcedOpen = !!q;
      const open = forcedOpen || !railGroupIsCollapsed("recent");
      root.appendChild(railCollapsibleGroupHead({
        title: "Recent",
        group: "recent",
        open,
        forcedOpenBySearch: forcedOpen,
        openTitle: "Hide recent conversations",
        closedTitle: "Show recent conversations",
        searchTitle: "Open while your search matches a conversation",
      }));
      if (open) {
        const list = document.createElement("div");
        list.className = "rail-list rail-recent";
        appendRailSessionSlice(list, recentAll, RAIL_RECENT_KEY, (s) =>
          renderRailSessionRow(s, { cwd: s.cwd, available: true }, { showRepo: true }),
          RAIL_RECENT_EXPANDED,
        );
        root.appendChild(list);
      }
      shownAnything = true;
    }

    // While filtering, a project earns its place either by its own name (then it
    // shows all its rows) or by holding a matching conversation (then it shows
    // only those). Projects that do neither are dropped rather than left as empty
    // headings — a filtered list that still lists everything is not a filter.
    const sections = railSections();
    const repos = sections.active.filter((repo) => !q || railRepoHasMatch(repo));
    const archivedRepos = sections.archived.filter((repo) => !q || railRepoHasMatch(repo));
    // TWIN of the same guard in projects-rail.js. Archiving the last project
    // used to take the header, the "+" and the wide add target with it, leaving
    // a rail with nothing to press -- and `!shownAnything` could not rescue it,
    // because the archive section below had already set it.
    const emptyProjects = !repos.length && !q && archivedRepos.length > 0;
    if (repos.length || emptyProjects) {
      const forcedOpen = !!q;
      const open = forcedOpen || !railGroupIsCollapsed("projects");
      root.appendChild(railCollapsibleGroupHead({
        title: "Projects",
        group: "projects",
        open,
        forcedOpenBySearch: forcedOpen,
        openTitle: "Hide projects",
        closedTitle: "Show projects",
        searchTitle: "Open while your search matches a project",
        action: canAddProjectFolder() ? railAddProjectButton : undefined,
      }));
      if (open) {
        const list = document.createElement("div");
        list.className = "rail-list rail-projects";
        for (const repo of repos) list.appendChild(renderRailRepo(repo, false));
        root.appendChild(list);
        if (emptyProjects) root.appendChild(railNote("Every project is archived."));
        // Full-width target under the list, not only the small "+" in the group
        // head. With one project or none the rail is mostly empty space and the
        // header glyph is easy to miss — and on a phone, easy to miss AND hard
        // to hit. Same control, said where there is room to say it.
        if (canAddProjectFolder() && !q) root.appendChild(railAddProjectWide());
      }
      shownAnything = true;
    }

    // Project archive: put-away + age-quiet projects. Folded by default; search opens it.
    const archived = archivedRepos;
    if (archived.length) {
      const forcedOpen = !!q;
      const open = forcedOpen || !railGroupIsCollapsed("archived");
      root.appendChild(railCollapsibleGroupHead({
        title: "Project Archive",
        group: "archived",
        open,
        forcedOpenBySearch: forcedOpen,
        icon: ICON.archive,
        openTitle: "Hide archived projects",
        closedTitle: "Show archived projects",
        searchTitle: "Open while your search matches an archived project",
      }));
      if (open) {
        const list = document.createElement("div");
        list.className = "rail-list rail-archived";
        for (const repo of archived) list.appendChild(renderRailRepo(repo, true));
        root.appendChild(list);
      }
      shownAnything = true;
    }

    if (!shownAnything) {
      if (!state.reposKnown && railChromeBeforeCatalog()) {
        root.appendChild(railNote("Loading…"));
      } else if (!q && canAddProjectFolder()) {
        // An empty rail that only says "No projects yet" is a dead end on the
        // one screen where the user has nothing else to click.
        const empty = railNote("No projects yet");
        empty.appendChild(railAddProjectWide());
        root.appendChild(empty);
      } else {
        root.appendChild(railNote(q ? "No matches." : "No projects yet"));
      }
    }

    // Re-anchor AFTER renderSessionHead: the top-right ⋯ lives in
    // #session-head-actions (key "session-head"), which fillSessionHeadActions
    // rebuilds. Searching only `root` here used to miss that button and slam
    // the menu shut on every catalog frame — the thing the owner hit while
    // projects were still loading. Search the document so both a rail-row
    // menu and the header menu survive the wipe.
    renderSessionHead();
    reanchorOpenRailMenu(openMenuKey);
    // Colour picker is one-shot and short-lived — the rebuild destroys its
    // anchor button, and re-opening it mid-catalog-refresh is not worth the
    // bookkeeping. Closing avoids a fixed popover stranded over a gone row.
    if (railColorPickerEl) closeRailColorPicker();
    railHoldHoverAfterRebuild();
    // Let the browser paint this rebuild with transitions off, then restore them
    // so an ordinary hover still fades. rAF (not a timer) so it lands after the
    // paint rather than at an arbitrary later moment.
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => root.classList.remove("rail-rebuilding"));
    } else {
      root.classList.remove("rail-rebuilding");
    }
  }

  /** Re-hang an open ⋯ on the button that replaced its anchor, or close it
   *  if that row/header is gone. Searches the whole document, not just the
   *  rail: the conversation overflow is outside `#projects-rail`. */
  function reanchorOpenRailMenu(openMenuKey) {
    if (!openMenuKey) return;
    const esc = window.CSS && CSS.escape ? CSS.escape(openMenuKey) : openMenuKey;
    const anchor = document.querySelector('[data-rail-menu-key="' + esc + '"]');
    if (anchor) {
      railMenuAnchorEl = anchor;
      // Re-place it. Keeping the menu open but leaving it at the old fixed
      // coordinates is worse than closing it: rows insert and reorder as
      // frames arrive, so the menu would end up beside whichever row moved
      // into that spot while still acting on the one it was opened from.
      if (railMenuEl) placeRailPopover(railMenuEl, anchor);
    } else closeRailMenu();
  }

  /** Non-collapsible group label (PINNED). */
  function railStaticGroupHead(title) {
    const head = document.createElement("div");
    head.className = "rail-head";
    head.innerHTML = `<span class="rail-head-title"></span>`;
    head.querySelector(".rail-head-title").textContent = title;
    return head;
  }

  /**
   * Collapsible group header: label first, chevron AFTER (not before).
   * PINNED never uses this.
   */
  function railCollapsibleGroupHead(opts) {
    const head = document.createElement("div");
    head.className = "rail-head rail-head-fold";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rail-head-btn";
    btn.setAttribute("aria-expanded", String(opts.open));
    let html = "";
    if (opts.icon) html += `<span class="rail-head-icon">${opts.icon}</span>`;
    html += `<span class="rail-head-title"></span>`;
    html += `<span class="rail-head-twisty">${opts.open ? ICON.chevronDown : ICON.chevronRight}</span>`;
    btn.innerHTML = html;
    btn.querySelector(".rail-head-title").textContent = opts.title;
    btn.disabled = !!opts.forcedOpenBySearch;
    btn.title = opts.forcedOpenBySearch
      ? (opts.searchTitle || "Held open by search")
      : (opts.open ? opts.openTitle : opts.closedTitle);
    btn.onclick = (e) => {
      e.stopPropagation();
      // Toggle: currently open → collapse; currently closed → expand.
      setRailGroupCollapsed(opts.group, opts.open);
      renderRail();
    };
    head.appendChild(btn);
    if (opts.action) head.appendChild(opts.action());
    return head;
  }

  /**
   * "Add project" — capability, not a host flag. Three ways in now, and they do
   * not all have the same reach: opening the native picker is host-local (a
   * dialog on the desk that a phone could not see or answer), while naming a
   * new project or cloning a URL are things a remote CAN do, because the host
   * derives the destination rather than being handed one. So the control shows
   * wherever at least one entry is available, and the menu carries whichever
   * ones are.
   *
   * VS Code answers these messages too, but this rail is not where it lands:
   * `railAvailable()` needs a rail MOUNT and the VS Code chat view has none —
   * it gets a separate `grok.projects` view (media/projects-rail.js), which
   * carries its own copy of this control.
   */
  /**
   * "+ Add project", full width, at button height.
   *
   * The TWIN of addProjectWideButton in projects-rail.js — the two rails are
   * separate implementations and have drifted into different wording before,
   * which is why the clone hint was moved to a shared builder. Keep these two
   * in step: same class, same label, same behaviour. It replaces the empty
   * state's text link rather than joining it; a link and a button offering one
   * action in one rail is a second mechanism, not a second affordance.
   */
  function railAddProjectWide() {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "rail-add-project-wide";
    const plus = document.createElement("span");
    plus.className = "rail-add-project-wide-plus";
    plus.setAttribute("aria-hidden", "true");
    plus.textContent = "+";
    add.appendChild(plus);
    add.appendChild(document.createTextNode("Add project"));
    add.onclick = (e) => {
      e.stopPropagation();
      openAddProjectMenu(add);
    };
    return add;
  }

  function railAddProjectButton() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rail-action-btn rail-add-project";
    btn.innerHTML = ICON.plus;
    btn.title = "Add project";
    btn.setAttribute("aria-label", "Add project");
    btn.onclick = (e) => {
      e.stopPropagation();
      openAddProjectMenu(btn);
    };
    return btn;
  }

  /**
   * What this host offers as ways into a project.
   *
   * Importing needs a native picker, so it stays desk-only exactly as it always
   * was. Creating and cloning take a NAME and a URL — the host derives the
   * destination inside its own root — so they work from a phone, which is the
   * whole reason they exist as separate messages rather than as arguments to
   * `addProjectFolder`.
   */
  function addProjectCaps() {
    const caps = state.hostCaps || {};
    return {
      appPurpose: state.appPurpose === "coding" ? "coding" : "knowledge",
      canImport: !IS_REMOTE && caps.addProjectFolder === true,
      canCreate: caps.createProject === true,
      canClone: caps.cloneProject === true,
    };
  }

  /**
   * May this surface put a project away?
   *
   * NOT canAddProjectFolder(), and the difference is the whole bug. That helper
   * used to mean "the native picker is here" — false on every remote, so Hide
   * never drew there and gate and action agreed. Then create and clone shipped
   * as remote-capable ways IN, the helper started answering true on a remote,
   * and Hide came with it: drawn, posted, and dropped by the host's policy
   * without a word. The owner found it on a cloud machine.
   *
   * Its own capability now, advertised only where the action can be honoured.
   */
  function canRemoveProjectFolder() {
    const caps = state.hostCaps || {};
    return caps.removeProjectFolder === true;
  }

  function canAddProjectFolder() {
    const caps = addProjectCaps();
    return caps.canImport || caps.canCreate || caps.canClone;
  }

  const ADD_PROJECT_ICON = {
    "new": `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/><path d="M12 10v6M9 13h6"/></svg>`,
    "import": `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>`,
    clone: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M6 15V9a3 3 0 0 1 3-3h6"/></svg>`,
  };

  /**
   * Open the Add project menu — or, when this host offers exactly one way in,
   * just do that one thing.
   *
   * A menu with a single item is a click that asks permission to be a click.
   * Older hosts advertise only `addProjectFolder`, so on those this control
   * behaves exactly as it did before, with no menu at all.
   */
  function openAddProjectMenu(anchor) {
    const helpers = window.GrokWebviewHelpers;
    if (!helpers || typeof helpers.addProjectMenuItems !== "function") {
      vscode.postMessage({ type: "addProjectFolder" });
      return;
    }
    const spec = helpers.addProjectMenuItems(addProjectCaps());
    const run = (id) => {
      // The knowledge-work hint acts instead of instructing: it opens the
      // setting that would put Clone in this menu.
      if (id === "import") vscode.postMessage({ type: "addProjectFolder" });
      else openAddProjectForm(id);
    };
    // One way in is a click, not a menu that asks permission to be a click.
    // NONE at all means the host has not said yet — the no-project onboarding
    // card can be on screen before `initialState` lands, and its button has to
    // do something. Falling through to the picker is what it did before.
    if (spec.length <= 1) { run(spec.length ? spec[0].id : "import"); return; }
    openRailMenu(
      anchor,
      spec.map((item) => ({
        label: item.label,
        description: item.description,
        icon: ADD_PROJECT_ICON[item.id] || "",
        onSelect: () => run(item.id),
      })),
      "add-project",
    );
  }

  let addProjectFormApi = null;
  let addProjectFormScrim = null;
  let addProjectFormKeydown = null;

  /**
   * Cancel a GitHub device login, but only at a host that knows what that
   * means. An older one maps every unrecognised provider to `grok`, so sending
   * it there either does nothing (no Grok login running) or cancels somebody
   * else's Grok sign-in. Silence costs the abandoned login its 15-minute
   * timeout, which is exactly the behaviour those hosts already had.
   */
  function cancelGithubDeviceLoginIfSupported() {
    if (IS_REMOTE && !(state.hostCaps && state.hostCaps.remoteGithubToken)) return;
    vscode.postMessage({ type: "cancelDeviceLogin", provider: "github" });
  }

  function closeAddProjectForm() {
    const wasClone = !!(addProjectFormApi && addProjectFormApi.el && addProjectFormApi.el.dataset.kind === "clone");
    if (wasClone) {
      state.projectGithub = null;
      cancelGithubDeviceLoginIfSupported();
    }
    if (addProjectFormScrim) addProjectFormScrim.remove();
    // Capture-phase, so it must come off again — a listener left behind would
    // swallow Escape everywhere else in the app for the rest of the session.
    if (addProjectFormKeydown) document.removeEventListener("keydown", addProjectFormKeydown, true);
    addProjectFormKeydown = null;
    addProjectFormScrim = null;
    addProjectFormApi = null;
  }

  /**
   * The name/URL form, over a scrim.
   *
   * Modal on purpose: it is two fields and one button, and the rail underneath
   * re-renders on every catalog frame — an inline form would be rebuilt out
   * from under the caret, which is the bug the routines form spent a round on.
   */
  function openAddProjectForm(kind) {
    const helpers = window.GrokWebviewHelpers;
    if (!helpers || typeof helpers.addProjectForm !== "function") return;
    closeAddProjectForm();
    closeRailMenu();
    if (kind === "clone") {
      state.projectGithub = null;
      cancelGithubDeviceLoginIfSupported();
    }
    const githubSignIn = !IS_REMOTE || !!(state.hostCaps && state.hostCaps.remoteGithubSignIn);
    // The token path is NOT covered by remoteGithubSignIn: that flag promises
    // the device-code flow and nothing else, and a host advertising it but
    // predating `githubLoginWithToken` takes the credential across the relay
    // and drops it, clearing the field with no error.
    const githubToken = !IS_REMOTE || !!(state.hostCaps && state.hostCaps.remoteGithubToken);
    const api = helpers.addProjectForm({
      kind,
      root: state.projectRoot,
      canGithubCli: githubSignIn,
      canUseToken: githubToken,
      onSubmit: (value, extra) => {
        vscode.postMessage(
          kind === "clone"
            ? { type: "cloneProject", url: value, ...(extra && extra.name ? { name: extra.name } : {}) }
            : { type: "createProject", name: value },
        );
      },
      onLoginWithToken: (token) => {
        vscode.postMessage({ type: "githubLoginWithToken", token });
      },
      onConnect: () => {
        // Same gate as onFix below, and for the same reason: a host that
        // predates `remoteGithubSignIn` drops `setupGithubCli` silently, so
        // without this the picker's Connect row is a button that does nothing.
        // The client is always as new as the relay deploy while the extension
        // is whatever the person installed, so "older host" is the ordinary
        // case, not an edge one.
        if (IS_REMOTE && !(state.hostCaps && state.hostCaps.remoteGithubSignIn)) {
          if (addProjectFormApi) {
            addProjectFormApi.update({
              error: IS_CLOUD_HOST
                ? "This machine's app is too old to connect GitHub from here. It updates itself shortly."
                : "Sign in to GitHub on the computer running this workspace — a terminal opens there — then try again here.",
            });
          }
          return;
        }
        vscode.postMessage({ type: "setupGithubCli", action: "auth" });
      },
      onRequestRepos: () => {
        vscode.postMessage({ type: "listGithubRepos" });
      },
      githubState: state.githubState || undefined,
      repos: state.githubRepos,
      terminalSignIn: !IS_REMOTE,
      onRecheck: () => vscode.postMessage({ type: "refreshProviders" }),
      touch: remoteUsesTouchComposer() || (typeof window.matchMedia === "function"
        && window.matchMedia("(hover: none), (pointer: coarse)").matches),
      onCancel: closeAddProjectForm,
      // Local: signing in happens in a terminal, and the form stays open so
      // they can clone again afterwards.
      //
      // Remote: older hosts classify `setupGithubCli` as host-local and DROP
      // it silently. A new host advertises `remoteGithubSignIn` and runs the
      // headless device-code flow into this form. Capability, never a version
      // check — the same reason Connect is gated on `remoteAgentSignIn`.
      onFix: (fix) => {
        const install = fix === "install-gh";
        // INSTALL has no headless path and is not getting one: a package
        // manager asks for elevation, so the host opens a terminal for it. On a
        // cloud machine that terminal is an Xvfb screen nobody is at, and
        // pressing the button again just opens another one — the very dead end
        // the sign-in flow exists to remove, reintroduced on the other branch.
        // Caught by review before release. The capability says the host can
        // sign in headlessly; it says nothing about installing.
        if (IS_REMOTE && install) {
          if (addProjectFormApi) {
            addProjectFormApi.update({
              error: IS_CLOUD_HOST
                // A cloud machine ships gh, so this is a broken machine rather
                // than a missing step, and there is no computer to walk to.
                ? "The GitHub CLI is missing on this cloud machine, which should not happen. "
                  + "Reset the machine from Settings, or tell us and we will look."
                // Literal, not the host's GITHUB_CLI_DOWNLOAD: that constant
                // lives in project-create.ts and is not in scope here, so
                // referencing it would throw at the moment of the click.
                : "Install the GitHub CLI on the computer running this workspace — cli.github.com — then try again here.",
            });
          }
          return;
        }
        if (IS_REMOTE && !(state.hostCaps && state.hostCaps.remoteGithubSignIn)) {
          const cloud = IS_CLOUD_HOST;
          if (addProjectFormApi) {
            addProjectFormApi.update({
              error: cloud
                ? "Signing in to GitHub needs a terminal, and a cloud machine has none. "
                  + "Public repositories clone as they are; private ones need this, and it is coming."
                : "Sign in to GitHub on the computer running this workspace — a terminal opens there — then try again here.",
            });
          }
          return;
        }
        // Local keeps both actions: a terminal there is one the person can see.
        vscode.postMessage({ type: "setupGithubCli", action: install ? "install" : "auth" });
      },
    });
    if (!api) return;
    const scrim = document.createElement("div");
    scrim.className = "add-project-scrim";
    scrim.appendChild(api.el);
    scrim.addEventListener("mousedown", (e) => { if (e.target === scrim) closeAddProjectForm(); });
    document.body.appendChild(scrim);
    addProjectFormScrim = scrim;
    addProjectFormApi = api;
    addProjectFormKeydown = (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeAddProjectForm();
    };
    document.addEventListener("keydown", addProjectFormKeydown, true);
    api.update({
      root: state.projectRoot,
      githubState: state.githubState || undefined,
      repos: state.githubRepos,
    });
    api.focus();
  }

  /**
   * Most-recent conversations across every project whose preview (or selected
   * page) has loaded, plus pinned sessions that may not be in those previews.
   * Newest first. The final rail render assigns every id to one visible group.
   */
  function railRecentRows() {
    const byId = new Map();
    for (const repo of state.repos || []) {
      const known = railKnownRows(repo);
      if (!known) continue;
      for (const s of known.entries) {
        if (s && s.id) byId.set(s.id, s);
      }
    }
    for (const s of state.pinnedSessions || []) {
      if (!s || !s.id) continue;
      // Prefer the pinned record when both exist (carries pinnedAt).
      const prev = byId.get(s.id);
      byId.set(s.id, prev ? { ...prev, ...s } : s);
    }
    return [...byId.values()].sort(
      (a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0)
        || String(b.id || "").localeCompare(String(a.id || "")),
    );
  }

  /**
   * Preview / Show more / Show less for a flat session list (RECENT or a repo).
   * Labels carry no digits — three disagreeing totals stranded rows behind a
   * lying count (see the scar comment on renderRailSessions).
   */
  function appendRailSessionSlice(body, entries, expandKey, rowFactory, expandedLimit = RAIL_EXPANDED) {
    const expanded = !!state.railExpanded[expandKey];
    const visible = expanded ? expandedLimit : RAIL_PREVIEW;
    const shown = entries.slice(0, visible);
    for (const s of shown) body.appendChild(rowFactory(s));
    const reachable = Math.min(entries.length, expandedLimit);
    const hidden = Math.max(0, reachable - shown.length);
    if (hidden > 0 && !expanded) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "rail-more";
      more.textContent = "Show more";
      more.onclick = (e) => {
        e.stopPropagation();
        state.railExpanded[expandKey] = true;
        saveRailShape();
        renderRail();
      };
      body.appendChild(more);
    } else if (expanded && entries.length > RAIL_PREVIEW) {
      const less = document.createElement("button");
      less.type = "button";
      less.className = "rail-more";
      less.textContent = "Show less";
      less.onclick = (e) => {
        e.stopPropagation();
        delete state.railExpanded[expandKey];
        saveRailShape();
        renderRail();
      };
      body.appendChild(less);
    }
  }

  /** The catalog's label for a cwd — repos that share a leaf name are only
   *  distinguishable there. Falls back to the leaf for a worktree, whose cwd is a
   *  subdirectory and so names no catalog row. */
  function railRepoLabelFor(cwd) {
    const home = state.repos.find((r) => sameCwd(r.cwd, cwd));
    return home?.label || cwdLeaf(cwd);
  }

  function railRepoHasMatch(repo) {
    if (railMatches(repo.label || cwdLeaf(repo.cwd))) return true;
    const rows = railRowsFor(repo);
    return !!rows && rows.entries.some((s) => railMatches(s.displayName));
  }

  // ---------- the conversation header ----------
  //
  // Where the rail exists, the app-wide toolbar does not: the controls that
  // belong to a PROJECT moved into the rail, and what is left belongs to the
  // conversation you are reading, so it lives with the conversation. On a phone
  // this same header also carries the drawer handle and New, which is why it is
  // one component and not two.

  /** The active session's record, wherever we happen to hold it. `railSelectedRows`
   *  first: it is the only list guaranteed to be an unfiltered page of the repo
   *  currently selected, where `state.sessions` follows the history search box. */
  function activeSessionRecord() {
    const id = state.activeSessionId;
    if (!id) return null;
    const lists = [state.railSelectedRows, state.sessions, state.pinnedSessions];
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      const hit = list.find((s) => s && s.id === id);
      if (hit) return hit;
    }
    return null;
  }

  function activeSessionName() {
    const data = state.sessionName;
    if (!data) return null;
    if (state.activeSessionId && data.sessionId !== state.activeSessionId) return null;
    return data;
  }

  function displayedSessionName(record) {
    const t = state.railTransition;
    const displayId = (t && t.kind === "resume" && t.sessionId)
      || record?.id
      || activeSessionName()?.sessionId
      || state.activeSessionId;
    const renamed = displayId ? pendingRename.valueFor(displayId) : undefined;
    let name;
    // Overlay wins until a catalog frame names this id. sessionName can
    // arrive first carrying the pre-rename title, and treating it as
    // authority would snap the header back for a beat.
    if (renamed !== undefined) name = renamed || "Untitled";
    else if (t && t.kind === "resume" && t.displayName) name = t.displayName;
    else {
      const data = activeSessionName();
      name = data?.name || record?.displayName || "New session";
    }
    if (record?.worktreeLabel && name.startsWith("(WT)")) name = name.slice(4).trim() || "Worktree";
    return name;
  }

  function exportConversationTitle() {
    return displayedSessionName(activeSessionRecord());
  }

  function shouldRecordExportEvent(msg) {
    if (!isExportableSessionEvent(msg)) return false;
    // The renderer already applied replayedUserBubbleVerdict: suppressReplayTurn
    // hides a whole primer turn; skipUserBubble hides a replayed userMessageChunk
    // that did not render. userMessage is a live send — including when the
    // session buffer is re-wrapped in historyReplay — and is never hidden.
    if (state.suppressReplayTurn) return false;
    if (msg.type === "userMessageChunk" && state.skipUserBubble && state.replaying) return false;
    // Live user_message_chunk echoes are not rendered.
    if (msg.type === "userMessageChunk" && !state.replaying) return false;
    return true;
  }

  function exportCurrentSession() {
    const title = exportConversationTitle();
    const markdown = exportSessionMarkdown(state.exportEvents, {
      title,
      windowed: !!state.exportWindowed,
    });
    const filename = exportSessionFilename(title);
    if (IS_REMOTE) {
      const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = filename;
      a.rel = "noopener";
      a.addEventListener("click", (e) => e.stopPropagation());
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10000);
      return;
    }
    // filename is a save-as hint. The host chooses delivery (untitled tab vs
    // OS save dialog). An older host ignores the field and still opens text.
    vscode.postMessage({ type: "openText", content: markdown, language: "markdown", filename });
  }

  function sessionNameTarget() {
    const data = activeSessionName();
    if (!data) return null;
    const record = activeSessionRecord();
    return { id: data.sessionId, cwd: data.cwd || record?.cwd || state.activeRepoCwd || state.selectedRepoCwd };
  }

  function finishSessionNameEdit(commit) {
    const edit = state.sessionNameEditing;
    if (!edit) return;
    state.sessionNameEditing = null;
    const next = (edit.input.value || "").trim();
    // Emptying the field is how you give a conversation its grok-generated title
    // back — the host drops the custom name on an empty rename. Escape is the
    // cancel, so this can't be reached by backing out of an edit.
    if (commit && next !== edit.original) {
      vscode.postMessage({ type: "renameSession", id: edit.id, name: next, ...(edit.cwd ? { cwd: edit.cwd } : {}) });
    }
    if (edit.input.isConnected) edit.input.replaceWith(edit.label);
    edit.editBtn.classList.remove("session-name-edit-editing");
    edit.editBtn.hidden = false;
    // After the input is gone — paintSessionSurfaces rebuilds the label.
    if (commit && next !== edit.original) paintPendingRename(edit.id, next);
    else if (edit.surface === "local") renderSessionName();
    else renderSessionHead();
  }

  function beginSessionNameEdit(surface, labelEl, editBtn) {
    if (state.sessionNameEditing) return;
    const target = sessionNameTarget();
    if (!target || !labelEl) return;
    const inputEl = document.createElement("input");
    inputEl.type = "text";
    inputEl.className = "session-name-input";
    inputEl.id = labelEl.id;
    inputEl.value = displayedSessionName(activeSessionRecord());
    inputEl.setAttribute("aria-label", "Conversation name");
    inputEl.onclick = (e) => e.stopPropagation();
    inputEl.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); finishSessionNameEdit(true); }
      else if (e.key === "Escape") { e.preventDefault(); finishSessionNameEdit(false); }
    };
    inputEl.onblur = () => finishSessionNameEdit(true);
    labelEl.replaceWith(inputEl);
    // Hidden, not REMOVED. The pencil is a fixed 28px .icon-btn and the tallest
    // thing in the chip's first row, so `hidden` collapsed that row to the
    // input's 21px — the whole top bar shrank by 7px the moment you clicked the
    // name, taking the project line and the separator up with it. Reserving the
    // box costs nothing and is the only thing here that cannot drift: it holds
    // whatever height the button has rather than restating it as a number.
    editBtn.classList.add("session-name-edit-editing");
    state.sessionNameEditing = {
      surface,
      id: target.id,
      cwd: target.cwd,
      original: inputEl.value,
      input: inputEl,
      label: labelEl,
      editBtn,
    };
    // The label is a row of its own now, so editing no longer hides it — this
    // keeps it correct if the conversation changed under the edit.
    renderSessionNameRepo();
    setTimeout(() => { inputEl.focus(); inputEl.select(); }, 0);
  }

  function wireSessionNameLabel(labelEl, editBtn, surface) {
    labelEl.onclick = (e) => {
      e.stopPropagation();
      // The label is deliberately a button on desktop too: this gives a
      // keyboard and screen-reader user the same direct route as a touch tap,
      // while the pencil remains the quiet pointer affordance.
      beginSessionNameEdit(surface, labelEl, editBtn);
    };
    labelEl.onkeydown = (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      e.stopPropagation();
      beginSessionNameEdit(surface, labelEl, editBtn);
    };
  }

  function beginNewSession() {
    // Empty open set: New would reset the welcome to Starting and then the
    // host would refuse to spawn. Leave the empty-state card up.
    if (state.onboardingMode === "no-project") return;
    // Capture before reset — activeSessionId is host-confirmed and is the only
    // honest "what we are leaving" for the identity frames that will confirm
    // the new conversation (they must differ from previousSessionId).
    const previousSessionId = state.activeSessionId;
    const repoCwd = state.selectedRepoCwd || state.activeRepoCwd || "";
    forgetRememberedSessionByChoice();
    // Veil before the host-style reset so the click can unhide the welcome.
    // resetForNewSession marks the old nodes pending-clear, and a pending-clear
    // transcript must not grow an empty-state panel on top of it.
    startRailNewTransition(repoCwd, "creating", previousSessionId);
    resetForNewSession();
    vscode.postMessage({ type: "newSession" });
  }

  function wireSessionNewButton(btn) {
    if (!btn || btn.dataset.railWired) return;
    btn.dataset.railWired = "1";
    btn.hidden = false;
    btn.type = "button";
    btn.title = "New session";
    btn.setAttribute("aria-label", "New session");
    btn.innerHTML = ICON.squarePen;
    btn.onclick = (e) => {
      e.stopPropagation();
      closePopovers();
      beginNewSession();
    };
  }

  // History stays a dedicated control; New sits next to it on every surface
  // (top-bar `#new-btn`, remote `#session-new`). Older remote pages omit the
  // latter — inject it after History so current-project New is still there
  // when the rail is closed (see railSessionMenuItems).
  function ensureVisibleNewSession() {
    if (newBtn) {
      newBtn.hidden = false;
      newBtn.title = "New session";
    }
    const history = document.getElementById("session-history");
    let sessionNew = document.getElementById("session-new");
    if (!sessionNew && history && history.parentElement) {
      sessionNew = document.createElement("button");
      sessionNew.id = "session-new";
      sessionNew.className = (history.className ? history.className + " " : "") + "icon-btn";
      history.insertAdjacentElement("afterend", sessionNew);
    }
    if (sessionNew) {
      if (!sessionNew.classList.contains("icon-btn")) sessionNew.classList.add("icon-btn");
      wireSessionNewButton(sessionNew);
    }
  }

  /** VS Code's compact top-bar overflow. Desktop and remote keep the richer
   *  session menu they already render through `#session-head-actions`. */
  function fillVsCodeSessionActions() {
    const menuSlot = document.getElementById("vscode-session-actions");
    if (!menuSlot) return;
    menuSlot.innerHTML = "";
    if (!state.activeSessionId) return;
    menuSlot.appendChild(railMenuButton(
      "Session actions",
      [
        {
          label: "Continue in a new chat",
          icon: ICON.gitFork,
          onSelect: () => beginContinueInNewChat(state.activeSessionId),
        },
        {
          label: "Export conversation as Markdown",
          icon: ICON.download,
          onSelect: () => exportCurrentSession(),
        },
        {
          label: "Find in conversation",
          icon: ICON.search,
          onSelect: () => openFind(),
        },
      ],
      "vscode-session-head",
    ));
  }

  /**
   * Conversation overflow (⋯) in the top-right cluster (after Remote, History, New).
   * Present only when the host shipped `#session-head-actions` (desktop getHtml /
   * AFK Pilot page). VS Code's smaller two-item menu uses its own slot so this
   * richer desktop/remote menu stays unchanged. Capability = the slot exists,
   * not a host flag.
   */
  function fillSessionHeadActions() {
    fillVsCodeSessionActions();
    ensureVisibleNewSession();
    const menuSlot = document.getElementById("session-head-actions");
    if (!menuSlot) return;

    menuSlot.innerHTML = "";
    // Fall back to what we already know rather than degrading the menu.
    // activeSessionRecord() searches the loaded lists, and a conversation can be
    // the live one before it appears in any of them — right after a fork, most
    // visibly. The menu then dropped its conversation actions, and came back
    // later when a list happened to refresh, which read as options randomly
    // disappearing.
    // This menu acts on the conversation you are IN; its id and cwd are state we
    // hold, so a missing list entry is not a reason to withhold Rename, Delete
    // or Continue in a new chat.
    const record = activeSessionRecord() || (state.activeSessionId
      ? {
          id: state.activeSessionId,
          cwd: state.activeRepoCwd || state.selectedRepoCwd || "",
          displayName: activeSessionName() || "",
        }
      : null);
    const cwd = record?.cwd || state.selectedRepoCwd || state.activeRepoCwd;
    const repo = state.repos.find((r) => sameCwd(r.cwd, cwd)) || { cwd: cwd || "", available: true };
    // This menu hangs off the conversation NAME at the top of the panel, so
    // its record is the conversation you are in, by construction. Deriving
    // "active" by comparing ids was redundant here and quietly wrong: a
    // session whose id the host has not assigned yet compares false, and the
    // whole Session group — Continue in a new chat, worktree apply/remove —
    // vanished from the one menu where it always applies. The row menus below
    // still compute it, because there the record really can be some other
    // conversation.
    //
    // "By construction" stops holding mid-transition, though: the name still
    // reads the conversation being LEFT while the host has already moved to the
    // one being opened. railSessionMenuItems disables the id-less actions for
    // that window rather than this call site withholding them.
    if (!record) return;
    menuSlot.appendChild(railMenuButton(
      "Session actions",
      () => railSessionMenuItems(record, repo, true, { inlineRename: true }),
      "session-head",
    ));
  }

  function renderSessionName() {
    if (IS_REMOTE) return;
    const chip = $("session-name-chip");
    const label = $("session-name-label");
    const editBtn = $("session-name-edit");
    if (!chip || !label || !editBtn) return;
    const data = activeSessionName();
    const pendingOpen = !!(state.railTransition && state.railTransition.kind === "resume" && state.railTransition.displayName);
    chip.hidden = !data && !pendingOpen;
    // Desktop rail hosts: overflow lives in the top-right cluster (after History).
    fillSessionHeadActions();
    renderSessionNameRepo();
    if ((!data && !pendingOpen) || state.sessionNameEditing?.surface === "local") return;
    const name = displayedSessionName(activeSessionRecord());
    label.textContent = name;
    label.title = name;
    // Pending open paints the title only. Rename stays gated on sessionName
    // (the host confirmation), same as an older host that never sent the frame.
    editBtn.hidden = !data;
    if (!data) return;
    label.setAttribute("aria-label", `Conversation: ${name}. Activate to rename.`);
    editBtn.title = "Rename conversation";
    editBtn.setAttribute("aria-label", "Rename conversation");
    editBtn.innerHTML = ICON.pencil;
    wireSessionNameLabel(label, editBtn, "local");
    editBtn.onclick = (e) => { e.stopPropagation(); beginSessionNameEdit("local", label, editBtn); };
  }

  /**
   * The project label beside the conversation name.
   *
   * VS Code history used to be pinned to the open folder, so the name alone
   * always meant "in this workspace". It is multi-workspace now — the rail can
   * resume a conversation from any discovered project without reloading the
   * window — and the header stopped saying where you are. Same information the
   * rail already puts on its cross-project rows.
   *
   * Shown only where there is something to disambiguate: one project in the
   * catalog and the tag is a label repeating what the title bar says. Hidden
   * while renaming, because the input takes the chip's whole width.
   */
  function renderSessionNameRepo() {
    const el = $("session-name-repo");
    if (!el) return;
    // Owner decision 2026-08-15: the header shows JUST the conversation name,
    // everywhere — same as VS Code with the current project. The rail groups
    // by project and the header tooltip still carries the full path, so the
    // second line repeated what the surroundings already say.
    el.hidden = true;
    if (el.hidden) return;
    // The `sessionName` frame carries the conversation's own cwd, so prefer it:
    // a conversation resumed from another project may not be in any list this
    // webview holds, and `state.cwd` is the host's, not the conversation's.
    const named = activeSessionName();
    const cwd = named?.cwd || activeSessionRecord()?.cwd || state.cwd || "";
    // A worktree's cwd is deliberately NOT a catalog row, so resolving the label
    // from it alone fell back to that directory's leaf — and where the leaf
    // happened to match another project's name, project A's conversation was
    // labelled as project B. The host names the owner when the two differ.
    const projectCwd = named?.repoCwd || cwd;
    // Only when it is NOT the folder this window has open. There, the window
    // title already says it and the line is noise; the whole point of the label
    // is "this conversation is somewhere else".
    const ide = state.workspaceRepoCwd || "";
    const elsewhere = !!projectCwd && (!ide || !sameCwd(projectCwd, ide));
    const label = elsewhere ? railRepoLabelFor(projectCwd) : "";
    // Stays put while the name is being edited: it is a second ROW now, not
    // something competing with the input for width.
    el.hidden = !label;
    if (el.hidden) return;
    el.textContent = label;
    el.title = projectCwd === cwd ? cwd : `${cwd}
(in ${projectCwd})`;
  }

  function renderSessionHead() {
    if (!IS_REMOTE) return;
    const head = document.getElementById("session-head");
    if (!head) return;
    const titleEl = document.getElementById("session-head-title");
    const subEl = document.getElementById("session-head-sub");
    if (!titleEl || !subEl) return;

    const record = activeSessionRecord();
    // A brand-new conversation has no stored name until its first turn is
    // summarised, so say what it is rather than showing an empty bar.
    const name = displayedSessionName(record);
    const editingRemote = state.sessionNameEditing?.surface === "remote";
    if (!editingRemote) titleEl.textContent = name;
    titleEl.title = name;

    const cwd = record?.cwd || state.selectedRepoCwd;
    // Owner decision 2026-08-15: no project line under the name, anywhere —
    // the rail says the project, the header tooltip keeps the full path.
    subEl.textContent = "";
    subEl.hidden = true;
    // The name has its own tooltip on the title element; leave the header's to
    // the full path, which the truncated repo line below cannot show.
    head.title = cwd || "";

    let editBtn = document.getElementById("session-head-edit");
    const canRename = !!sessionNameTarget();
    if (!editBtn && canRename && titleEl.parentElement) {
      editBtn = document.createElement("button");
      editBtn.id = "session-head-edit";
      editBtn.className = "session-name-edit session-name-edit-remote icon-btn";
      titleEl.parentElement.appendChild(editBtn);
    }
    if (editBtn) {
      editBtn.hidden = !canRename;
      editBtn.title = "Rename conversation";
      editBtn.setAttribute("aria-label", "Rename conversation");
      editBtn.innerHTML = ICON.pencil;
      editBtn.onclick = (e) => { e.stopPropagation(); beginSessionNameEdit("remote", titleEl, editBtn); };
    }
    if (canRename) {
      titleEl.classList.add("session-name-label");
      titleEl.setAttribute("role", "button");
      titleEl.tabIndex = 0;
      titleEl.setAttribute("aria-label", `Conversation: ${name}. Activate to rename.`);
      if (!state.sessionNameEditing || state.sessionNameEditing.surface !== "remote") {
        wireSessionNameLabel(titleEl, editBtn || { hidden: true }, "remote");
      }
    } else {
      titleEl.classList.remove("session-name-label");
      titleEl.removeAttribute("role");
      titleEl.removeAttribute("tabindex");
      titleEl.removeAttribute("aria-label");
      titleEl.onclick = null;
      titleEl.onkeydown = null;
    }

    fillSessionHeadActions();

    const history = document.getElementById("session-history");
    if (history && !history.dataset.railWired) {
      history.dataset.railWired = "1";
      history.innerHTML = ICON.clock;
      history.title = history.title || "Session history";
      history.onclick = (e) => { e.stopPropagation(); openHistoryPopover(); };
    }
    ensureVisibleNewSession();
  }

  function renderRailRepo(repo, inArchive) {
    const key = cwdKey(repo.cwd);
    const selected = sameCwd(repo.cwd, state.selectedRepoCwd);
    // A fold must never hide where you are NOW — folding a project and later
    // opening one of its conversations from elsewhere used to leave you looking
    // at a closed section. That is handled by opening the section when the live
    // conversation ARRIVES in it (see railFollowLiveRepo), which is a one-time
    // correction rather than a standing ban: pinning the current project open
    // forever meant the one section you most often want out of the way was the
    // one you could not fold. Only in Projects — down in Archived the section is
    // already closed, so holding one open inside it would be noise.
    //
    // ONE flag drives both the session list and the folder icon. `expanded` is
    // the positive form so the icon cannot drift from the list (closed icon on
    // an open section was a real screenshot bug when the two read different
    // shapes of the same store).
    const expanded = !state.railCollapsed[key];

    // No marker for the selected or the live project. The conversation you are
    // reading is highlighted where it sits, which says which project you are in
    // without a second, competing mark — and the header names it outright.
    const sec = document.createElement("section");
    sec.className = "rail-repo" +
      (repo.available ? "" : " unavailable") +
      (expanded ? "" : " collapsed");
    // Mirror for CSS/tests: data-expanded is the same boolean that controls the list.
    sec.dataset.expanded = expanded ? "1" : "0";

    const head = document.createElement("div");
    head.className = "rail-repo-head";
    head.title = repo.cwd;
    // Whole header toggles expand/collapse (folder is indicator only). Hover
    // actions stopPropagation so a pin/new/menu click does not also fold.
    head.setAttribute("role", "button");
    head.tabIndex = 0;
    head.setAttribute("aria-expanded", String(expanded));
    head.setAttribute(
      "aria-label",
      (expanded ? "Collapse " : "Expand ") + (repo.label || cwdLeaf(repo.cwd)),
    );

    // Folder open/closed indicator — same `expanded` flag as the session list.
    // Colour tints the stroke via currentColor (`data-repo-color` → CSS vars);
    // none/absent leaves the default descriptionForeground.
    const twisty = document.createElement("span");
    twisty.className = "rail-twisty";
    twisty.innerHTML = expanded ? ICON.folderOpen : ICON.folderClosed;
    twisty.setAttribute("aria-hidden", "true");
    const repoColor = repoColorOf(repo);
    if (repoColor) twisty.dataset.repoColor = repoColor;
    head.appendChild(twisty);

    const name = document.createElement("span");
    name.className = "rail-repo-name";
    // Worktree keeps a branch glyph; ordinary projects rely on the folder indicator.
    name.innerHTML = repo.worktreeLabel
      ? `<span class="rail-repo-icon">${ICON.gitBranch}</span><span class="rail-repo-label"></span>`
      : `<span class="rail-repo-label"></span>`;
    name.querySelector(".rail-repo-label").textContent = repo.label || cwdLeaf(repo.cwd);
    head.appendChild(name);

    const toggleRepoExpand = () => {
      if (expanded) state.railCollapsed[key] = true;
      else delete state.railCollapsed[key];
      saveRailShape();
      renderRail();
    };
    head.onclick = (e) => {
      // Actions (and anything inside them) must not fold the section.
      if (e.target.closest(".rail-repo-actions")) return;
      // Purely a disclosure control. It used to ALSO switch into an unselected
      // project — which had two problems. It selected a repo without opening
      // anything in it, leaving the chat on the old conversation while the rail
      // claimed a different project (the state the repo chip has to explain as
      // "Browsing X; live session is in Y"). And because that branch forced the
      // section open and returned, clicking an already-expanded unselected
      // project did nothing visible: the owner's "closing a project sometimes
      // needs two clicks".
      //
      // Switching now follows from opening something — a session row, or the
      // "+" (which switches and then creates). The chip's project popover
      // remains the explicit switch. Unselected projects still list their
      // conversations here: requestRailPreviews fetches those regardless of
      // selection or fold state.
      toggleRepoExpand();
    };
    head.onkeydown = (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (e.target !== head) return;
      e.preventDefault();
      head.click();
    };

    const actions = document.createElement("div");
    actions.className = "rail-repo-actions";
    // Clicks inside the action cluster must not bubble to the head toggle.
    actions.addEventListener("click", (e) => e.stopPropagation());

    // New session in ANY project, selected or not. The host only ever creates in
    // the repo it currently has selected, so for another one this is really
    // "switch there, then start fresh" — a two-step intent the page has to own,
    // because the browser client arms its own "open this repo's newest session"
    // bridge on every outbound `selectRepo` and would otherwise land the tab on
    // an existing conversation. `__grokRailNewIntent` tells that bridge which
    // intent this particular switch carries. The title says so out loud: this
    // button moves the whole tab, and that should never be a surprise.
    const add = document.createElement("button");
    add.type = "button";
    add.className = "rail-action-btn";
    add.innerHTML = ICON.squarePen;
    add.title = selected ? "New session here" : "Switch to this project and start a new session";
    // Deliberately NOT gated on repoSwitcherLocked(). Starting a conversation is
    // the one thing that should always be available, and a lock that disables it
    // in EVERY project at once is indistinguishable from the app being broken —
    // which is how it read. A click during a transition supersedes it rather
    // than racing it: this posts selectRepo for its own project and re-arms the
    // new-session intent, so the destination is whichever "+" was clicked last.
    // Only a folder the host cannot reach still refuses, and it says so on hover.
    add.disabled = !repo.available;
    add.onclick = (e) => {
      e.stopPropagation();
      if (!repo.available) return;
      if (selected) {
        // Same path as the header New — optimistic placeholder + host create.
        beginNewSession();
        return;
      }
      // Switch first, create once the catalog names this project. The transition
      // starts in switching-repo so the placeholder paints on the destination
      // immediately; repos advances it to creating (and __grokRailNewIntent
      // still posts newSession when the switch lands).
      startRailNewTransition(repo.cwd, "switching-repo", state.activeSessionId);
      window.__grokRailNewIntent = repo.cwd;
      selectRailRepo(repo);
    };
    actions.appendChild(add);

    // Projects sort by recency and nothing else, so there is no pin here — the
    // menu carries only the destructive act, which is precisely what a menu is
    // for. (The VS Code repo picker keeps its own repo pins; the rail ignores
    // them.)
    //
    // A project we have loaded and found empty offers nothing to clear, so the
    // item says so on its face instead of taking the click and answering with a
    // notice in whatever conversation happens to be open. Only a LOADED preview
    // counts: "no rows yet" is not "no rows".
    const loaded = railKnownRows(repo);
    const knownEmpty = !!loaded && loaded.entries.length === 0;
    // Clearing a project the host has NOT selected is a repo-addressed act, and
    // an extension that predates that simply drops the message — no error, no
    // deletion, nothing. A control that fails in silence is worse than one that
    // isn't offered, so it waits for proof: a host that has answered
    // `listRepoSessions` is a host that reads the cwd on these messages, and one
    // that has not cannot draw another project's rows either. The SELECTED
    // project is never gated — clearing where you already are has always worked.
    const reachable = selected || state.repoPreviewsSupported;
    // Capture the menu button so "Set color" can re-anchor the swatch picker
    // after the menu closes (onSelect runs after closeRailMenu).
    // Named so right-click can build the same menu. Evaluated lazily, so the
    // `projectMenuBtn` reference below is bound by the time it runs.
    const projectMenuItems = () => [
      // First, because it is the everyday one: putting a project away is
      // housekeeping, and it has to be reachable without passing the delete.
      // The verb follows the section this row is drawn in rather than the stored
      // flag — a project the age rule archived has no stored flag, and offering
      // "Archive" on a row that is already under Archived would be nonsense.
      // Hidden entirely against a host too old to record the choice: a control
      // that silently does nothing is worse than one that isn't there.
      ...(railArchiveSupported() ? [{
        label: inArchive ? "Move to Projects" : "Archive project",
        icon: inArchive ? ICON.archiveRestore : ICON.archive,
        title: inArchive
          ? "Show this project under Projects again"
          : "Move this project out of the way. Its conversations stay, and working here brings it back.",
        onSelect: () => vscode.postMessage({
          type: "setRepoArchived",
          cwd: repo.cwd,
          archived: !inArchive,
        }),
      }, null] : []),
      // Folder colour — host-persisted, capability-gated the same way as archive
      // (`color` present on catalog rows). Opens a swatch picker rather than a
      // nested menu so six hues + none stay one glance away.
      ...(railColorSupported() ? [{
        label: "Set color",
        icon: ICON.palette,
        title: "Tint this project's folder icon so it is easy to find",
        onSelect: () => openRepoColorPicker(projectMenuBtn, repo),
      }, null] : []),
      // Hide closes a local folder; archiving only changes its rail group.
      ...(canRemoveProjectFolder() ? [{
        label: "Hide project",
        icon: ICON.archive,
        title:
          "Take this project out of the list. Nothing is deleted — the folder " +
          "stays on disk, and + adds it back.",
        // Confirmed, like every other rail act that reaches other surfaces. The
        // VS Code rail has always asked; this one posted bare, so one gesture was
        // guarded on one surface and not the other. It also takes the row off
        // every linked device at once, which is worth saying out loud.
        onSelect: () => {
          const repoLabel = repo.label || cwdLeaf(repo.cwd);
          uiConfirm({
            title: `Hide “${repoLabel}”?`,
            body: `Takes this project out of the list on every linked device:\n${repo.cwd}`
              + "\n\nNothing is deleted — the folder stays on disk, and Add project brings it back.",
            confirmLabel: "Hide",
          }).then((ok) => {
            if (ok) vscode.postMessage({ type: "removeProjectFolder", cwd: repo.cwd });
          });
        },
      }, null] : []),
      {
        label: "Clear all history",
        icon: ICON.trash,
        danger: true,
        disabled: !repo.available || knownEmpty || !reachable,
        title: !reachable
          ? "Update Grok Build on your computer to clear another project's history from here"
          : knownEmpty
            ? "This project has no history"
            : "Delete all sessions in this repository's history",
        onSelect: () => {
          const repoLabel = repo.label || cwdLeaf(repo.cwd);
          uiConfirm({
            title: `Clear history for “${repoLabel}”?`,
            body: `Deletes every session for:\n${repo.cwd}\n\nThe current session is kept. This cannot be undone.`,
            confirmLabel: "Delete All",
            danger: true,
          }).then((ok) => {
            // `clearAllSessions` is repo-addressed, so this works on a project
            // the host does not currently have selected — no switch needed.
            if (ok) vscode.postMessage({ type: "clearAllSessions", cwd: repo.cwd });
          });
        },
      },
    ];
    const projectMenuKey = "repo:" + cwdKey(repo.cwd);
    const projectMenuBtn = railMenuButton("Project actions", projectMenuItems, projectMenuKey);
    actions.appendChild(projectMenuBtn);

    head.appendChild(actions);
    // Right-click anywhere on the project row opens the same menu.
    wireRailRowContextMenu(head, () => projectMenuBtn, projectMenuItems, projectMenuKey);
    sec.appendChild(head);

    // Same `expanded` as the folder icon — never a second, independent flag.
    if (expanded) sec.appendChild(renderRailSessions(repo, key));
    return sec;
  }

  function renderRailSessions(repo, key) {
    const body = document.createElement("div");
    body.className = "rail-sessions";

    if (!repo.available) {
      body.appendChild(railNote("Unavailable"));
      return body;
    }

    const rows = railRowsFor(repo);
    // Optimistic new-session placeholder still has to paint when we have no
    // catalog yet (cross-project "+" while the switch is in flight, or cold
    // selected project). Without this the click highlights nothing until the
    // host answers — the whole bug this transition exists to fix.
    const pendingNewHere = state.railTransition
      && state.railTransition.kind === "new"
      && sameCwd(repo.cwd, state.railTransition.repoCwd);
    if (!rows) {
      if (pendingNewHere) {
        const entries = railEntriesWithNewPlaceholder(repo, []);
        appendRailSessionSlice(body, entries, key, (s) => renderRailSessionRow(s, repo));
        return body;
      }
      const previewError = state.repoPreviewErrors[key];
      if (previewError) {
        const note = railNote("Couldn't load these conversations. ");
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "rail-note-retry";
        retry.textContent = "Retry";
        retry.onclick = (e) => {
          e.stopPropagation();
          delete state.repoPreviewErrors[key];
          renderRail();
          requestRailPreview(repo);
        };
        note.appendChild(retry);
        body.appendChild(note);
      } else {
        body.appendChild(railNote("Loading…"));
      }
      return body;
    }

    // Selected project: empty `railSelectedRows` before the first unfiltered
    // `sessions` frame means "list not received yet", not "zero conversations".
    // Without this the rail permanently said "No sessions yet" when the host
    // delayed or omitted that frame (desktop cold start used to only push
    // sibling `repoSessions` previews).
    if (
      sameCwd(repo.cwd, state.selectedRepoCwd) &&
      !rows.entries.length &&
      !state.railSelectedRowsKnown &&
      !state.railSessionsStale &&
      !pendingNewHere
    ) {
      body.appendChild(railNote("Loading…"));
      return body;
    }

    // A search answers itself: showing three of five matches behind a "Show
    // more" would hide the very rows the query asked for. Matching by project
    // name instead means the whole project matched, so its list stays as it was.
    // Placeholder injection is render-only (never into state.sessions).
    const entries = uniqueSessionRows(railEntriesWithNewPlaceholder(repo, rows.entries));
    const q = railFilterText();
    const nameMatched = !q || railMatches(repo.label || cwdLeaf(repo.cwd));
    if (q && !nameMatched) {
      const hits = entries.filter((s) => railMatches(s.displayName)).slice(0, RAIL_EXPANDED);
      for (const s of hits) body.appendChild(renderRailSessionRow(s, repo));
      return body;
    }

    if (!entries.length) {
      body.appendChild(railNote("No sessions yet"));
      return body;
    }

    // One-step reveal, no counters. Three numbers disagree (host total, loaded
    // length, RAIL_EXPANDED cap); a count-labelled control stranded rows. Depth
    // belongs in the history popover. See appendRailSessionSlice.
    appendRailSessionSlice(body, entries, key, (s) => renderRailSessionRow(s, repo));
    return body;
  }

  function renderRailSessionRow(s, repo, opts) {
    const row = document.createElement("div");
    // Two different questions, and they must not share one boolean.
    //
    // `active` = what to PAINT: the display target, so an optimistic click
    // highlights immediately. A pending cross-repo id is deliberately not in
    // activeSessionId, so this cannot read that field alone.
    //
    // `hostActive` = may this row offer the id-less session actions. While a
    // transition is in flight the answer is no for EVERY row — see
    // railIdlessActionsAllowed. With no transition the display target IS the
    // confirmed one, so `active` is already the right answer.
    const target = railDisplayTarget();
    const active = !!(target && s.id === target.id && railRepoOwnsTarget(repo, s, target));
    const hostActive = railIdlessActionsAllowed() && active;
    row.className = "rail-session" + (active ? " active" : "");
    row.dataset.sessionId = s.id || "";
    row.title = sessionRowName(s);
    // The row is the primary control, so it has to behave like one: reachable by
    // Tab and openable with Enter/Space. The repo names and pin buttons around it
    // are real <button>s; without this the conversations themselves — the whole
    // point of the rail — were the only thing a keyboard could not reach.
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    if (active) row.setAttribute("aria-current", "true");
    row.onkeydown = (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      // Only when the ROW itself has focus. The pin button lives inside it and
      // is a real <button>, so pressing Enter there already activates the pin —
      // letting the key bubble on to here would also open the conversation, and
      // opening one in another project moves the whole tab.
      if (e.target !== row) return;
      e.preventDefault(); // Space would scroll the rail
      row.click();
    };

    if (showProviderGlyphs()) {
      row.appendChild(makeProviderGlyph(s.provider, state.dots[s.id], s.id));
    } else {
      const dot = document.createElement("span");
      // Same attribute the history popover uses, so `sessionDot` patches both
      // surfaces at once without the rail subscribing to anything of its own.
      dot.setAttribute("data-session-dot", s.id);
      applySessionDot(dot, state.dots[s.id]);
      row.appendChild(dot);
    }

    const label = document.createElement("span");
    label.className = "rail-session-name";
    if (s.worktreeLabel) {
      const branch = document.createElement("span");
      branch.className = "rail-session-branch";
      branch.innerHTML = ICON.gitBranch;
      branch.title = "Worktree: " + s.worktreeLabel;
      row.appendChild(branch);
    }
    let name = sessionRowName(s);
    if (s.worktreeLabel && name.startsWith("(WT)")) name = name.slice(4).trim() || "Worktree";
    label.textContent = name;
    row.appendChild(label);

    // In the Pinned group a row has left its project behind, so it has to say
    // which one it came from — two conversations called "Untitled" are otherwise
    // indistinguishable, and opening the wrong one moves the whole tab.
    if (opts && opts.showRepo) {
      const where = document.createElement("span");
      where.className = "rail-session-repo";
      // Prefer the catalog's label: the host disambiguates repos that share a
      // leaf name (two checkouts both called "project" become distinguishable
      // there). Falling back to the leaf covers a worktree session, whose cwd is
      // a subdirectory and so names no catalog row.
      const home = state.repos.find((r) => sameCwd(r.cwd, s.cwd));
      where.textContent = home?.label || cwdLeaf(s.cwd);
      where.title = s.cwd || "";
      row.appendChild(where);
    }

    const isPinned = typeof s.pinnedAt === "number";
    if (isPinned) row.classList.add("pinned");

    // Optimistic new-session placeholder: presentation only. No pin/rename/
    // delete — those would ship a pending-new: token (or an unbound real id
    // that is not yet host-open on this client) to the host.
    if (!isRailPendingRow(s)) {
      const actions = document.createElement("div");
      actions.className = "rail-session-actions";
      // Hover pin control (one click). Hidden until :hover / :focus-within; forced
      // visible on touch via @media (hover: none). Capability-gated like the menu.
      if (state.pinnedSessionsKnown) {
        const pinBtn = document.createElement("button");
        pinBtn.type = "button";
        pinBtn.className = "rail-action-btn rail-pin-btn" + (isPinned ? " active" : "");
        pinBtn.innerHTML = isPinned ? ICON.pinFilled : ICON.pin;
        pinBtn.title = isPinned ? "Unpin conversation" : "Pin conversation";
        pinBtn.setAttribute("aria-label", pinBtn.title);
        pinBtn.onclick = (e) => {
          e.stopPropagation();
          vscode.postMessage({
            type: "toggleSessionPin",
            id: s.id,
            cwd: s.cwd || repo.cwd,
            pinned: !isPinned,
          });
        };
        actions.appendChild(pinBtn);
      }
      const menuKey = "session:" + (s.id || cwdKey(s.cwd || repo.cwd));
      const menuBtn = railMenuButton(
        "Session actions",
        // `active` (the painted target) decides WHICH row owns the id-less
        // actions; railSessionMenuItems disables them while the host has not
        // confirmed it is on that conversation yet.
        () => railSessionMenuItems(s, repo, active),
        menuKey,
      );
      actions.appendChild(menuBtn);
      row.appendChild(actions);
      // Right-click is the second way in, same menu — matching the desktop file
      // tree, where both triggers already share one menu.
      wireRailRowContextMenu(row, () => menuBtn, () => railSessionMenuItems(s, repo, active), menuKey);
    }
    row.onclick = railSessionOpener(s, repo, active);
    return row;
  }

  /** Shared by a rail row and the conversation header, so the same session
   *  offers the same actions wherever you reach it. */
  /** `opts.inlineRename` — the caller already offers renaming by clicking the
   *  name itself (the conversation header does), so a second Rename buried in a
   *  menu is a longer route to the same edit. Rail ROWS still need it: you
   *  cannot click the name of a conversation you are not in. */
  function railSessionMenuItems(s, repo, active, opts) {
    const cwd = s.cwd || repo.cwd;
    const isPinned = typeof s.pinnedAt === "number";
    const items = opts?.inlineRename ? [] : [
      {
        label: "Rename",
        icon: ICON.pencil,
        onSelect: () => railRenameSession(s, cwd),
      },
    ];
    // New used to live in the conversation overflow so rail hosts would not
    // show three similar New icons (top bar, rail +, project +). That
    // assumed the rail is on screen. It can be closed or minimised, and then
    // neither + is reachable — the top-bar New is the only one left. It is
    // also a different object: a new session in the CURRENT project, not
    // "create one in the project I am pointing at". So New is top-bar only.
    // Two places, not three: rail + (project-scoped, only while the rail is
    // open) and the top bar (current project, always). Rail rows must not
    // gain a copy — they already have + on the project head.
    // "Continue in a new chat" belongs with the other things you do TO a
    // conversation (rename, pin, delete), not in the composer's settings beside
    // model and effort — those adjust how the agent answers; this one makes a
    // different conversation. Only for the conversation you are actually in: a
    // fork continues from the live transcript, so offering it on some other row
    // in the history list would promise something it cannot do.
    if (active) {
      // Fork / apply / remove now name a sessionId, and the host refuses a
      // mismatch, but while a conversation is still opening the painted row and
      // the host can still disagree. Disabled rather than removed: they belong
      // to this row, they are coming back in a moment, and a menu whose
      // contents reshuffle mid-open is its own kind of wrong.
      const pending = !railIdlessActionsAllowed();
      const waiting = pending
        ? { disabled: true, title: "Available once the conversation has finished opening" }
        : null;
      items.push({
        label: "Continue in a new chat",
        icon: ICON.gitFork,
        ...waiting,
        onSelect: () => beginContinueInNewChat(s.id),
      });
      // The live transcript this client is showing — same scope as Continue.
      items.push({
        label: "Export as Markdown",
        icon: ICON.download,
        onSelect: () => exportCurrentSession(),
      });
      items.push({
        label: "Find in conversation",
        icon: ICON.search,
        onSelect: () => openFind(),
      });
      // Worktree upkeep rides along for the same reason, and only while you are
      // in one — you cannot apply a checkout you are not standing in.
      //
      // Not from a remote, though. The host runs apply/remove against ITS
      // focused session, not the one that asked, so a phone in repo B would
      // remove the worktree the desk was standing in — and Remove discards
      // unapplied edits. Hidden rather than shown-and-dropped: the host now
      // refuses these from remote, and a control that silently does nothing is
      // worse than one that isn't there.
      if (state.isWorktree && !IS_REMOTE) {
        items.push({
          label: "Apply worktree",
          icon: ICON.gitBranch,
          ...waiting,
          onSelect: () => uiConfirm({
            title: "Apply worktree?",
            body: "Merges this worktree's edits back into the main checkout.",
            confirmLabel: "Apply",
          }).then((ok) => { if (ok) vscode.postMessage({ type: "applyWorktree", sessionId: s.id }); }),
        });
        items.push({
          label: "Remove worktree",
          icon: ICON.gitBranch,
          danger: true,
          ...waiting,
          onSelect: () => uiConfirm({
            title: "Remove worktree?",
            body: "This deletes the isolated checkout. Unapplied edits are lost.",
            confirmLabel: "Remove",
            danger: true,
          }).then((ok) => { if (ok) vscode.postMessage({ type: "removeWorktree", sessionId: s.id }); }),
        });
      }
    }
    // Capability, never a version: a host that has never sent `pinnedSessions`
    // will silently drop `toggleSessionPin`, so offering the control there gives
    // a control that does nothing — worse than not having one. The frame arrives
    // in every remote snapshot, empty included, so a capable host always says so.
    if (state.pinnedSessionsKnown) {
      items.push({
        label: isPinned ? "Unpin conversation" : "Pin conversation",
        icon: ICON.pin,
        onSelect: () => vscode.postMessage({
          type: "toggleSessionPin",
          id: s.id,
          // The row's own cwd, so the host files the pin under the repo this
          // conversation actually lives in rather than the one we are viewing.
          cwd,
          pinned: !isPinned,
        }),
      });
    }
    // The open conversation can be deleted too, where the host can do it: it
    // tears the process down before touching the disk and then starts a fresh
    // conversation in the same project, so the delete sticks and you land
    // somewhere rather than nowhere. An older host refuses, so there the item
    // stays visibly disabled and says why — the menu keeps its shape, and the
    // reason is the truth rather than "the open session can't be deleted".
    const activeUndeletable = !!active && !canDeleteActiveSession();
    items.push(null, {
      label: "Delete",
      icon: ICON.trash,
      danger: true,
      disabled: activeUndeletable,
      title: activeUndeletable
        ? "Update Grok Build on your computer to delete the conversation you have open"
        : "Delete",
      onSelect: () => {
        uiConfirm({
          title: s.displayName ? `Delete "${s.displayName}"?` : "Delete this session?",
          body: deleteSessionWarning(active),
          confirmLabel: "Delete",
          danger: true,
        }).then((ok) => {
          // `cwd` names the project this row belongs to, so the host can act on a
          // conversation in a project it has not selected. Without it the host
          // authorizes against the selected repo only, and every row the rail
          // draws from elsewhere is refused.
          if (ok) vscode.postMessage({ type: "deleteSession", id: s.id, name: s.displayName, cwd });
        });
      },
    });
    return items;
  }

  /** Whether this host can delete the conversation you are READING. Older ones
   *  refuse it outright — they deleted the files while the live CLI still owned
   *  the conversation, so it came straight back — and a control that answers
   *  with a refusal is worse than one that isn't there. */
  function canDeleteActiveSession() {
    return !!(state.hostCaps && state.hostCaps.deleteActiveSession);
  }

  /** Confirm copy for a delete. Deleting the conversation you are READING is a
   *  bigger act than deleting a cold row — the thing on your screen goes away
   *  and something else takes its place — so the dialog says so before you agree
   *  to it, and says the extra part out loud when a turn is still running. */
  function deleteSessionWarning(active) {
    if (!active) return "This cannot be undone.";
    const stopping = state.busy ? " Grok is still working; that stops." : "";
    return "This is the conversation you have open. It will close and a new one will start in the same project."
      + stopping + " This cannot be undone.";
  }

  /** Rename from the rail. The history popover renames inline in its own row;
   *  out here there is no row to hand over to, so ask for the name directly. */
  function railRenameSession(s, cwd) {
    uiPrompt({
      title: "Rename session",
      value: s.displayName || "",
      placeholder: "Session name",
      confirmLabel: "Rename",
    }).then((name) => {
      const next = (name || "").trim();
      if (!next || next === s.displayName) return;
      vscode.postMessage({ type: "renameSession", id: s.id, name: next, ...(cwd ? { cwd } : {}) });
      paintPendingRename(s.id, next);
    });
  }

  /** Opening a rail row is the same act wherever the row is drawn, so both the
   *  full row and the capability-stripped one share it. */
  function railSessionOpener(s, repo, active) {
    return () => {
      // Already the display target (confirmed or this pending click) — no-op.
      // Deliberately NOT gated on repoSwitcherLocked: a new click supersedes any
      // in-flight rail transition, and stacking resumeSession is the host's job
      // to serialise. Locking here is what made a second click during load feel
      // dropped.
      if (active || isRailPendingRow(s)) return;
      // Optimistic highlight + veil before the host answers. activeSessionId is
      // left alone until sessionName / sessions.activeId confirm this id.
      startRailResumeTransition(s.id, s.cwd || repo.cwd, repo.cwd, s.displayName);
      // `cwd` rides along so a session in another repo reopens in ITS checkout —
      // the host resolves sessions by cwd, and omitting it would look the id up
      // under the repo we happen to be in.
      if (!sameCwd(repo.cwd, state.selectedRepoCwd)) forgetRememberedSessionByChoice();
      postResumeSession(s.id, s.cwd || repo.cwd, { claim: true });
    };
  }

  function railNote(text) {
    const el = document.createElement("div");
    el.className = "rail-note";
    el.textContent = text;
    return el;
  }

  /** Take an unfiltered first page as the selected repo's rail rows. Targeted
   *  removals also prune it, without adopting the history popover's search. */
  function adoptRailRows(entries) {
    state.railSelectedRows = uniqueSessionRows(entries);
    state.railSelectedRowsKnown = true;
    state.railSessionsStale = false;
    renderRail();
    renderSessionHead();
  }

  function selectRailRepo(repo) {
    state.repoSwitchPending = true;
    // What we are waiting for. The lock used to be released only by the frames a
    // session start produces — a replay, setBusy, or an error — which was fine
    // while every switch opened a conversation. Selecting a project no longer
    // touches any session, so on that path none of the three ever arrive and the
    // lock stuck: every "+" in the rail stayed disabled, in every project, until
    // something unrelated started a session. The catalog echo below is the
    // completion signal that actually belongs to a selection.
    state.repoSwitchTarget = repo.cwd;
    // A superseded switch drops its intent with it — otherwise clicking "+" on
    // one project and then a plain row on another would start a conversation
    // nobody asked for.
    if (window.__grokRailNewIntent && !sameCwd(window.__grokRailNewIntent, repo.cwd)) {
      window.__grokRailNewIntent = null;
    }
    renderRepoChip();
    forgetRememberedSessionByChoice();
    vscode.postMessage({ type: "selectRepo", cwd: repo.cwd });
  }

  // ---------- messages ----------

  function clearWelcome() {
    if (!state.welcomeVisible) return;
    const welcome = $("welcome");
    if (welcome) welcome.hidden = true;
    state.welcomeVisible = false;
  }

  /** The welcome panel's status line \u2014 the ONE place a pre-transcript wait is
   *  announced. Busy states borrow the send button's loader-circle so every
   *  "working" affordance spins the same way; settled states are plain text.
   *  `dataset.status` records which busy state is showing, so a later clear can
   *  tell "the conversation finished loading" from "startup finished" without
   *  comparing display strings. */
  function setWelcomeStatus(text, busy) {
    // body.identity-restoring: the wrapper's "Restoring conversation…" is the
    // only copy. Call sites already skip a painted-conversation hold.
    if (identityRestoring()) return;
    const ver = $("welcome-version");
    if (!ver) return;
    ver.classList.toggle("welcome-status-busy", !!busy);
    ver.dataset.status = busy ? text : "";
    if (!busy) {
      ver.textContent = text;
      renderWelcomeTip();
      return;
    }
    ver.textContent = "";
    ver.insertAdjacentHTML("beforeend", ICON.spinner);
    const label = document.createElement("span");
    label.textContent = text;
    ver.appendChild(label);
    renderWelcomeTip();
  }

  /**
   * Hide the current transcript without deleting it. Opening B must not leave
   * A's messages under B's title; aborting B must be able to put A's messages
   * back. Host `clearMessages` marks nodes pending-clear; they are destroyed
   * when replacement content arrives (`appendTranscriptChild`) or on the next
   * frame (`flushPendingTranscriptClear`) if none does.
   */
  function veilTranscriptForPendingOpen() {
    const welcome = $("welcome");
    for (const child of Array.from(messagesEl.children)) {
      if (child.id === "welcome") continue;
      if (child.getAttribute("data-pending-clear") === "1") continue;
      if (child.hasAttribute("data-pending-open-hide")) continue;
      child.setAttribute("data-pending-open-hide", "1");
      child.hidden = true;
    }
    // A host clear already owns these nodes; revealing the empty state on top
    // of them is the reconnect flash. The click path veils *before* that clear.
    if (welcome && !hasPendingClearNodes() && !identityRestoring()) {
      welcome.hidden = false;
      state.welcomeVisible = true;
    }
  }

  function unveilTranscriptAfterFailedOpen() {
    let restored = 0;
    for (const child of Array.from(messagesEl.children)) {
      if (child.getAttribute("data-pending-open-hide") !== "1") continue;
      // A committed host clear owns these nodes now; putting them back would
      // resurrect a conversation the next-frame flush is about to drop.
      if (child.getAttribute("data-pending-clear") === "1") continue;
      child.removeAttribute("data-pending-open-hide");
      child.hidden = false;
      restored++;
    }
    const welcome = $("welcome");
    if (welcome && restored > 0) {
      welcome.hidden = true;
      state.welcomeVisible = false;
    }
  }

  function setConversationLoading(active) {
    // Either branch stamps the empty-state line. A painted conversation must
    // not pick up Connected / Loading conversation, including when those
    // messages arrive before clearMessages has marked the nodes.
    if (welcomeHoldActive()) return;
    if (active) {
      // Deliberately the only indicator. A second banner above the transcript
      // used to double it up, and the transcript arrives as one batch anyway \u2014
      // so the wait that's worth announcing happens while the welcome is still
      // on screen, and the banner only ever duplicated this line.
      setWelcomeStatus("Loading conversation", true);
      return;
    }
    const ver = $("welcome-version");
    if (ver && ver.dataset.status === "Loading conversation") {
      setWelcomeStatus(state.cliVersion ? `Connected \u00b7 v${state.cliVersion}` : "Connected", false);
    }
  }

  /**
   * The one hint we show, in the empty state, in editors that refuse our
   * secondary-side-bar container.
   *
   * It exists because of a limit we cannot engineer around: nothing in the API
   * reports where a view lives, so the extension may place the chat somewhere
   * usable on a first-ever run and must never touch it again. That leaves the
   * better spot — the editor's own secondary side bar, beside its agent —
   * reachable only through the editor's own picker. So we say so, once, instead
   * of moving anything.
   *
   * `moveViewHint` is decided by the host and goes false the moment that picker
   * is opened from anywhere, so taking the advice retires the advice.
   */
  function renderMoveViewTip() {
    const welcome = $("welcome");
    if (!welcome) return;
    const existing = $("welcome-tip");
    if (existing) return;
    const tip = document.createElement("p");
    tip.id = "welcome-tip";
    tip.className = "welcome-tip muted";
    tip.dataset.tip = "moveView";
    // Built here rather than in the host's HTML skeleton, so the relay's mirror
    // of that skeleton cannot drift out of sync over an element it never shows.
    // Two steps, because the second cannot be done for the user. The host's
    // picker command does NOT wait for the pick — it opens the quickpick and
    // resolves immediately — so a reveal issued after it steals focus and
    // dismisses the picker before anything is chosen. And the move itself does
    // not open the container it landed in, which in Cursor is a collapsed agents
    // side bar. Say what to do, rather than half-doing it.
    //
    // The follow-up step is stated FIRST, above the action: acting on the link
    // dismisses this tip, so anything written below it would be read only by
    // someone who had already lost the chance to act on it.
    //
    // A <span>, not an <a href="#">: an anchor makes the webview attempt a
    // navigation, and the editor answers by trying to open a file that does not
    // exist. `role`/`tabindex`/keydown put back the semantics the anchor was
    // providing.
    tip.innerHTML =
      `<span class="welcome-tip-bulb">${ICON.idea}</span> <b>To move Grok to the right</b>` +
      "<br>After moving, click <b>Toggle Agents Side Bar</b> to show it." +
      '<br><span id="welcome-tip-link" class="muted-link" role="button" tabindex="0">Click here</span>' +
      " and select <b>New Secondary Side Bar Entry</b>.";
    welcome.appendChild(tip);
    const link = $("welcome-tip-link");
    if (link) {
      const open = (e) => {
        e.preventDefault();
        vscode.postMessage({ type: "moveView", location: "pick" });
        // Clear the LOCAL capability too, not just the node. `initialState` is
        // not re-sent on a session swap, so `resetForNewSession` would rebuild
        // the empty state, re-read a still-true flag and put the hint straight
        // back. The host records it as well, for the next window.
        if (state.hostCaps) state.hostCaps.moveViewHint = false;
        tip.remove();
      };
      link.onclick = open;
      // Keyboard parity, which the anchor used to give for free.
      link.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") open(e);
      };
    }
  }

  /**
   * Everything the tip pool needs, read off state the client already holds.
   *
   * Two facts are read CONSERVATIVELY rather than optimistically, because the
   * failure modes are not symmetric. An absent routine/connector count means
   * the host has not told us yet - welcomeTipsFor drops those tips rather than
   * treating "unknown" as "zero", which would advertise routines to someone
   * running twenty. Same for providers: until `providerState` arrives, claim an
   * alternate agent IS connected, so the one tip a multi-agent user would find
   * silly cannot flash on screen during startup.
   */
  /** Whatever tip is on screen right now, or "". */
  function currentWelcomeTipId() {
    const el = document.getElementById("welcome-tip");
    return (el && el.dataset && el.dataset.tip) || "";
  }

  function welcomeTipFacts() {
    const host = state.welcomeTips || {};
    const providers = state.providers || [];
    const altConnected = providers.some(
      (p) => p && (p.id === "codex" || p.id === "claude") && p.connected,
    );
    return {
      appPurpose: state.appPurpose === "coding" ? "coding" : "knowledge",
      isRemote: IS_REMOTE,
      // Mirrors continueChatDestinations(), so the tip is never offered where
      // the action it links to would be refused.
      worktreeSupported: state.worktreeSupported !== false,
      inWorktree: !!state.isWorktree,
      altAgentConnected: !state.providersKnown || altConnected,
      // A cloud machine can connect agents from here and cannot connect Claude
      // Code at all; both change what the providers tip should say and whether
      // it may be shown.
      cloudHost: !!(state.hostCaps && state.hostCaps.remoteAgentSignOut),
      remoteCanConnectAgents: !!(state.hostCaps && state.hostCaps.remoteAgentSignIn),
      routineCount: host.routineCount,
      connectorCount: host.connectorCount,
      // A phone's read-aloud is its own client-side preference, not the desk's.
      readRepliesAloud: IS_REMOTE ? !!state.remoteTts : !!state.readRepliesAloud,
      voiceConfigured: !!state.voiceConfigured,
      remoteLinked: state.remoteLinked,
      // Host list plus anything retired here. The union, so the control works
      // before the first frame and keeps working if the host never answers.
      dismissed: (Array.isArray(host.dismissed) ? host.dismissed : [])
        .concat(Array.from(welcomeTipsRetiredHere)),
      shownToday: (Array.isArray(host.shownToday) ? host.shownToday : [])
        .concat(Array.from(welcomeTipsClosedHere)),
      // The tip on screen is exempt from the once-a-day filter — it joined that
      // list when it rendered, and a repaint must not blank it mid-read. Closing
      // it with the X is exactly the act of releasing that pin.
      keepId: welcomeTipsClosedHere.has(currentWelcomeTipId())
        ? ""
        : currentWelcomeTipId(),
    };
  }

  /**
   * Record that a tip has had its turn today, once per client.
   *
   * Deliberately NOT conditional on the host frame having arrived — that is the
   * same mistake the dismiss control made, where an effect that depended on a
   * frame landing silently did nothing when it had not.
   */
  function noteWelcomeTipShown(id, force) {
    if (!force && welcomeTipsNoted.has(id)) return;
    welcomeTipsNoted.add(id);
    const host = state.welcomeTips;
    if (host && Array.isArray(host.shownToday) && host.shownToday.indexOf(id) < 0) {
      host.shownToday = host.shownToday.concat([id]);
    }
    vscode.postMessage({ type: "welcomeTipShown", id });
  }

  /** The X: done with this one for today. */
  function closeWelcomeTipForToday(id) {
    welcomeTipsClosedHere.add(id);
    // `force`, because the render already noted this id and the once-guard
    // would otherwise swallow the message. That guard exists to stop repaints
    // rewriting the file all afternoon; a deliberate close is not a repaint,
    // and if the render's note never reached the host then without this one
    // tomorrow would look exactly like today. The host is idempotent per day,
    // so the extra message costs nothing when the first one did arrive.
    noteWelcomeTipShown(id, true);
  }

  /**
   * Where a tip's action goes. Every destination is real and reachable from an
   * empty screen — that is the bar a tip has to clear to earn a link at all,
   * and the reason the Plan tip was removed rather than given one: it pointed
   * at a mode menu, which is a control, not work.
   */
  function runWelcomeTipTarget(target) {
    if (typeof target !== "string") return;
    if (target.indexOf("settings:") === 0) {
      openSettingsCategory(target.slice("settings:".length));
      return;
    }
    if (target === "worktree") {
      // No confirm step: the host refuses a non-git folder and a nested
      // worktree with a message of its own, and on an empty screen the only
      // other destination ("use this checkout") is what the screen already is.
      vscode.postMessage({ type: "newWorktreeSession" });
      return;
    }
    if (target === "mention") {
      // Put the caret where the advice points and type the character for them.
      // Anything less leaves the reader to find the composer and remember what
      // the tip said; the popover then opens on its own from the input handler.
      const input = $("input");
      if (!input) return;
      input.focus();
      const at = input.selectionStart === null || input.selectionStart === undefined
        ? input.value.length
        : input.selectionStart;
      const before = input.value.slice(0, at);
      const insert = (before && !/\s$/.test(before) ? " " : "") + "@";
      input.value = before + insert + input.value.slice(at);
      const caret = at + insert.length;
      if (typeof input.setSelectionRange === "function") input.setSelectionRange(caret, caret);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  /**
   * Tips retired in THIS client, whatever the host has said.
   *
   * The dismiss control used to write only into `state.welcomeTips.dismissed`,
   * which meant it did nothing at all whenever that frame had not arrived: no
   * local record, so the next render recomputed the same pool and put the same
   * tip straight back. On a host too old to answer, the X stayed inert for
   * ever. A control whose effect depends on a frame having landed is a control
   * that silently does nothing, so this set is consulted unconditionally and
   * merged with whatever the host reports.
   */
  const welcomeTipsRetiredHere = new Set();

  /**
   * Tips the reader has closed with the X — NOT TODAY, not for ever.
   *
   * Every tip is already recorded as shown for the day the moment it renders,
   * so closing one does not need to record anything new: it only has to release
   * the pin that keeps the tip currently on screen exempt from that day filter.
   * Tomorrow it comes round again.
   */
  const welcomeTipsClosedHere = new Set();

  /** Ids this client has already reported as shown, so a repaint cannot post
   *  the same note over and over. */
  const welcomeTipsNoted = new Set();

  /** Retire a tip - the same message for "took it" and "not interested",
   *  because both mean the reader is done with it. */
  function retireWelcomeTip(id) {
    // First, and never conditionally: this is what makes the click work.
    welcomeTipsRetiredHere.add(id);
    const host = state.welcomeTips;
    if (host && Array.isArray(host.dismissed) && host.dismissed.indexOf(id) < 0) {
      host.dismissed = host.dismissed.concat([id]);
    }
    vscode.postMessage({ type: "dismissWelcomeTip", id });
  }

  /**
   * Advice in the empty state: one line naming something this user has not set
   * up yet.
   *
   * THE SLOT IS SHARED with the move-view hint above, which wins while the host
   * still offers it - that hint is about a window that is currently in the
   * wrong place, which outranks anything on this list.
   *
   * Three suppressions, each a rule rather than a special case:
   *  - while the status line is BUSY (Starting / Loading conversation), because
   *    a tip under a spinner competes with the one line the reader is waiting
   *    for;
   *  - while the onboarding card is up, because that empty state already has a
   *    call to action and does not need a second one;
   *  - when the pool is empty, in which case the screen goes back to what it is
   *    today. A permanently occupied slot stops being advice.
   *
   * Rotation advances only when the screen BECOMES empty (`advance`), never on
   * a repaint - otherwise a provider frame arriving mid-startup would shuffle
   * the line under the reader's eyes.
   */
  function renderWelcomeAdviceTip(advance) {
    const welcome = $("welcome");
    if (!welcome) return;
    // Rotate first. The screen becoming empty is what advances the cursor, and
    // that has already happened by the time any of the suppressions below run —
    // a desktop cold start is BUSY at this moment, and holding the rotation
    // until it settles (where no `advance` is passed) would pin one tip for ever.
    if (advance) state.welcomeTipCursor = (state.welcomeTipCursor || 0) + 1;
    const helpers = window.GrokWebviewHelpers;
    const existing = $("welcome-tip");
    const drop = () => { if (existing) existing.remove(); };
    if (!helpers || typeof helpers.welcomeTipsFor !== "function") return drop();
    const status = $("welcome-version");
    if (status && status.classList.contains("welcome-status-busy")) return drop();
    // BOTH the mode and the node. The node alone is a proxy that is briefly
    // wrong: showOnboarding sets the mode, reveals the welcome — which stamps
    // the status line, which re-renders this slot — and only then writes the
    // card's HTML. In that gap the node is still empty, so a tip rendered over
    // an empty state that was about to have a call to action in it, and burned
    // its own once-a-day turn doing so.
    if (state.onboardingMode) return drop();
    const onb = $("welcome-onboarding");
    if (onb && onb.childNodes.length) return drop();

    const pool = helpers.welcomeTipsFor(welcomeTipFacts());
    if (!pool.length) return drop();
    const cursor = state.welcomeTipCursor || 0;
    const tip = pool[((cursor % pool.length) + pool.length) % pool.length];

    // Idempotent: the same advice already on screen is left alone, so the
    // status-line and provider frames that call through here cannot flicker it.
    if (existing && existing.dataset.tip === tip.id) return;
    drop();

    const parts = helpers.splitWelcomeTipCopy(
      typeof helpers.welcomeTipCopy === "function" ? helpers.welcomeTipCopy(tip, welcomeTipFacts()) : tip.copy,
    );
    const el = document.createElement("p");
    el.id = "welcome-tip";
    el.className = "welcome-tip welcome-advice muted";
    el.dataset.tip = tip.id;

    const bulb = document.createElement("span");
    bulb.className = "welcome-tip-bulb";
    bulb.innerHTML = ICON.idea;
    bulb.setAttribute("aria-hidden", "true");
    el.appendChild(bulb);

    const body = document.createElement("span");
    body.className = "welcome-tip-body";
    // textContent throughout - tip copy is never parsed as markup.
    body.appendChild(document.createTextNode(parts.before));
    if (parts.action) {
      // A <span role="button">, not an <a href="#">: an anchor makes the
      // webview attempt a navigation and the editor answers by trying to open a
      // file that does not exist. Same reason as the move-view hint above.
      const action = document.createElement(tip.target ? "span" : "b");
      action.textContent = parts.action;
      if (tip.target) {
        action.className = "muted-link";
        action.setAttribute("role", "button");
        action.setAttribute("tabindex", "0");
        const go = (e) => {
          if (e) e.preventDefault();
          // The click must NOT reach the document. Several handlers there close
          // every popover on any outside click, and this one runs first — so a
          // target that opens a popover had it built and then hidden again in
          // the same tick, which is precisely how the Plan link looked broken
          // while doing exactly what it was told.
          if (e && typeof e.stopPropagation === "function") e.stopPropagation();
          runWelcomeTipTarget(tip.target);
          // Acting on advice retires the advice - the principle the move-view
          // hint established. Retire AFTER opening, so a target that refuses to
          // open still leaves the reader holding the tip.
          retireWelcomeTip(tip.id);
          renderWelcomeTip();
        };
        action.onclick = go;
        action.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") go(e); };
      }
      body.appendChild(action);
    }
    body.appendChild(document.createTextNode(parts.after));
    el.appendChild(body);

    const close = document.createElement("button");
    close.type = "button";
    close.className = "welcome-tip-dismiss";
    close.title = "Not today";
    close.setAttribute("aria-label", "Hide this tip until tomorrow");
    close.textContent = "\u00d7";
    close.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeWelcomeTipForToday(tip.id);
      renderWelcomeTip();
    };
    el.appendChild(close);

    welcome.appendChild(el);
    // After the append, so a tip that failed to build is not marked as seen.
    noteWelcomeTipShown(tip.id);
  }

  /**
   * The empty state's single advice slot.
   *
   * `advance` rotates to the next eligible tip and is passed only from the two
   * places where the screen genuinely becomes empty again - a new session, and
   * the deferred transcript wipe. Every other caller is a repaint.
   */
  function renderCodexUpdateNudge() {
    const existing = $("welcome-codex-update");
    if (existing) existing.remove();
    const welcome = $("welcome");
    const codex = (state.providers || []).find((p) => p.id === "codex");
    if (!welcome || !codex || !codex.cliUpdate) return;
    const update = codex.cliUpdate;
    // Retain progress/outcome after the version changes so an empty phone
    // conversation doesn't lose the answer to the update it just requested.
    if ((!codex.connected || !codex.updateAvailable) && update.status === "idle") return;
    const el = document.createElement("div");
    el.id = "welcome-codex-update";
    el.className = "welcome-tip welcome-cli-update muted";
    el.setAttribute("role", "status");
    const text = document.createElement("span");
    text.textContent = update.message ||
      `Codex CLI v${codex.cliVersion} is older than v${codex.latestCliVersion}, the version included with this app. Update to discover newer models. `;
    el.appendChild(text);
    if (codex.connected && (codex.updateAvailable || update.status === "failed") && update.status !== "running") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "muted-link";
      button.textContent = "Update Codex CLI";
      button.disabled = (state.providers || []).some((p) => p.cliUpdate && p.cliUpdate.status === "running");
      button.onclick = async () => {
        const ok = await uiConfirm({
          title: "Update Codex CLI?",
          body: "This runs Codex’s updater on the connected machine. Running Codex sessions will stop, then visible conversations will resume.",
          confirmLabel: "Update Codex CLI",
        });
        if (ok) vscode.postMessage({ type: "updateCodex" });
      };
      el.appendChild(document.createTextNode(" "));
      el.appendChild(button);
    }
    welcome.appendChild(el);
  }

  function renderWelcomeTip(advance) {
    renderCodexUpdateNudge();
    // Never in the browser client. The capability is mirrored to remotes with
    // the rest of initialState, but where the chat sits is a property of the
    // machine running the extension - `moveView` is host-local and the relay
    // drops it, so a phone would get advice it cannot take.
    if (!IS_REMOTE && state.hostCaps && state.hostCaps.moveViewHint === true) {
      const existing = $("welcome-tip");
      if (existing && existing.dataset.tip !== "moveView") existing.remove();
      renderMoveViewTip();
      return;
    }
    const stale = $("welcome-tip");
    if (stale && stale.dataset.tip === "moveView") stale.remove();
    renderWelcomeAdviceTip(advance);
  }

  // clearMessages marks existing transcript nodes instead of destroying them.
  // Destroy at the first replacement append (same task) or on the next frame
  // if nothing replaces it. body.identity-restoring suspends that next-frame
  // flush: a restore is a replacement we already know is coming, so wait for
  // the class to lift and flush then only if nothing arrived. Welcome, title,
  // composer focus, and the reader's pin stay put while a conversation is
  // still on screen — a resync must not blank, refocus, re-pin, or paint
  // "Starting" over it, even before those nodes are marked pending-clear.
  const PENDING_CLEAR_ATTR = "data-pending-clear";
  let pendingTranscriptClear = false;
  let pendingTranscriptClearRaf = 0;
  // Status resetForNewSession would have stamped immediately. Held while a
  // conversation is still on screen (pending-clear or not) or while
  // body.identity-restoring is set; applied in the flush if nothing replaces
  // them, dropped if a replacement arrives.
  // "loading" / "no-project" / "starting" match the three special cases at
  // the welcome block.
  let pendingWelcomeReveal = null;
  // Title, worktree flag, in-progress rename, composer focus, and the
  // reader's pin: same hold. A resync must not blank the name, move focus
  // (a returning phone tab would pop the keyboard), or yank a scrolled-up
  // reader to the bottom. Flush still applies them for an empty swap; a
  // sessionName with a different id applies focus + pin for a real swap.
  let pendingSessionChromeReset = false;
  // Desktop launch is a different event from that resync: the app just opened
  // and the caret belongs in the composer, restored conversation or not. One
  // shot, consumed on the first focused-window claim. VS Code never sets this.
  let desktopLaunchFocusPending = IS_DESKTOP_CLIENT;

  function isPendingClearNode(el) {
    return !!(el && typeof el.closest === "function" && el.closest("[" + PENDING_CLEAR_ATTR + "]"));
  }

  function hasPendingClearNodes() {
    for (const child of messagesEl.children) {
      if (child.id === "welcome") continue;
      if (child.getAttribute(PENDING_CLEAR_ATTR) === "1") return true;
    }
    return false;
  }

  function welcomeRevealKind() {
    if (state.railTransition) return "loading";
    if (state.onboardingMode === "no-project") return "no-project";
    return "starting";
  }

  function applyWelcomeRevealKind(kind) {
    if (kind === "loading") setConversationLoading(true);
    else if (kind === "no-project") setWelcomeStatus("No project folder", false);
    else setWelcomeStatus("Starting", true);
  }

  function revealWelcome() {
    if (welcomeHoldActive()) return;
    const welcome = $("welcome");
    if (welcome) welcome.hidden = false;
    state.welcomeVisible = true;
  }

  function identityRestoring() {
    return !!(document.body && document.body.classList.contains("identity-restoring"));
  }

  function welcomeHoldActive() {
    // Cold load of a remembered conversation: the wrapper owns the wait
    // ("Restoring conversation…") and the welcome starts visible with no .msg
    // nodes, so the painted-conversation hold below would not apply. Hide it
    // in syncIdentityRestoreHold — this predicate only refuses to stamp/reveal.
    if (identityRestoring()) return true;
    const welcome = $("welcome");
    if (!welcome || !welcome.hidden) return false;
    // A painted conversation, whether already marked pending-clear or not.
    // Remote snapshots send initialState first; local sends clearMessages first.
    // Keying the hold on the mark made the phone's order stamp the empty state.
    for (const child of messagesEl.children) {
      if (child.id === "welcome") continue;
      if (isPendingClearNode(child)) return true;
    }
    return liveTranscriptQueryAll(".msg").length > 0;
  }

  function liveTranscriptQueryAll(sel) {
    return [...messagesEl.querySelectorAll(sel)].filter((el) => !isPendingClearNode(el));
  }

  function cancelPendingTranscriptClearRaf() {
    if (!pendingTranscriptClearRaf) return;
    cancelAnimationFrame(pendingTranscriptClearRaf);
    pendingTranscriptClearRaf = 0;
  }

  function schedulePendingTranscriptClearFlush() {
    if (pendingTranscriptClearRaf) return;
    pendingTranscriptClearRaf = requestAnimationFrame(() => {
      pendingTranscriptClearRaf = 0;
      flushPendingTranscriptClear();
    });
  }

  function markTranscriptPendingClear() {
    pendingTranscriptClear = true;
    for (const child of Array.from(messagesEl.children)) {
      if (child.id === "welcome") continue;
      child.setAttribute(PENDING_CLEAR_ATTR, "1");
    }
    cancelPendingTranscriptClearRaf();
    if (identityRestoring()) return;
    schedulePendingTranscriptClearFlush();
  }

  function focusComposerIfAllowed() {
    // Guarded on document.hasFocus(): a host-initiated clear can arrive while
    // the user is typing in the editor, and focusing then would yank keyboard
    // focus across panels. The same argument keeps a resync from focusing —
    // that path never reaches here because the chrome reset is held.
    if (typeof document.hasFocus !== "function" || document.hasFocus()) input.focus();
  }

  function takeDesktopLaunchComposerFocus() {
    // The desktop app IS the chat. First time this document is the focused
    // surface, put the caret in the composer — including a boot that restores
    // a conversation (the pending-clear hold would otherwise skip it). A
    // reconnect/resync of an already-open surface has already consumed this.
    // Do not consume while the window is unfocused: show:false boot would
    // burn the shot before the first real window-focus.
    if (!desktopLaunchFocusPending) return false;
    if (typeof document.hasFocus === "function" && !document.hasFocus()) return false;
    desktopLaunchFocusPending = false;
    input.focus({ preventScroll: true });
    return true;
  }

  function resetSessionChrome() {
    pendingSessionChromeReset = false;
    if (state.sessionNameEditing) finishSessionNameEdit(false);
    state.isWorktree = false;
    state.sessionName = null;
    renderSessionName();
    if (IS_REMOTE) renderSessionHead();
    focusComposerIfAllowed();
    setStickToBottom(true); // a fresh/loaded session starts pinned
    updateScrollBtn();
  }

  /** Empty-state path: no replacement arrived, so the welcome must appear. */
  function flushPendingTranscriptClear() {
    if (!pendingTranscriptClear) return;
    // Replay has started: replacement is in flight even if the first append
    // has not landed yet. Keep the conversation until it does, or until the
    // replay ends empty and calls us again.
    if (state.replaying) return;
    // Same for the wrapper's restore veil: stay armed until the class lifts.
    if (identityRestoring()) return;
    pendingTranscriptClear = false;
    const kind = pendingWelcomeReveal;
    pendingWelcomeReveal = null;
    const chrome = pendingSessionChromeReset;
    cancelPendingTranscriptClearRaf();
    for (const child of Array.from(messagesEl.children)) {
      if (child.getAttribute(PENDING_CLEAR_ATTR) === "1") child.remove();
    }
    if (kind) {
      applyWelcomeRevealKind(kind);
      // A genuinely new empty screen — rotate to the next piece of advice.
      renderWelcomeTip(true);
    }
    if (chrome) resetSessionChrome();
    revealWelcome();
  }

  // The relay wrapper sets body.identity-restoring while it restores a
  // remembered session on a fresh page. Both layers share this document, so
  // read the class rather than waiting for a host frame.
  let identityRestoreHeld = false;

  function scheduleEmptyWelcomeFlush() {
    pendingTranscriptClear = true;
    if (pendingWelcomeReveal == null) pendingWelcomeReveal = welcomeRevealKind();
    schedulePendingTranscriptClearFlush();
  }

  function syncIdentityRestoreHold() {
    const now = identityRestoring();
    if (now) {
      const welcome = $("welcome");
      if (welcome) welcome.hidden = true;
      if (pendingWelcomeReveal == null) pendingWelcomeReveal = welcomeRevealKind();
      identityRestoreHeld = true;
      cancelPendingTranscriptClearRaf();
      return;
    }
    if (!identityRestoreHeld) return;
    identityRestoreHeld = false;
    // Pending-clear nodes still count as painted, so welcomeHoldActive cannot
    // decide this. Flag dropped → replacement landed. Still armed → flush.
    if (!pendingTranscriptClear && welcomeHoldActive()) {
      pendingWelcomeReveal = null;
      return;
    }
    scheduleEmptyWelcomeFlush();
  }

  syncIdentityRestoreHold();
  if (typeof MutationObserver === "function" && document.body) {
    new MutationObserver(syncIdentityRestoreHold).observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  // Last N counted user bubbles render on open; earlier turns prepend on scroll
  // (#102). 80 is several screens even on a phone, 8× the remote snapshot of 10,
  // and small conversations fall through unchanged. Tests may shrink it via
  // `window.__grokHistoryWindow`.
  const HISTORY_WINDOW_USER_TURNS = 80;
  const HISTORY_PREPEND_USER_TURNS = 40;
  const HISTORY_PREPEND_PX = 720;
  let historyPark = null;
  let prependLock = 0;

  function historyWindowTurns() {
    const override = window.__grokHistoryWindow;
    if (typeof override === "number" && override > 0 && Number.isFinite(override)) return Math.floor(override);
    return HISTORY_WINDOW_USER_TURNS;
  }

  function firstLiveTranscriptChild() {
    for (const child of messagesEl.children) {
      if (child.id === "welcome" || child.id === "history-head") continue;
      if (isPendingClearNode(child)) continue;
      return child;
    }
    return null;
  }

  function syncHistoryHead() {
    let head = $("history-head");
    const more = !!(state.historyPrefix && state.historyPrefix.length);
    if (!more) {
      if (head) head.remove();
      return null;
    }
    if (!head) {
      head = document.createElement("div");
      head.id = "history-head";
      head.setAttribute("aria-hidden", "true");
      const welcome = $("welcome");
      if (welcome && welcome.parentElement === messagesEl) {
        messagesEl.insertBefore(head, welcome.nextSibling);
      } else {
        messagesEl.insertBefore(head, messagesEl.firstChild);
      }
    }
    head.hidden = false;
    return head;
  }

  function clearHistoryWindow() {
    state.replayHold = false;
    state.replayHeld = [];
    state.historyPrefix = [];
    state.historyPrefixUserCount = 0;
    state.historyPrefixPlans = [];
    state.historyPrefixPermissions = [];
    state.historyHydrating = false;
    historyPark = null;
    const head = $("history-head");
    if (head) head.remove();
  }

  const REPLAY_HOLD_TYPES = new Set([
    "userMessage", "agentStart", "thoughtChunk", "messageChunk", "media",
    "userMessageChunk", "historyBatch", "toolCall", "toolCallUpdate",
    "permissionRequest", "permissionOptions", "permissionResolved",
    "exitPlanRequest", "planResolved", "questionRequest", "planNotice",
    "autoCompactNotice", "planBlocked", "promptComplete", "commandOutput",
    "agentReset", "agentError", "agentEnd", "exit", "sessionContext",
    "xaiNotification", "subagentUpdate", "childStream", "runProgress",
    "summarizing",
  ]);

  function recordPrefixExport(msgs) {
    for (const m of flattenHistoryMessages(msgs)) {
      if (isExportableSessionEvent(m)) state.exportEvents.push(m);
    }
  }

  function applyHistoryWindow(held) {
    const split = splitHistoryWindow(held, historyWindowTurns());
    state.historyPrefix = split.prefix;
    state.historyPrefixUserCount = split.prefixUserCount;
    if (split.prefixUserCount > 0) {
      const counters = countHistoryReplayCounters(split.prefix);
      state.userMsgCount = counters.userMsgCount;
      state.interjectionCount = counters.interjectionCount;
      state.historyEventCount = counters.historyEventCount;
      const plans = state.planHistoryQueue || [];
      state.historyPrefixPlans = plans.filter((p) =>
        typeof p.afterUserMessage === "number" && p.afterUserMessage <= split.prefixUserCount);
      state.planHistoryQueue = plans.filter((p) =>
        typeof p.afterUserMessage !== "number" || p.afterUserMessage > split.prefixUserCount);
      const perms = state.permissionHistoryQueue || [];
      state.historyPrefixPermissions = perms.filter((p) =>
        typeof p.afterUserMessage === "number" && p.afterUserMessage <= split.prefixUserCount);
      state.permissionHistoryQueue = perms.filter((p) =>
        typeof p.afterUserMessage !== "number" || p.afterUserMessage > split.prefixUserCount);
      recordPrefixExport(split.prefix);
    }
    for (const m of split.suffix) handleHostMessage(m);
    syncHistoryHead();
  }

  function restorePrependAnchor(sentinel, y) {
    if (!sentinel || !sentinel.isConnected) return 0;
    const delta = sentinel.getBoundingClientRect().top - y;
    if (delta) messagesEl.scrollTop += delta;
    return delta;
  }

  function prependHistoryNodes(nodes) {
    if (!nodes.length) {
      state.historyHydrating = false;
      return;
    }
    const insertAt = firstLiveTranscriptChild();
    const sentinel = insertAt;
    const anchorY = sentinel ? sentinel.getBoundingClientRect().top : 0;
    const prevHeight = messagesEl.scrollHeight;
    const prevTop = messagesEl.scrollTop;
    // Native anchoring is off while pinned and would double-count a height-delta
    // write while unpinned. Hold the visible line in JS instead.
    prependLock += 1;
    messagesEl.classList.add("history-prepending");
    const head = syncHistoryHead();
    const before = (head && head.nextSibling) || insertAt;
    for (const node of nodes) {
      if (before) messagesEl.insertBefore(node, before);
      else HTMLElement.prototype.appendChild.call(messagesEl, node);
    }
    if (sentinel && sentinel.isConnected) restorePrependAnchor(sentinel, anchorY);
    else {
      const grown = messagesEl.scrollHeight - prevHeight;
      if (grown) messagesEl.scrollTop = prevTop + grown;
    }
    state.historyHydrating = false;
    const finish = () => {
      if (sentinel && sentinel.isConnected) restorePrependAnchor(sentinel, anchorY);
      messagesEl.classList.remove("history-prepending");
      prependLock = Math.max(0, prependLock - 1);
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(finish);
    else finish();
  }

  function loadEarlierHistory(all) {
    if (state.replaying || state.historyHydrating) return false;
    if (!state.historyPrefix.length) return false;
    const turns = all ? state.historyPrefixUserCount : HISTORY_PREPEND_USER_TURNS;
    const split = splitHistoryWindow(state.historyPrefix, Math.max(1, turns));
    const chunk = split.suffix.length ? split.suffix : split.prefix;
    const remain = split.suffix.length ? split.prefix : [];
    const remainUsers = split.suffix.length ? split.prefixUserCount : 0;
    const remainCounters = countHistoryReplayCounters(remain);
    state.historyPrefix = remain;
    state.historyPrefixUserCount = remainUsers;
    hydrateHistoryChunkWithCounters(chunk, remainUsers, remainCounters);
    return true;
  }

  function hydrateHistoryChunkWithCounters(chunk, startUserCount, remainCounters) {
    if (!chunk.length) return;
    const saved = {
      userMsgCount: state.userMsgCount,
      interjectionCount: state.interjectionCount,
      historyEventCount: state.historyEventCount,
      planHistoryQueue: state.planHistoryQueue,
      permissionHistoryQueue: state.permissionHistoryQueue,
      busy: state.busy,
      busyLocked: state.busyLocked,
      grokkingEl: state.grokkingEl,
      thinkingIndicatorEl: state.thinkingIndicatorEl,
      activeAgentEl: state.activeAgentEl,
      activeAgentRaw: state.activeAgentRaw,
      activeUserEl: state.activeUserEl,
      activeUserRaw: state.activeUserRaw,
      activeThoughtEl: state.activeThoughtEl,
      activeThoughtHdrEl: state.activeThoughtHdrEl,
      thoughtBuffer: state.thoughtBuffer,
      activeToolGroupEl: state.activeToolGroupEl,
      turnAgentActionsEl: state.turnAgentActionsEl,
      turnRating: state.turnRating,
      suppressReplayTurn: state.suppressReplayTurn,
      skipUserBubble: state.skipUserBubble,
      replaying: state.replaying,
    };
    historyPark = document.createElement("div");
    state.historyHydrating = true;
    state.replaying = true;
    state.busy = false;
    state.grokkingEl = null;
    state.thinkingIndicatorEl = null;
    state.activeAgentEl = null;
    state.activeAgentRaw = "";
    state.activeUserEl = null;
    state.activeUserRaw = "";
    state.activeThoughtEl = null;
    state.activeThoughtHdrEl = null;
    state.thoughtBuffer = "";
    state.activeToolGroupEl = null;
    state.turnAgentActionsEl = null;
    state.suppressReplayTurn = false;
    state.skipUserBubble = false;
    state.userMsgCount = startUserCount;
    state.interjectionCount = remainCounters.interjectionCount;
    state.historyEventCount = remainCounters.historyEventCount;
    const endUserCount = startUserCount + countHistoryReplayCounters(chunk).userMsgCount;
    const plans = partitionHistoryCards(state.historyPrefixPlans, startUserCount, endUserCount);
    const perms = partitionHistoryCards(state.historyPrefixPermissions, startUserCount, endUserCount);
    state.planHistoryQueue = plans.inChunk;
    state.permissionHistoryQueue = perms.inChunk;
    for (const m of chunk) handleHostMessage(m);
    flushPlanHistory();
    flushPermissionHistory();
    if (!state.historyPrefix.length) {
      state.planHistoryQueue = plans.rest;
      state.permissionHistoryQueue = perms.rest;
      flushPlanHistory();
      flushPermissionHistory();
    }
    const nodes = [...historyPark.children];
    historyPark = null;
    state.historyPrefixPlans = state.historyPrefix.length ? plans.rest : [];
    state.historyPrefixPermissions = state.historyPrefix.length ? perms.rest : [];
    state.userMsgCount = saved.userMsgCount;
    state.interjectionCount = saved.interjectionCount;
    state.historyEventCount = saved.historyEventCount;
    state.planHistoryQueue = saved.planHistoryQueue;
    state.permissionHistoryQueue = saved.permissionHistoryQueue;
    state.busy = saved.busy;
    state.busyLocked = saved.busyLocked;
    state.grokkingEl = saved.grokkingEl;
    state.thinkingIndicatorEl = saved.thinkingIndicatorEl;
    state.activeAgentEl = saved.activeAgentEl;
    state.activeAgentRaw = saved.activeAgentRaw;
    state.activeUserEl = saved.activeUserEl;
    state.activeUserRaw = saved.activeUserRaw;
    state.activeThoughtEl = saved.activeThoughtEl;
    state.activeThoughtHdrEl = saved.activeThoughtHdrEl;
    state.thoughtBuffer = saved.thoughtBuffer;
    state.activeToolGroupEl = saved.activeToolGroupEl;
    state.turnAgentActionsEl = saved.turnAgentActionsEl;
    state.turnRating = saved.turnRating;
    state.suppressReplayTurn = saved.suppressReplayTurn;
    state.skipUserBubble = saved.skipUserBubble;
    state.replaying = saved.replaying;
    prependHistoryNodes(nodes);
    refreshUserRewindButtons();
    syncHistoryHead();
    updateSendButton();
  }

  function expandHistoryAll() {
    while (state.historyPrefix.length) loadEarlierHistory(true);
  }

  function maybeLoadEarlierHistory() {
    if (state.replaying || state.historyHydrating) return;
    if (!state.historyPrefix.length) return;
    if (state.stickToBottom) return;
    if (messagesEl.scrollTop > HISTORY_PREPEND_PX) return;
    loadEarlierHistory(false);
  }

  /** Append replacement content. Drops pending-clear nodes in the same task
   *  AFTER the new node is in, so the transcript is never empty mid-paint. */
  function appendTranscriptChild(el) {
    if (historyPark) {
      historyPark.appendChild(el);
      return el;
    }
    if (!pendingTranscriptClear) {
      HTMLElement.prototype.appendChild.call(messagesEl, el);
      return el;
    }
    const scrollTop = messagesEl.scrollTop;
    pendingTranscriptClear = false;
    pendingWelcomeReveal = null;
    pendingSessionChromeReset = false;
    cancelPendingTranscriptClearRaf();
    HTMLElement.prototype.appendChild.call(messagesEl, el);
    for (const child of Array.from(messagesEl.children)) {
      if (child.getAttribute(PENDING_CLEAR_ATTR) === "1") child.remove();
    }
    messagesEl.scrollTop = scrollTop;
    return el;
  }

  function resetForNewSession() {
    clearSessionSuperseded();
    stopProcessingCue();
    cancelPendingSpeech();
    // The transcript is about to be emptied wholesale; drop the reference so a
    // later echo can't try to remove a node from the previous session.
    state.optimisticSendEl = null;
    markTranscriptPendingClear();
    // Incoming `session` / `sessionName` re-set these. Clearing them first is
    // why a resync blanks the title and then paints it back. Hold while the
    // previous conversation is still on screen — title, caret, and the
    // reader's pin. Flush applies the reset if this was an empty swap; a
    // replacement drops it.
    if (hasPendingClearNodes()) pendingSessionChromeReset = true;
    else resetSessionChrome();
    const welcome = $("welcome");
    if (welcome) {
      const onb = $("welcome-onboarding");
      // Keep a just-shown "Connected" confirmation. Connecting an agent starts a
      // fresh session for it, and that session swap arrives as clearMessages —
      // so wiping the panel here erased the very confirmation the swap was
      // announcing, which is why Codex and Claude never showed one. Any other
      // panel is genuinely stale at this point and still goes.
      if (onb && state.onboardingMode !== "provider-connected" && state.onboardingMode !== "no-project") onb.innerHTML = "";
      // A host clearMessages during an optimistic new-session transition must
      // not replace the paired "Loading conversation" veil with Starting — the
      // click already owns that wait. Otherwise the rail highlights the
      // placeholder while the welcome says something unrelated.
      // no-project is the other hold: last-folder-removed emits clearMessages
      // then the empty-state card, and flipping to Starting in between is the
      // hang that card exists to replace.
      //
      // Do not unhide or stamp while the previous conversation is still on
      // screen (pending-clear or not). flushPendingTranscriptClear applies the
      // same status once the nodes actually go; a replacement drops it so the
      // empty state never appears over a conversation that is about to come back.
      if (welcomeHoldActive() || hasPendingClearNodes()) {
        pendingWelcomeReveal = welcomeRevealKind();
      } else {
        pendingWelcomeReveal = null;
        applyWelcomeRevealKind(welcomeRevealKind());
        renderWelcomeTip(true);
      }
    }
    state.welcomeVisible = true;
    state.pendingDiffByToolCallId.clear();
    state.toolItemsByToolCallId.clear();
    state.toolFailuresById.clear();
    state.mediaGenCallIds.clear();
    state.subagentCards.clear();
    state.runProgressCards.clear();
    // Question/restored-card maps too, or a new session's tool updates could
    // attach to the previous session's (now-detached) cards by toolCallId.
    state.questionToolCalls.clear();
    state.restoredCardsByToolCallId.clear();
    state.pendingCommandDetails = [];
    state.toolExpandOverride = null; // the Expand/Collapse All latch is per-session; a swap/restore starts clean (the replay buffer re-applies it for a warm re-focus)
    state.turnAgentActionsEl = null;
    state.activeAgentEl = null;
    state.activeAgentRaw = "";
    state.activeUserEl = null;
    state.activeUserRaw = "";
    state.activeThoughtEl = null;
    state.activeThoughtHdrEl = null;
    state.thoughtBuffer = "";
    state.activeToolGroupEl = null;
    state.replaying = false;
    state.replayDepth = 0;
    clearHistoryWindow();
    state.exportEvents = [];
    state.exportWindowed = false;
    state.planHistoryQueue = [];
    state.permissionHistoryQueue = [];
    state.userMsgCount = 0;
    state.feedbackAvailable = false;
    state.turnRating = 0;
    state.interjectionCount = 0;
    state.historyEventCount = 0;
    state.lastTurnUsage = null;
    state.sessionUsage = null;
    state.contextBreakdown = null;
    state.suppressReplayTurn = false;
    state.skipUserBubble = false;
    cancelPendingSpeech();
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
    // Reset only the local render mirror. The deferred transcript wipe would
    // otherwise leave the queued block visible until the next frame; the replay
    // delivers the focused session's own queuedSends snapshot, so its queued
    // messages reappear when you swap back.
    if (state.queuedWrapEl) state.queuedWrapEl.remove();
    state.sendQueue = [];
    state.queuedWrapEl = null;
    state.queuedSubmissionPending = false;
    state.queuedSubmissionRejected = false;
    state.pendingSubmissionText = "";
    state.pendingSubmissionId = null;
    state.pendingSubmissionChipIds = [];
    state.rejectedSubmissionText = "";
    updateSendButton();
    // Body-attached lightbox / preview overlay outlive #messages — close them
    // on every session swap so the previous conversation cannot cover the next.
    // (confirm-overlay / uiPrompt are action-scoped and remove themselves.)
    closeImagePreview();
    closePreviewOverlay();
    onFindSessionReset();
  }

  /** Acts that open a terminal we cannot observe finishing. */
  const LAUNCH_ACTS = ["runInstall", "runLogin", "connectProvider"];
  const launchKey = (act, provider) => act + ":" + (provider || "");

  /**
   * Remember that a terminal was launched, and re-apply that on every render.
   *
   * Clicking one of these re-posts the onboarding state from the host, so the
   * panel is rebuilt immediately — a mark written straight onto the DOM node
   * vanished on the very next frame, which is why it looked like nothing had
   * happened even after pressing the button twice.
   *
   * Keyed per mode, so moving to a different panel starts clean; a re-render of
   * the SAME panel (a failed re-check) keeps it, because the terminal really was
   * opened and pressing it again just stacks another login on top.
   */
  function markOnboardingLaunched(act, provider) {
    if (state.onboardingRanMode !== state.onboardingMode) {
      state.onboardingRanMode = state.onboardingMode;
      state.onboardingRan = [];
      state.onboardingLaunched = [];
    }
    const key = launchKey(act, provider);
    if (!state.onboardingRan.includes(key)) state.onboardingRan.push(key);
    applyOnboardingLaunchState();
  }

  /**
   * The HOST opened a login terminal — from a Settings → Providers connect, or
   * from a connect tile it handled itself. A click in this webview is not the
   * only way one gets opened, and marking only on click meant an automatically
   * launched terminal left the button looking untouched.
   *
   * Recorded per provider rather than per button, because the same launch is
   * spelled `runLogin` on Grok's panel and `connectProvider` on the adapters'.
   */
  function markOnboardingLaunchedByHost(provider) {
    if (state.onboardingRanMode !== state.onboardingMode) {
      state.onboardingRanMode = state.onboardingMode;
      state.onboardingRan = [];
      state.onboardingLaunched = [];
    }
    const list = state.onboardingLaunched || (state.onboardingLaunched = []);
    if (provider && !list.includes(provider)) list.push(provider);
    if (!provider && !list.includes("*")) list.push("*");
  }

  /**
   * Once a terminal has been opened, the next thing to press is the re-check —
   * so it takes the primary styling and the launch button steps back to a dim
   * secondary with a done mark. The launch button stays clickable: re-running a
   * login is legitimate if the terminal was closed by accident.
   */
  function applyOnboardingLaunchState() {
    const onb = $("welcome-onboarding");
    if (!onb) return;
    if (state.onboardingRanMode !== state.onboardingMode) return;
    const ran = state.onboardingRan || [];
    const launched = state.onboardingLaunched || [];
    if (!ran.length && !launched.length) return;
    // The panel's own provider, for Grok's `runLogin` button which carries none.
    const panelProvider = (state.onboardingInfo && state.onboardingInfo.provider)
      || (state.onboardingMode === "codex-login" ? "codex"
        : state.onboardingMode === "claude-login" ? "claude"
        : state.onboardingMode === "auth-required" ? "grok" : undefined);
    let anyRan = false;
    for (const btn of onb.querySelectorAll(".onb-action")) {
      const act = btn.dataset.act;
      if (!LAUNCH_ACTS.includes(act)) continue;
      const forProvider = btn.dataset.provider || panelProvider;
      const hostLaunched = launched.includes("*")
        || (forProvider && launched.includes(forProvider));
      if (!ran.includes(launchKey(act, btn.dataset.provider)) && !hostLaunched) continue;
      anyRan = true;
      btn.classList.add("onb-ran", "onb-secondary");
      if (!btn.querySelector(".onb-ran-mark")) {
        btn.insertAdjacentHTML("afterbegin", `<span class="onb-ran-mark">${ICON.check}</span>`);
      }
    }
    if (!anyRan) return;
    for (const btn of onb.querySelectorAll('.onb-action[data-act="recheckProvider"], .onb-action[data-act="recheck"]')) {
      btn.classList.remove("onb-secondary");
    }
  }

  /**
   * Connecting an agent from a phone.
   *
   * This panel used to say "accounts can only be connected on the computer
   * running this workspace" and stop there. That was true of the old
   * implementation — `runGrokLogin` opened a terminal on the desk, which a
   * remote cannot see — and it was a dead end at the exact moment someone most
   * wanted a next step. The host now runs the CLI's headless device-code flow
   * for a remote request, so the answer is a URL and a short code instead.
   *
   * Everything below renders from what the host reported. The client makes no
   * judgement about which providers have a headless flow: it offers the button,
   * and a provider that cannot be signed in from here comes back `unavailable`
   * with a sentence saying so. That way a CLI that grows the flow starts working
   * without a client change, and one that loses it stops lying.
   */
  /** Host-supplied panel text: escaped, then `**bold**` and `[label](https://…)`
   *  re-admitted. Never the other way round — see the note on the steps below. */
  function onbRich(text) {
    return escapeHtml(String(text == null ? "" : text))
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(
        /\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)/g,
        (_m, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`,
      );
  }

  function remoteConnectPanel(mode, info, ver) {
    const device = info.device;
    const provider = info.provider
      || (mode === "codex-login" ? "codex" : mode === "claude-login" ? "claude" : mode === "auth-required" ? "grok" : "");
    // The products' own names, everywhere this panel speaks. Not "Grok": that
    // is the model, the extension is Grok Build, and a heading that disagrees
    // with the button beneath it reads as two different things to connect.
    const NAMES = { grok: "Grok Build", codex: "Codex", claude: "Claude Code" };
    const name = NAMES[provider] || "an agent";
    const status = (text) => { if (ver) setWelcomeStatus(text, false); };

    // The relay serves this page, so it is always as new as the last deploy
    // while the host is whatever the user installed. A host built before remote
    // sign-in existed classifies `runGrokLogin` as host-local and DROPS it
    // silently — so offering Connect there would be a button that does nothing,
    // which is worse than the honest dead end it replaced. Capability, never a
    // version check.
    if (!(state.hostCaps && state.hostCaps.remoteAgentSignIn)) {
      status("Sign in at the desk");
      return `<div class="onb">` +
        `<p class="onb-heading">Sign in at the desk</p>` +
        `<p class="onb-desc">${escapeHtml(name === "an agent" ? "Agent" : name)} accounts can only be connected on the computer running this workspace. Sign in there, then refresh this remote view.</p>` +
      `</div>`;
    }
    const cancel = `<button class="onb-action onb-secondary" type="button" data-act="cancelDeviceLogin" `
      + `data-provider="${escapeHtml(provider)}">Cancel</button>`;

    if (device && device.status === "waiting" && device.url) {
      status(device.needsCode ? (device.submitted ? "Confirming sign-in" : "Paste the code") : "Confirm the code");
      const paste = !!device.needsCode;
      const codeChip = !paste && device.code
        ? `<p class="onb-desc">Open the link, then confirm this code:</p>` +
          // Same markup as every other copyable value in this panel, so it
          // inherits the existing copy handler and its copied state.
          `<div class="onb-cmd">` +
            `<code>${escapeHtml(device.code)}</code>` +
            `<button class="onb-copy" type="button" title="Copy" data-cmd="${escapeHtml(device.code)}">${ICON.copy}</button>` +
          `</div>`
        : (!paste ? `<p class="onb-desc">Open the link to finish signing in.</p>` : "");
      // Paste-code is a SEQUENCE, and the card now reads in that order: what
      // you are about to do, the link that does it, then the field for what it
      // gives you back. The field used to sit ABOVE the link, so the first
      // thing on screen was somewhere to paste a code you had no way to have
      // yet (owner, 2026-09-01).
      const pasteIntro = paste && !device.submitted
        ? `<p class="onb-desc">Open the sign-in page, sign in, then paste the code it shows you:</p>`
        : "";
      const pasteEntry = paste && !device.submitted
        ? `<div class="onb-cmd onb-code-entry">` +
            `<input class="onb-code-input" type="text" inputmode="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste code" aria-label="Paste sign-in code">` +
            `<button class="onb-action" type="button" data-act="submitDeviceLoginCode" data-provider="${escapeHtml(provider)}">Submit</button>` +
          `</div>`
        : "";
      return `<div class="onb">` +
        `<p class="onb-heading">${device.preflight ? "Step 2 of 2 &mdash; confirm the code" : `Finish signing in to ${escapeHtml(name)}`}</p>` +
        // The vendor's own page warns that device codes are used in phishing
        // and to continue only if the CLI started the sign-in. Saying that
        // BEFORE they meet it turns an alarming page into an expected one
        // (owner, with the screenshot, 2026-08-31).
        (device.note ? `<p class="onb-desc onb-note">${onbRich(device.note)}</p>` : "") +
        codeChip +
        pasteIntro +
        `<a class="onb-action" href="${escapeHtml(device.url)}" target="_blank" rel="noopener noreferrer">Open the sign-in page</a>` +
        // AFTER the link: you cannot have a code until you have been there.
        pasteEntry +
        // The setting to check, beside the code it gates — not on a screen
        // before it that cost an extra click to get past.
        (device.preflight && Array.isArray(device.preflight.steps) && device.preflight.steps.length
          ? `<p class="onb-desc">${onbRich(device.preflight.reason || "")}</p>` +
            `<ol class="onb-steps">${device.preflight.steps
              .map((s) => `<li>${onbRich(s)}</li>`)
              .join("")}</ol>`
          : "") +
        cancel +
        // Device-code finishes without another tap. Paste-code does not, until
        // the code has been written back.
        `<p class="onb-desc">${paste
          ? (device.submitted
            ? "Code sent &mdash; keep this page open, it finishes on its own."
            : "This page stays open so you can paste the code back.")
          : "Keep this page open &mdash; it finishes on its own."}</p>` +
      `</div>`;
    }

    if (device && device.status === "starting") {
      status("Starting sign-in");
      return `<div class="onb">` +
        `<p class="onb-heading">Connecting ${escapeHtml(name)}</p>` +
        `<p class="onb-desc">Asking the ${escapeHtml(name)} CLI for a sign-in code&hellip;</p>` +
        cancel +
      `</div>`;
    }

    if (device && device.status === "verifying") {
      status("Confirming sign-in");
      return `<div class="onb">` +
        `<p class="onb-heading">Almost there</p>` +
        `<p class="onb-desc">Signed in — confirming the credential on this machine…</p>` +
      `</div>`;
    }

    if (device && device.status === "done") {
      status("Connected");
      return `<div class="onb">` +
        `<p class="onb-heading">${escapeHtml(name)} connected</p>` +
        `<p class="onb-desc">You can start a conversation.</p>` +
      `</div>`;
    }

    // Shown BEFORE anything is attempted, when a sign-in is likely to fail for a
    // reason the reader can fix in seconds. Codex device-code login is off by
    // default on every account — telling somebody that after a wait and a
    // failure is telling them too late.
    if (device && device.preflight) {
      status("One setting first");
      const pf = device.preflight;
      // Escape FIRST, then allow `**bold**` and one link — never the other way
      // round. The step strings come from the host, and the point of the escape
      // is that nothing in them can become markup; re-admitting two shapes
      // afterwards, on text that is already inert, keeps that true. Both are
      // needed here: the setting people cannot find sits at the bottom of a
      // long page, and the page it sits on should be one tap away.
      const steps = (pf.steps || [])
        .map((s) => `<li>${onbRich(s)}</li>`)
        .join("");
      return `<div class="onb">` +
        `<p class="onb-heading">${escapeHtml(pf.title || `Turn on device sign-in for ${name}`)}</p>` +
        `<p class="onb-desc">${onbRich(pf.reason || "")}</p>` +
        (steps ? `<ol class="onb-steps">${steps}</ol>` : "") +
        (pf.url
          ? `<a class="onb-action" href="${escapeHtml(pf.url)}" target="_blank" rel="noopener noreferrer">Open ${escapeHtml(name)} settings</a>`
          : "") +
        // Still offered, because the setting may already be on — and because a
        // screen that only sends you elsewhere is a dead end with a link on it.
        `<button class="onb-action onb-secondary" type="button" data-act="connectRemote" data-provider="${escapeHtml(provider)}">${escapeHtml(pf.continueLabel || "I've turned it on — connect")}</button>` +
      `</div>`;
    }

    if (device && (device.status === "failed" || device.status === "unavailable")) {
      const stuck = device.status === "unavailable";
      status(stuck ? "Sign in at your computer" : "Sign-in failed");
      // `unavailable` gets no retry button. Offering one for a flow that cannot
      // work here is how a dead end gets disguised as a loop.
      return `<div class="onb">` +
        `<p class="onb-heading">${stuck ? `Connect ${escapeHtml(name)} at your computer` : `Could not connect ${escapeHtml(name)}`}</p>` +
        `<p class="onb-desc">${escapeHtml(device.message || "")}</p>` +
        (stuck
          ? ""
          : `<button class="onb-action" type="button" data-act="connectRemote" data-provider="${escapeHtml(provider)}">Try again</button>`) +
      `</div>`;
    }

    // No flow started yet. `connect-agent` means nothing is connected at all, so
    // offer each rather than guessing which one the person wants. The client
    // does not decide which of these can work headlessly — it asks, and the host
    // answers `unavailable` with a reason for any that cannot.
    status("Connect an agent");
    // A cloud machine with NOTHING connected gets the whole menu, even when the
    // frame names one provider (the session's agent needing auth). On a fresh
    // machine that narrowing hid the choice entirely: the owner saw only Grok
    // where all three belong (2026-08-31). Once something IS connected, the
    // frame's provider is the specific thing being asked for again.
    const nothingConnected = !((state.providers || []).some((p) => p && p.connected));
    const cloudFresh = !!(state.hostCaps && state.hostCaps.remoteAgentSignOut) && nothingConnected;
    const offer = provider && !cloudFresh ? [provider] : ["grok", "codex", "claude"];
    // A cloud machine's three agents are not equal offers: Grok is the native
    // one. Ranking is the cloud-only part; every agent that has a headless
    // flow is offered, including Claude Code's paste-code sign-in.
    const cloudHost = !!(state.hostCaps && state.hostCaps.remoteAgentSignOut);
    const buttons = offer
      .map((id) => {
        const rec = cloudHost && id === "grok" ? " (recommended)" : "";
        // The mark the reader already knows from the model picker and the
        // provider rows. currentColor, so it takes the button's foreground.
        return `<button class="onb-action" type="button" data-act="connectRemote" data-provider="${id}">`
          + providerLogoMarkup(id)
          + `<span>Connect ${NAMES[id]}${rec}</span></button>`;
      })
      .join("");
    return `<div class="onb">` +
      `<p class="onb-heading">${provider ? `Connect ${escapeHtml(name)}` : "Connect an agent"}</p>` +
      `<p class="onb-desc">Sign in with your own account. You will open a link and confirm a short code &mdash; no password is typed here, and nothing is stored on this page.</p>` +
      buttons +
    `</div>`;
  }

  /** `beforeRender` runs after the mode is set and before markup is built, so a
   *  host-launched terminal can be recorded against the panel it belongs to. */
  /**
   * Connecting an agent, in ONE place.
   *
   * There used to be two renderers for this flow: the transcript's onboarding
   * card, and a set of rows inside Settings → Providers. The second existed
   * only because the first cannot paint over a conversation
   * (`revealWelcome` holds while `.msg` nodes exist), so a Connect clicked in
   * Settings had nowhere to report. Two implementations of one auth flow is
   * one too many to keep true (owner, 2026-08-31).
   *
   * A dialog is subject to no such hold, so the flow lives here and both
   * surfaces become entry points. The markup is the SAME builder the welcome
   * card uses, and the document-level `.onb-action` delegation already wires
   * every button inside it, so there is nothing to duplicate and nothing to
   * keep in step.
   */
  let connectWizard = null;

  function connectWizardProvider() {
    return connectWizard ? connectWizard.provider : "";
  }

  function closeConnectWizard() {
    if (!connectWizard) return;
    document.removeEventListener("keydown", connectWizard.onKey, true);
    delete document.body.dataset.modalAbove;
    connectWizard.overlay.remove();
    const opener = connectWizard.opener;
    connectWizard = null;
    if (opener && typeof opener.focus === "function" && document.contains(opener)) {
      try { opener.focus(); } catch { /* the opener may have gone with a repaint */ }
    }
  }

  function openConnectWizard(provider, opener) {
    if (connectWizard && connectWizard.provider === provider) {
      renderConnectWizard();
      return;
    }
    closeConnectWizard();
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay connect-wizard-overlay";
    const panel = document.createElement("div");
    panel.className = "confirm-panel connect-wizard-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", `Connect ${provider}`);
    const body = document.createElement("div");
    body.className = "connect-wizard-body";
    panel.appendChild(body);
    const actions = document.createElement("div");
    actions.className = "confirm-actions";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "confirm-btn";
    closeBtn.textContent = "Close";
    // Closing the window never cancels the sign-in: the flow lives on the host
    // and finishes on its own, which is exactly what the card promises.
    // Cancelling is a separate, explicit button inside the panel.
    closeBtn.onclick = (e) => { e.stopPropagation(); closeConnectWizard(); };
    actions.appendChild(closeBtn);
    panel.appendChild(actions);
    overlay.appendChild(panel);
    overlay.onclick = (e) => { if (e.target === overlay) { e.stopPropagation(); closeConnectWizard(); } };
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); closeConnectWizard(); } };
    document.addEventListener("keydown", onKey, true);
    // Tells any page underneath (the settings overlay has its own Escape and
    // Tab trap) that a modal owns the keyboard while this is up.
    document.body.dataset.modalAbove = "connect-wizard";
    document.body.appendChild(overlay);
    connectWizard = { provider, overlay, panel, body, onKey, opener: opener || document.activeElement };
    // Nothing has come back from the host yet — and on a cloud machine the
    // first frame is seconds away. Open on "starting" rather than repainting
    // the offer that was just clicked, which read as a click that did nothing
    // (owner, 2026-08-31). A real frame replaces this on arrival.
    if (!state.deviceLoginByProvider[provider]) connectWizard.lastDevice = { status: "starting" };
    renderConnectWizard();
    const focusTarget = body.querySelector(".onb-action") || closeBtn;
    try { focusTarget.focus(); } catch { /* focus is a courtesy, never a failure */ }
  }

  /** Paint the wizard from the flow state the host last sent. */
  function renderConnectWizard() {
    if (!connectWizard) return;
    const provider = connectWizard.provider;
    // The mirror is the live source, but a confirmed account retires its
    // mirror, so a settled panel keeps its own copy of the last thing it was
    // told rather than falling back to the empty-state offer.
    const device = state.deviceLoginByProvider[provider] || connectWizard.lastDevice;
    // `ver` is null on purpose: the welcome status line belongs to the welcome
    // card, and a modal must not rewrite it.
    connectWizard.body.innerHTML = remoteConnectPanel(
      "auth-required",
      { provider, device, platform: state.onboardingInfo && state.onboardingInfo.platform },
      null,
    );
  }

  /**
   * Keep the wizard in step with the host, and open it when a flow begins
   * wherever the click came from — the card, Settings, or another tab.
   */
  function syncConnectWizard(provider, device) {
    if (!IS_REMOTE || !provider) return;
    // Only a RUNNING flow opens a wizard. A settled outcome renders wherever
    // the reader already is: in this dialog when one is open (which it is
    // whenever they got here by clicking Connect), and in the card otherwise.
    // Opening one for `failed` meant the card and the dialog both painted the
    // same retry button — the relay's sign-in check found it as a strict-mode
    // locator violation, which is a person seeing the same panel twice.
    const live = !!device && (device.status === "starting" || device.status === "waiting"
      || device.status === "verifying" || !!device.preflight);
    if (live) {
      openConnectWizard(provider);
      if (connectWizard) connectWizard.lastDevice = device;
      return;
    }
    if (!connectWizard || connectWizard.provider !== provider) return;
    if (device && device.status === "done") {
      // Show the confirmation, then get out of the way. The account is
      // connected; keeping a dialog up over it is make-work.
      connectWizard.lastDevice = device;
      connectWizard.settled = true;
      renderConnectWizard();
      setTimeout(() => {
        if (connectWizard && connectWizard.provider === provider) closeConnectWizard();
      }, 1600);
      return;
    }
    // Nothing repaints a finished panel. Between "connected" and the close
    // there is a window where the mirror is already gone, and repainting in
    // it turned a success into an offer to start over.
    if (connectWizard.settled) return;
    // No flow left to show — a cancel, or a bare frame after one ends. The
    // wizard exists to RUN a flow, so with nothing to run it gets out of the
    // way rather than repainting itself as an invitation to start another;
    // the card underneath is the entry point and is already offering one.
    if (!device) {
      closeConnectWizard();
      return;
    }
    renderConnectWizard();
  }

  /** The onboarding modes that are asking for an account to be connected. */
  const CONNECT_ONBOARDING_MODES = {
    "connect-agent": true,
    "codex-login": true,
    "claude-login": true,
    "auth-required": true,
  };

  /**
   * Nothing in this transcript is a conversation.
   *
   * The second signal for "this session is empty, do not remember it". It used
   * to be `welcomeVisible`, which an error bubble turns off — including the
   * host's own sign-out notice, so an empty session was remembered, reaped, and
   * then failed to restore on every refresh (owner, 2026-08-31). Errors and
   * notices are momentary UI; a turn is the thing that makes a conversation
   * worth restoring. Pending authored text still counts, because `numMessages`
   * lags during the first send.
   */
  function transcriptHasNoTurns() {
    const messages = $("messages");
    if (!messages) return true;
    // `.msg.error` is a notice and `.msg.thinking` is scaffolding; anything
    // else in the transcript is somebody's conversation.
    if (messages.querySelector(".msg:not(.error):not(.thinking)")) return false;
    const input = $("input");
    const typed = input && typeof input.value === "string" ? input.value.trim() : "";
    return !typed;
  }

  function showOnboarding(mode, info, beforeRender) {
    info = info || {};
    state.onboardingMode = mode;
    state.onboardingInfo = info;
    if (beforeRender) beforeRender();
    // Onboarding is the empty-state card. Flush a pending transcript wipe so
    // the card cannot sit above leftover conversation nodes for a frame —
    // unless a replay is already putting the conversation back, in which case
    // revealing now is the reconnect flash (a buffered provider-connected
    // confirmation used to unhide on top of the messages still waiting to go).
    const holdWelcome = identityRestoring() || (state.replaying && welcomeHoldActive());
    if (!holdWelcome) {
      flushPendingTranscriptClear();
      revealWelcome();
    }
    const onb = $("welcome-onboarding");
    const ver = $("welcome-version");
    if (!onb) return;
    if (IS_REMOTE && (mode === "connect-agent" || mode === "codex-login" || mode === "claude-login" || mode === "auth-required")) {
      // The card is an ENTRY POINT, not a second renderer: a live flow belongs
      // to the wizard, so the card keeps showing the offer underneath it.
      // The card NEVER renders a live flow. Stripping it only while the wizard
      // was already open left a window -- this function runs before
      // syncConnectWizard on the very frame that starts a flow -- where both
      // painted it, so the code and its Cancel existed twice on the page. The
      // relay's own sign-in check caught that as a strict-mode locator
      // violation; a person would have seen it by closing the dialog.
      //
      // A SETTLED outcome still lands here when no wizard is open, so nothing
      // is lost if the reader closed it.
      const device = info && info.device;
      const liveFlow = !!device && (device.status === "starting" || device.status === "waiting"
        || device.status === "verifying" || !!device.preflight);
      const wizardOwnsIt = !!connectWizard && info && info.provider === connectWizard.provider;
      const forCard = device && (liveFlow || wizardOwnsIt)
        ? Object.assign({}, info, { device: undefined })
        : info;
      onb.innerHTML = remoteConnectPanel(mode, forCard, ver);
      return;
    }
    if (mode === "no-project") {
      // Desktop with nothing open. Names the block and points at the same
      // action the rail already offers — do not leave the baked Starting
      // spinner up (that is the first-run hang).
      if (ver) setWelcomeStatus("No project folder", false);
      if (IS_REMOTE) {
        onb.innerHTML =
          `<div class="onb">` +
            `<p class="onb-heading">No project folder</p>` +
            `<p class="onb-desc">Add a project folder on the computer running this workspace, then start a conversation there.</p>` +
          `</div>`;
        updateSendButton();
        return;
      }
      onb.innerHTML =
        `<div class="onb">` +
          `<p class="onb-heading">No project folder</p>` +
          `<p class="onb-desc">A conversation needs a project folder before it can start. Add one to continue.</p>` +
          `<button class="onb-action" type="button" data-act="addProjectFolder">Add project folder</button>` +
        `</div>`;
      updateSendButton();
      return;
    }
    if (mode === "provider-connected") {
      // A successful re-check used to leave a bare empty session, which reads
      // identically to "nothing happened" — the one moment someone most wants
      // to be told it worked. It clears itself the instant a message is added
      // (addMessage calls clearWelcome), so it never survives into a real
      // conversation and does not need dismissing.
      const id = info.provider || "grok";
      const done = id === "codex"
        ? "You can start working with OpenAI!"
        : id === "claude" ? "You can start clauding!" : "You can start grokking!";
      if (ver) setWelcomeStatus("Connected", false);
      onb.innerHTML =
        `<div class="onb onb-connected">` +
          `<p class="onb-heading"><span class="onb-ok">${ICON.check}</span>Connected</p>` +
          `<p class="onb-desc">${done}</p>` +
        `</div>`;
      return;
    }
    if (mode === "connect-agent") {
      if (ver) setWelcomeStatus("Connect an agent", false);
      onb.innerHTML =
        `<div class="onb onb-connect">` +
          `<p class="onb-heading">Connect an agent</p>` +
          `<p class="onb-desc">Choose the command-line agent that will own this conversation.</p>` +
          `<div class="onb-agent-grid">` +
            // One row each, not a grid: three side-by-side tiles squeezed the
            // name and the CLI into a column too narrow to read either, and the
            // list is short enough that stacking costs nothing. Each row names
            // the agent and the CLI it will install — "Recommended default"
            // used to describe our ranking where the others described what the
            // thing IS, so the row a newcomer reads first was the only one not
            // saying what it would put on their machine.
            `<button class="onb-agent-tile primary onb-action" type="button" data-act="connectProvider" data-provider="grok">` +
              `<span class="onb-agent-mark">${providerLogoMarkup("grok")}</span><span><strong>Grok Build (Recommended)</strong><small>Grok Build CLI</small></span>` +
            `</button>` +
            `<button class="onb-agent-tile onb-action" type="button" data-act="connectProvider" data-provider="codex">` +
              `<span class="onb-agent-mark">${providerLogoMarkup("codex")}</span><span><strong>Codex</strong><small>OpenAI Codex CLI</small></span>` +
            `</button>` +
            `<button class="onb-agent-tile onb-action" type="button" data-act="connectProvider" data-provider="claude">` +
              `<span class="onb-agent-mark">${providerLogoMarkup("claude")}</span><span><strong>Claude Code</strong><small>Claude Code CLI</small></span>` +
            `</button>` +
          `</div>` +
        `</div>`;
    } else if (mode === "missing-cli") {
      if (ver) setWelcomeStatus("CLI not installed", false);
      if (IS_REMOTE) {
        onb.innerHTML = `<div class="onb"><p class="onb-heading">Grok CLI is missing at the desk</p>` +
          `<p class="onb-desc">Install it on the computer running this workspace, then refresh this remote view.</p></div>`;
        return;
      }
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
          `<button class="onb-action onb-secondary" type="button" data-act="recheckProvider" data-provider="${info.provider || "grok"}">Re-check connection</button>` +
        `</div>`;
    } else if (mode === "missing-codex") {
      if (ver) setWelcomeStatus("Codex CLI not found", false);
      if (IS_REMOTE) {
        onb.innerHTML = `<div class="onb"><p class="onb-heading">Codex CLI is missing at the desk</p>` +
          `<p class="onb-desc">Install or configure Codex on the computer running this workspace, then refresh this remote view.</p></div>`;
        return;
      }
      const installCmd = "npm i -g @openai/codex";
      const install = state.codexInstall;
      const installing = install.phase !== "idle";
      const percent = install.totalBytes > 0
        ? Math.min(100, Math.round((install.receivedBytes / install.totalBytes) * 100))
        : null;
      const progressLabel = install.phase === "downloading"
        ? `Downloading Codex${percent == null ? "" : ` (${percent}%)`}...`
        : install.phase === "verifying" ? "Verifying downloaded package..."
        : install.phase === "installing" ? "Installing Codex..." : "";
      const reason = info.reason || install.reason;
      onb.innerHTML =
        `<div class="onb">` +
          `<p class="onb-heading">Install the Codex CLI</p>` +
          `<p class="onb-desc">Install the pinned official Codex release into this app's storage, or use your own installation.</p>` +
          (reason ? `<p class="onb-install-error" role="alert">${escapeHtml(reason)}</p>` : "") +
          (installing
            ? `<div class="onb-install-progress" role="status"><span>${escapeHtml(progressLabel)}</span>` +
                (percent == null ? "" : `<progress max="100" value="${percent}">${percent}%</progress>`) +
                `<button class="onb-action onb-secondary" type="button" data-act="cancelCodexInstall">Cancel</button></div>`
            : `<button class="onb-action" type="button" data-act="installCodex">Install Codex</button>`) +
          `<p class="onb-desc onb-manual-label">Or install it yourself, or install the OpenAI ChatGPT extension for VS Code:</p>` +
          `<div class="onb-cmd"><code>${installCmd}</code><button class="onb-copy" type="button" title="Copy" data-cmd="${installCmd}">${ICON.copy}</button></div>` +
          `<button class="onb-action onb-secondary" type="button" data-act="recheckProvider" data-provider="codex">Re-check</button>` +
        `</div>`;
    } else if (mode === "codex-login") {
      if (ver) setWelcomeStatus("Finish signing in", false);
      onb.innerHTML =
        `<div class="onb">` +
          `<p class="onb-heading">Complete <code>codex login</code></p>` +
          `<p class="onb-desc">Finish the sign-in flow in the terminal, then continue here.</p>` +
          `<button class="onb-action onb-secondary" type="button" data-act="connectProvider" data-provider="codex">Open terminal &amp; run <code>codex login</code></button>` +
          `<button class="onb-action" type="button" data-act="recheckProvider" data-provider="codex">Done - connect Codex</button>` +
        `</div>`;
    } else if (mode === "missing-claude") {
      if (ver) setWelcomeStatus("Claude Code not found", false);
      if (IS_REMOTE) {
        onb.innerHTML = `<div class="onb"><p class="onb-heading">Claude Code is missing at the desk</p>` +
          `<p class="onb-desc">Install Anthropic's Claude Code CLI on the computer running this workspace, then refresh this remote view.</p></div>`;
        return;
      }
      onb.innerHTML =
        `<div class="onb">` +
          `<p class="onb-heading">Install Claude Code</p>` +
          `<p class="onb-desc">This app does not install or sign in to Claude for you. Install Anthropic's own Claude Code CLI, sign in with <code>claude auth login</code>, then re-check.</p>` +
          `<div class="onb-cmd"><code>claude --version</code><button class="onb-copy" type="button" title="Copy" data-cmd="claude --version">${ICON.copy}</button></div>` +
          `<button class="onb-action" type="button" data-act="recheckProvider" data-provider="claude">Re-check</button>` +
        `</div>`;
    } else if (mode === "claude-login") {
      if (ver) setWelcomeStatus("Finish signing in", false);
      onb.innerHTML =
        `<div class="onb">` +
          `<p class="onb-heading">Sign in with Claude Code</p>` +
          `<p class="onb-desc">This app never implements, proxies, holds, or forwards Claude credentials. Sign-in happens entirely inside Anthropic's own CLI, which may use your Claude subscription or an Anthropic Console account depending on how you sign in.</p>` +
          `<button class="onb-action onb-secondary" type="button" data-act="connectProvider" data-provider="claude">Open terminal &amp; run <code>claude auth login</code></button>` +
          `<button class="onb-action" type="button" data-act="recheckProvider" data-provider="claude">Done - connect Claude</button>` +
        `</div>`;
    } else if (mode === "auth-required") {
      if (ver) setWelcomeStatus("Authentication required", false);
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
          `<button class="onb-action onb-secondary" type="button" data-act="recheckProvider" data-provider="grok">Re-check connection</button>` +
        `</div>`;
    } else {
      onb.innerHTML = "";
    }
    // Every branch above rebuilds innerHTML, so the launched-terminal state has
    // to be re-applied here rather than living on the node.
    applyOnboardingLaunchState();
    updateSendButton();
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
    const previewSrc = chip?.previewSrc || (chip?.previewId && state.imagePreviews.get(chip.previewId));
    const hasPreview = chip?.imageIndex != null && !!previewSrc;
    if (hasPreview) {
      const preview = document.createElement("button");
      preview.type = "button";
      preview.className = "msg-chip-preview";
      preview.title = `Preview ${name}`;
      const img = document.createElement("img");
      img.src = previewSrc;
      img.alt = "";
      preview.appendChild(img);
      preview.onclick = (e) => {
        e.stopPropagation();
        openImagePreview(previewSrc, name, chip?.fullId);
      };
      tag.appendChild(preview);
    }
    // The icon stands in FOR the picture. With a thumbnail beside it, it is the
    // same idea said twice — so it appears only when there is nothing to show.
    tag.insertAdjacentHTML("beforeend", (hasPreview ? "" : icon) + `<span>${escapeHtml(name + range)}</span>`);
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
      // prompt_index (skipping a hidden primer in legacy sessions). Set after userMsgCount bump.
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
      //
      // Built for every client since 2026-09-01: remote clients used to be
      // excluded here because the host's rewind flow ran native VS Code UI, and
      // that stopped being true when the confirmation moved in-chat. Visibility
      // is decided in refreshUserRewindButtons, which also owns the provider
      // gate — so a session that switches provider does not need re-rendering.
      if (role === "user") {
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
      const replayTimestamp = opts && opts.timestampMs;
      ts.textContent = state.replaying
        ? (typeof replayTimestamp === "number" && Number.isFinite(replayTimestamp)
          ? formatTime(replayTimestamp)
          : "")
        : formatTime(Date.now());
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
        // A steer is still the same turn — keep the footer pointer so agentEnd
        // can attach thumbs to it. Nulling it here dropped the only handle
        // after more agent chunks reused the same bubble.
        revealTurnFooter();
        if (!(opts && opts.steer)) {
          retireLiveTurnFeedback(state.turnAgentActionsEl);
          state.turnAgentActionsEl = null;
          state.turnRating = 0;
        }
      }
    }

    appendTranscriptChild(el);
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
    const rendered = liveTranscriptQueryAll(".msg.user:not(.queued)")
      .filter((el) => el.dataset.steer !== "1").length;
    return (state.historyPrefixUserCount || 0) + rendered;
  }

  function refreshUserRewindButtons() {
    // Steered messages are NOT prompts and have no rewind point, so they get no
    // index — counting them shifted every later bubble by one, which pointed
    // Rewind at the wrong turn (and reverted the wrong files) and made Edit
    // fail outright. Both actions are hidden on a steer bubble for the same
    // reason: there is nothing on the wire to roll back to.
    const users = liveTranscriptQueryAll(".msg.user:not(.queued)")
      .filter((el) => el.dataset.steer !== "1");
    for (const el of liveTranscriptQueryAll('.msg.user[data-steer="1"]')) {
      delete el.dataset.userBubbleIndex;
      const r = el.querySelector(".msg-rewind-btn");
      const ed = el.querySelector(".msg-edit-btn");
      if (r) r.hidden = true;
      if (ed) ed.hidden = true;
    }
    const prefixCount = state.historyPrefixUserCount || 0;
    // One provider gate for both buttons: the RPC underneath either exists on
    // this session's CLI or it does not, and a control that always fails is
    // worse than an absent one.
    const capable = rewindCapableProvider();
    // A conversation another tab has taken is frozen: these act on it, so they
    // are disabled rather than merely dimmed. Visible, so the transcript still
    // reads normally, but genuinely unclickable.
    const frozen = !!state.sessionSuperseded;
    users.forEach((el, i) => {
      el.dataset.userBubbleIndex = String(prefixCount + i);
      const isLast = i === users.length - 1;
      const btn = el.querySelector(".msg-rewind-btn");
      if (btn) {
        // Hide on the tip: that message is Edit's, which does the same rewind
        // and returns the text. Not a wire limitation — execute accepts the tip.
        btn.hidden = !capable || users.length <= 1 || isLast;
        btn.disabled = frozen;
      }
      // Edit is the exact complement: only the tip, which is the message a
      // rewind can't remove and the one you most often want to retype (#56).
      const edit = el.querySelector(".msg-edit-btn");
      if (edit) {
        edit.hidden = !capable || !isLast;
        edit.disabled = frozen;
      }
    });
  }

  // Show the current turn's (single) agent footer — called at every turn-end
  // signal: promptComplete/agentEnd/agentError live, the next user message or
  // replay end on restore. Stamps the time at reveal so it reads as the
  // turn's END time, not the moment the last segment happened to start.
  function revealTurnFooter(timestampMs) {
    const a = state.turnAgentActionsEl;
    if (!a || !a.hidden) return;
    a.hidden = false;
    const ts = a.querySelector(".msg-timestamp");
    if (!ts) return;
    if (!state.replaying) {
      ts.textContent = formatTime(Date.now());
    } else if (typeof timestampMs === "number" && Number.isFinite(timestampMs)) {
      ts.textContent = formatTime(timestampMs);
    }
  }

  function feedbackOffered() {
    return state.feedbackAvailable === true && state.activeProvider !== "codex" && state.activeProvider !== "claude";
  }

  function stripTurnThumbs(actions) {
    if (!actions) return;
    const existing = actions.querySelector(".msg-thumbs");
    if (existing) existing.remove();
    actions.classList.remove("has-rating");
    delete actions.dataset.feedbackPending;
  }

  function retireLiveTurnFeedback(actions) {
    if (!actions) return;
    stripTurnThumbs(actions);
    delete actions.dataset.feedbackLive;
  }

  function liveTurnActions() {
    const a = state.turnAgentActionsEl;
    if (!a || a.hidden || a.dataset.feedbackLive !== "1") return null;
    return a;
  }

  function insertTurnThumbs(actions) {
    if (actions.querySelector(".msg-thumbs")) return;
    const wrap = document.createElement("span");
    wrap.className = "msg-thumbs";
    wrap.appendChild(makeThumbButton("up", 1, "Good response", ICON.thumbsUp));
    wrap.appendChild(makeThumbButton("down", -1, "Bad response", ICON.thumbsDown));
    const ts = actions.querySelector(".msg-timestamp");
    if (ts) actions.insertBefore(wrap, ts);
    else actions.appendChild(wrap);
    paintTurnThumbs(actions);
  }

  function makeThumbButton(kind, rating, label, glyph) {
    const btn = document.createElement("button");
    btn.className = `msg-action-btn msg-thumb-btn msg-thumb-${kind}`;
    btn.type = "button";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.setAttribute("aria-pressed", "false");
    btn.dataset.rating = String(rating);
    btn.innerHTML = `<span class="msg-action-glyph">${glyph}</span>`;
    return btn;
  }

  function paintTurnThumbs(actions) {
    const rating = state.turnRating === 1 || state.turnRating === -1 ? state.turnRating : 0;
    actions.classList.toggle("has-rating", rating === 1 || rating === -1);
    const up = actions.querySelector(".msg-thumb-up");
    const down = actions.querySelector(".msg-thumb-down");
    if (up) up.setAttribute("aria-pressed", rating === 1 ? "true" : "false");
    if (down) down.setAttribute("aria-pressed", rating === -1 ? "true" : "false");
  }

  function syncFeedbackButtons() {
    const live = liveTurnActions();
    for (const actions of liveTranscriptQueryAll(".msg.agent .msg-actions")) {
      if (actions === live && feedbackOffered()) {
        if (!actions.querySelector(".msg-thumbs")) insertTurnThumbs(actions);
        else paintTurnThumbs(actions);
      } else {
        stripTurnThumbs(actions);
      }
    }
  }

  /** Thumbs rate only the turn that just finished in this process. */
  function markLiveTurnFeedback() {
    if (state.replaying) return;
    const a = state.turnAgentActionsEl;
    if (!a) return;
    for (const other of liveTranscriptQueryAll(".msg.agent .msg-actions")) {
      if (other !== a) retireLiveTurnFeedback(other);
    }
    a.dataset.feedbackLive = "1";
    state.turnRating = 0;
    syncFeedbackButtons();
  }

  function applyTurnFeedbackAck(rating) {
    if (state.replaying) return;
    const a = state.turnAgentActionsEl;
    if (!a) return;
    a.dataset.feedbackLive = "1";
    state.turnRating = rating === 1 || rating === -1 ? rating : 0;
    delete a.dataset.feedbackPending;
    syncFeedbackButtons();
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
  function pathFromToolTitle(call) {
    const title = String(call && call.title || "").trim();
    if (!title) return "";
    const tick = title.match(/`([^`]+)`/);
    if (tick && tick[1]) return tick[1].trim();
    const stripped = title.replace(/^(edit|write|read|delete|create|update)\s+/i, "").trim();
    if (stripped && stripped !== title && /[\\/]|\.\w{1,8}$/.test(stripped)) return stripped;
    return "";
  }
  function toolFilePath(call) {
    const r = call.rawInput || call.input || {};
    // `target_directory` is list_dir's path field (verified against real sessions);
    // without it, "List" rendered with no target.
    return r.target_file || r.filePath || r.file_path || r.path ||
      r.new_path || r.new_file || r.file || r.filename ||
      r.target_directory || r.directory || r.dir ||
      (Array.isArray(r.paths) ? r.paths[0] : "") ||
      pathFromToolTitle(call);
  }
  function isReadTool(call) {
    if (!call) return false;
    const name = toolName(call);
    const kind = toolKind(call);
    return name === "read_file" || name === "file_read" || kind === "read";
  }
  function asLineNum(v) {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  }
  // Line range for a Read row. Prefer requested offset/limit (1-based; 0 → 1),
  // then FileContent.{offset,limit,total_lines} on the completed update.
  // Do not invent numbers when none of those are on the wire.
  function readLineRange(call) {
    const r = (call && (call.rawInput || call.input)) || {};
    const ro = call && call.rawOutput;
    const fc = ro && (ro.FileContent || ro.file_content) || {};
    let start = asLineNum(r.offset) ?? asLineNum(r.start_line) ?? asLineNum(r.startLine) ?? asLineNum(fc.offset);
    const endHint = asLineNum(r.end_line) ?? asLineNum(r.endLine);
    const limit = asLineNum(r.limit) ?? asLineNum(fc.limit);
    const total = asLineNum(fc.total_lines) ?? asLineNum(fc.totalLines);
    if (start === 0) start = 1;
    if (start != null && endHint != null && endHint >= start) return { start, end: endHint };
    if (start != null && limit != null && limit > 0) return { start, end: start + limit - 1 };
    if (start == null && limit != null && limit > 0) return { start: 1, end: limit };
    if (start != null && total != null && total >= start) return { start, end: total };
    // No offset, no limit, no end — the agent asked for the WHOLE file, and
    // `total_lines` is then just how long the file happens to be. Rendering it
    // as "lines 1-26" reads like a range the agent chose, which it did not, and
    // costs the row space the path needs (owner, 2026-08-23). The row shows the
    // path alone and the link opens the file with nothing selected.
    return null;
  }
  // `path#Lstart-Lend` — the syntax `parseFileRef` already accepts, so the host
  // opens the REAL file with those lines selected instead of an untitled copy of
  // the excerpt (#122). No range on the wire → the path alone.
  function readOpenFileRef(call) {
    const p = String(toolFilePath(call) || "").trim();
    if (!p) return "";
    const range = readLineRange(call);
    return range ? `${p}#L${range.start}-L${range.end}` : p;
  }
  // The label text for a Read row's target: basename, plus the line range when
  // one is on the wire. Shared by toolLabel and by the linked-label path, so the
  // link's text can never drift from the row's own label.
  function readTargetLabel(call) {
    const filePath = toolFilePath(call);
    if (!filePath) return "";
    const range = readLineRange(call);
    return range
      ? `${prettyPath(filePath)} lines ${range.start}-${range.end}`
      : prettyPath(filePath);
  }
  // #122: the path and range in a Read row's own label BECOME the link — no
  // separate control, and no six-line excerpt of a 150-line read competing for
  // space. The ROW LOOKS THE SAME on every host; only what the link does
  // differs, because the hosts can do different things.
  function readLinkRef(call) {
    if (!isReadTool(call)) return "";
    return readOpenFileRef(call);
  }
  // What that link can do here, decided by what the host proved it can do —
  // never by a version:
  //   "file"    an editor that opens the real file AT the line range. The whole
  //             point: the surrounding context is why you clicked.
  //   "overlay" the desktop app. Its openTextFile cannot honour a line
  //             selection, so the click opens the in-app preview: the whole
  //             file, numbered, with the agent's lines marked (falls back to
  //             the excerpt when the file can't be fetched).
  //   "inline"  a remote. `openFile` is host-local in remote-policy, so a phone
  //             can only reveal the text already on the wire.
  function readLinkMode() {
    if (IS_REMOTE) return "inline";
    if (hostPreviewsInApp()) return "overlay";
    return "file";
  }
  function toolRenamePaths(call) {
    const r = call && (call.rawInput || call.input) || {};
    const from = r.old_path || r.old_file || r.from;
    const to = r.new_path || r.new_file || r.to;
    if (from && to && from !== to) return { from, to };
    return null;
  }
  function prettyPath(p) {
    if (!p) return "";
    if (p === "." || p === "./") return "root folder";
    const leaf = String(p).replace(/\\/g, "/").split("/").pop();
    return leaf || p;
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

  // Deliberate short trim (40 chars): a row reads as a scannable summary, not a
  // wall of shell. Shared so the running header and the settled row clamp
  // identically.
  const clampToolTarget = (s) => (s && s.length > 40 ? s.slice(0, 40) + "…" : s);

  /**
   * What a search tool is looking for. The pattern is the useful thing — grep
   * ships both `pattern` and `path:"."`, and the path is the unhelpful half.
   *
   * #145: the settled row has named the pattern for a long time, but the
   * running header said a bare "Searching", so the one moment you actually
   * want to know what is being searched was the one moment we would not say.
   * Every neighbouring verb already carries its argument (Reading foo.ts,
   * Listing src/, Editing bar.css); this makes search consistent with them.
   * It is NOT the details block — a search row has no IN/OUT, because the IN
   * would repeat this label and the OUT is the match list.
   */
  function searchPatternText(call) {
    const r = (call && (call.rawInput || call.input)) || {};
    const p = r.glob_pattern || r.pattern || r.query || r.regex || r.search;
    return typeof p === "string" && p.trim() ? clampToolTarget(p.trim()) : "";
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
    if (/^(web_search|search_web)$/.test(name)) {
      const q = searchPatternText(call);
      return q ? `Searching web for "${q}"` : "Searching web";
    }
    if (/^(web_fetch|webfetch)$/.test(name)) return "Fetching page";
    if (/^(grep|ripgrep|search_files)$/.test(name) || kind === "search") {
      const p = searchPatternText(call);
      return p ? `Searching for "${p}"` : "Searching";
    }
    if (/^(write_file|file_write|write|edit_file|search_replace|str_replace)$/.test(name) || kind === "edit" || kind === "write") {
      const renamed = toolRenamePaths(call);
      if (renamed) return `Editing ${prettyPath(renamed.from)} → ${prettyPath(renamed.to)}`;
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

  function toolLabel(call, opts) {
    const name = toolName(call);
    const kind = toolKind(call);
    const verb = TOOL_VERB[name] || KIND_VERB[kind] || null;
    const r = call.rawInput || call.input || {};
    const filePath = toolFilePath(call);
    const command = r.command || r.cmd;
    const pattern = r.glob_pattern || r.pattern || r.query || r.regex || r.search;
    const url = r.url || r.uri;
    // Collapsed rows read as a scannable summary, not a wall of shell — the
    // full command lives one click away in the IN/OUT detail. (CSS still
    // single-line-ellipsizes whatever remains.)
    const clamp = clampToolTarget;
    // A search tool's *pattern* is the useful target — prefer it over the path it
    // searched (grep ships both `pattern` and `path:"."`, which would otherwise
    // render the unhelpful "root folder"). Match by kind OR name so it still wins
    // when the first tool_call arrives before grok finalizes `kind`.
    const isSearch =
      kind === "search" || /\b(grep|glob|ripgrep|search_files|web_search|search_web)\b/i.test(name);

    let target = "";
    const renamed = toolRenamePaths(call);
    if (renamed && (kind === "edit" || kind === "write" || kind === "delete" || verb === "Edit" || verb === "Write")) {
      target = `${prettyPath(renamed.from)} → ${prettyPath(renamed.to)}`;
    } else if (isSearch && pattern) {
      target = clamp(pattern);
    } else if (url) {
      target = clamp(url.replace(/^https?:\/\//i, ""));
    } else if (filePath) {
      const isList = /^(list_dir|list_directory)$/.test(name) || verb === "List";
      const isRead = name === "read_file" || name === "file_read" || kind === "read";
      if (isList) {
        target = prettyDir(filePath);
      } else if (isRead) {
        target = readTargetLabel(call);
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
    if (title) return opts && opts.full ? title : middleElide(title, TOOL_LABEL_MAX);
    return name || "tool";
  }

  // Flatten rebuilds the label span (details/chevron nodes move; the label
  // does not), so title has to be painted wherever textContent is set.
  function applyToolLabel(el, call) {
    if (!el) return;
    const full = toolLabel(call);
    el.title = toolLabel(call, { full: true });
    // Assigning textContent first is what keeps this idempotent across the
    // repaints that call it — it drops any link node an earlier pass appended.
    el.textContent = full;
    const ref = readLinkRef(call);
    const target = ref ? readTargetLabel(call) : "";
    // Split only when the rendered label really ends with the target: a row that
    // fell back to grok's own title (nothing synthesized) stays plain text.
    if (!target || !full.endsWith(target)) return;
    // Off the editor the link acts on a CARRIER, and only a real tool row ever
    // gets one — a subagent's row is painted by this same function (the row IS
    // the label) and never does. Rendering a link there would give those hosts a
    // control that looks clickable and does nothing. Decided by what the label
    // IS, not where it sits: this runs BEFORE the label is appended to its row,
    // so closest() would see nothing yet.
    const carrierCapable = el.classList.contains("tool-item-label")
      || el.classList.contains("tool-label");
    if (readLinkMode() !== "file" && !carrierCapable) return;
    el.textContent = full.slice(0, full.length - target.length);
    const link = document.createElement("button");
    link.type = "button";
    link.className = "tool-label-ref";
    link.textContent = target;
    link.title = `Open ${ref.replace(/#L(\d+)-L(\d+)$/, " at lines $1-$2")}`;
    link.onclick = (e) => {
      e.stopPropagation(); // must not toggle the row or the group
      const mode = readLinkMode();
      if (mode === "file") {
        vscode.postMessage({ type: "openFile", path: ref });
        return;
      }
      // Both remaining hosts act on the carrier: the text the agent read, parked
      // hidden in the row for exactly this (attachReadCarrier).
      const row = el.closest && el.closest(".tool-item, .tool-flat");
      const details = row && row.querySelector(".tool-item-details");
      if (!details) return; // still reading — nothing to show yet
      if (mode === "inline") {
        details.hidden = !details.hidden;
        link.classList.toggle("open", !details.hidden);
        return;
      }
      const pre = details.querySelector(".tool-cmd-output");
      const parsed = previewFileRef(ref);
      if (pre) {
        openPreviewOverlay({
          kind: "text",
          content: pre.textContent,
          path: parsed.path,
          range: parsed.range,
        });
      }
    };
    el.appendChild(link);
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
      applyToolLabel(lbl, calls[0]);
      flat.appendChild(lbl);
      // #41: a lone command's expandable detail (full command + output) moves
      // into the flat row — moving the NODES keeps the pendingCommandDetails
      // reference valid, so an output that lands after the flatten still
      // attaches.
      const detailsEl = el.querySelector(".tool-item-details");
      if (detailsEl) {
        // A carrier keeps its silence through the flatten: no chevron, no row
        // toggle. Wiring one here would hand the row back the affordance the
        // label link replaced (#122).
        const carrier = detailsEl.classList.contains("tool-read-carrier");
        const chev = el.querySelector(".tool-item .tool-chevron");
        if (chev && !carrier) flat.appendChild(chev);
        flat.appendChild(detailsEl);
        if (!carrier) wireCommandToggle(flat, detailsEl);
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
  }

  function addToToolGroup(call) {
    clearWelcome();
    hideGrokking(); // a tool card is the first content of this turn
    hideThinkingIndicator(); // a running tool now conveys the activity
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
      appendTranscriptChild(el);
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
    applyToolLabel(itemLabel, call);
    item.appendChild(itemLabel);
    item._call = call;
    body.appendChild(item);
    if (call.toolCallId) state.toolItemsByToolCallId.set(call.toolCallId, item);
    // #41: a shell command's row carries an expandable detail — the FULL
    // command text immediately (grok truncates its titles), and the complete
    // captured output once the terminal finishes. MCP rows reuse this
    // shell via host-normalized `detailInput` (never an empty pending block).
    const cmd = commandDetailText(call);
    if (cmd) attachCommandDetails(item, cmd, call.toolCallId);
    else if (isReadTool(call) && !item.querySelector(".cmd-block")) {
      const path = String(toolFilePath(call) || "");
      const ref = readLinkRef(call);
      if (ref && readLinkMode() !== "file") attachReadCarrier(item, path, call.toolCallId);
      else if (!ref && (path || extractToolResultOutput(call))) {
        attachCommandDetails(item, path, call.toolCallId);
      }
    }

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
      el._calls.length === 1
        && !!(commandDetailText(call) || (isReadTool(call) && !readLinkRef(call))),
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
    // Settle the group NOW, not only at closeToolGroup. Every row carries its
    // detail (a command's IN block) or its link (a Read row's path) from the
    // moment it appears, so deferring this is what made "expand tool details"
    // look like it only fired once the command had finished (#122). An explicit
    // toggle on this group still wins.
    if (!el._userToggled) setGroupExpanded(el, groupShouldExpand(el));
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
  //   - override null → the setting: every detail box (command IN/OUT, Read
  //                     file text, edit diff) opens, and only GROUPS that HOLD
  //                     a detail auto-open — search/list-only groups stay collapsed.
  // `groupShouldExpand` needs the element to decide the has-detail case;
  // `detailShouldExpand` is group-agnostic.
  function groupShouldExpand(el) {
    if (state.toolExpandOverride !== null) return state.toolExpandOverride;
    // `.tool-label-ref` counts the same as a detail: a linked Read row carries
    // its payload in the row itself (#122), so a read-only batch is worth
    // opening even though it holds no detail box.
    return effectiveExpandCommandOutputs()
      && !!(el && el.querySelector(".has-details, .tool-label-ref"));
  }
  function detailShouldExpand() {
    if (state.toolExpandOverride !== null) return state.toolExpandOverride;
    return effectiveExpandCommandOutputs();
  }
  // Open/close a group's body + chevron (safe on an in-progress group — the CSS
  // shows the chevron once `.expanded` is set even mid-run).
  function setGroupExpanded(el, open) {
    const body = el.querySelector(".tool-group-body");
    if (!body) return;
    body.hidden = !open;
    el.classList.toggle("expanded", open);
  }

  function revealToolDiff(toolCallId) {
    const item = state.toolItemsByToolCallId.get(toolCallId);
    if (!item) return false;
    const details = item.querySelector(".tool-item-diff");
    if (!details) return false;
    const group = item.closest(".tool-group");
    if (group) setGroupExpanded(group, true);
    setDetailExpanded(item, true);
    item.scrollIntoView({ block: "nearest" });
    return true;
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
    for (const row of liveTranscriptQueryAll(".has-details")) {
      setDetailExpanded(row, detailShouldExpand());
    }
    for (const group of liveTranscriptQueryAll(".tool-group")) {
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
      if (!details.hidden) {
        details.querySelectorAll(".cmd-io pre").forEach((pre) => pre._syncOverflowAffordance?.());
      }
    });
  }

  const MAX_COMMAND_PREVIEW_LINES = 6;

  function makeInlineExpandToggle(collapsedText, className, onToggle) {
    let currentCollapsedText = collapsedText;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = className;
    toggle.textContent = currentCollapsedText;
    toggle.setAttribute("aria-expanded", "false");
    toggle._setCollapsedText = (text) => {
      currentCollapsedText = text;
      if (toggle.getAttribute("aria-expanded") !== "true") toggle.textContent = text;
    };
    toggle.onclick = (e) => {
      e.stopPropagation();
      const expanding = toggle.getAttribute("aria-expanded") !== "true";
      onToggle(expanding);
      toggle.textContent = expanding ? "Show less" : currentCollapsedText;
      toggle.setAttribute("aria-expanded", String(expanding));
    };
    return toggle;
  }

  function appendCommandPreview(container, text, className, language, maxLines = MAX_COMMAND_PREVIEW_LINES, openRef) {
    const fullText = text == null ? "" : String(text);
    const logicalPreview = commandTextPreview(fullText, maxLines);
    const pre = document.createElement("pre");
    pre.className = className;
    // Keep the CSS bound in place before the first layout pass. The observer
    // can then compare this element's full scrollHeight with its clamped
    // clientHeight without cloning the text or guessing a line-height.
    pre.classList.add("command-preview-capped");
    pre.textContent = fullText;
    pre.style.setProperty("--command-preview-lines", String(maxLines));
    pre.title = fullText;
    container.appendChild(pre);
    let viewAll = null;
    let expanded = false;
    let previewLabel = logicalPreview.truncated
      ? `View all (${logicalPreview.lineCount} lines) →`
      : "View all →";
    const ensureViewAll = () => {
      if (viewAll) {
        viewAll._setCollapsedText?.(previewLabel);
        if (!IS_REMOTE) viewAll.textContent = previewLabel;
        return viewAll;
      }
      viewAll = IS_REMOTE
        ? makeInlineExpandToggle(previewLabel, "msg-collapse-btn command-view-all", (expanding) => {
            expanded = expanding;
            pre.classList.toggle("command-full", expanding);
            pre.classList.toggle("command-preview-capped", !expanding);
          })
        : document.createElement("button");
      if (!IS_REMOTE) {
        viewAll.type = "button";
        viewAll.className = "preview-link command-view-all";
        viewAll.textContent = previewLabel;
        viewAll.onclick = (e) => {
          e.stopPropagation();
          // A Read row's "View all" means the file, not a copy of the lines the
          // agent happened to request (#122). Editor hosts post openFile with
          // the range; desktop's openTextFile cannot honour a line selection,
          // so the in-app preview fetches the file and marks those lines.
          if (openRef && !hostPreviewsInApp()) {
            vscode.postMessage({ type: "openFile", path: openRef });
            return;
          }
          const openLanguage = language
            || (className === "tool-cmd" ? state.commandLanguage : "");
          if (hostPreviewsInApp()) {
            const parsed = previewFileRef(openRef);
            openPreviewOverlay({
              kind: "text",
              content: fullText,
              language: openLanguage,
              path: parsed.path || undefined,
              range: parsed.range,
            });
            return;
          }
          const message = { type: "openText", content: fullText };
          if (openLanguage) message.language = openLanguage;
          vscode.postMessage(message);
        };
      }
      container.appendChild(viewAll);
      return viewAll;
    };

    const syncOverflowAffordance = () => {
      const visible = pre.isConnected && !pre.closest("[hidden]");
      const hasLayout = pre.clientWidth > 0 && pre.clientHeight > 0 && visible;
      const logicalTruncated = logicalPreview.truncated;
      if (!expanded) pre.classList.add("command-preview-capped");
      const renderedTruncated = hasLayout && pre.scrollHeight > pre.clientHeight;
      const truncated = logicalTruncated || renderedTruncated;
      previewLabel = truncated ? `View all (${logicalPreview.lineCount} lines) →` : "View all →";
      if (!expanded) {
        if (hasLayout && !truncated) pre.classList.remove("command-preview-capped");
        pre.classList.remove("command-full");
      } else {
        pre.classList.remove("command-preview-capped");
      }
      const overflowing = visible && className === "tool-cmd" && pre.clientWidth > 0 && pre.scrollWidth > pre.clientWidth;
      if (truncated || overflowing) ensureViewAll();
      else if (viewAll && viewAll.getAttribute("aria-expanded") !== "true") {
        viewAll.remove();
        viewAll = null;
      }
    };
    pre._syncOverflowAffordance = syncOverflowAffordance;
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(syncOverflowAffordance);
      observer.observe(pre);
    }
    // Run once immediately so purely logical truncation can expose its control.
    // The later animation-frame/ResizeObserver pass supplies real layout
    // measurements after a card or tool row has been attached and painted.
    syncOverflowAffordance();
    requestAnimationFrame(syncOverflowAffordance);
  }

  // A linked Read row's detail is a CARRIER, not an affordance: no chevron, no
  // row toggle, hidden regardless of the expand setting. It exists only so the
  // text the agent read is in the DOM for the label's link to act on — revealed
  // in place on a remote, handed to the preview window on the desktop. The row's
  // own path IS the control, which is the whole of #122.
  function attachReadCarrier(item, path, toolCallId) {
    const details = document.createElement("div");
    details.className = "tool-item-details tool-read-carrier";
    details.hidden = true;
    const block = document.createElement("div");
    block.className = "cmd-block";
    details.appendChild(block);
    item.appendChild(details);
    // Same registration shape as attachCommandDetails, so the completed update
    // fills it through the identical path.
    state.pendingCommandDetails.push({ command: path, details, done: false, toolCallId });
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
    // Command View all uses the host-supplied shell language (click time, from
    // state.commandLanguage). Output below omits language so the untitled
    // editor can detect file-shaped content.
    appendCommandPreview(body, command, "tool-cmd");
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

  /**
   * Fold a `tool_call_update` back into its row's label and detail.
   *
   * Grok puts the arguments on the FIRST `tool_call`, so its rows read correctly
   * the moment they appear. Claude does not: the first call is a generic
   * `{title:"Read File", rawInput:{}}` and the real `{title:"Read package.json",
   * rawInput:{file_path:…}}` arrives on an update — which nothing was applying,
   * so a Claude turn rendered as a flat list of bare verbs: Run, Read, Search,
   * with no argument, input or output.
   *
   * Applies to every provider, not just Claude — it is simply a no-op where the
   * first call was already complete, which is the Grok case. That is also why
   * the merge is field by field and skips null: Grok's updates frequently carry
   * `title: null`, and a wholesale replace would blank a good label. Claude also
   * sends an update carrying ONLY a toolCallId and `_meta` (the tool response),
   * which would erase everything gathered so far.
   */
  // IN text for the shared command-detail shell. Shell rows use
  // `rawInput.command` / `.cmd`. MCP rows use the host-stamped `detailInput`
  // (`null` / absent = pending or not MCP; `{}` is a no-argument call).
  function commandDetailText(call) {
    const raw = (call && (call.rawInput || call.input)) || {};
    if (typeof raw.command === "string" && raw.command.trim()) return raw.command.trim();
    if (typeof raw.cmd === "string" && raw.cmd.trim()) return raw.cmd.trim();
    if (typeof call.detailInput === "string" && call.detailInput.trim()) return call.detailInput.trim();
    return "";
  }

  function refreshToolRowFromUpdate(update) {
    const id = update && update.toolCallId;
    if (!id) return;
    const item = state.toolItemsByToolCallId.get(id);
    if (!item || !item._call) return;
    const merged = { ...item._call };
    for (const key of ["title", "kind", "status", "locations", "rawOutput"]) {
      if (update[key] !== undefined && update[key] !== null) merged[key] = update[key];
    }
    // Arguments accumulate across updates (`{}` → `{file_path}` → `{file_path,
    // limit}`), so merge rather than replace or a later, sparser update would
    // drop the path.
    for (const key of ["rawInput", "input"]) {
      if (update[key] && typeof update[key] === "object") {
        merged[key] = { ...(item._call[key] || {}), ...update[key] };
      }
    }
    if (Object.prototype.hasOwnProperty.call(update, "detailInput")) {
      merged.detailInput = update.detailInput;
    }
    item._call = merged;
    // Flatten / summarize read `_calls`, not `item._call`. Grok's first
    // use_tool row is titled "use_tool" until this update; leave the
    // group's copy stale and the flat label stays the wrapper name.
    const groupCalls = item.closest(".tool-group");
    if (groupCalls && Array.isArray(groupCalls._calls)) {
      const idx = groupCalls._calls.findIndex((c) => c && c.toolCallId === id);
      if (idx >= 0) groupCalls._calls[idx] = merged;
    }
    const labelEl = item.querySelector(".tool-item-label");
    if (labelEl) applyToolLabel(labelEl, merged);
    // The running header names the NEWEST call (addToToolGroup), and its
    // argument often arrives on an update rather than the first tool_call —
    // Claude ships an empty rawInput and fills it in. Without this the header
    // sits on a bare "Searching" for the whole search, which is the half of
    // #145 worth fixing. Only while running: once the batch closes the header
    // is a summary, not a verb.
    if (groupCalls && groupCalls.classList.contains("in-progress") && Array.isArray(groupCalls._calls)) {
      const newest = groupCalls._calls[groupCalls._calls.length - 1];
      const hdrLabel = groupCalls.querySelector(".tool-group-label");
      if (hdrLabel && newest && newest.toolCallId === id) {
        hdrLabel.textContent = inProgressLabel(merged);
        paintGroupDiffTotals(groupCalls); // textContent just wiped the totals slot
      }
    }
    // A shell command that only shows up on the update still earns its IN/OUT
    // box; attachCommandDetails is a no-op once the row already has one.
    // MCP args that arrive after a pending row use the same attach.
    const cmd = commandDetailText(merged);
    if (cmd && !item.querySelector(".cmd-block")) attachCommandDetails(item, cmd, id);
    else if (isReadTool(merged) && !item.querySelector(".cmd-block")) {
      const path = String(toolFilePath(merged) || "");
      const ref = readLinkRef(merged);
      if (ref && readLinkMode() !== "file") attachReadCarrier(item, path, id);
      else if (!ref && (path || extractToolResultOutput(merged))) {
        attachCommandDetails(item, path, id);
      }
    }
    if (groupCalls && groupCalls.classList.contains("in-progress") && groupCalls._calls && groupCalls._calls.length === 1) {
      groupCalls.classList.toggle(
        "cmd-single",
        !!(cmd || (isReadTool(merged) && !readLinkRef(merged))),
      );
    }
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
    } else if (commandOutputWasCancelled(msg)) {
      // Live kill. This host always states `cancelled` (true/false). Absence is
      // an older host, which never hydrated replay commandOutput, so null exit
      // was a kill. Do not infer from state.replaying: historyReplay also
      // wraps buffer rebuilds.
      const mark = document.createElement("div");
      mark.className = "cmd-out-marker muted";
      mark.textContent = "[Cancelled] no exit code";
      body.appendChild(mark);
    } else if (msg.exitCode === 0 && !hasOutput) {
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
      appendCommandPreview(body, output, "tool-cmd-output", undefined, MAX_COMMAND_PREVIEW_LINES, msg.openFileRef);
    }
    if (msg.truncated) {
      const note = document.createElement("div");
      note.className = "cmd-out-marker muted";
      note.textContent = commandOutputTruncationNote(msg);
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
    // A pending Claude row's `content` is the tool description — not stdout.
    if (String(call.status || "").toLowerCase() === "pending") return false;
    // Use the pendingCommandDetails entry (a direct `details` node reference that
    // survives a lone command's flatten-move) rather than re-querying the item —
    // the item's details node is relocated to the .tool-flat wrapper.
    const entry = state.pendingCommandDetails.find((p) => p.toolCallId === id);
    if (!entry) return false;
    const block = entry.details.querySelector(".cmd-block");
    if (!block || block.querySelector(".cmd-out")) return false; // OUT already present (grok-build)
    // Live Claude/Composer have no commandDone, so this is the only OUT source.
    // extractToolResultOutput already prefers the unfenced string and applies
    // the same 100K cap as the host commandOutput path — first arriver is
    // correct; attachCommandOutput is idempotent if both land. Do not gate on
    // state.replaying: historyReplay also wraps in-memory buffer rebuilds
    // (focusSession / rehydrateWebviewFromFocused), which have no commandOutput.
    const res = extractToolResultOutput(call);
    if (!res) return false;
    // Read rows reuse this OUT chrome. The 100K cap is display-only —
    // grok already saw the full FileContent (same polarity as MCP).
    // The ref comes from the ROW's merged call, not this update: grok puts the
    // path on the first tool_call and the result on a later one, so the update
    // that carries the text usually has no rawInput to read a path from.
    const rowCall = (state.toolItemsByToolCallId.get(id) || {})._call || call;
    // On an editor host a linked Read row has no detail at all — its path and
    // range ARE the affordance (#122). Elsewhere the carrier still gets filled,
    // because the link needs that text to reveal or to hand to the preview.
    if (readLinkRef(rowCall) && readLinkMode() === "file") return true;
    attachCommandOutput(
      entry.details,
      isReadTool(rowCall) ? { ...res, agentSawCut: false, openFileRef: readOpenFileRef(rowCall) } : res,
    );
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
  function buildInlineDiffRegion(hunks, opts) {
    const previewCap = opts && opts.full ? Infinity : DIFF_PREVIEW_LINES;
    const lineCap = opts && opts.full ? 20000 : MAX_INLINE_DIFF_LINES;
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
      if (rendered >= lineCap) break;
      const rows = result.lines;
      let oldNo = fileLineOr1(site && site.oldLine);
      let newNo = fileLineOr1(site && site.newLine);
      // Only between hunks, and only when the new side actually skipped lines.
      if (prevNewEnd !== null && newNo !== prevNewEnd) {
        const sep = makeHunkSeparator();
        if (rendered >= previewCap) {
          sep.hidden = true;
          previewOverflow.push(sep);
        }
        wrap.appendChild(sep);
      }
      const shown = Math.min(rows.length, lineCap - rendered);
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
        if (rendered + i >= previewCap) {
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
    wrap.style.setProperty("--tdl-num-w", tdlGutterCh(widest));
    const remaining = total - rendered;
    if (remaining > 0) {
      const more = document.createElement("div");
      more.className = "tool-diff-more";
      more.textContent = "... " + remaining + " more line(s) - open diff for the full change";
      more.hidden = true;
      previewOverflow.push(more);
      wrap.appendChild(more);
    }
    if (rendered > previewCap) {
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
    const diffPath = diffs[0] && diffs[0].path;
    if (diffPath && item._call && !toolFilePath(item._call)) {
      item._call.rawInput = { ...(item._call.rawInput || {}), path: diffPath };
    }
    const itemLabel = item.querySelector(".tool-item-label");
    if (itemLabel && item._call) applyToolLabel(itemLabel, item._call);
    const group = item.closest && item.closest(".tool-group");
    if (group && group.classList.contains("in-progress") && item._call) {
      const groupLabel = group.querySelector(".tool-group-label");
      if (groupLabel) {
        const totals = groupLabel.querySelector(".tool-group-diff-totals");
        groupLabel.textContent = inProgressLabel(item._call);
        if (totals) groupLabel.appendChild(totals);
      }
    }

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
        requestDiffPreview(diff);
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

  function requestDiffPreview(diff, requestId) {
    if (hostPreviewsInApp()) {
      openPreviewOverlay({
        kind: "diff",
        path: diff.path,
        oldText: diff.oldText,
        newText: diff.newText,
        sites: diff.sites,
        replaceAll: diff.replaceAll,
      });
      return;
    }
    vscode.postMessage(openDiffMessage(diff, requestId));
  }

  /**
   * Remember that this request's diff has been auto-opened.
   *
   * Bounded, because it is never cleared: a long-lived window with thousands of
   * permissions would otherwise keep every id forever. Sets iterate in
   * insertion order, so dropping the front drops the oldest — and an id old
   * enough to be evicted belongs to a card nobody is about to re-render.
   */
  function rememberAutoOpenedDiff(requestId) {
    const seen = state.autoOpenedDiffRequests;
    seen.add(requestId);
    while (seen.size > 500) seen.delete(seen.values().next().value);
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
    appendTranscriptChild(el);
    scrollToBottom();
  }

  function addError(text, code) {
    clearWelcome();
    const el = document.createElement("div");
    el.className = "msg error";
    el.textContent = text;
    if (typeof code === "string" && code) el.setAttribute("data-error-code", code);
    appendTranscriptChild(el);
    scrollToBottom();
  }

  function sessionSupersededCwd(id) {
    const row = (state.sessions || []).find((s) => s && s.id === id)
      || (state.pinnedSessions || []).find((s) => s && s.id === id)
      || (state.railSelectedRows || []).find((s) => s && s.id === id);
    return (row && row.cwd) || state.activeRepoCwd || state.selectedRepoCwd || state.cwd || "";
  }

  /** Every composer control, not just the textarea. A frozen conversation that
   *  still offers Add context, the mode picker or Send is offering actions the
   *  host will refuse — and `disabled` is what makes them genuinely unclickable
   *  rather than merely faded (owner, 2026-09-01). */
  function setComposerFrozen(frozen) {
    for (const el of [input, micBtn, addBtn, gearBtn, modeBtn, sendBtn]) {
      if (el) el.disabled = frozen;
    }
    // Rewind and Edit hang off the message bubbles rather than the composer,
    // and they act on this conversation, so they freeze with it.
    refreshUserRewindButtons();
  }

  function renderSessionSupersededBanner() {
    let el = document.getElementById("session-superseded-banner");
    if (!state.sessionSuperseded) {
      if (el) el.remove();
      document.body.classList.remove("session-superseded");
      setComposerFrozen(false);
      updateSendButton();
      return;
    }
    document.body.classList.add("session-superseded");
    setComposerFrozen(true);
    if (!el) {
      el = document.createElement("div");
      el.id = "session-superseded-banner";
      el.className = "session-superseded-banner";
      const composer = document.querySelector(".composer");
      if (composer) composer.insertBefore(el, composer.firstChild);
      else return;
    }
    // A CARD standing where the composer would be, not a stripe above it.
    // The composer is the thing that no longer works, so the explanation takes
    // its place instead of hovering over something that still looks usable — a
    // 12px strip over a live-looking composer read as ignorable chrome, and the
    // wording had to carry the whole state in one muted line (owner,
    // 2026-09-01, from a phone).
    el.replaceChildren();
    const title = document.createElement("p");
    title.className = "session-superseded-title";
    title.textContent = "This conversation moved to another tab";
    const body = document.createElement("p");
    body.className = "session-superseded-body";
    // Says the thing a person actually wants to know first: nothing is lost.
    body.textContent = "Nothing was lost — it is still here. Take it back to carry on in this tab.";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "session-superseded-btn";
    btn.textContent = "Continue here";
    btn.onclick = () => {
      const held = state.sessionSuperseded;
      if (!held) return;
      postResumeSession(held.id, held.cwd, { claim: true });
    };
    el.append(title, body, btn);
  }

  function enterSessionSuperseded(id, cwd) {
    if (!id) return;
    state.sessionSuperseded = { id, cwd: cwd || sessionSupersededCwd(id) };
    // STOP THE MICROPHONE FIRST, and treat a takeover as a cancel.
    //
    // The frozen card hides the composer, and the mic button lives in it — so
    // the only in-page way to stop a capture goes away with it. A start already
    // waiting on the browser's permission prompt is worse: it resumes after the
    // takeover, checks only its own `cancelled` flag, installs the capture and
    // starts streaming. The tab would then be recording with no visible control
    // and nothing but the 120-second timer to end it.
    //
    // Both halves of that were introduced here — admitting voice without a
    // bound session, and hiding the composer — so both are closed here.
    if (IS_REMOTE) {
      if (remoteMicStart) remoteMicStart.cancelled = true;
      if (remoteMic) stopBrowserMic(true);
      else if (remoteMicStart) remoteMicStart = null;
      state.mic = "idle";
      clearVoiceInsertion();
      state.voiceLive = false;
      renderMic();
    }
    renderSessionSupersededBanner();
  }

  function clearSessionSuperseded() {
    if (!state.sessionSuperseded) return;
    state.sessionSuperseded = null;
    renderSessionSupersededBanner();
  }

  // Does this surface open files in a host editor tab? Opt-out polarity on
  // capabilities.openInEditor (absent/true = yes). Remote always answers no:
  // the caps a phone receives are the DESK machine's, and a tap must never
  // open an editor 200 km away.
  function hostOpensInEditor() {
    return !IS_REMOTE && !(state.hostCaps && state.hostCaps.openInEditor === false);
  }

  // Hover actions for an inlined image/video, anchored top-right like the
  // code-block copy button: copy the on-disk path, or open/reveal the file.
  // Which of open-vs-reveal is a host capability, not a media kind.
  function buildMediaActions(path, src) {
    const actions = document.createElement("div");
    actions.className = "generated-media-actions";

    // Remote clients: there is no host to copy a path to or open a file in — the
    // one action that means anything on a phone is saving the image, which
    // arrives inlined as a self-contained data: URI. Show only Download; the
    // copy-path / open-file buttons would post host-local messages the
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
    // Both kinds, on a host that advertises it. A generated clip already plays
    // inline and a generated image already enlarges in place, so handing either
    // to the OS default app shows you nothing you cannot already see — finding
    // the file is the thing you actually want. An editor host keeps Open,
    // because there a tab genuinely is somewhere else to put it.
    const showInFolder = !!(state.hostCaps && state.hostCaps.showInFolder === true);
    openBtn.title = showInFolder
      ? "Show in folder"
      : (hostOpensInEditor() ? "Open in VS Code" : "Open file");
    openBtn.innerHTML = showInFolder ? ICON.folder : ICON.file;
    openBtn.onclick = (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: showInFolder ? "showInFolder" : "openFile", path });
    };

    actions.appendChild(copyBtn);
    actions.appendChild(openBtn);
    return actions;
  }

  // Render generated media (grok `/imagine` image or `/imagine-video` video).
  // `src` is a renderable source the host resolved for a generated file — a
  // webview URI streamed from disk (big videos) or a base64 data: URI; `url` is
  // a remote link we open externally. Clicking an image opens a host editor tab
  // when the host can (VS Code); otherwise the in-app lightbox. Video gets
  // native <video> controls. Hover icons: copy path / open file, or show video
  // in its folder.
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
        // Chromium's native overflow (⋯) menu is drawn outside the zoomed
        // layout and misplaces itself under body CSS zoom — we cannot position
        // it. Its entries are Download + Picture-in-Picture; our hover actions
        // already cover download (remote) and open-file (desk). Drop those so
        // the overflow is unreachable rather than reachable-and-wrong.
        // controlsList tokens (Chromium): nodownload, nofullscreen,
        // noremoteplayback, noplaybackrate. Keep fullscreen + play/scrub.
        // disablePictureInPicture is a separate attribute (not controlsList).
        video.controlsList = "nodownload noremoteplayback noplaybackrate";
        video.disablePictureInPicture = true;
        // Metadata preload is safe only when the host advertises honest byte
        // ranges for its media handler. It restores the first frame and the
        // video's intrinsic aspect ratio there; every other host keeps the
        // lazy behavior because its resource pipeline may not serve ranges.
        //
        // What "none" costs, so nobody reads it as free: with no metadata the
        // box has no intrinsic ratio, so height:auto renders Chromium's default
        // ~2:1 until play and then jumps. Deliberately NOT pinned to 16:9 — a
        // fixed ratio would mis-shape portrait and square clips, and a jump
        // beats a wrong shape.
        video.preload = state.hostCaps?.servesMediaRanges === true ? "metadata" : "none";
        video.playsInline = true;
        el.appendChild(video);
      } else {
        const img = document.createElement("img");
        img.src = msg.src;
        img.alt = "Generated image";
        img.loading = "lazy";
        const mediaLabel = (msg.path && String(msg.path).split(/[\\/]/).pop()) || "Generated image";
        // Editor host → openFile (tab). No editor / remote → lightbox. No
        // fullId: generated media is already full-size on the wire (remote
        // inlines the whole file as a data: URI; it never downscales).
        if (hostOpensInEditor() && msg.path) {
          img.title = "Open " + msg.path;
          img.style.cursor = "pointer";
          img.onclick = () => vscode.postMessage({ type: "openFile", path: msg.path });
        } else {
          img.title = "View " + mediaLabel;
          img.style.cursor = "pointer";
          img.onclick = () => openImagePreview(msg.src, mediaLabel);
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
    appendTranscriptChild(el);
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
    flushChildStream(el);
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
    const liveStatus = el.querySelector(".subagent-status");
    if (liveStatus) liveStatus.textContent = "";
    const result = cleanSubagentOutput(info.output || "");
    if (result) {
      const body = el.querySelector(".subagent-result");
      body.innerHTML = `<div class="subagent-result-label">Output of the subagent:</div>` + renderMarkdown(result);
      applyAutoDir(body);
      wireSubagentExpand(el, "Show the subagent's result");
    }
  }

  function hasChildStreamContent(el) {
    const stream = el.querySelector(".subagent-stream");
    return !!(stream && stream.childNodes.length);
  }

  function toggleSubagentDetails(el) {
    const stream = el.querySelector(".subagent-stream");
    const result = el.querySelector(".subagent-result");
    const anyOpen = (stream && !stream.hidden) || (result && !result.hidden);
    const hide = anyOpen;
    if (stream && hasChildStreamContent(el)) stream.hidden = hide;
    if (result && result.innerHTML) result.hidden = hide;
  }

  function wireSubagentExpand(el, title) {
    const row = el.querySelector(".subagent-row");
    if (!row) return;
    row.classList.add("expandable");
    if (title) row.title = title;
    if (row._expandWired) return;
    row._expandWired = true;
    row.onclick = () => toggleSubagentDetails(el);
  }

  function findSubagentCardByChildSession(id) {
    if (!id) return null;
    const sid = String(id);
    return [...state.subagentCards.values()].find(
      (c) => c.dataset.childSessionId === sid || c.dataset.subagentId === sid,
    ) || null;
  }

  function tagSubagentChildSession(el, update) {
    if (!el || !update) return;
    if (update.subagent_id && !el.dataset.subagentId) {
      el.dataset.subagentId = String(update.subagent_id);
    }
    const childId = update.child_session_id || update.subagent_id;
    if (childId && !el.dataset.childSessionId) el.dataset.childSessionId = String(childId);
  }

  function setSubagentLiveStatus(el, text) {
    if (el.classList.contains("subagent-done")) return;
    const status = el.querySelector(".subagent-status");
    if (!status) return;
    const t = String(text || "").replace(/\s+/g, " ").trim();
    status.textContent = t.length > 72 ? t.slice(0, 71) + "…" : t;
  }

  // Child chunks arrive word-level. Paint once per frame per card — same
  // coalescing as appendAgent/flushAgent — so a storm does not reparse the
  // open prose segment (or rewrite thoughts) on every token.
  function scheduleChildStreamFlush(el) {
    if (el._childRenderScheduled) return;
    el._childRenderScheduled = true;
    // Generation-stamped: a synchronous boundary flush (tool row, finish)
    // supersedes the queued frame, which would otherwise reparse the same
    // segment a second time inside one frame.
    const gen = (el._childRenderGen = (el._childRenderGen || 0) + 1);
    requestAnimationFrame(() => {
      if (el._childRenderGen !== gen || !el._childRenderScheduled) return;
      flushChildStream(el);
    });
  }

  function flushChildStream(el) {
    el._childRenderScheduled = false;
    el._childRenderGen = (el._childRenderGen || 0) + 1;
    if (el._childProseEl) {
      el._childProseEl.innerHTML = renderMarkdown(el._childProse || "");
      applyAutoDir(el._childProseEl);
    }
    if (el._childThoughtEl) el._childThoughtEl.textContent = el._childThought || "";
  }

  // A tool row is a hard close, like addToToolGroup nulling activeAgentEl:
  // flush the open segment, then drop the pointer so the next prose chunk
  // appends a NEW .subagent-prose after the tool instead of concatenating
  // into the block above it.
  function closeChildProseSegment(el) {
    flushChildStream(el);
    el._childProse = "";
    el._childProseEl = null;
  }

  function appendChildProse(el, stream, text) {
    if (!el._childProseEl) {
      const body = document.createElement("div");
      body.className = "subagent-prose";
      stream.appendChild(body);
      el._childProseEl = body;
      el._childProse = "";
    }
    el._childProse = (el._childProse || "") + (text || "");
    setSubagentLiveStatus(el, el._childProse);
    scheduleChildStreamFlush(el);
  }

  function appendChildThought(el, stream, text) {
    el._childThought = (el._childThought || "") + (text || "");
    if (!el._childThoughtEl) {
      const wrap = document.createElement("div");
      wrap.className = "subagent-thoughts";
      wrap.innerHTML =
        `<button type="button" class="subagent-thoughts-toggle">Thinking</button>` +
        `<div class="subagent-thoughts-body" hidden></div>`;
      wrap.querySelector(".subagent-thoughts-toggle").onclick = (e) => {
        e.stopPropagation();
        const body = wrap.querySelector(".subagent-thoughts-body");
        body.hidden = !body.hidden;
        wrap.classList.toggle("expanded", !body.hidden);
      };
      stream.insertBefore(wrap, stream.firstChild);
      el._childThoughtEl = wrap.querySelector(".subagent-thoughts-body");
    }
    scheduleChildStreamFlush(el);
  }

  function addChildToolRow(el, stream, call) {
    if (!el._childTools) el._childTools = new Map();
    const id = call && call.toolCallId;
    if (id && el._childTools.has(id)) {
      updateChildToolRow(el, stream, call);
      return;
    }
    closeChildProseSegment(el);
    const row = document.createElement("div");
    row.className = "subagent-tool";
    if (id) row.dataset.toolCallId = id;
    applyToolLabel(row, call);
    stream.appendChild(row);
    if (id) el._childTools.set(id, row);
    setSubagentLiveStatus(el, toolLabel(call));
  }

  function updateChildToolRow(el, stream, call) {
    const id = call && call.toolCallId;
    const row = id && el._childTools && el._childTools.get(id);
    if (!row) {
      addChildToolRow(el, stream, call);
      return;
    }
    const label = toolLabel(call);
    if (label && label !== "tool") applyToolLabel(row, call);
    const status = String(call && call.status || "").toLowerCase();
    if (status === "failed") row.classList.add("subagent-tool-failed");
  }

  function applyChildStream(msg) {
    const el = findSubagentCardByChildSession(msg && msg.childSessionId);
    if (!el) return;
    const stream = el.querySelector(".subagent-stream");
    if (!stream) return;
    if (msg.event === "messageChunk") appendChildProse(el, stream, msg.text);
    else if (msg.event === "thoughtChunk") appendChildThought(el, stream, msg.text);
    else if (msg.event === "toolCall") addChildToolRow(el, stream, msg.call);
    else if (msg.event === "toolCallUpdate") updateChildToolRow(el, stream, msg.call);
    if (hasChildStreamContent(el)) wireSubagentExpand(el, "Show the subagent's activity");
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
        `<span class="subagent-status"></span>` +
        BLINK_DOTS +
        `<span class="subagent-time"></span>` +
      `</div>` +
      `<div class="subagent-stream" hidden></div>` +
      `<div class="subagent-result" hidden></div>`;
    setSubagentTitle(el, call);
    // Cards rebuilt by a cold restore never receive their own subagent_spawned
    // (session/load strips the lifecycle rail), so they'd sit permanently
    // untagged — a magnet for a LATER live spawn's FIFO tag, corrupting the old
    // card with the new run's duration/output. Mark them so live spawn-tagging
    // and the no-id finish fallback skip them.
    if (state.replaying) el.dataset.subagentReplayed = "1";
    appendTranscriptChild(el);
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
      appendTranscriptChild(el);
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
    appendTranscriptChild(el);
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
    appendTranscriptChild(el);
    scrollToBottom();
  }

  function appendThought(text) {
    if (state.suppressReplayTurn) return; // thinking inside the primer turn
    hideGrokking(); // real content arrived — the Thinking block takes over
    // Traces hidden (the default): stand in with a "Thinking…" row. While
    // replaying a loaded session there's no live reasoning to indicate.
    if (!effectiveShowThinking() && !state.replaying) showThinkingIndicator();
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
      appendTranscriptChild(el);
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
    if (!state.replaying) state.ttsTurnText += text;
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
  }

  function applyChatZoom() {
    const zoom = CLIENT_OWNS_FONT_SCALE ? state.remoteFontScale : state.hostFontScale;
    document.body.style.setProperty("--chat-zoom", String(zoom));
  }

  // Desktop-only: a boot-time focus() into the composer can scroll html when
  // the first frame is taller than the window. File-tree inject / chrome wrap
  // call this hook (they must not live in this file); resize is the backstop.
  function resetDocumentScroll() {
    const root = document.documentElement;
    if (!root) return;
    root.scrollTop = 0;
    root.scrollLeft = 0;
  }
  if (IS_DESKTOP_CLIENT) {
    window.__grokResetDocumentScroll = resetDocumentScroll;
    // Window resize only — deliberately NOT visualViewport resize: a touch
    // keyboard shrinking the visual viewport relies on the UA pan that keeps
    // the focused composer in view, and zeroing scrollTop would undo it.
    window.addEventListener("resize", resetDocumentScroll);
  }

  /** Set client-owned zoom, persist, report (remote), refresh gear if open. */
  function setClientFontScale(next) {
    if (!CLIENT_OWNS_FONT_SCALE) return state.remoteFontScale;
    const clamped = clampClientFontScale(next);
    state.remoteFontScale = clamped;
    storeRemotePref(CLIENT_FONT_SCALE_KEY, clamped);
    applyChatZoom();
    if (IS_REMOTE) reportRemotePreferences();
    const slider = document.getElementById("remote-font-scale");
    if (slider) {
      slider.value = String(Math.round(clamped * 100));
      const output = slider.parentElement && slider.parentElement.querySelector("output");
      if (output) output.textContent = `${Math.round(clamped * 100)}%`;
    }
    return clamped;
  }

  function wireClientFontScaleShortcuts() {
    if (!CLIENT_OWNS_FONT_SCALE || window.__grokFontScaleWired) return;
    window.__grokFontScaleWired = true;
    // Test seam (also handy for manual probes).
    window.__grokFontScale = {
      get: () => state.remoteFontScale,
      set: setClientFontScale,
      clamp: clampClientFontScale,
      step: stepClientFontScale,
      min: CLIENT_FONT_SCALE_MIN,
      max: CLIENT_FONT_SCALE_MAX,
      stepSize: CLIENT_FONT_SCALE_STEP,
      key: CLIENT_FONT_SCALE_KEY,
    };
    window.addEventListener("keydown", (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      // Ignore when an editable field is composing IME, but allow zoom over inputs
      // (desktop apps zoom the whole UI regardless of focus).
      const key = e.key;
      if (key === "=" || key === "+" || key === "Add") {
        e.preventDefault();
        setClientFontScale(stepClientFontScale(state.remoteFontScale, CLIENT_FONT_SCALE_STEP));
      } else if (key === "-" || key === "Subtract") {
        e.preventDefault();
        setClientFontScale(stepClientFontScale(state.remoteFontScale, -CLIENT_FONT_SCALE_STEP));
      } else if (key === "0" || key === "Digit0" || key === "Numpad0") {
        // Ctrl/Cmd+0 resets to 100%.
        if (key === "0" || e.code === "Digit0" || e.code === "Numpad0") {
          e.preventDefault();
          setClientFontScale(1);
        }
      }
    });
    window.addEventListener(
      "wheel",
      (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        // Continuous scale; prevent Chromium page-zoom fighting us.
        e.preventDefault();
        const delta = e.deltaY === 0 ? 0 : e.deltaY > 0 ? -0.05 : 0.05;
        if (delta) setClientFontScale(stepClientFontScale(state.remoteFontScale, delta));
      },
      { passive: false },
    );
  }

  function setRemoteTtsEnabled(enabled) {
    const next = !!enabled;
    if (state.remoteTts === next && (next || !state.remoteSummarizeRepliesAloud)) return next;
    state.remoteTts = next;
    storeRemotePref(REMOTE_TTS_KEY, state.remoteTts);
    if (!state.remoteTts) {
      state.remoteSummarizeRepliesAloud = false;
      storeRemotePref(REMOTE_TTS_SUMMARY_KEY, false);
      cancelPendingSpeech();
    }
    window.dispatchEvent(new CustomEvent("grokRemoteTtsChange", {
      detail: { available: ttsAvailable, enabled: state.remoteTts },
    }));
    reportRemotePreferences();
    return state.remoteTts;
  }

  function setRemoteTtsSummaryEnabled(enabled) {
    const next = state.remoteTts && !!enabled;
    if (state.remoteSummarizeRepliesAloud === next) return next;
    state.remoteSummarizeRepliesAloud = next;
    storeRemotePref(REMOTE_TTS_SUMMARY_KEY, next);
    invalidatePendingSpeechSummary();
    reportRemotePreferences();
    return next;
  }

  function reportRemotePreferences() {
    if (!IS_REMOTE || !state.remotePreferencesSupported) return;
    vscode.postMessage({
      type: "remotePreferences",
      fontScale: Math.round(state.remoteFontScale * 100),
      readRepliesAloud: state.remoteTts,
      summarizeRepliesAloud: state.remoteSummarizeRepliesAloud,
      usesTouch: remoteUsesTouchComposer(),
    });
  }

  function clearPendingSpeechSummary() {
    if (!pendingSpeechSummary) return;
    clearTimeout(pendingSpeechSummary.timer);
    pendingSpeechSummary = null;
  }

  function invalidatePendingSpeechSummary() {
    speechRequestId += 1;
    clearPendingSpeechSummary();
  }

  function cancelPendingSpeech() {
    invalidatePendingSpeechSummary();
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  }

  function speakText(text) {
    window.speechSynthesis.speak(new window.SpeechSynthesisUtterance(text));
  }

  function requestSpeech(markdownText) {
    const enabled = IS_REMOTE ? state.remoteTts : state.readRepliesAloud;
    if (!enabled || !ttsAvailable || state.replaying) return;
    const text = spokenTextFromMarkdown(markdownText);
    if (!text) return;
    clearPendingSpeechSummary();
    const requestId = ++speechRequestId;
    window.speechSynthesis.cancel();
    const summarize = IS_REMOTE
      ? state.remoteSummarizeRepliesAloud
      : state.summarizeRepliesAloud;
    if (summarize) {
      const pending = { requestId, text, timer: 0 };
      pending.timer = setTimeout(() => {
        if (pendingSpeechSummary !== pending) return;
        pendingSpeechSummary = null;
        if (speechRequestId !== requestId) return;
        const enabledNow = IS_REMOTE ? state.remoteTts : state.readRepliesAloud;
        const summarizeNow = IS_REMOTE
          ? state.remoteSummarizeRepliesAloud
          : state.summarizeRepliesAloud;
        if (enabledNow && summarizeNow && ttsAvailable) speakText(text);
      }, SPEECH_SUMMARY_FALLBACK_MS);
      pendingSpeechSummary = pending;
      vscode.postMessage({ type: "summarizeSpeech", requestId, text });
      return;
    }
    speakText(text);
  }

  function speakCompletedTurn() {
    const text = state.ttsTurnText;
    state.ttsTurnText = "";
    // The agent copy affordance identifies the newest narration segment for the
    // current turn. Use that same pointer so neither plain nor summarized speech
    // can target an older rendered message.
    const agentActions = liveTranscriptQueryAll(".msg.agent .msg-actions");
    if (
      !state.turnAgentActionsEl ||
      agentActions[agentActions.length - 1] !== state.turnAgentActionsEl
    ) return;
    requestSpeech(text);
  }

  function speakWaitingPrompt(markdownText) {
    state.ttsTurnText = "";
    requestSpeech(markdownText);
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
  }

  // Replayed user prompts (session/load) arrive as user_message_chunk updates.
  // Commit any in-flight agent turn first, then accumulate into one user bubble.
  function appendUserChunk(text, timestampMs, images) {
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
    // skipUserBubble is per user event: a new event re-evaluates hide rules,
    // so a marker-only chunk followed by another user chunk cannot latch.
    if (!state.activeUserEl) {
      state.skipUserBubble = false;
      // A new user message is starting. Hide rules (legacy primer, CLI
      // <system-reminder>, marker-only plan verdict) come from one verdict so
      // the export recorder can consume the same decision.
      const verdict = replayedUserBubbleVerdict(text);
      if (verdict.hide === "turn") {
        state.suppressReplayTurn = true;
        return;
      }
      // Background-task notices the CLI injects as <system-reminder> user turns
      // are agent plumbing, not user content — never bubble them on restore.
      // Grok's reply to them still renders. (Live ones are already dropped by
      // the !replaying guard above; this covers the replayed copy.)
      if (verdict.hide === "reminder") {
        state.skipUserBubble = true;
        return;
      }
      state.suppressReplayTurn = false;
      // Drain saved plan cards that should appear BEFORE this user message — the
      // verdict message that resolved a plan is the boundary, so drain first even
      // for a marker-only verdict that itself renders no bubble.
      drainPlanHistory(state.userMsgCount);
      drainPermissionHistory(state.userMsgCount);
      if (verdict.hide === "marker") {
        // A plan-verdict protocol message. Live never counted or showed a
        // marker-only verdict (e.g. plain "[Plan cancelled]"), so skip it here
        // too — both to hide the grok-only marker and to keep userMsgCount
        // aligned with the afterUserMessage positions the host persisted.
        state.skipUserBubble = true;
        return;
      }
      // Marker + comment: drop the marker, keep the user's words. Live
      // counted this (the comment), so we count it here too.
      text = verdict.text;
      state.userMsgCount += 1;
      state.activeUserEl = addMessage("user", "", undefined, { timestampMs });
      state.activeUserRaw = "";
    }
    if (state.skipUserBubble) return; // marker-only verdict: no user bubble
    if (state.suppressReplayTurn) return; // still inside the primer's user message
    state.activeUserRaw += text;
    const interjection = isInterjectionText(state.activeUserRaw);
    if (interjection) {
      const steerEl = state.activeUserEl.closest(".msg");
      if (steerEl && steerEl.dataset.steer !== "1") {
        // Classification may need several chunks. Undo the speculative prompt
        // count once, then advance the independent in-turn coordinate.
        state.userMsgCount = Math.max(0, state.userMsgCount - 1);
        state.interjectionCount += 1;
        steerEl.dataset.steer = "1";
        refreshUserRewindButtons();
      }
    }
    const displayRaw = interjection
      ? stripInterjectionEnvelope(state.activeUserRaw)
      : state.activeUserRaw;
    // The replayed prompt carries the <vscode-context> envelope we sent; strip it
    // back out so the bubble shows the user's own words + filename-only chips (with
    // the full path on hover), matching the live send — not the raw paths inline.
    // Fenced selection snippets (buildPrompt's output for ranged chips) become
    // ranged chips (`a.ts:2-4`) the same way, and the [Image #N] tag lines
    // buildPromptWithImages appended become image chips — each parser only strips
    // the exact leading/trailing shapes we produce, so a look-alike string in the
    // middle of the user's own words stays put. The stripped body is also what
    // the copy button yields: the user's words, not the context plumbing.
    const parsed = parseAttachmentContext(displayRaw);
    const selBlocks = parseSelectionBlocks(parsed.body);
    const imageTags = parseImageTags(selBlocks.body);
    const imagePreviews = new Map(
      (images || []).map((image) => [image.imageIndex, image]),
    );
    state.activeUserEl.innerHTML = renderMarkdown(imageTags.body);
    applyAutoDir(state.activeUserEl);
    const msgEl = state.activeUserEl.closest(".msg");
    if (msgEl) msgEl._copyText = imageTags.body;
    const chipTags = [
      ...parsed.files.map((f) => makeMsgChipTag(f)),
      ...selBlocks.selections.map((s) =>
        makeMsgChipTag(s.path, { selectionStart: s.start, selectionEnd: s.end })),
      ...imageTags.images.map((im) =>
        makeMsgChipTag(`Image #${im.index}`, {
          imageIndex: im.index,
          path: im.path || imagePreviews.get(im.index)?.path,
          previewSrc: imagePreviews.get(im.index)?.previewSrc,
          fullId: imagePreviews.get(im.index)?.fullId,
        })),
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
  function normalizePlanHistory(plans) {
    let promptPosition;
    let promptOrdinal = 0;
    let inferredInterjections = 0;
    return (plans || []).map((plan) => {
      if (typeof plan.afterUserMessage !== "number") return plan;
      if (plan.afterUserMessage !== promptPosition) {
        if (promptPosition !== undefined) {
          inferredInterjections += Math.max(0, promptOrdinal - 1);
        }
        promptPosition = plan.afterUserMessage;
        promptOrdinal = 0;
      }
      if (typeof plan.afterInterjection === "number") {
        inferredInterjections = Math.max(inferredInterjections, plan.afterInterjection);
        promptOrdinal += 1;
        return plan;
      }
      // Old entries retain chronological array order. Use it as the best
      // possible in-prompt ordinal instead of bunching equal coordinates.
      const afterInterjection = inferredInterjections + promptOrdinal;
      promptOrdinal += 1;
      return { ...plan, afterInterjection };
    });
  }

  function drainPlanHistory(cutoff) {
    if (!state.planHistoryQueue.length) return;
    state.planHistoryQueue = state.planHistoryQueue.filter((p) => {
      const reached = typeof p.afterUserMessage === "number" && (
        p.afterUserMessage < cutoff ||
        (p.afterUserMessage === cutoff && (
          typeof p.afterInterjection !== "number" ||
          p.afterInterjection <= state.interjectionCount
        ))
      );
      if (reached) {
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
    appendTranscriptChild(el);
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

  // "Grokking…" — the generic waiting indicator shown on every user-initiated
  // turn from agentStart until grok produces its first content (thought /
  // message / tool / card), which removes it and renders in its place. Mirrors
  // the Thinking header's look (blink-dots, same muted font) without the
  // chevron, and is not expandable.
  function showGrokking() {
    if (state.historyHydrating) return;
    hideGrokking(); // dedupe
    hideThinkingIndicator();
    clearWelcome();
    const el = document.createElement("div");
    el.className = "grokking";
    // No blink-dots here — the spinning orbit icon is Grokking's "waiting" motion
    // (Thinking / tools use the dots for discrete progress instead).
    const verb = activityVerb();
    el.innerHTML = `<span class="grokking-icon">${ICON.orbit}</span><span class="grokking-label">${verb}</span>`;
    el.setAttribute("aria-label", activityAriaLabel());
    el.title = "Waiting for response";
    appendTranscriptChild(el);
    state.grokkingEl = el;
    // Not while replaying: a restored mid-turn indicator would count from the
    // restore rather than from the send, and understating a 20-minute wait as
    // "3s" is worse than showing nothing.
    if (!state.replaying) armWaitElapsed(el);
    scrollToBottom();
  }

  // The counter is armed per ELEMENT rather than on `state.grokkingEl`, because
  // history hydration nulls that field while the node stays on screen
  // (hydrateHistoryChunkWithCounters saves and restores the reference), and a
  // state-keyed timer would stop counting a wait the user is still looking at.
  // It also stops itself once the node is detached, so any path that removes
  // the indicator — not just hideGrokking — cleans up.
  function armWaitElapsed(el) {
    el._waitStart = Date.now();
    // Painted at once and then every second, with NO threshold to cross.
    //
    // A delay was the first design and it was wrong twice over. It guaranteed
    // that nothing was on screen at exactly the moment someone starts
    // wondering whether the turn is stuck, and it was a constant that could
    // never be right. The obvious objection — a number flickering on every
    // fast turn — does not hold either: this row itself only exists between
    // agentStart and the first content, so on a quick turn it already appears
    // and vanishes in about a second. The churn is the row, not the number.
    const paint = () => {
      if (!el.isConnected) {
        clearWaitElapsed(el);
        return;
      }
      let out = el.querySelector(".grokking-elapsed");
      if (!out) {
        out = document.createElement("span");
        out.className = "grokking-elapsed";
        // The verb is already announced. A value that changes every second
        // would otherwise be read out every second.
        out.setAttribute("aria-hidden", "true");
        el.appendChild(out);
      }
      out.textContent = `\u00b7 ${formatWaitElapsed(Date.now() - el._waitStart)}`;
    };
    paint();
    el._waitTimer = setInterval(paint, 1000);
  }

  function clearWaitElapsed(el) {
    if (el && el._waitTimer) {
      clearInterval(el._waitTimer);
      el._waitTimer = null;
    }
  }

  function hideGrokking() {
    clearWaitElapsed(state.grokkingEl);
    if (state.grokkingEl && state.grokkingEl.parentElement) {
      state.grokkingEl.parentElement.removeChild(state.grokkingEl);
    }
    state.grokkingEl = null;
  }

  function activityVerb() {
    if (state.activeProvider === "codex") return CODEX_ACTIVITY_VERB;
    if (state.activeProvider === "claude") return CLAUDE_ACTIVITY_VERB;
    return GROK_ACTIVITY_VERB;
  }

  function activityAriaLabel() {
    if (state.activeProvider === "codex") return "OpenAI is working";
    if (state.activeProvider === "claude") return "Claude is working";
    return "Grok is working";
  }

  function syncProviderVoice() {
    input.placeholder = COMPOSER_PLACEHOLDER[state.activeProvider] || COMPOSER_PLACEHOLDER.grok;
    if (!state.grokkingEl) return;
    const label = state.grokkingEl.querySelector(".grokking-label");
    if (label) label.textContent = activityVerb();
    state.grokkingEl.setAttribute("aria-label", activityAriaLabel());
  }

  // "Thinking…" — the stand-in shown while thinking traces are hidden (#26, the
  // default). grok's thought stream is suppressed from view, so this lightweight
  // row signals it's reasoning — but only when nothing else already conveys work
  // (no running tool group, no Grokking). Styled like a tool row: brain icon +
  // muted label + blink-dots. Stable while thoughts stream; removed the moment
  // a tool, agent message, or turn-end takes over.
  function showThinkingIndicator() {
    if (state.thinkingIndicatorEl) return; // already up — keep it stable
    if (state.activeToolGroupEl) return; // a running tool already indicates work
    hideGrokking();
    clearWelcome();
    const el = document.createElement("div");
    el.className = "thinking-indicator";
    el.innerHTML = `<span class="thinking-indicator-icon">${ICON.brain}</span><span class="thinking-indicator-label">Thinking</span>${BLINK_DOTS}`;
    el.setAttribute("aria-label", "Grok is thinking");
    appendTranscriptChild(el);
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
  let onFindPreferenceChange = () => {};
  function applyThinkingVisibility() {
    document.body.classList.toggle("thinking-hidden", !effectiveShowThinking());
    if (effectiveShowThinking()) hideThinkingIndicator();
    onFindPreferenceChange();
  }

  // True when *something* already tells the user grok is mid-work or awaiting
  // them: a waiting indicator, a running tool group, streaming agent text, a
  // visible thinking block (only counts when traces are shown — hidden ones are
  // display:none), or an open permission/question/plan card.
  function turnHasVisibleActivity() {
    return !!(
      state.grokkingEl ||
      state.thinkingIndicatorEl ||
      state.activeToolGroupEl ||
      (state.activeAgentEl && (state.activeAgentRaw || "").trim()) ||
      (effectiveShowThinking() && state.activeThoughtEl) ||
      liveTranscriptQueryAll(".card:not(.resolved)")[0]
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
  // they gesture away (the listener below clears state.stickToBottom) this
  // becomes a no-op, so they can read history while grok keeps thinking (#16).
  // Replay (ACP session/load *and* in-memory buffer rebuilds) must not do this
  // per element: each assignment forces layout, and a large load looks like
  // infinite scroll. historyReplay end follows the pin once.
  function scrollToBottom() {
    if (state.replaying || !state.stickToBottom) return;
    messagesEl.scrollTop = messagesEl.scrollHeight;
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
  // cards and their own just-sent message. No-op during replay — the closing
  // historyReplay frame follows the pin instead of re-pinning.
  function forceScrollToBottom() {
    if (state.replaying) return;
    setStickToBottom(true);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    updateScrollBtn();
  }

  // Browser scroll anchoring is useful to a reader who has deliberately
  // scrolled into history, but it produces a synthetic scroll event for a
  // pinned reader when a detail block grows above the viewport. Keep anchoring
  // disabled only while pinned; the unpinned reader keeps the native anchor and
  // therefore keeps the same line in view while new content arrives (#92).
  function setStickToBottom(stick) {
    state.stickToBottom = !!stick;
    messagesEl.classList.toggle("stick-to-bottom", state.stickToBottom);
  }
  setStickToBottom(state.stickToBottom);

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
    if (state.stickToBottom && !state.replaying) messagesEl.scrollTop = messagesEl.scrollHeight;
  }).observe(messagesEl);

  // The scrollport's own border-box does not resize when content inside an
  // expanded tool detail grows, so ResizeObserver above cannot see that case.
  // Re-follow after subtree layout changes only when the reader was already
  // pinned; a deliberate scroll-up has cleared stickToBottom and is untouched.
  let contentFollowFrame = 0;
  new MutationObserver(() => {
    if (state.replaying || state.historyHydrating || prependLock || !state.stickToBottom || contentFollowFrame) return;
    contentFollowFrame = requestAnimationFrame(() => {
      contentFollowFrame = 0;
      if (state.stickToBottom && !state.replaying && !prependLock) messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }).observe(messagesEl, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["hidden", "class", "style"],
  });

  // Pin state is a user-intent bit, not a distance-from-bottom measurement.
  // Content growth, focus(), programmatic scrollTop, and UA scroll-into-view
  // all fire `scroll` with dist well above one line — at zoom that used to
  // look like the reader had scrolled away (#92). Only wheel / touch /
  // scrollbar / keyboard movement may clear the pin. #16 still holds: a
  // reader who gestured away stays unyanked; permission cards still
  // force-scroll; resize (mobile keyboard) is not a gesture.
  // Latch, not a one-shot: a trackpad flick emits one wheel then many
  // inertial `scroll`s. Clearing on the first event would land at the
  // bottom still unpinned.
  let userScrollIntentUntil = 0;
  const USER_SCROLL_INTENT_MS = 750;
  const noteUserScrollIntent = () => {
    userScrollIntentUntil = (typeof performance !== "undefined" && performance.now)
      ? performance.now() + USER_SCROLL_INTENT_MS
      : Date.now() + USER_SCROLL_INTENT_MS;
  };
  const hasUserScrollIntent = () => {
    const now = (typeof performance !== "undefined" && performance.now)
      ? performance.now() : Date.now();
    return now < userScrollIntentUntil;
  };
  messagesEl.addEventListener("wheel", noteUserScrollIntent, { passive: true });
  messagesEl.addEventListener("touchstart", noteUserScrollIntent, { passive: true });
  messagesEl.addEventListener("pointerdown", (e) => {
    // Chromium targets the scrollport itself for the scrollbar thumb/track.
    if (e.target === messagesEl) noteUserScrollIntent();
  });
  messagesEl.addEventListener("keydown", (e) => {
    if (e.target !== messagesEl) return;
    if (e.key === "PageUp" || e.key === "PageDown" || e.key === "Home" || e.key === "End" ||
        e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === " ") {
      noteUserScrollIntent();
    }
  });

  function currentStickThreshold() {
    const lh = parseFloat(getComputedStyle(messagesEl).lineHeight);
    return typeof stickThresholdPx === "function" ? stickThresholdPx(lh) : 40;
  }

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
    if (hasUserScrollIntent()) {
      setStickToBottom(shouldStickToBottom(
        messagesEl.scrollTop, messagesEl.scrollHeight, messagesEl.clientHeight,
        currentStickThreshold(),
      ));
      updateScrollBtn();
    }
    maybeLoadEarlierHistory();
  });

  scrollBottomBtn.onclick = () => {
    autoScrolling = true;
    setStickToBottom(true);
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

  function resolvePermissionCardEl(el, opt, fallbackTitle) {
    if (el._planShown) {
      resolvePlanCardEl(el, /reject|deny/i.test(opt && opt.kind) ? "rejected" : "approved");
      return;
    }
    if (el.classList.contains("plan")) {
      // A switch_mode card with no plan text is a mode question. Do not claim
      // a plan was approved.
      collapsePermissionCard(el, opt && opt.kind, (opt && opt.name) || "mode change");
      return;
    }
    collapsePermissionCard(el, opt && opt.kind, fallbackTitle);
  }

  function renderPermissionActions(el, requestId, cardTitle, rawOptions) {
    const oldActions = el.querySelector(".card-actions");
    if (oldActions) oldActions.remove();
    el._permOptions = rawOptions || [];
    const actions = document.createElement("div");
    actions.className = "card-actions";
    // Approve first, reject last — the CLI's own order isn't guaranteed, and the
    // keyboard default below must never land on a reject (#68).
    const options = orderPermissionOptions(rawOptions);
    const defaultIndex = defaultPermissionIndex(options);
    const buttons = [];
    options.forEach((opt, i) => {
      const btn = document.createElement("button");
      btn.textContent = opt.name;
      btn.type = "button";
      if (opt.kind === "allow_once") btn.classList.add("primary");
      if (opt.kind === "reject_once") {
        btn.classList.add("danger");
        // A permission arrival force-scrolls the transcript. Ignore pointer
        // targeting during that layout transition so a click intended for the
        // adjacent Thinking disclosure cannot land on Reject (#76).
        if (effectiveShowThinking()) {
          btn.classList.add("arming");
          setTimeout(() => btn.classList.remove("arming"), 1000);
        }
      }
      // Only the default button is in the tab order; the arrow keys move within
      // the group. Standard toolbar/radiogroup roving-tabindex, so Tab escapes
      // the card in one press instead of walking every option.
      btn.tabIndex = i === (defaultIndex >= 0 ? defaultIndex : 0) ? 0 : -1;
      btn.onclick = () => {
        if (state.sessionSuperseded) return;
        vscode.postMessage({
          type: "permissionAnswer",
          requestId,
          optionId: opt.optionId,
        });
        // Collapse to one muted line and show the working indicator — grok
        // resumes the turn after the answer.
        resolvePermissionCardEl(el, opt, cardTitle);
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
    return { buttons, defaultIndex };
  }

  // A single replay-stable coordinate shared by plan cards, permission cards,
  // and usage records. Drain before advancing so a verdict that released the
  // agent appears immediately before the first implementation update.
  function advanceHistoryEvent() {
    state.planHistoryQueue = state.planHistoryQueue.filter((p) => {
      if (typeof p.afterHistoryEvent === "number" && p.afterHistoryEvent <= state.historyEventCount) {
        addPlanHistoryCard(p.text, p.verdict, p.planPath, p.planName);
        return false;
      }
      return true;
    });
    state.permissionHistoryQueue = state.permissionHistoryQueue.filter((p) => {
      if (!p.toolCallId && typeof p.afterHistoryEvent === "number" && p.afterHistoryEvent <= state.historyEventCount) {
        addRestoredPermissionCard(p.title, p.outcome);
        return false;
      }
      return true;
    });
    state.historyEventCount += 1;
  }

  function updatePermissionOptions(requestId, options) {
    const cards = liveTranscriptQueryAll(".card.permission");
    const el = cards.find((card) =>
      card.dataset.permReqId === String(requestId) &&
      !card.classList.contains("perm-resolved") &&
      !card.classList.contains("resolved")
    );
    if (el) renderPermissionActions(el, requestId, el._permTitle, options);
  }

  function isPlanReviewTool(call) {
    return String((call && call.kind) || "").toLowerCase() === "switch_mode";
  }

  function addPlanReviewPermissionCard(req) {
    clearWelcome();
    hideGrokking();
    commitAgentTurn();
    const planText = typeof req.plan === "string" ? req.plan : "";
    const hasPlan = !!planText.trim();
    const el = document.createElement("div");
    el.className = "card plan permission";
    el.dataset.permReqId = String(req.id);
    el._permTitle = req.toolCall?.title || "Plan review";
    el._planShown = hasPlan;

    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = "Plan ready for review";
    el.appendChild(title);

    const sub = document.createElement("div");
    sub.className = "card-subtitle";
    sub.textContent = hasPlan
      ? "Nothing has been written yet. Choose how to continue."
      : "The agent asked to leave plan mode, but did not include the plan text.";
    el.appendChild(sub);

    const body = document.createElement("div");
    body.className = "plan-body";
    if (hasPlan) {
      body.innerHTML = renderMarkdown(planText);
      applyAutoDir(body);
      renderMermaidIn(body);
    } else {
      body.textContent = "No plan was provided with this request.";
    }
    el.appendChild(body);

    const { buttons, defaultIndex } =
      renderPermissionActions(el, req.id, el._permTitle, req.options);
    appendTranscriptChild(el);
    el.querySelectorAll("pre").forEach((pre) => pre._syncOverflowAffordance?.());
    forceScrollToBottom();
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

  function addPermissionCard(req) {
    clearWelcome();
    hideGrokking();
    // Mirror the plan card: finalize any in-flight agent/thinking/tool turn so
    // grok's continuation after the answer renders BELOW this card, not appended
    // to the bubble that was streaming above it.
    commitAgentTurn();
    if (typeof req.plan === "string" || isPlanReviewTool(req.toolCall)) {
      addPlanReviewPermissionCard(req);
      return;
    }
    const cardTitle = req.toolCall?.title || `permission: ${req.toolCall?.kind || "tool"}`;
    const el = document.createElement("div");
    el.className = "card permission";
    // Tag the card so a buffered `permissionResolved` (replayed when this session
    // is re-focused) can find it and collapse it — the live collapse is a DOM-only
    // mutation that isn't in the session buffer, so without this an already-answered
    // card replays as active on every re-focus.
    el.dataset.permReqId = String(req.id);
    el._permTitle = cardTitle;
    appendCommandPreview(el, cardTitle, "card-title command-card-title", undefined, 4);

    const diff = state.pendingDiffByToolCallId.get(req.toolCall?.toolCallId);
    if (diff) {
      const subtitle = document.createElement("div");
      subtitle.className = "card-subtitle";
      const oldLines = (diff.oldText || "").split("\n").length;
      const newLines = (diff.newText || "").split("\n").length;
      subtitle.textContent = `${diff.path} — ${oldLines} → ${newLines} lines`;
      el.appendChild(subtitle);

      const openDiff = () => {
        if (IS_REMOTE) revealToolDiff(req.toolCall?.toolCallId);
        else requestDiffPreview(diff, req.id);
      };
      const preview = document.createElement("button");
      preview.className = "preview-link";
      // VS Code keeps a re-open action for its native preview; AFK Pilot uses
      // the same control to reveal the inline diff in the tool row above.
      preview.textContent = "open diff →";
      preview.onclick = openDiff;
      el.appendChild(preview);
      // Auto-open only where a native editor exists. The in-app overlay would
      // cover the permission buttons, so previewInApp waits for the tap.
      // Moving a remote transcript on card arrival is disorienting; its
      // explicit tap expands inline.
      //
      // ONCE per request, not once per render. This card is rebuilt every time
      // its conversation is re-entered, and firing again there reopened a diff
      // the reader had closed — on top of the files they were actually working
      // in (#132). A new edit is a new request id and still opens, which is the
      // behaviour that was wanted.
      if (!IS_REMOTE && !hostPreviewsInApp() && !state.autoOpenedDiffRequests.has(req.id)) {
        rememberAutoOpenedDiff(req.id);
        openDiff();
      }
    }

    const { buttons, defaultIndex } =
      renderPermissionActions(el, req.id, cardTitle, req.options);
    appendTranscriptChild(el);
    el.querySelectorAll("pre").forEach((pre) => pre._syncOverflowAffordance?.());
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
    // preventScroll: forceScrollToBottom already placed the card. A UA
    // scroll-into-view here (zoom + a card taller than the port) is not a
    // user scroll-away, but it fires `scroll` with dist > one line and used
    // to unpin the reader (#92).
    buttons[index].focus({ preventScroll: true });
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
    const questions = (Array.isArray(req.questions) ? req.questions : []).map((q) => {
      const options = Array.isArray(q?.options) ? q.options : [];
      if (options.some((opt) => isFreeTextOptionLabel(opt?.label))) return q;
      // The tool contract promises every question carries a free-text "Other",
      // but grok doesn't send one — so without this the card has no way to say
      // anything the listed options don't cover (#85). The answer still travels
      // through the existing `answers[question]` map, which is a plain
      // string→string map on the CLI side, so the typed value simply takes the
      // label's place. If grok ever starts sending its own — under whatever
      // wording — isFreeTextOptionLabel is what keeps us from adding a second.
      return { ...q, options: [...options, { label: "Other" }] };
    });
    const el = document.createElement("div");
    el.className = "card question";

    const title = buildQuestionHead(el, "Grok is asking");

    // selections[i] = array of chosen labels for question i.
    const selections = questions.map(() => []);
    const oneClick = questions.length === 1 && !questions[0].multiSelect;
    const otherSelected = questions.map(() => false);
    const otherText = questions.map(() => "");
    const hasOther = questions.some((q) =>
      (q.options || []).some((opt) => isFreeTextOptionLabel(opt.label)));
    const effectiveSelections = () => selections.map((picked, qi) => {
      const custom = otherSelected[qi] ? otherText[qi].trim() : "";
      return custom ? [...picked, custom] : [...picked];
    });

    let submitBtn;
    let skip;
    const updateSubmit = () => {
      if (!submitBtn) return;
      const built = buildQuestionAnswers(questions, effectiveSelections());
      const otherComplete = otherSelected.every((selected, qi) => !selected || !!otherText[qi].trim());
      submitBtn.disabled = !built.allAnswered || !otherComplete;
    };
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
        block.appendChild(answerLineEl(skipped ? "" : (effectiveSelections()[qi] || []).join(", ")));
      });
    };
    const submit = () => {
      const { answers, allAnswered } = buildQuestionAnswers(questions, effectiveSelections());
      if (!allAnswered || otherSelected.some((selected, qi) => selected && !otherText[qi].trim())) return;
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
        const isOther = isFreeTextOptionLabel(opt.label);
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
          if (isOther) {
            if (q.multiSelect) {
              otherSelected[qi] = !otherSelected[qi];
              btn.classList.toggle("selected", otherSelected[qi]);
            } else {
              selections[qi] = [];
              otherSelected[qi] = true;
              for (const sib of opts.querySelectorAll(".question-option")) sib.classList.remove("selected");
              btn.classList.add("selected");
            }
            const custom = opts.querySelector(".question-other-input");
            if (custom) {
              custom.hidden = !otherSelected[qi];
              if (otherSelected[qi]) custom.focus();
            }
            updateSubmit();
            return;
          }
          if (oneClick) {
            selections[qi] = [opt.label];
            otherSelected[qi] = false;
            submit();
            return;
          }
          if (q.multiSelect) {
            const i = selections[qi].indexOf(opt.label);
            if (i >= 0) { selections[qi].splice(i, 1); btn.classList.remove("selected"); }
            else { selections[qi].push(opt.label); btn.classList.add("selected"); }
          } else {
            selections[qi] = [opt.label];
            otherSelected[qi] = false;
            for (const sib of opts.querySelectorAll(".question-option")) sib.classList.remove("selected");
            btn.classList.add("selected");
            const custom = opts.querySelector(".question-other-input");
            if (custom) custom.hidden = true;
          }
          updateSubmit();
        };
        opts.appendChild(btn);
        if (isOther) {
          // A textarea, not a single-line input (#144): an "Other" answer is
          // often a list or a couple of paragraphs, and a one-line box meant
          // the writer could not read back what they had typed. One row at
          // rest so it looks no heavier than the input it replaces; it grows
          // with the content and then scrolls, same rule as the composer.
          const custom = document.createElement("textarea");
          custom.rows = 1;
          custom.className = "question-other-input";
          custom.placeholder = "Type your answer";
          custom.setAttribute("aria-label", `${questionText(q)} — Other answer`);
          custom.hidden = true;
          const autosize = () => {
            const cs = window.getComputedStyle(custom);
            const line = parseFloat(cs.lineHeight) || 20;
            const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
              + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
            // Same ceiling as the composer: it is the same trade about how much
            // of the screen a writing box may take, and two different answers to
            // it on one screen would be arbitrary.
            const max = Math.round(line * composerMaxLines() + pad);
            custom.style.height = "auto";
            const content = custom.scrollHeight;
            custom.style.height = Math.max(Math.round(line + pad), Math.min(content, max)) + "px";
            custom.style.overflowY = content > max ? "auto" : "hidden";
          };
          custom.oninput = () => {
            otherText[qi] = custom.value;
            autosize();
            updateSubmit();
          };
          custom.onkeydown = (e) => {
            // The composer's rule, verbatim, so one convention covers both:
            // Ctrl/Cmd+Enter when the user has chosen that, otherwise Enter —
            // except on a touch composer, where Enter has to make a newline
            // because a phone keyboard has no other way to.
            const sendKey = state.useCtrlEnter
              ? e.key === "Enter" && (e.metaKey || e.ctrlKey)
              : !remoteUsesTouchComposer() && e.key === "Enter" && !e.shiftKey;
            if (sendKey && submitBtn && !submitBtn.disabled) {
              e.preventDefault();
              submit();
            }
          };
          opts.appendChild(custom);
          // Hidden until "Other" is picked, so the first measurement has to
          // wait for it to be revealed — the click handler focuses it, and
          // focus is what this rides on.
          custom.onfocus = autosize;
        }
      }
      block.appendChild(opts);
      el.appendChild(block);
    });

    if (!oneClick || hasOther) {
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

    appendTranscriptChild(el);
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
    appendTranscriptChild(el);
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
  // live click and buffered `planResolved` replay (re-focus), so a resolved
  // card can never come back actionable.
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
        resolvePlanCardEl(el, verdict);
      };
      return b;
    };
    actions.appendChild(mk("Approve & implement", "primary", "approved", true));
    actions.appendChild(mk("Reject", "", "rejected", true));
    actions.appendChild(mk("Cancel", "secondary", "abandoned", true));
    el.appendChild(actions);
    appendTranscriptChild(el);
    scrollToBottom();
  }

  // Read-only plan card for resumed sessions. The original exit_plan_mode request
  // is long gone, so there's nothing to respond to — we just show the plan text
  // grok wrote during that session, recovered from ~/.grok/sessions/.../plan.md,
  // and the verdict the user gave it (persisted in globalState).
  function addPlanHistoryCard(text, verdict, planPath, planName) {
    clearWelcome();
    // A native verdict can sit inside one agent turn. Finalize the plan-drafting
    // bubble so the implementation chunk after this card starts a new bubble.
    commitAgentTurn();
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

    appendTranscriptChild(el);
    scrollToBottom();
  }

  // ---------- chips ----------

  /** Toggle the "rendering the full size" disc over the open preview.
   *  The timeout is not decoration: an unrecognised handle is answered with
   *  SILENCE on purpose, so that probing reveals nothing about what is on disk —
   *  which means a spinner waiting on one would turn forever. */
  function setImagePreviewLoading(active) {
    if (state.imageFullTimer) {
      clearTimeout(state.imageFullTimer);
      state.imageFullTimer = null;
    }
    const spinner = document.querySelector(".image-preview-spinner");
    if (spinner) spinner.hidden = !active;
    if (!active) return;
    state.imageFullTimer = setTimeout(() => {
      const late = document.querySelector(".image-preview-spinner");
      if (late) late.hidden = true;
      state.pendingImageFullId = null;
      state.imageFullTimer = null;
    }, 20000);
  }

  /** Hide the body-attached lightbox and drop any in-flight full-size request.
   *  Called from the close control, Escape, and session reset — the overlay
   *  outlives the transcript, so a focus swap must not leave the previous
   *  session's image sitting over the next one. */
  function closeImagePreview() {
    const overlay = document.querySelector(".image-preview-overlay");
    if (overlay) {
      overlay.hidden = true;
      const img = overlay.querySelector("img");
      if (img) {
        img.removeAttribute("src");
        img.alt = "";
      }
    }
    setImagePreviewLoading(false);
    state.pendingImageFullId = null;
  }

  function openImagePreview(src, label, fullId) {
    if (!src) return;
    let overlay = document.querySelector(".image-preview-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "image-preview-overlay";
      overlay.hidden = true;
      overlay.innerHTML = `<button type="button" class="image-preview-close" aria-label="Close image preview">&times;</button><img>`
        + `<div class="image-preview-spinner" role="status" aria-label="Loading full-size image" hidden>${ICON.spinner}</div>`;
      overlay.onclick = (e) => { if (e.target === overlay) closeImagePreview(); };
      overlay.querySelector(".image-preview-close").onclick = closeImagePreview;
      document.body.appendChild(overlay);
    }
    const img = overlay.querySelector("img");
    img.src = src;
    img.alt = label || "Attached image";
    overlay.hidden = false;
    overlay.querySelector(".image-preview-close").focus();

    // A remote only ever holds a 320px thumbnail, so enlarging it shows a blurry
    // copy of what was already on screen. Ask the host for a real render and
    // swap it in when it lands — the thumbnail stays up meanwhile, so a slow or
    // unanswered request degrades to exactly the old behaviour.
    state.pendingImageFullId = null;
    setImagePreviewLoading(false);
    if (IS_REMOTE && fullId) {
      state.pendingImageFullId = fullId;
      setImagePreviewLoading(true);
      vscode.postMessage({ type: "requestImageFull", fullId });
    }
  }

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const overlay = document.querySelector(".image-preview-overlay");
    if (overlay && !overlay.hidden) closeImagePreview();
  });

  function previewCacheForCurrentSession() {
    return state.imagePreviews;
  }

  function rememberImagePreview(previewId, previewSrc) {
    if (typeof previewId !== "string" || typeof previewSrc !== "string") return false;
    const previews = previewCacheForCurrentSession();
    previews.set(previewId, previewSrc);
    while (previews.size > 24) {
      const oldest = previews.keys().next().value;
      if (oldest === undefined) break;
      previews.delete(oldest);
    }
    return true;
  }

  if (IS_REMOTE) {
    // The relay registers its decoded/uploaded preview before sending the host
    // frame. Generate the id here so it uses the same opaque-token contract as
    // the rest of the remote UI, while keeping imagePreviews private to chat.js.
    window.grokRegisterRemoteImagePreview = (previewSrc) => {
      if (typeof previewSrc !== "string" || !previewSrc.startsWith("data:image/")) return null;
      const previewId = newRemoteTabToken();
      if (!previewId || !/^[A-Za-z0-9_-]{20,128}$/.test(previewId)) return null;
      return rememberImagePreview(previewId, previewSrc) ? previewId : null;
    };
  }

  function renderChips() {
    chipsEl.innerHTML = "";
    attachmentsEl.innerHTML = "";
    const imagePreviews = previewCacheForCurrentSession();
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
        const previewSrc = chip.previewSrc || (chip.previewId && imagePreviews.get(chip.previewId));
        if (chip.imageIndex != null && previewSrc) {
          const preview = document.createElement("button");
          preview.type = "button";
          preview.className = "attachment-preview";
          preview.title = `Preview ${label}`;
          const img = document.createElement("img");
          img.src = previewSrc;
          img.alt = "";
          preview.appendChild(img);
          preview.onclick = () => openImagePreview(previewSrc, label, chip.fullId);
          el.appendChild(preview);
        } else {
          el.innerHTML = chip.imageIndex != null ? ICON.image : ICON.file;
        }
        const span = document.createElement("span");
        span.textContent = label;
        el.appendChild(span);
        const rm = document.createElement("button");
        rm.type = "button";
        rm.className = "attachment-remove";
        rm.title = "Remove";
        rm.textContent = "×";
        rm.onclick = (e) => {
          e.stopPropagation();
          if (chip.previewId) imagePreviews.delete(chip.previewId);
          vscode.postMessage({ type: "removeChip", id: chip.id });
        };
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
    donutEl.title = `Context usage — ${used.toLocaleString()} / ${max.toLocaleString()} tokens`;
    // Occupancy can move without a contextUsage frame (promptComplete,
    // modelChanged). Re-paint, then re-fetch session/info while the popover
    // is open so the group stays and catches up instead of vanishing.
    if (!contextPopover.hidden) {
      renderContextPopover();
      if (!contextBreakdownIsCurrent(state.contextBreakdown, used, state.contextWindow)) {
        vscode.postMessage({ type: "refreshContextDetails" });
      }
    }
  }

  // ---------- slash autocomplete ----------

  function updateSlash() {
    // Skills load anywhere in the prompt; commands dispatch only at position 0
    // of the text block (owner-measured; grok `available_commands` stamps
    // `_meta.scope`+`_meta.path` on skills). Offer accordingly — #110.
    const hit = getSlashQuery(input.value, input.selectionStart || 0);
    if (!hit) { slashPopover.hidden = true; state.slashFiltered = []; state.slashQuery = ""; return; }
    const pool = hit.atStart ? state.commands : state.commands.filter(isAdvertisedSkill);
    state.slashQuery = hit.query;
    state.slashFiltered = filterCommands(pool, hit.query);
    if (!state.slashFiltered.length) { slashPopover.hidden = true; return; }
    state.slashActive = 0;
    renderSlash();
    slashPopover.hidden = false;
  }

  function renderSlash() {
    slashPopover.innerHTML = "";
    let activeEl = null;
    const q = state.slashQuery || "";
    state.slashFiltered.forEach((cmd, i) => {
      const el = document.createElement("div");
      el.className = `slash-item${i === state.slashActive ? " active" : ""}`;
      if (i === state.slashActive) activeEl = el;
      const name = document.createElement("div");
      name.className = "slash-name";
      appendHighlightedText(name, `/${cmd.name}`, q);
      el.appendChild(name);
      if (cmd.description) {
        const d = document.createElement("div");
        d.className = "slash-desc";
        appendHighlightedText(d, cmd.description, q);
        el.appendChild(d);
      }
      el.onclick = () => pickSlash(cmd);
      slashPopover.appendChild(el);
    });
    if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
  }

  function pickSlash(cmd) {
    const next = applySlashPick(input.value, input.selectionStart || 0, cmd.name);
    input.value = next.text;
    input.selectionStart = input.selectionEnd = next.caret;
    slashPopover.hidden = true;
    input.focus();
    renderInputHighlight();
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
    modeBtn.title = modeButtonTitle(state.currentModeId);
    if (state.sessionSuperseded) {
      sendBtn.innerHTML = ICON.arrowUp;
      sendBtn.title = "This conversation is open in another tab";
      sendBtn.disabled = true;
      if (newBtn) {
        newBtn.disabled = false;
        newBtn.title = "New session";
      }
    } else if (state.onboardingMode === "no-project") {
      sendBtn.innerHTML = ICON.arrowUp;
      sendBtn.title = "Add a project folder first";
      sendBtn.disabled = true;
      if (newBtn) {
        newBtn.disabled = true;
        newBtn.title = "Add a project folder first";
      }
    } else if (!state.busy) {
      sendBtn.innerHTML = ICON.arrowUp;
      sendBtn.title = "Send";
      sendBtn.disabled = false;
      if (newBtn) {
        newBtn.disabled = false;
        newBtn.title = "New session";
      }
    } else if (state.busyLocked) {
      sendBtn.innerHTML = ICON.spinner;
      sendBtn.title = "Initializing…";
      sendBtn.classList.add("initializing");
      sendBtn.disabled = true;
    } else if (composerHasSendIntent(input.value, state.chips)) {
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

  // Queue whatever is staged for send-at-turn-end. Returns true if something was
  // queued (or refused with a reason — never a cancel). The one busy-path helper
  // both Enter and the button click funnel through, so send-intent can never
  // turn into a cancel (#37). A composer holding only an attachment is send-intent.
  function queueFromComposer() {
    if (state.sessionSuperseded) return true;
    if (state.pendingPaste > 0) return true;
    const t = input.value.trim();
    const chips = explicitVisibleChips(state.chips);
    if (!composerHasSendIntent(t, state.chips)) return false;
    // Everything or nothing: an older host would ignore extra chips and queue
    // the text alone. Refuse rather than silently drop attachments.
    if (chips.length && !(state.hostCaps && state.hostCaps.queueSendChips)) {
      addError("This host cannot queue attachments. Wait until Grok finishes, then send.");
      return true;
    }
    stopVoiceForManualSend();
    queueOutgoing(t, chips);
    input.value = "";
    renderInputHighlight(); // also flips the busy button back to Stop (empty composer)
    updateSlash();
    updateMention();
    updateSendButton();
    return true;
  }

  function syncRemoteButton() {
    if (remoteBtn) remoteBtn.hidden = IS_REMOTE || !state.remoteLinked;
  }

  // REMOTE ONLY — paint the user's message the instant they send it.
  //
  // A local webview echoes back in microseconds, so waiting for the host's
  // `userMessage` is invisible. Over a relay on a weak phone connection that
  // round trip is 1-2s, during which the composer had already cleared and the
  // message existed nowhere on screen — the send read as lost. This is a
  // PLACEHOLDER, not a second source of truth: the host's echo is still
  // authoritative and replaces it (clearOptimisticSend runs first, so the
  // real bubble carries the true chips, rewind index and counter). If the
  // relay rejects the send instead, the placeholder is removed and the
  // existing "Not sent" recovery block takes over.
  function showOptimisticSend(text, chips) {
    clearOptimisticSend();
    if (!text && !(chips && chips.length)) return;
    // addMessage returns the message BODY; the placeholder we later remove is
    // its whole bubble.
    const body = addMessage("user", text, chips || []);
    state.optimisticSendEl = body && body.closest ? body.closest(".msg") : null;
    if (state.optimisticSendEl) state.optimisticSendEl.dataset.optimistic = "1";
    forceScrollToBottom();
    showGrokking();
  }

  function clearOptimisticSend() {
    const el = state.optimisticSendEl;
    state.optimisticSendEl = null;
    if (el && el.parentNode) el.remove();
  }

  // NOTHING here retires a pending submission on the strength of a queue event,
  // and that is deliberate. `sendQueue` is SESSION-wide — every attached view
  // contributes to one collapsed string — while `pendingSubmission*` belongs to
  // this tab alone, and the queue carries no per-contribution id to correlate
  // the two. So a queue action (edit, remove, steer) or a process exit says
  // nothing about whether THIS tab's in-flight send survived, and clearing the
  // pending state on one of them would destroy the only thing a relay rejection
  // can rebuild the message from. Only the host's own `userMessage` echo, which
  // carries the submission id, retires a pending submission.

  function visibleChipIds(chips) {
    return (chips || []).filter((chip) => !chip.hidden).map((chip) => String(chip.id || ""));
  }

  function sameChipIds(chips, expectedIds) {
    const actualIds = visibleChipIds(chips);
    return actualIds.length === expectedIds.length &&
      actualIds.every((id, index) => id === expectedIds[index]);
  }

  function sendOrStop() {
    if (state.sessionSuperseded) return;
    if (state.onboardingMode === "no-project") return;
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
        input.value = queuedSendsText(state.sendQueue);
        state.sendQueue = [];
        state.queuedSubmissionPending = false;
        state.queuedSubmissionRejected = false;
        renderQueuedBlocks();
        vscode.postMessage({ type: "clearQueuedSends", restore: true });
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
    stopVoiceForManualSend();
    state.busy = true;
    updateSendButton();
    state.activeAgentEl = null;
    state.activeAgentRaw = "";
    state.activeThoughtEl = null;
    state.activeThoughtHdrEl = null;
    state.thoughtStartTime = null;
    state.activeToolGroupEl = null;
    let submissionId;
    if (IS_REMOTE) {
      const visibleChips = state.chips.filter((c) => !c.hidden);
      submissionId = newRemoteTabToken();
      state.pendingSubmissionText = text;
      state.pendingSubmissionId = submissionId;
      state.pendingSubmissionChipIds = visibleChipIds(visibleChips);
      showOptimisticSend(text, visibleChips);
    }
    // Chips are host-owned state (every mutation routes through the host and
    // comes back via postChips) — the host snapshots its own copy on send.
    vscode.postMessage({ type: "send", text, ...(submissionId ? { submissionId } : {}) });
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
    if (IS_REMOTE && (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode)) {
      micBtn.innerHTML = ICON.mic;
      micBtn.title = "Dictation is not supported by this browser";
      micBtn.disabled = true;
    } else if (IS_REMOTE && state.mic === "listening" && !remoteMic) {
      micBtn.innerHTML = ICON.micWaves;
      micBtn.title = "Dictation is active in another tab on this repository";
      micBtn.disabled = true;
    } else if (state.mic === "listening") {
      micBtn.innerHTML = ICON.micWaves;
      micBtn.title = IS_REMOTE ? "Listening — click to stop dictating" : "Listening — say 'grok send' to submit, or click to stop";
      micBtn.disabled = false;
    } else if (state.mic === "connecting") {
      micBtn.innerHTML = ICON.spinner;
      micBtn.title = "Starting mic… wait for the waves before speaking";
      micBtn.disabled = false; // clickable to cancel
    } else if (state.mic === "transcribing") {
      micBtn.innerHTML = ICON.spinner;
      micBtn.title = "Transcribing…";
      micBtn.disabled = true;
    } else if (IS_REMOTE && !state.voiceConfigured && !voiceNeedsGrokAccount()) {
      micBtn.innerHTML = ICON.mic;
      micBtn.title = "Voice dictation is unavailable because the host has no Speech-to-Text credential";
      micBtn.disabled = true;
    } else {
      micBtn.innerHTML = ICON.mic;
      micBtn.title = state.voiceConfigured
        ? "Voice control"
        : voiceNeedsGrokAccount()
          ? "Voice needs Grok connected"
          : "Voice control — click to set up (needs an xAI API key)";
      micBtn.disabled = false;
    }
    // "needs setup" dot only when idle, clickable, and no key is configured.
    micBtn.classList.toggle("needs-setup", !micBtn.disabled && state.mic === "idle" && !state.voiceConfigured);
  }

  function voiceNeedsGrokAccount() {
    return !!state.providersKnown && !state.voiceConfigured
      && !state.providers.some((provider) => provider.id === "grok" && provider.connected);
  }

  function explainVoiceNeedsGrok() {
    return uiConfirm({
      title: "Voice needs Grok",
      body: "Voice uses your Grok account for speech-to-text. Connect Grok to use it.",
      confirmLabel: "Connect Grok",
    }).then((ok) => {
      if (ok) openSettingsCategory("providers");
    });
  }

  function setMic(event) {
    state.mic = nextMicState(state.mic, event);
    renderMic();
  }

  function toggleMic() {
    if (state.sessionSuperseded) return;
    if (IS_REMOTE) {
      toggleBrowserMic();
      return;
    }
    if (state.mic === "idle") {
      if (voiceNeedsGrokAccount()) {
        void explainVoiceNeedsGrok();
        return;
      }
      // The host is the authority on whether voice is configured, but the
      // anchors must be captured before every start request it receives.
      captureVoiceInsertion();
      state.voiceLive = false;
      state.voiceDiscarded = false;
      // Skip the optimistic "listening" flash when we know no key is set — the
      // host will pop the setup guidance instead of recording. Still send
      // voiceStart so the host (the authority on the key) makes the call.
      if (state.voiceConfigured) {
        setMic("start");
      }
      vscode.postMessage({ type: "voiceStart" });
    } else if (state.mic === "listening" || state.mic === "connecting") {
      setMic("stop");
      vscode.postMessage({ type: "voiceStop" });
    }
    // "transcribing": ignore clicks until the transcript or an error arrives.
  }

  let remoteMic = null;
  let remoteMicStart = null;
  const REMOTE_MIC_PREROLL_MAX_BYTES = 16 * 16000 * 2;

  function browserMicErrorText(error) {
    const name = error && typeof error.name === "string" ? error.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      return "Microphone access was denied. Allow microphone access for this site in your browser settings, then try again.";
    }
    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      return "No microphone was found on this device.";
    }
    if (name === "NotReadableError" || name === "TrackStartError") {
      return "The microphone is unavailable. Close other apps using it, check your device settings, then try again.";
    }
    return "The browser could not start the microphone. Check its microphone permissions and try again.";
  }

  function pcmBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return btoa(binary);
  }

  function postRemotePcm(buffer) {
    if (!remoteMic) return;
    if (!remoteMic.ready) {
      if (
        !buffer ||
        typeof buffer.byteLength !== "number" ||
        remoteMic.pendingBytes + buffer.byteLength > REMOTE_MIC_PREROLL_MAX_BYTES
      ) {
        remoteMic.stopping = true;
        cleanupRemoteMic();
        setMic("error");
        addError("Speech recognition took too long to start. No audio was sent; please try dictating again.");
        vscode.postMessage({ type: "remoteVoiceStop", cancel: true });
        return;
      }
      remoteMic.pending.push(buffer);
      remoteMic.pendingBytes += buffer.byteLength;
      return;
    }
    vscode.postMessage({ type: "remoteVoiceChunk", data: pcmBase64(buffer) });
  }

  function cleanupRemoteMic() {
    const mic = remoteMic;
    remoteMic = null;
    if (!mic) return;
    clearTimeout(mic.timer);
    if (mic.flushTimer) clearTimeout(mic.flushTimer);
    try { mic.source.disconnect(); } catch {}
    try { mic.node.disconnect(); } catch {}
    try { mic.silent.disconnect(); } catch {}
    for (const track of mic.stream.getTracks()) {
      try { track.stop(); } catch {}
    }
    void mic.context.close().catch(() => {});
  }

  function discardBrowserMicSetup(stream, context) {
    if (stream) {
      for (const track of stream.getTracks()) {
        try { track.stop(); } catch {}
      }
    }
    if (context) {
      try {
        const closing = context.close();
        if (closing && typeof closing.catch === "function") void closing.catch(() => {});
      } catch {}
    }
  }

  async function startBrowserMic() {
    if (!state.voiceConfigured || remoteMic || remoteMicStart || state.mic !== "idle") return;
    const attempt = { cancelled: false };
    remoteMicStart = attempt;
    captureVoiceInsertion();
    state.voiceLive = false;
    state.voiceDiscarded = false;
    setMic("start");
    let stream;
    let context;
    let installed = false;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (attempt.cancelled) return;
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      context = new AudioContextCtor();
      if (context.state === "suspended") await context.resume();
      await context.audioWorklet.addModule(versionedSiblingUrl("pcm-worklet.js", CHAT_SCRIPT_URL));
      if (attempt.cancelled) return;
      const source = context.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(context, "grok-pcm-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      const silent = context.createGain();
      silent.gain.value = 0;
      node.port.onmessage = (event) => {
        if (event.data && event.data.type === "flushed") {
          if (remoteMic?.stopping) finishBrowserMicStop(remoteMic);
          return;
        }
        postRemotePcm(event.data);
      };
      source.connect(node);
      node.connect(silent);
      silent.connect(context.destination);
      remoteMic = {
        stream, context, source, node, silent, ready: false, pending: [], pendingBytes: 0,
        timer: setTimeout(() => stopBrowserMic(false), 120000),
      };
      for (const track of stream.getTracks()) {
        track.addEventListener?.("ended", () => stopBrowserMic(true), { once: true });
      }
      installed = true;
      vscode.postMessage({ type: "remoteVoiceStart" });
    } catch (error) {
      if (installed) cleanupRemoteMic();
      if (!attempt.cancelled) {
        addError(browserMicErrorText(error));
        setMic("error");
      }
    } finally {
      if (remoteMicStart === attempt) remoteMicStart = null;
      if (!installed) discardBrowserMicSetup(stream, context);
    }
  }

  function stopBrowserMic(cancel) {
    const mic = remoteMic;
    if (!mic || mic.stopping) return;
    mic.stopping = true;
    if (cancel) {
      cleanupRemoteMic();
      setMic("error");
      vscode.postMessage({ type: "remoteVoiceStop", cancel: true });
      return;
    }
    setMic("stop");
    mic.flushTimer = setTimeout(() => finishBrowserMicStop(mic), 500);
    try {
      mic.node.port.postMessage("flush");
    } catch {
      finishBrowserMicStop(mic);
    }
  }

  // Manual Send/Queue means "send exactly what is visible now". It cancels
  // capture and blocks in-flight voice results from repopulating the cleared
  // composer. The mic button's stop path deliberately does not use this.
  function stopVoiceForManualSend() {
    if (state.mic === "idle") return;
    state.mic = "idle";
    clearVoiceInsertion();
    state.voiceLive = false;
    state.voiceDiscarded = true;
    if (IS_REMOTE) {
      if (remoteMicStart) remoteMicStart.cancelled = true;
      if (remoteMic) stopBrowserMic(true);
      else if (remoteMicStart) remoteMicStart = null;
    } else {
      vscode.postMessage({ type: "voiceStop", discard: true });
    }
    renderMic();
  }

  function finishBrowserMicStop(mic) {
    if (remoteMic !== mic) return;
    if (mic.flushTimer) clearTimeout(mic.flushTimer);
    cleanupRemoteMic();
    vscode.postMessage({ type: "remoteVoiceStop" });
  }

  function toggleBrowserMic() {
    if (remoteMic && (state.mic === "listening" || state.mic === "connecting")) {
      stopBrowserMic(false);
    } else if (remoteMicStart && state.mic === "connecting") {
      remoteMicStart.cancelled = true;
      setMic("error");
    } else if (state.mic === "idle") {
      if (voiceNeedsGrokAccount()) {
        void explainVoiceNeedsGrok();
        return;
      }
      void startBrowserMic();
    }
  }

  function teardownBrowserMic() {
    if (!IS_REMOTE || !remoteMic) return;
    remoteMic.stopping = true;
    cleanupRemoteMic();
    vscode.postMessage({ type: "remoteVoiceStop", cancel: true });
  }

  window.addEventListener("pagehide", teardownBrowserMic);
  window.addEventListener("beforeunload", teardownBrowserMic);

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

  function captureVoiceInsertion() {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    state.voiceBefore = input.value.slice(0, start);
    state.voiceAfter = input.value.slice(end);
    state.voiceInsertionActive = true;
  }

  function clearVoiceInsertion() {
    const wasActive = state.voiceInsertionActive;
    state.voiceBefore = "";
    state.voiceAfter = "";
    state.voiceInsertionActive = false;
    // Repaint: dictation is over, so the words stop being provisional and lose
    // their tint. Callers finalise by rendering FIRST and clearing after, so
    // without this the mark survives until the next keystroke.
    if (wasActive && inputHighlight) renderInputHighlight();
  }

  // Insert between the text surrounding the selection captured at start. The
  // caret stays just after the dictated text, before the preserved suffix.
  function composeVoiceInsertion(before, text, after) {
    const t = text || "";
    if (!t) return { value: before + after, caret: before.length };
    const left = before && !/\s$/.test(before) && !/^\s/.test(t) ? " " : "";
    const right = after && !/\s$/.test(t) && !/^\s/.test(after) &&
      !/^[.,!?;:)\]}]/.test(after) ? " " : "";
    return {
      value: before + left + t + right + after,
      caret: before.length + left.length + t.length,
    };
  }

  function renderVoiceInsertion(text, focus = false) {
    if (!state.voiceInsertionActive) captureVoiceInsertion();
    const result = composeVoiceInsertion(state.voiceBefore, text, state.voiceAfter);
    input.value = result.value;
    input.setSelectionRange(result.caret, result.caret);
    if (focus) input.focus();
    updateSlash();
    updateMention();
    renderInputHighlight();
  }

  // Mirror the composer text onto the backdrop, wrapping a trailing send command
  // ("grok send") in an accent pill. Call whenever the input value changes.
  // Auto-grow the composer with its content: 2 lines at rest (Cursor-style,
  // matching the textarea's rows attribute), expanding to composerMaxLines()
  // as the user types, then scrolling. The .input-highlight overlay is inset:0
  // in the same wrap, so it tracks the height for free; its scrollTop is synced
  // in renderInputHighlight.
  //
  // More than the original 5 (#144): a longer answer could not be read back
  // while writing it. A drag handle was considered and rejected — a maximum you
  // have to re-drag every time you want the history back is worse than one that
  // is simply large enough. See composerMaxLines for why a phone gets fewer.
  function autosizeInput() {
    const cs = window.getComputedStyle(input);
    const line = parseFloat(cs.lineHeight) || 20;
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const min = Math.round(line * 2 + pad);
    const max = Math.round(line * composerMaxLines() + pad);
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

    // Two things get marked, and they are not the same kind of thing. The words
    // being dictated are PROVISIONAL — each partial replaces them — so they take
    // a tint that says "this part is still moving". A trailing send phrase is a
    // COMMAND about to fire, so it takes solid fill: louder than the text beside
    // it, because acting on it is irreversible.
    const range = trailingSendPhrase(text, state.voiceSendPhrase);
    const cmdStart = range ? range.index : text.length;
    // The dictated span lies between the anchors captured at mic start. Clamped,
    // because the composer stays editable while dictation runs.
    const liveStart = state.voiceInsertionActive
      ? Math.min(state.voiceBefore.length, text.length)
      : text.length;
    const liveEnd = state.voiceInsertionActive
      ? Math.max(liveStart, text.length - state.voiceAfter.length)
      : text.length;
    // The command wins where they overlap: it always sits at the tail, and the
    // dictation that produced it must not out-shout it.
    const liveEndVisible = Math.min(liveEnd, cmdStart);

    if (!range && liveStart >= liveEnd) {
      inputHighlight.textContent = "";
    } else {
      const span = (cls, s) => (s ? '<span class="' + cls + '">' + escapeHtml(s) + "</span>" : "");
      inputHighlight.innerHTML =
        escapeHtml(text.slice(0, liveStart)) +
        span("voice-token", text.slice(liveStart, liveEndVisible)) +
        escapeHtml(text.slice(Math.max(liveStart, liveEndVisible), cmdStart)) +
        span("cmd-token", range ? text.slice(range.index, range.index + range.length) : "") +
        escapeHtml(range ? text.slice(range.index + range.length) : "");
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
    let submissionId;
    if (IS_REMOTE) {
      submissionId = newRemoteTabToken();
      state.pendingSubmissionText = t;
      state.pendingSubmissionId = submissionId;
      state.pendingSubmissionChipIds = [];
      showOptimisticSend(t, []);
    }
    vscode.postMessage({ type: "send", text: t, ...(submissionId ? { submissionId } : {}) });
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
  // Attachments ride `_x.ai/interject` `content` (same encoder as a send).
  function queueOutgoing(text, chips) {
    if (state.sessionSuperseded) return;
    const attachments = Array.isArray(chips) ? chips : explicitVisibleChips(state.chips);
    if (
      state.steerByDefault && state.steerSupported && steerableProvider() && state.busy && !state.busyLocked
    ) {
      const msg = { type: "steerSend", text };
      if (attachments.length) msg.chips = attachments;
      vscode.postMessage(msg);
      return;
    }
    const msg = { type: "queueSend", text };
    if (state.hostCaps && state.hostCaps.queueSendChips) msg.chips = attachments;
    vscode.postMessage(msg);
  }

  // THE pending user block (the host keeps at most one queued message —
  // composing more appends to it), pinned to the end of the conversation.
  // Italic + dashed border + clock tag reads "not sent yet"; Edit pulls the
  // whole pending text back to the composer, Remove drops it.
  /** Does the host's queue hold `text` as a WHOLE contribution?
   *
   *  Exact equality only, and deliberately so. The host joins contributions with
   *  a blank line and a message may itself contain blank lines, so the joined
   *  string genuinely cannot say where one contribution ends — queued
   *  "prefix\n\nfix\n\nup" is indistinguishable from a queue holding "fix" as its
   *  own entry. Only an item that IS the text is unambiguous. Deciding otherwise
   *  needs per-contribution ids the queue does not carry (see divertRacingSend in
   *  the host, which explains why it cannot).
   *
   *  So this answers "yes" for the case that actually produced the duplicate — a
   *  send diverted into an empty queue — and "no" once another view has already
   *  queued something. A "no" leaves a stale placeholder beside the queued block
   *  until the next refresh, which is cosmetic; a wrong "yes" would retire a
   *  submission that is still in flight, which is not. */
  function queueHoldsContribution(entries, text) {
    if (!text) return false;
    for (var i = 0; i < entries.length; i++) {
      const entryText = typeof entries[i] === "string" ? entries[i] : (entries[i] && entries[i].text) || "";
      if (entryText === text) return true;
    }
    return false;
  }

  function renderQueuedBlocks() {
    let wrap = state.queuedWrapEl;
    // One visual block: the flush is still one combined prompt. Text is joined
    // the way it will send; chips from every contribution are shown on it.
    const rejected = !!state.rejectedSubmissionText;
    const text = rejected ? state.rejectedSubmissionText : queuedSendsText(state.sendQueue);
    const chips = rejected ? [] : queuedSendsChips(state.sendQueue);
    if (!text && !chips.length) {
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
    tag.innerHTML = `${ICON.clock}<span>${state.queuedSubmissionRejected || rejected ? "Not sent" : "Queued"}</span>`;
    tag.title = state.queuedSubmissionRejected || rejected
      ? "The relay rejected this prompt. Edit it to retry, or remove it."
      : "Sends when Grok finishes";
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
      if (rejected) {
        state.rejectedSubmissionText = "";
        renderQueuedBlocks();
      } else {
        vscode.postMessage({ type: "clearQueuedSends", restore: true });
      }
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
      if (rejected) {
        state.rejectedSubmissionText = "";
        renderQueuedBlocks();
      } else {
        vscode.postMessage({ type: "clearQueuedSends" });
      }
    };
    // Steer (#52): send this into the RUNNING turn instead of waiting for it.
    // Rendered whenever the CLI supports it; `body.turn-busy` (updateSendButton)
    // does the show/hide, so a replay that delivers queuedSends before agentStart
    // still ends up with the button once busy lands.
    // Not for Claude Code: it has no mid-turn interject, so the button would
    // offer to do something the agent cannot do. Its messages stay scheduled.
    // Attachments ride `_x.ai/interject` `content` — the host encodes them the
    // same way as a send. An older CLI that ignores `content` gets the whole
    // item queued rather than a silent drop.
    if (state.steerSupported && steerableProvider()) {
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
        if (state.sessionSuperseded) return;
        // steerSend first so the host can snapshot the queue before this
        // clear races (webview handlers are not serialized across awaits).
        const msg = { type: "steerSend", text, fromQueue: true };
        if (chips.length) msg.chips = chips;
        vscode.postMessage(msg);
        vscode.postMessage({ type: "clearQueuedSends" });
      };
      actions.appendChild(steerBtn);
    }
    actions.appendChild(editBtn);
    actions.appendChild(rmBtn);
    hdr.appendChild(tag);
    hdr.appendChild(actions);
    // Same order as a sent user bubble (`addMessage`): header, then text, then
    // chips. The pending block is a preview of that bubble, not of the composer.
    bubble.appendChild(hdr);
    if (text) {
      const body = document.createElement("div");
      body.className = "queued-text";
      body.textContent = text;
      body.title = text; // body is line-clamped; full text on hover
      bubble.appendChild(body);
    }
    if (chips.length) {
      const chipsRow = document.createElement("div");
      chipsRow.className = "msg-chips";
      for (const chip of chips) chipsRow.appendChild(makeMsgChipTag(chip.relPath, chip));
      bubble.appendChild(chipsRow);
    }
    msg.appendChild(bubble);
    wrap.appendChild(msg);
    appendTranscriptChild(wrap); // (re)pin to the end of the conversation
    scrollToBottom();
  }

  // ---------- find in conversation (#99) ----------
  // One in-webview find serves VS Code, desktop, and the browser client.
  // VS Code's enableFindWidget is a createWebviewPanel API and does not exist
  // on WebviewView; even if it did it would do nothing for desktop or AFK Pilot.
  //
  // Paint uses CSS.highlights + Range. Wrapping matches in <mark> would force
  // a full re-layout of a multi-megabyte transcript and detach the click
  // handlers tool rows, diffs, and images depend on.
  //
  // Collapsed tool / command / subagent rows stay in the DOM (`hidden` / class),
  // so a TreeWalker reaches them. A match inside one expands that row. Content
  // hidden by a standing preference (`body.thinking-hidden` — "Show thinking
  // traces" off, or Knowledge work forcing that off) is counted but kept out
  // of next/prev until the user clicks the hint. Expanding a collapsed row is
  // fine; silently flipping a preference is not.
  //
  // Navigation scrolls the match without calling forceScrollToBottom or
  // noteUserScrollIntent. Programmatic scroll then cannot re-arm stick-to-bottom,
  // so a live turn arriving while find is open cannot yank the view off the hit.

  const FIND_DEBOUNCE_MS = 80;
  const FIND_SLICE_MS = 8;
  const FIND_QUERY_MAX = 200;
  const FIND_MAX_MATCHES = 10000;
  const FIND_HL = "grok-find";
  const FIND_HL_CUR = "grok-find-current";

  const find = {
    open: false,
    bar: null,
    input: null,
    countEl: null,
    hiddenBtn: null,
    caseBtn: null,
    regexBtn: null,
    prevBtn: null,
    nextBtn: null,
    query: "",
    caseSensitive: false,
    regex: false,
    includeHidden: false,
    invalid: false,
    matches: [],
    nav: [],
    hiddenCount: 0,
    index: -1,
    timer: 0,
    sliceTimer: 0,
    gen: 0,
    lastFocus: null,
    memoryBySession: new Map(),
    lastHaystackKey: "",
    lastNodes: null,
    lastQuery: "",
    lastFlags: "",
    lastComplete: false,
    lastCapped: false,
  };

  function findHasHighlightApi() {
    return !!(typeof CSS !== "undefined" && CSS.highlights && typeof Highlight === "function");
  }

  function findSessionKey() {
    return state.activeSessionId || "";
  }

  function rememberFindQuery() {
    find.memoryBySession.set(findSessionKey(), {
      query: find.query,
      caseSensitive: find.caseSensitive,
      regex: find.regex,
    });
  }

  function recalledFindQuery() {
    return find.memoryBySession.get(findSessionKey()) || null;
  }

  function transcriptSelectionText() {
    const sel = typeof window.getSelection === "function" ? window.getSelection() : null;
    if (!sel || sel.isCollapsed || !sel.anchorNode) return "";
    if (!messagesEl.contains(sel.anchorNode)) return "";
    const text = String(sel.toString() || "").replace(/\s+/g, " ").trim();
    if (!text || text.length > FIND_QUERY_MAX) return "";
    return text;
  }

  function isMacPlatform() {
    const plat = typeof navigator !== "undefined" ? (navigator.platform || "") : "";
    if (/Mac|iPhone|iPad|iPod/.test(plat)) return true;
    const ua = typeof navigator !== "undefined" ? (navigator.userAgent || "") : "";
    return /Mac OS X/.test(ua);
  }

  function isFindHotkey(e) {
    // Remote: the browser owns Ctrl/Cmd+F (and the primary device is a phone).
    if (IS_REMOTE) return false;
    if (e.altKey || e.shiftKey) return false;
    if (String(e.key).toLowerCase() !== "f") return false;
    // Cmd+F is find on every desk. Ctrl+F is find except on Mac, where it is
    // grok.composerForward (package.json, composer-focused). Do not steal it.
    if (e.metaKey && !e.ctrlKey) return true;
    if (e.ctrlKey && !e.metaKey) return !isMacPlatform();
    return false;
  }

  /**
   * Payload bodies find deliberately does NOT search (owner, 2026-08-19).
   * `.tool-item-details` is the one container every expandable payload renders
   * into — tool IN/OUT, command IN/OUT, MCP IN/OUT, and the file-edit diffs
   * (`.tool-item-details.tool-item-diff`, whose content is `.tool-diff-region`).
   *
   * The issue asked for the opposite ("including text inside collapsed tool and
   * command rows"), and that is what shipped first. In use it made results
   * chaotic: a search for an ordinary word matched dozens of times inside
   * command output and diff hunks, burying the prose hits, and a diff match is
   * not much use anyway because the full diff is not on screen. Row LABELS stay
   * searchable, so "find the command I ran" and "find that file path" still
   * work — it is only the payload bodies that drop out.
   */
  const FIND_SKIP_SEL = ".tool-item-details, .tool-diff-region";

  function findCollectNodes() {
    const nodes = [];
    const root = messagesEl;
    if (!root) return nodes;
    const SHOW_TEXT = (typeof NodeFilter !== "undefined" && NodeFilter.SHOW_TEXT) || 4;
    const REJECT = (typeof NodeFilter !== "undefined" && NodeFilter.FILTER_REJECT) || 2;
    const ACCEPT = (typeof NodeFilter !== "undefined" && NodeFilter.FILTER_ACCEPT) || 1;
    if (typeof document.createTreeWalker === "function") {
      const walker = document.createTreeWalker(root, SHOW_TEXT, {
        acceptNode(node) {
          if (!node || !node.data) return REJECT;
          const parent = node.parentElement;
          if (!parent) return REJECT;
          const tag = parent.tagName;
          if (tag === "SCRIPT" || tag === "STYLE") return REJECT;
          if (parent.closest("#welcome, .welcome")) return REJECT;
          if (parent.closest("[" + PENDING_CLEAR_ATTR + "]")) return REJECT;
          if (parent.closest(FIND_SKIP_SEL)) return REJECT;
          return ACCEPT;
        },
      });
      let n = walker.nextNode();
      while (n) {
        nodes.push(n);
        n = walker.nextNode();
      }
      return nodes;
    }
    const stack = [root];
    while (stack.length) {
      const el = stack.pop();
      if (!el) continue;
      if (el.nodeType === 3) {
        if (el.data) nodes.push(el);
        continue;
      }
      if (el.nodeType !== 1) continue;
      const tag = el.tagName;
      if (tag === "SCRIPT" || tag === "STYLE") continue;
      if (el.id === "welcome" || el.classList.contains("welcome")) continue;
      if (el.getAttribute && el.getAttribute(PENDING_CLEAR_ATTR) === "1") continue;
      if (typeof el.matches === "function" && el.matches(FIND_SKIP_SEL)) continue;
      for (let i = el.childNodes.length - 1; i >= 0; i--) stack.push(el.childNodes[i]);
    }
    return nodes;
  }

  function findMatchIsHidden(node) {
    // Preference-hidden, not collapsed. Collapsed tool rows stay in the
    // navigation set; thinking traces with body.thinking-hidden do not.
    if (!document.body.classList.contains("thinking-hidden")) return false;
    const el = node.nodeType === 3 ? node.parentElement : node;
    return !!(el && el.closest(".msg.thinking"));
  }

  function compileFindRegex(source, caseSensitive) {
    if (source.length > FIND_QUERY_MAX) return { error: "long" };
    // Nested quantifiers are the usual catastrophic-backtracking shape.
    // Treat as no-match rather than hanging the UI on a 5 MB haystack.
    if (/\([^()]*[+*][^()]*\)[+*{]/.test(source)) return { error: "unsafe" };
    try {
      // `m` so ^ / $ mean line (the issue's `^_+build$` example), not the
      // whole concatenated transcript.
      return { re: new RegExp(source, caseSensitive ? "gm" : "gim") };
    } catch {
      return { error: "invalid" };
    }
  }

  function searchNodeLiteral(node, query, caseSensitive, into) {
    const raw = node.data;
    const text = caseSensitive ? raw : raw.toLowerCase();
    const q = caseSensitive ? query : query.toLowerCase();
    if (!q) return;
    let i = 0;
    while (i <= text.length - q.length) {
      const found = text.indexOf(q, i);
      if (found < 0) break;
      into.push({ node, start: found, end: found + q.length });
      if (into.length >= FIND_MAX_MATCHES) return;
      i = found + q.length;
    }
  }

  function searchNodeRegex(node, re, into) {
    const text = node.data;
    re.lastIndex = 0;
    let m = re.exec(text);
    while (m) {
      if (!m[0]) {
        re.lastIndex += 1;
        if (re.lastIndex > text.length) break;
        m = re.exec(text);
        continue;
      }
      into.push({ node, start: m.index, end: m.index + m[0].length });
      if (into.length >= FIND_MAX_MATCHES) return;
      m = re.exec(text);
    }
  }

  function canNarrowFind(nodes, query) {
    if (find.regex || !find.lastComplete || find.invalid) return false;
    if (!find.lastQuery || !query.startsWith(find.lastQuery)) return false;
    if (find.lastFlags !== findFlagsKey()) return false;
    if (find.lastNodes !== nodes) return false;
    return true;
  }

  function findFlagsKey() {
    return (find.caseSensitive ? "c" : "") + (find.regex ? "r" : "") + (find.includeHidden ? "h" : "");
  }

  function rangeForFindMatch(m) {
    if (!m || !m.node || !m.node.parentNode) return null;
    try {
      const r = document.createRange();
      const len = m.node.data ? m.node.data.length : 0;
      r.setStart(m.node, Math.max(0, Math.min(m.start, len)));
      r.setEnd(m.node, Math.max(0, Math.min(m.end, len)));
      return r;
    } catch {
      return null;
    }
  }

  function clearFindHighlights() {
    if (findHasHighlightApi()) {
      try {
        CSS.highlights.delete(FIND_HL);
        CSS.highlights.delete(FIND_HL_CUR);
      } catch { /* ignore */ }
    }
    for (const el of messagesEl.querySelectorAll(".msg.thinking.find-reveal")) {
      el.classList.remove("find-reveal");
    }
  }

  function paintFindHighlights() {
    clearFindHighlights();
    if (!find.open || !find.nav.length) return;
    if (!findHasHighlightApi()) return;
    const others = new Highlight();
    const current = new Highlight();
    for (let i = 0; i < find.nav.length; i++) {
      const range = rangeForFindMatch(find.nav[i]);
      if (!range) continue;
      if (i === find.index) current.add(range);
      else others.add(range);
    }
    try {
      CSS.highlights.set(FIND_HL, others);
      CSS.highlights.set(FIND_HL_CUR, current);
    } catch { /* older Highlight impl */ }
  }

  function updateFindChrome() {
    if (!find.bar) return;
    const q = find.query;
    const n = find.nav.length;
    const hidden = find.hiddenCount;
    if (find.input) {
      find.input.classList.toggle("find-input-invalid", !!find.invalid);
      find.input.setAttribute("aria-invalid", find.invalid ? "true" : "false");
    }
    if (find.countEl) {
      if (!q) find.countEl.textContent = "";
      else if (find.invalid) find.countEl.textContent = "—";
      else if (!n) find.countEl.textContent = find.lastCapped ? "0/" + FIND_MAX_MATCHES + "+" : "0/0";
      else {
        const cap = find.lastCapped ? "+" : "";
        find.countEl.textContent = (find.index + 1) + "/" + n + cap;
      }
    }
    if (find.hiddenBtn) {
      if (!q || find.invalid || hidden <= 0) {
        find.hiddenBtn.hidden = true;
      } else {
        find.hiddenBtn.hidden = false;
        find.hiddenBtn.setAttribute("aria-pressed", find.includeHidden ? "true" : "false");
        find.hiddenBtn.textContent = find.includeHidden
          ? "Including " + hidden + " in hidden thinking traces"
          : hidden + " in hidden thinking traces";
        find.hiddenBtn.title = find.includeHidden
          ? "Stop navigating matches inside hidden thinking traces"
          : "Include matches inside hidden thinking traces";
      }
    }
    if (find.caseBtn) find.caseBtn.setAttribute("aria-pressed", find.caseSensitive ? "true" : "false");
    if (find.regexBtn) find.regexBtn.setAttribute("aria-pressed", find.regex ? "true" : "false");
    const dead = !n;
    if (find.prevBtn) find.prevBtn.disabled = dead;
    if (find.nextBtn) find.nextBtn.disabled = dead;
  }

  function rebuildFindNav() {
    const nav = [];
    let hidden = 0;
    for (const m of find.matches) {
      const isHidden = findMatchIsHidden(m.node);
      if (isHidden) hidden += 1;
      if (!isHidden || find.includeHidden) nav.push(m);
    }
    find.nav = nav;
    find.hiddenCount = hidden;
    if (!nav.length) find.index = -1;
    else if (find.index < 0 || find.index >= nav.length) find.index = 0;
  }

  function revealFindMatch(m) {
    if (!m || !m.node) return;
    const el = m.node.parentElement;
    if (!el) return;
    const thinking = el.closest(".msg.thinking");
    if (thinking) {
      thinking.classList.add("find-reveal");
      const body = thinking.querySelector(".thinking-body");
      if (body && body.hidden) {
        body.hidden = false;
        thinking.classList.add("expanded");
      }
    }
    const group = el.closest(".tool-group");
    if (group) setGroupExpanded(group, true);
    const details = el.closest(".tool-item-details");
    if (details) {
      const row = details.closest(".has-details");
      if (row) setDetailExpanded(row, true);
    }
    const sub = el.closest(".subagent-card");
    if (sub) {
      const stream = sub.querySelector(".subagent-stream");
      const result = sub.querySelector(".subagent-result");
      if (stream && stream.contains(el)) stream.hidden = false;
      if (result && result.contains(el)) result.hidden = false;
    }
  }

  function scrollToFindMatch(m) {
    // Unpin first. A programmatic scrollTop fires `scroll`, but that handler
    // only recomputes stick after a user gesture (wheel/touch/keys). If stick
    // stayed true, the content MutationObserver / ResizeObserver would yank
    // back to the bottom the moment we expand a tool row or a chunk arrives.
    setStickToBottom(false);
    updateScrollBtn();
    const range = rangeForFindMatch(m);
    // Centre the MATCH, not the element containing it. scrollIntoView centres
    // the BLOCK, and a message body wraps to well over a screen on a phone —
    // measured at 1017px inside a 727px viewport. Centring that block puts the
    // phrase off the TOP when it sits near the block's start and off the BOTTOM
    // when it sits near the end, so stepping next/prev showed some hits and
    // scrolled past others. Both directions reproduced under Pixel-5 emulation.
    const scroller = messagesEl;
    const rect = range && typeof range.getBoundingClientRect === "function"
      ? range.getBoundingClientRect()
      : null;
    if (scroller && rect && (rect.height > 0 || rect.width > 0)
        && typeof scroller.getBoundingClientRect === "function") {
      const box = scroller.getBoundingClientRect();
      const centred = (scroller.clientHeight - rect.height) / 2;
      const delta = (rect.top - box.top) - centred;
      if (delta) scroller.scrollTop += delta;
      return;
    }
    // No usable Range geometry (jsdom, or a detached node): the block is still
    // a better answer than nothing.
    const target = (range && range.startContainer && range.startContainer.parentElement) || m.node.parentElement;
    if (!target || typeof target.scrollIntoView !== "function") return;
    try {
      target.scrollIntoView({ block: "center", inline: "nearest" });
    } catch {
      try { target.scrollIntoView(true); } catch { /* ignore */ }
    }
  }

  function goToFindMatch(index, opts) {
    if (!find.nav.length) {
      find.index = -1;
      paintFindHighlights();
      updateFindChrome();
      return;
    }
    const n = find.nav.length;
    find.index = ((index % n) + n) % n;
    const m = find.nav[find.index];
    revealFindMatch(m);
    if (!opts || opts.scroll !== false) {
      // Unpin synchronously. The actual scroll waits a frame so a just-expanded
      // [hidden] row can layout; if stick stayed true until then, the content
      // MutationObserver would yank back to the bottom first.
      setStickToBottom(false);
      updateScrollBtn();
      requestAnimationFrame(() => scrollToFindMatch(m));
    }
    paintFindHighlights();
    updateFindChrome();
  }

  function findStep(dir) {
    if (!find.nav.length) return;
    goToFindMatch(find.index < 0 ? 0 : find.index + dir);
  }

  function finishFindSearch(matches, invalid, capped) {
    find.matches = matches;
    find.invalid = !!invalid;
    find.lastCapped = !!capped;
    find.lastComplete = !invalid;
    find.lastQuery = find.query;
    find.lastFlags = findFlagsKey();
    rebuildFindNav();
    if (find.nav.length) {
      if (find.index < 0) find.index = 0;
      goToFindMatch(find.index, { scroll: false });
    } else {
      find.index = -1;
      paintFindHighlights();
      updateFindChrome();
    }
  }

  function cancelFindSearch() {
    if (find.timer) {
      clearTimeout(find.timer);
      find.timer = 0;
    }
    if (find.sliceTimer) {
      clearTimeout(find.sliceTimer);
      find.sliceTimer = 0;
    }
    find.gen += 1;
  }

  function runFindSearchNow() {
    cancelFindSearch();
    const query = find.query;
    if (!find.open) return;
    if (!query) {
      find.matches = [];
      find.nav = [];
      find.hiddenCount = 0;
      find.invalid = false;
      find.lastComplete = false;
      find.lastCapped = false;
      find.index = -1;
      clearFindHighlights();
      updateFindChrome();
      return;
    }
    if (state.historyPrefix && state.historyPrefix.length) expandHistoryAll();
    const nodes = findCollectNodes();
    find.lastNodes = nodes;
    if (canNarrowFind(nodes, query)) {
      const next = [];
      const q = find.caseSensitive ? query : query.toLowerCase();
      for (const m of find.matches) {
        if (!m.node || !m.node.parentNode) continue;
        const slice = m.node.data.slice(m.start, m.start + q.length);
        const have = find.caseSensitive ? slice : slice.toLowerCase();
        if (have === q) next.push({ node: m.node, start: m.start, end: m.start + q.length });
      }
      finishFindSearch(next, false, false);
      return;
    }
    if (find.regex) {
      const compiled = compileFindRegex(query, find.caseSensitive);
      if (compiled.error) {
        finishFindSearch([], true, false);
        return;
      }
      const gen = find.gen;
      const acc = [];
      let i = 0;
      const step = () => {
        if (gen !== find.gen) return;
        const t0 = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
        while (i < nodes.length && acc.length < FIND_MAX_MATCHES) {
          searchNodeRegex(nodes[i], compiled.re, acc);
          i += 1;
          const now = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
          if (now - t0 > FIND_SLICE_MS) break;
        }
        if (i < nodes.length && acc.length < FIND_MAX_MATCHES) {
          find.matches = acc;
          find.invalid = false;
          rebuildFindNav();
          if (find.countEl) find.countEl.textContent = find.nav.length + "…";
          find.sliceTimer = setTimeout(step, 0);
          return;
        }
        finishFindSearch(acc, false, acc.length >= FIND_MAX_MATCHES);
      };
      step();
      return;
    }
    const gen = find.gen;
    const acc = [];
    let i = 0;
    const step = () => {
      if (gen !== find.gen) return;
      const t0 = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
      while (i < nodes.length && acc.length < FIND_MAX_MATCHES) {
        searchNodeLiteral(nodes[i], query, find.caseSensitive, acc);
        i += 1;
        const now = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
        if (now - t0 > FIND_SLICE_MS) break;
      }
      if (i < nodes.length && acc.length < FIND_MAX_MATCHES) {
        find.matches = acc;
        find.invalid = false;
        rebuildFindNav();
        if (find.countEl) find.countEl.textContent = find.nav.length + "…";
        find.sliceTimer = setTimeout(step, 0);
        return;
      }
      finishFindSearch(acc, false, acc.length >= FIND_MAX_MATCHES);
    };
    step();
  }

  function scheduleFindSearch() {
    cancelFindSearch();
    find.timer = setTimeout(runFindSearchNow, FIND_DEBOUNCE_MS);
  }

  function setFindQuery(value, opts) {
    const next = String(value || "").slice(0, FIND_QUERY_MAX);
    find.query = next;
    if (find.input && find.input.value !== next) find.input.value = next;
    rememberFindQuery();
    if (opts && opts.immediate) runFindSearchNow();
    else scheduleFindSearch();
  }

  function ensureFindBar() {
    if (find.bar) return find.bar;
    const bar = document.createElement("div");
    bar.id = "find-bar";
    bar.className = "find-bar";
    bar.hidden = true;
    bar.setAttribute("role", "search");
    bar.setAttribute("aria-label", "Find in this conversation");

    const row = document.createElement("div");
    row.className = "find-bar-row";
    const icon = document.createElement("span");
    icon.className = "find-bar-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = ICON.search;
    const field = document.createElement("input");
    field.id = "find-input";
    field.type = "search";
    field.placeholder = "Find in this conversation";
    field.autocomplete = "off";
    field.spellcheck = false;
    field.setAttribute("enterkeyhint", "search");
    const count = document.createElement("span");
    count.className = "find-count";
    count.setAttribute("aria-live", "polite");
    const prev = document.createElement("button");
    prev.type = "button";
    prev.className = "icon-btn";
    prev.title = "Previous match";
    prev.setAttribute("aria-label", "Previous match");
    prev.innerHTML = ICON.chevronUp;
    const next = document.createElement("button");
    next.type = "button";
    next.className = "icon-btn";
    next.title = "Next match";
    next.setAttribute("aria-label", "Next match");
    next.innerHTML = ICON.chevronDown;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "icon-btn";
    close.title = "Close find";
    close.setAttribute("aria-label", "Close find");
    close.innerHTML = ICON.x;
    row.appendChild(icon);
    row.appendChild(field);
    row.appendChild(count);
    row.appendChild(prev);
    row.appendChild(next);
    row.appendChild(close);

    const opts = document.createElement("div");
    opts.className = "find-bar-row";
    const caseBtn = document.createElement("button");
    caseBtn.type = "button";
    caseBtn.className = "find-toggle";
    caseBtn.textContent = "Aa";
    caseBtn.title = "Match case";
    caseBtn.setAttribute("aria-label", "Match case");
    caseBtn.setAttribute("aria-pressed", "false");
    const regexBtn = document.createElement("button");
    regexBtn.type = "button";
    regexBtn.className = "find-toggle";
    regexBtn.textContent = ".*";
    regexBtn.title = "Use regular expression";
    regexBtn.setAttribute("aria-label", "Use regular expression");
    regexBtn.setAttribute("aria-pressed", "false");
    const hiddenBtn = document.createElement("button");
    hiddenBtn.type = "button";
    hiddenBtn.className = "find-hidden-hint";
    hiddenBtn.hidden = true;
    hiddenBtn.setAttribute("aria-pressed", "false");
    opts.appendChild(caseBtn);
    opts.appendChild(regexBtn);
    opts.appendChild(hiddenBtn);

    bar.appendChild(row);
    bar.appendChild(opts);
    const parent = messagesEl.parentNode;
    if (parent) parent.insertBefore(bar, messagesEl);
    else document.body.insertBefore(bar, document.body.firstChild);

    field.addEventListener("input", () => setFindQuery(field.value));
    field.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        findStep(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeFind();
      }
    });
    prev.addEventListener("click", () => findStep(-1));
    next.addEventListener("click", () => findStep(1));
    close.addEventListener("click", () => closeFind());
    caseBtn.addEventListener("click", () => {
      find.caseSensitive = !find.caseSensitive;
      find.lastComplete = false;
      rememberFindQuery();
      runFindSearchNow();
    });
    regexBtn.addEventListener("click", () => {
      find.regex = !find.regex;
      find.lastComplete = false;
      rememberFindQuery();
      runFindSearchNow();
    });
    hiddenBtn.addEventListener("click", () => {
      find.includeHidden = !find.includeHidden;
      rebuildFindNav();
      if (find.nav.length && find.index < 0) find.index = 0;
      if (find.includeHidden && find.hiddenCount && find.nav.length) {
        const firstHidden = find.nav.findIndex((m) => findMatchIsHidden(m.node));
        if (firstHidden >= 0) goToFindMatch(firstHidden);
        else {
          paintFindHighlights();
          updateFindChrome();
        }
      } else {
        paintFindHighlights();
        updateFindChrome();
      }
    });

    find.bar = bar;
    find.input = field;
    find.countEl = count;
    find.hiddenBtn = hiddenBtn;
    find.caseBtn = caseBtn;
    find.regexBtn = regexBtn;
    find.prevBtn = prev;
    find.nextBtn = next;
    return bar;
  }

  function onFindDocKey(e) {
    if (!find.open) return;
    if (isFindHotkey(e)) {
      e.preventDefault();
      e.stopPropagation();
      openFind();
      return;
    }
    if (e.key !== "Escape") return;
    if (e.target && e.target.closest && e.target.closest(".toolbar-popover, .confirm-overlay, .rail-menu, #gear-popover")) return;
    e.preventDefault();
    closeFind();
  }

  function openFind() {
    ensureFindBar();
    const wasOpen = find.open;
    if (!wasOpen) {
      find.lastFocus = document.activeElement;
      find.bar.hidden = false;
      find.open = true;
      document.addEventListener("keydown", onFindDocKey, true);
    }
    const selected = transcriptSelectionText();
    const recalled = recalledFindQuery();
    if (selected) {
      find.caseSensitive = !!(recalled && recalled.caseSensitive);
      find.regex = !!(recalled && recalled.regex);
      setFindQuery(selected, { immediate: true });
    } else if (!wasOpen && recalled) {
      find.caseSensitive = !!recalled.caseSensitive;
      find.regex = !!recalled.regex;
      setFindQuery(recalled.query || "", { immediate: true });
    } else if (!wasOpen) {
      updateFindChrome();
    }
    find.input.focus({ preventScroll: true });
    try { find.input.select(); } catch { /* ignore */ }
  }

  function closeFind() {
    if (!find.open) return;
    rememberFindQuery();
    cancelFindSearch();
    find.open = false;
    if (find.bar) find.bar.hidden = true;
    clearFindHighlights();
    document.removeEventListener("keydown", onFindDocKey, true);
    const back = find.lastFocus;
    find.lastFocus = null;
    if (back && back !== find.input && typeof back.focus === "function" && document.contains(back)) {
      try { back.focus({ preventScroll: true }); } catch { try { back.focus(); } catch { /* ignore */ } }
    } else {
      input.focus({ preventScroll: true });
    }
  }

  function onFindSessionReset() {
    cancelFindSearch();
    find.matches = [];
    find.nav = [];
    find.hiddenCount = 0;
    find.index = -1;
    find.lastComplete = false;
    find.lastNodes = null;
    find.includeHidden = false;
    clearFindHighlights();
    if (find.open) {
      const recalled = recalledFindQuery();
      if (recalled) {
        find.caseSensitive = !!recalled.caseSensitive;
        find.regex = !!recalled.regex;
        if (find.input) find.input.value = recalled.query || "";
        find.query = recalled.query || "";
      }
      updateFindChrome();
    }
  }

  function onFindTranscriptSettled() {
    if (find.open && find.query) runFindSearchNow();
  }

  if (!IS_REMOTE) {
    document.addEventListener("keydown", (e) => {
      if (!isFindHotkey(e)) return;
      e.preventDefault();
      e.stopPropagation();
      openFind();
    }, true);
  }

  onFindPreferenceChange = () => {
    if (find.open) runFindSearchNow();
  };

  window.__grokHistory = {
    prefixRemaining: () => state.historyPrefixUserCount || 0,
    prefixLength: () => (state.historyPrefix && state.historyPrefix.length) || 0,
    expandMore: () => loadEarlierHistory(false),
    expandAll: () => expandHistoryAll(),
  };

  window.__grokFind = {
    open: openFind,
    close: closeFind,
    isOpen: () => !!find.open,
    query: () => find.query,
    setQuery: (q) => setFindQuery(q, { immediate: true }),
    next: () => findStep(1),
    prev: () => findStep(-1),
    matchCount: () => find.nav.length,
    totalCount: () => find.matches.length,
    hiddenCount: () => find.hiddenCount,
    index: () => find.index,
    includeHidden: (on) => {
      find.includeHidden = !!on;
      rebuildFindNav();
      paintFindHighlights();
      updateFindChrome();
    },
    caseSensitive: () => find.caseSensitive,
    setCaseSensitive: (on) => {
      find.caseSensitive = !!on;
      find.lastComplete = false;
      runFindSearchNow();
    },
    regex: () => find.regex,
    setRegex: (on) => {
      find.regex = !!on;
      find.lastComplete = false;
      runFindSearchNow();
    },
    invalid: () => !!find.invalid,
    hasHighlightApi: findHasHighlightApi,
  };

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
    "subagentUpdate", "childStream",
  ]);

  const SETTINGS_LIVE_MSGS = new Set([
    "initialState", "showThinking", "appPurpose", "expandCommandOutputs",
    "steerByDefault", "steerUnavailable", "soundNotifications", "processingSound",
    "readRepliesAloud", "summarizeRepliesAloud", "fontScale", "voiceConfigured",
    "providerState", "githubState", "mcpServers", "mcpConnectors", "remoteStatus", "telemetryEnabled", "thumbsFeedback", "grokUpdateStatus", "initialized",
  ]);

  function handleHostMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    if (state.replayHold && msg.type !== "historyReplay" && REPLAY_HOLD_TYPES.has(msg.type)) {
      state.replayHeld.push(msg);
      return;
    }
    switch (msg.type) {
      case "initialState":
        state.useCtrlEnter = msg.useCtrlEnter;
        state.effort = msg.effort || "";
        state.cwd = msg.cwd || "";
        state.extVersion = msg.extVersion || "";
        // Field presence, not a version check: an older host sends neither, and
        // the About panel then keeps its local shape rather than naming a
        // machine or a GUI it was never told about.
        state.hostKind = msg.hostKind || "";
        state.hostName = msg.hostName || "";
        // What this particular host can do, as the host itself reports it. Every
        // remote snapshot carries an initialState, so this is answered before
        // any control is drawn — and a host that says nothing is a host that
        // cannot, which is the safe way round.
        state.hostCaps = (msg.capabilities && typeof msg.capabilities === "object") ? msg.capabilities : {};
        // Field presence: an older host never sends this, and command View all
        // then omits language rather than inventing a dialect.
        state.commandLanguage = typeof msg.commandLanguage === "string" ? msg.commandLanguage : "";
        // Every remote snapshot carries an initialState, so this is where a
        // reconnect lands. Whatever the rail concluded from silence belongs to
        // the host that was quiet, not to this one.
        forgetRailProbeVerdict();
        restoreRememberedRemoteSession();
        // Capability field presence — never a version check. Local hosts ignore.
        ensureRemoteFilesBrowser();
        if (typeof msg.showThinking === "boolean") state.showThinking = msg.showThinking;
        if (typeof msg.expandCommandOutputs === "boolean") state.expandCommandOutputs = msg.expandCommandOutputs;
        if (typeof msg.steerByDefault === "boolean") state.steerByDefault = msg.steerByDefault;
        if (typeof msg.soundNotifications === "boolean") state.soundNotifications = msg.soundNotifications;
        if (typeof msg.processingSound === "boolean") state.processingSound = msg.processingSound;
        releaseAudioIfSilent();
        // Absent appPurpose (older host) → Knowledge work — smaller surface.
        state.appPurpose = msg.appPurpose === "coding" ? "coding" : "knowledge";
        if (typeof msg.readRepliesAloud === "boolean") {
          state.readRepliesAloud = msg.readRepliesAloud;
          if (IS_REMOTE && !state.remotePreferencesSupported) {
            state.remotePreferencesSupported = true;
            reportRemotePreferences();
          }
        }
        if (typeof msg.telemetryEnabled === "boolean") state.telemetryEnabled = msg.telemetryEnabled;
        if (typeof msg.thumbsFeedback === "boolean") state.thumbsFeedback = msg.thumbsFeedback;
        applyThinkingVisibility();
        applyExpandCommandOutputs();
        syncGearPlacement();
        renderWelcomeTip();
        break;
      case "moveViewHint":
        // Live retraction. `initialState` is not re-sent on a session swap, so a
        // webview holding a stale true would rebuild the hint the user has
        // already acted on — and opening the picker and cancelling causes no
        // rebuild that would refresh it.
        if (state.hostCaps) state.hostCaps.moveViewHint = msg.value === true;
        renderWelcomeTip();
        break;
      case "projectSetup":
        // `root` is stated on every frame, including the first — the form has to
        // show a destination before anyone has typed, and before any attempt has
        // been made there is nothing else in the frame at all.
        if (typeof msg.root === "string" && msg.root) state.projectRoot = msg.root;
        // `done` is the only close signal. Silence is not one: a failed attempt
        // also stops being busy, and closing on that would throw away the error
        // the user needs to read.
        if (msg.done) {
          state.projectGithub = null;
          closeAddProjectForm();
          break;
        }
        if (msg.busy) state.projectGithub = null;
        else if (addProjectFormApi && msg.github && typeof msg.github === "object") state.projectGithub = msg.github;
        else if (msg.error) state.projectGithub = null;
        if (addProjectFormApi) addProjectFormApi.update({
          ...msg,
          github: state.projectGithub || msg.github,
          githubState: state.githubState || undefined,
          repos: state.githubRepos,
        });
        break;
      case "githubState":
        state.githubState = msg.github && typeof msg.github === "object" ? msg.github : null;
        if (addProjectFormApi) addProjectFormApi.update({ githubState: state.githubState });
        break;
      case "githubRepos":
        state.githubRepos = Array.isArray(msg.repos) ? msg.repos : [];
        if (addProjectFormApi) {
          addProjectFormApi.update({
            repos: state.githubRepos,
            reposTruncated: msg.truncated === true,
            reposError: typeof msg.error === "string" ? msg.error : "",
          });
        }
        break;
      case "welcomeTips":
        // Deliberately NOT an advance: this frame arrives on startup and after
        // every routine/connector change, and rotating the advice because a
        // connector was linked in another window would be movement with no
        // meaning. Re-render so a tip whose condition just went false leaves.
        state.welcomeTips = {
          routineCount: msg.routineCount,
          connectorCount: msg.connectorCount,
          dismissed: Array.isArray(msg.dismissed) ? msg.dismissed : [],
          // Absent on an older host: no field, no once-a-day filter, and the
          // pool behaves exactly as it did before this existed.
          shownToday: Array.isArray(msg.shownToday) ? msg.shownToday : [],
        };
        renderWelcomeTip();
        break;
      case "providerState":
        state.providersKnown = true;
        state.providers = Array.isArray(msg.providers) ? msg.providers.filter((provider) =>
          provider && (provider.id === "grok" || provider.id === "codex" || provider.id === "claude")) : [];
        // A confirmed account retires its device-flow mirror. Without this the
        // "Connected" flow row would resurface in Settings after a later
        // sign-out, describing a connection that no longer exists.
        for (const provider of state.providers) {
          const mirrored = state.deviceLoginByProvider[provider.id];
          if (!mirrored) continue;
          // A terminal "done" can always lie: connected, it is redundant with
          // the snapshot; disconnected, it claims an account the user just
          // signed out of. A `failed` or `unavailable` mirror is the
          // explanation for what just happened, so it survives the refresh
          // Providers sends on open (round 2) — but only while the provider is
          // still unhealthy. Once a snapshot says the account is connected and
          // working, that explanation is history, and keeping it left a row
          // offering Sign out above the reason a previous attempt failed
          // (round 3).
          var healthy = provider.connected && provider.needsLogin !== true;
          var terminal = mirrored.status === "failed" || mirrored.status === "unavailable";
          if (mirrored.status === "done" || (healthy && terminal)) {
            delete state.deviceLoginByProvider[provider.id];
          }
        }
        // Read, never latched on click: a host too old to know `refreshProviders`
        // sends no frame at all, and a locally-set flag would spin forever.
        // Absent means idle, which is also what every pre-refresh host means.
        state.providersChecking = msg.checking === true;
        renderCodexUpdateNudge();
        refreshSettingsOverlay();
        // Connecting an additional account happens from the gear while the
        // current transcript stays mounted. The login/recovery view temporarily
        // borrows the welcome overlay; dismiss it when the provider it was
        // waiting for is now connected, without clearing or replaying messages.
        {
          // What the card is ASKING FOR, not which button it happens to draw.
          // Keying on the recovery button meant a device-code card — the only
          // way to connect from a phone or a cloud machine — was never
          // dismissed by its own success (owner, 2026-08-31).
          const onboardingProvider = $("welcome-onboarding")?.querySelector(
            '[data-act="recheckProvider"][data-provider], [data-act="recheck"][data-provider]',
          )?.dataset?.provider
            || (CONNECT_ONBOARDING_MODES[state.onboardingMode]
              ? (state.onboardingInfo && state.onboardingInfo.provider) || ""
              : "");
          // "Connected" is the configured account; one the host says still
          // needs a sign-in has not answered a card that asks for one. A fresh
          // cloud machine posts connect-agent and then broadcasts providerState
          // with grok connected + needsLogin behind it, and this dismissal
          // blanked the first attach until a reload (owner, 2026-09-05).
          const usable = (provider) => !!provider.connected && provider.needsLogin !== true;
          const anyConnected = state.providers.some(usable);
          const askedForConnected = onboardingProvider && state.providers.some((provider) =>
            provider.id === onboardingProvider && usable(provider));
          // `connect-agent` names no provider: it is the "pick any of the
          // three" card, so any connected account answers it.
          const chooserAnswered = state.onboardingMode === "connect-agent" && anyConnected;
          if ($("welcome-onboarding")?.childElementCount && (askedForConnected || chooserAnswered)) {
            clearWelcome();
          }
        }
        if (!gearPopover.hidden && state.gearView === "main") renderGearMain();
        if (!historyPopover.hidden) renderSessionRows();
        renderRail();
        break;
      case "mcpServers":
        state.mcpServers = Array.isArray(msg.servers) ? msg.servers : [];
        state.mcpLoading = msg.loading === true;
        state.mcpError = msg.error || "";
        state.mcpWarning = msg.warning || "";
        refreshSettingsOverlay();
        break;
      case "mcpConnectorAuthorization":
        if (msg.status === "finished") {
          if (!state.mcpConnectorAuthorization || state.mcpConnectorAuthorization.attemptId === msg.attemptId) {
            state.mcpConnectorAuthorization = msg.error ? msg : undefined;
          }
        } else {
          state.mcpConnectorAuthorization = msg;
        }
        refreshSettingsOverlay();
        break;
      case "mcpConnectors":
        state.mcpConnectors = Array.isArray(msg.connectors) ? msg.connectors : [];
        state.mcpRemoteConnect = msg.remoteConnect === true;
        refreshSettingsOverlay();
        break;
      case "routines":
        // The host answered, so any refusal we were holding is stale.
        state.routineSavePending = false;
        state.routines = Array.isArray(msg.entries) ? msg.entries : [];
        state.routineProjects = Array.isArray(msg.projects) ? msg.projects : [];
        state.routineModels = Array.isArray(msg.models) ? msg.models : [];
        state.routineError = msg.error || "";
        state.routineErrorId = msg.errorId || "";
        refreshSettingsOverlay();
        break;
      case "codexInstallProgress":
        state.codexInstall = {
          phase: msg.phase || "idle",
          receivedBytes: Number.isFinite(msg.receivedBytes) ? msg.receivedBytes : 0,
          totalBytes: Number.isFinite(msg.totalBytes) ? msg.totalBytes : 0,
          reason: typeof msg.reason === "string" ? msg.reason : "",
        };
        if (state.onboardingMode === "missing-codex") {
          showOnboarding("missing-codex", { ...state.onboardingInfo, reason: state.codexInstall.reason });
        }
        break;
      case "planModeAvailability":
        state.planModeAvailable = msg.available !== false;
        state.planModeUnavailableReason = state.planModeAvailable
          ? ""
          : String(msg.reason || "Plan mode is unavailable.");
        // Only an unverified probe is recheckable; a verified-old CLI stays latched.
        state.planModeRecheckable = !state.planModeAvailable && msg.recheckable === true;
        updateSendButton();
        break;
      case "remoteStatus":
        state.remoteLinked = !!msg.linked;
        syncRemoteButton();
        // The answer can land while the gear is already open (it usually
        // arrives within a frame of boot, but a slow secret read is exactly
        // the case this guards): repaint so the section appears rather than
        // waiting for the next open.
        if (!gearPopover.hidden && state.gearView === "main") renderGearMain();
        break;
      case "steerByDefault":
        // Live toggle (grok.steerByDefault). Pure policy for the next send —
        // the queued block's Steer button is unaffected.
        state.steerByDefault = !!msg.value;
        break;
      case "soundNotifications":
        // Live toggle (grok.soundNotifications). Only affects future turn-end/
        // error beeps.
        state.soundNotifications = !!msg.value;
        releaseAudioIfSilent();
        break;
      case "processingSound":
        state.processingSound = !!msg.value;
        if (state.processingSound && liveTurnInFlight) {
          scheduleProcessingCue();
        } else if (!state.processingSound && processingCueTimer != null) {
          clearTimeout(processingCueTimer);
          processingCueTimer = null;
        }
        releaseAudioIfSilent();
        break;
      case "readRepliesAloud": {
        const wasEnabled = state.readRepliesAloud;
        state.readRepliesAloud = !!msg.value;
        if (!state.readRepliesAloud && !IS_REMOTE) {
          if (wasEnabled) cancelPendingSpeech();
          if (state.summarizeRepliesAloud) {
            state.summarizeRepliesAloud = false;
            vscode.postMessage({ type: "setSummarizeRepliesAloud", value: false });
          }
        }
        break;
      }
      case "summarizeRepliesAloud":
        state.summarizeRepliesAloud = !IS_REMOTE && state.readRepliesAloud && !!msg.value;
        if (!IS_REMOTE && !state.readRepliesAloud && msg.value) {
          vscode.postMessage({ type: "setSummarizeRepliesAloud", value: false });
        }
        invalidatePendingSpeechSummary();
        break;
      case "telemetryEnabled":
        state.telemetryEnabled = !!msg.value;
        break;
      case "thumbsFeedback":
        state.thumbsFeedback = !!msg.value;
        break;
      case "speechSummary": {
        const pending = pendingSpeechSummary;
        if (
          pending &&
          pending.requestId === msg.requestId &&
          msg.requestId === speechRequestId &&
          (IS_REMOTE ? state.remoteTts : state.readRepliesAloud) &&
          (IS_REMOTE ? state.remoteSummarizeRepliesAloud : state.summarizeRepliesAloud) &&
          ttsAvailable
        ) {
          clearPendingSpeechSummary();
          speakText(msg.text || pending.text);
        }
        break;
      }
      case "showThinking":
        // Live toggle (grok.showThinking). Initial value also arrives via
        // initialState + is baked into the <body class> by the host to avoid a flash.
        state.showThinking = !!msg.value;
        applyThinkingVisibility();
        break;
      case "appPurpose":
        // Live global disclosure preference (Knowledge work / Coding).
        state.appPurpose = msg.value === "coding" ? "coding" : "knowledge";
        applyThinkingVisibility();
        applyExpandCommandOutputs();
        if (!gearPopover.hidden && state.gearView === "main") renderGearMain();
        syncGearPlacement();
        break;
      case "fontScale":
        // Live chat-only zoom (grok.chatFontScale). Initial value is baked into
        // <body style="--chat-zoom:…"> by the host; this just applies later edits.
        // The CSS derives both `zoom` and the containing-block height
        // compensation from this one variable, so the composer stays pinned.
        // Client-owned zoom (remote + desktop) ignores host updates so local
        // keyboard/wheel/slider choice is not clobbered.
        state.hostFontScale = Number(msg.value) || 1;
        if (!CLIENT_OWNS_FONT_SCALE) applyChatZoom();
        break;
      case "focusInput":
        // Send Selection / Send File / @-mention (#43): the host revealed the
        // panel taking focus; land the caret in the composer so the user can
        // type a prompt immediately. preventScroll: the composer lives in the
        // fixed chrome — html must never scroll to reveal it (boot-layout fix).
        input.focus({ preventScroll: true });
        break;
      case "findInSession":
        // Command Palette / workbench Ctrl+F fallback. The keystroke path is
        // untested inside a WebviewView, so this message must open find on its
        // own. Idempotent: a second open focuses the field.
        openFind();
        break;
      case "moveComposerCaret":
        moveComposerCaret(msg.direction);
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
        // A pending clearMessages is logically empty already; flush so
        // lastElementChild is not a stale node we are about to drop.
        flushPendingTranscriptClear();
        const surviving = Math.max(0, Number(msg.surviving) || 0);
        if (surviving < (state.historyPrefixUserCount || 0)) {
          const trimmed = splitHistoryWindow(state.historyPrefix, (state.historyPrefixUserCount || 0) - surviving);
          state.historyPrefix = trimmed.prefix;
          state.historyPrefixUserCount = surviving;
          state.historyPrefixPlans = (state.historyPrefixPlans || []).filter((p) =>
            typeof p.afterUserMessage !== "number" || p.afterUserMessage <= surviving);
          state.historyPrefixPermissions = (state.historyPrefixPermissions || []).filter((p) =>
            typeof p.afterUserMessage !== "number" || p.afterUserMessage <= surviving);
          for (const child of Array.from(messagesEl.children)) {
            if (child.id === "welcome" || child.id === "history-head") continue;
            child.remove();
          }
          syncHistoryHead();
        } else {
          const users = liveTranscriptQueryAll(".msg.user:not(.queued)")
            .filter((el) => el.dataset.steer !== "1");
          const firstGone = users.find((el) => Number(el.dataset.userBubbleIndex) === surviving) || users[surviving];
          if (firstGone) {
            // Remove that message and every sibling after it — agent replies, tool
            // groups, plan/permission cards, subagent rows all belong to the
            // discarded turns.
            while (messagesEl.lastElementChild && messagesEl.lastElementChild !== firstGone) {
              messagesEl.removeChild(messagesEl.lastElementChild);
            }
            if (messagesEl.lastElementChild === firstGone) messagesEl.removeChild(firstGone);
          }
        }
        // Same surviving-user-turn count as the DOM filter above. Steer
        // interjections and hidden replayed user events do not consume a slot.
        state.exportEvents = truncateExportEvents(state.exportEvents, surviving);
        // Nothing streaming survives a truncation — drop the per-turn handles so
        // the next turn starts clean rather than appending into a removed node.
        state.userMsgCount = surviving;
        state.turnRating = 0;
        state.activeAgentEl = null;
        state.activeAgentRaw = "";
        state.activeUserEl = null;
        state.activeUserRaw = "";
        state.activeThoughtEl = null;
        state.activeToolGroupEl = null;
        state.turnAgentActionsEl = null;
        // The host has just rebuilt the aggregate from the surviving ledger.
        // No completed-turn figure survives a rewind; when the whole transcript
        // is gone, neither does the session aggregate.
        state.lastTurnUsage = null;
        if (surviving === 0) state.sessionUsage = null;
        if (!contextPopover.hidden) openContextPopover();
        hideGrokking();
        hideThinkingIndicator();
        // The newest surviving agent message ends a finished turn, so its
        // copy/timestamp footer belongs visible.
        const agents = liveTranscriptQueryAll(".msg.agent .msg-actions");
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
        // Reply to Settings → About's checkGrokUpdate. The check also reports the
        // CLI's current version — adopt it, since the ACP handshake doesn't always
        // give us one (native Windows build) and otherwise the panel would show a
        // bare "—" right next to a confident "CLI is up to date".
        state.grokUpdate = {
          current: msg.current, latest: msg.latest,
          updateAvailable: !!msg.updateAvailable, error: msg.error || null,
          policy: msg.policy || null,
        };
        if (msg.current) state.cliVersion = msg.current;
        break;
      case "updateAvailable": {
        // Capability: the frame arrived. No host flag / IS_DESKTOP check.
        // Host-local outbound — remotes never receive this (remote-policy).
        const version = typeof msg.version === "string" ? msg.version.trim() : "";
        const url = typeof msg.url === "string" ? msg.url.trim() : "";
        if (version && url) {
          state.appUpdate = { version, url, ready: false };
          ensureRailGear();
          renderAppUpdateAffordance();
        }
        break;
      }
      case "updateReady": {
        const version = typeof msg.version === "string" ? msg.version.trim() : "";
        if (version) {
          const prevUrl = state.appUpdate && typeof state.appUpdate.url === "string"
            ? state.appUpdate.url : "";
          state.appUpdate = { version, url: prevUrl, ready: true };
          ensureRailGear();
          renderAppUpdateAffordance();
        }
        break;
      }
      case "initialized": {
        // The ACP handshake is done, but session/new or session/load may still be
        // running. Keep showing Starting until the startup lock clears.
        if (!msg.info.provider || msg.info.provider === "grok") state.cliVersion = msg.info.version || "";
        state.startingPhase = true;
        state.onboardingMode = null;
        if (!welcomeHoldActive()) setWelcomeStatus("Starting", true);
        const onb = $("welcome-onboarding");
        if (onb) onb.innerHTML = "";
        updateSendButton();
        break;
      }
      case "cliUpdating": {
        // One-time hint while the silent `grok update` runs before the session
        // spawns; overwritten by Starting once grok connects, then Connected
        // once session startup finishes.
        if (!welcomeHoldActive()) setWelcomeStatus("Updating Grok Build CLI", true);
        break;
      }
      case "session": {
        state.currentModelId = msg.currentModelId;
        state.activeProvider = msg.provider === "codex" || msg.provider === "claude" ? msg.provider : "grok";
        syncFeedbackButtons();
        syncProviderVoice();
        if (state.railTransition?.kind === "new") renderRail();
        state.isWorktree = !!msg.worktree; // gates the gear Apply/Remove worktree items
        state.availableModels = msg.models || [];
        const m = state.availableModels.find((x) => x.modelId === msg.currentModelId && (!x.provider || x.provider === state.activeProvider));
        if (m?.totalContextTokens) state.contextWindow = m.totalContextTokens;
        state.contextBreakdown = null;
        updateDonut(0);
        reportRemotePreferences();
        break;
      }
      case "sessionName": {
        const prev = state.sessionName;
        const next = {
          sessionId: msg.sessionId,
          name: String(msg.name || "New session"),
          cwd: String(msg.cwd || ""),
          // Present only when the conversation's cwd is not itself a project —
          // a worktree. Absent from an older host, which is why the label below
          // still has a fallback rather than depending on this.
          repoCwd: typeof msg.repoCwd === "string" ? msg.repoCwd : "",
        };
        const sameId = !!(prev && prev.sessionId === next.sessionId);
        const sameVisible = !!(sameId
          && prev.name === next.name
          && prev.cwd === next.cwd
          && (prev.repoCwd || "") === (next.repoCwd || ""));
        state.sessionName = next;
        // Host-confirmed identity only. Optimistic rail clicks never write here.
        state.activeSessionId = msg.sessionId;
        // May complete a resume (id match) or bind a new-session resolved id.
        noteRailTransitionSessionName(msg);
        // AFTER the note: a surviving transition means this frame was about a
        // different conversation. See noteHostIdentityKnown.
        noteHostIdentityKnown(msg.sessionId);
        // Same conversation coming back: do not rebuild the header. Different
        // at all: paint immediately. A held resync that turns out to be a
        // swap still lands the caret in the composer and pins like a fresh open.
        if (!sameVisible) {
          renderSessionName();
          renderSessionHead();
        }
        pendingSessionChromeReset = false;
        if (prev && !sameId) {
          focusComposerIfAllowed();
          setStickToBottom(true);
          updateScrollBtn();
          scrollToBottom();
        }
        break;
      }
      case "modelChanged": {
        state.currentModelId = msg.modelId;
        // The context window is model-specific (grok-build 512K vs Composer 200K).
        // The initial `session` event carries grok's *default* model, so when we
        // switch (e.g. to the configured default) recompute the max — otherwise the
        // donut keeps showing the wrong ceiling and an inflated percentage.
        const m = state.availableModels.find((x) => x.modelId === msg.modelId && (!x.provider || x.provider === state.activeProvider));
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
        if (state.voiceDiscarded && msg.status !== "idle") break;
        if (msg.status === "listening" || msg.status === "transcribing") {
          state.mic = msg.status;
          if (IS_REMOTE && msg.status === "listening" && remoteMic && !remoteMic.ready) {
            remoteMic.ready = true;
            const pending = remoteMic.pending.splice(0);
            remoteMic.pendingBytes = 0;
            for (const buffer of pending) postRemotePcm(buffer);
          }
          renderMic();
        } else if (msg.status === "idle") {
          // Hard reset — the host stopped voice (e.g. session switch). Clear the
          // live flag and any queued messages too, not just the button.
          state.mic = "idle";
          state.voiceLive = false;
          clearVoiceInsertion();
          if (IS_REMOTE) cleanupRemoteMic();
          renderMic();
        }
        break;
      case "voiceConfigured":
        state.voiceConfigured = !!msg.value;
        if (typeof msg.sendPhrase === "string") state.voiceSendPhrase = msg.sendPhrase;
        if (Array.isArray(msg.keyterms)) state.voiceKeyterms = msg.keyterms.filter((t) => typeof t === "string");
        renderMic();
        renderInputHighlight();
        break;
      case "voicePartial":
        if (state.voiceDiscarded) break;
        // Live streaming update: replace only the dictated text at the captured
        // insertion point. Passive remote tabs do not own the capture.
        // Same-repo passive tabs receive the shared partial too, but their
        // independently typed composer must remain untouched.
        if (!IS_REMOTE || remoteMic) {
          state.voiceLive = true;
          renderVoiceInsertion(msg.text || "");
        }
        break;
      case "voiceSubmit": {
        if (state.voiceDiscarded) break;
        // The webview is the submission boundary for local and remote voice.
        // In AFK Pilot this makes the spoken prompt cross the relay as the same
        // send/queueSend frame as typed input, so relay metering and busy-turn
        // queueing apply before the host can prompt the agent.
        const composed = state.voiceInsertionActive
          ? composeVoiceInsertion(state.voiceBefore, msg.text || "", state.voiceAfter).value
          : (msg.text || "");
        const t = composed.trim();
        state.voiceBefore = "";
        state.voiceAfter = "";
        state.voiceInsertionActive = true;
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
        if (state.voiceDiscarded) break;
        // Final result. Streaming and started dictation replace the captured
        // insertion; unsolicited transcripts retain append behavior.
        if (state.voiceLive || state.voiceInsertionActive) {
          renderVoiceInsertion((msg.text || "").trim(), true);
        } else {
          insertTranscript(msg.text);
        }
        state.voiceLive = false;
        clearVoiceInsertion();
        if (IS_REMOTE) cleanupRemoteMic();
        setMic("transcript");
        // "grok send" detected: submit hands-free — but only when idle, so it
        // never doubles as a "stop" on an in-flight turn.
        if (msg.send && !state.busy) sendOrStop();
        break;
      case "voiceError":
        // Setup/record/transcribe failed (the host already showed the reason).
        state.voiceLive = false;
        clearVoiceInsertion();
        if (IS_REMOTE) cleanupRemoteMic();
        setMic("error");
        break;
      case "chips":
        state.chips = msg.chips;
        renderChips();
        updateSendButton();
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
        // Live send, including a buffer rebuild inside historyReplay. A prior
        // hidden turn's skip ends here — this event is never hidden.
        state.skipUserBubble = false;
        // A co-attached view also receives sends from the other view. Prefer our
        // submission id; old hosts omit it, so fall back to exact text + chip
        // identity. agentStart has no ownership signal and must not clear the
        // recovery copy.
        if (!IS_REMOTE || (
          state.pendingSubmissionId &&
          (msg.submissionId !== undefined
            ? msg.submissionId === state.pendingSubmissionId
            : msg.text === state.pendingSubmissionText &&
              sameChipIds(msg.chips, state.pendingSubmissionChipIds))
        )) {
          clearOptimisticSend();
          state.pendingSubmissionText = "";
          state.pendingSubmissionId = null;
          state.pendingSubmissionChipIds = [];
          state.rejectedSubmissionText = "";
          renderQueuedBlocks();
        }
        // A steer/interjection is part of the already-running turn: it renders
        // as a bubble but never advances the prompt counter or drains cards at
        // a new prompt boundary. Real sends do both.
        if (msg.steer) {
          drainPlanHistory(state.userMsgCount);
          state.interjectionCount += 1;
        } else {
          drainPlanHistory(state.userMsgCount);
          drainPermissionHistory(state.userMsgCount);
          state.userMsgCount += 1;
        }
        addMessage("user", msg.text, msg.chips || [], { steer: msg.steer });
        forceScrollToBottom(); // jump back to the bottom on the user's own send (#16)
        break;
      case "agentStart":
        // A user-initiated turn began. Show Grokking until content replaces it.
        // Previous completed turn keeps its footer but loses thumbs — only the
        // turn that just finished is rateable.
        retireLiveTurnFeedback(state.turnAgentActionsEl);
        state.turnAgentActionsEl = null; // new turn → previous turn keeps its footer
        if (!state.replaying) state.turnRating = 0;
        state.ttsTurnText = "";
        showGrokking();
        // Busy is event-sourced through the session buffer so a re-focus lands
        // on the true state: agentStart marks a turn in flight (a live send
        // already set busy before posting; a buffer REPLAY of a mid-turn
        // session relies on this), agentEnd/agentError clear it.
        state.busy = true;
        state.busyLocked = false;
        if (!state.replaying) {
          liveTurnInFlight = true;
          scheduleProcessingCue();
        }
        updateSendButton();
        break;
      case "thoughtChunk":
        advanceHistoryEvent();
        appendThought(msg.text);
        break;
      case "messageChunk":
        advanceHistoryEvent();
        appendAgent(msg.text);
        break;
      case "media":
        addGeneratedMedia(msg);
        break;
      case "userMessageChunk":
        appendUserChunk(msg.text, msg.timestampMs, msg.images);
        break;
      case "imageFull": {
        // Ignore an answer for a picture the overlay has moved on from, so a
        // slow reply cannot replace whatever the user is looking at now.
        if (state.pendingImageFullId !== msg.fullId) break;
        const overlay = document.querySelector(".image-preview-overlay");
        // A missing src means the source is gone (swept, or deleted). Stop the
        // spinner either way — the thumbnail already on screen is the answer.
        if (msg.src && overlay && !overlay.hidden) overlay.querySelector("img").src = msg.src;
        setImagePreviewLoading(false);
        state.pendingImageFullId = null;
        break;
      }
      case "historyReplay":
        if (msg.active) {
          if (state.replayDepth === 0) {
            // Raise before any veil DOM so MutationObserver cannot pin-scroll.
            state.replaying = true;
            state.suppressReplayTurn = false; // fresh outer replay starts unsuppressed
            state.skipUserBubble = false;
            state.repoSwitchPending = true;
            state.replayHold = true;
            state.replayHeld = [];
            setConversationLoading(true);
            renderRepoChip();
          }
          state.replayDepth += 1;
          state.replaying = true;
        } else {
          if (state.replayDepth === 0) break;
          state.replayDepth -= 1;
          if (state.replayDepth > 0) break;
          if (state.replayHold) {
            state.replayHold = false;
            const held = state.replayHeld;
            state.replayHeld = [];
            applyHistoryWindow(held);
          }
          const inFlightSpeech = state.busy ? state.activeAgentRaw : "";
          commitAgentTurn(); // finalize the last turn while still flagged as replay
          state.replaying = false;
          state.repoSwitchPending = false;
          // historyReplay is never identity confirmation. If a rail click is
          // still waiting for sessionName/sessions.activeId, keep the veil so
          // the highlight and the load indicator stay paired.
          if (!state.railTransition) setConversationLoading(false);
          else setConversationLoading(true);
          // A RAF flush during the replay was skipped so the conversation
          // stayed put. Empty replay: nothing replaced it, so the welcome
          // belongs now. A replacement already dropped the pending flag.
          if (pendingTranscriptClear) flushPendingTranscriptClear();
          takeDesktopLaunchComposerFocus();
          renderRepoChip();
          // A remote snapshot can end while its latest turn is still running.
          // Seed the already-rendered prefix only in that case, so the eventual
          // live agentEnd speaks the complete reply. Finished buffered turns
          // remain empty and can never be re-spoken on reconnect.
          state.ttsTurnText = inFlightSpeech;
          state.suppressReplayTurn = false; // replay over → no longer suppressing
          state.skipUserBubble = false;
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
          // Older CLIs may not replay turn_completed; finalize that last footer
          // here too. Without agentTimestampMs it deliberately stays blank.
          revealTurnFooter();
          // Remote reconnect/cold-load delivers only a recent window. Label
          // the export so it cannot be read as the whole transcript.
          if (IS_REMOTE) state.exportWindowed = true;
          // Follow the pin. Do not re-pin: a reader (or a cache restore) who
          // is not at the bottom must stay put. A pinned reader still lands
          // at the bottom so new messages stay visible. Fresh open / empty
          // flush pin in resetSessionChrome; a swap pins when sessionName
          // names a different id. Skip while the wrapper is restoring
          // identity — that class means a place is already owned.
          if (!identityRestoring()) scrollToBottom();
          onFindTranscriptSettled();
        }
        break;
      case "historyBatch":
        for (const nested of msg.messages || []) handleHostMessage(nested);
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
        state.planHistoryQueue = normalizePlanHistory(msg.plans);
        state.userMsgCount = 0;
        state.interjectionCount = 0;
        state.historyEventCount = 0;
        break;
      case "toolCall":
        advanceHistoryEvent();
        if (state.suppressReplayTurn) break; // tool calls inside the primer turn (unlikely but defensive)
        if (isPlanReviewTool(msg.call)) {
          // Plan text belongs on the review card, not a generic tool row.
          break;
        }
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
      if (isMediaGenToolCall(msg.call, state.activeProvider) && msg.call.toolCallId) {
          state.mediaGenCallIds.add(msg.call.toolCallId);
        }
        addToToolGroup(msg.call);
        // Reads replay as a completed tool_call with the file text in `content`.
        // Shell rows wait for host `commandOutput` (grok) or a later update (Claude).
        if (isReadTool(msg.call)) maybeAttachToolResultOutput(msg.call);
        // On session/load a completed edit replays as a single `tool_call` that
        // already carries its diff (no follow-up update) — attach the preview here
        // or the restored edit has no "open diff →" (#30).
        applyToolDiffs(msg.call);
        // One-shot failed media-gen on resume (title + status together, no update).
        {
          const failure = toolFailureText(msg.call);
          if (failure) {
      const hint = isMediaGenToolCall(msg.call, state.activeProvider)
              ? mediaGenZeroRetentionHint(failure)
              : null;
            markToolFailed(msg.call.toolCallId, hint ? failure + "\n" + hint : failure);
          }
        }
        // Resume: if this tool was permission-gated, drop the restored (collapsed)
        // card right here — exactly where it was answered — instead of at the turn
        // boundary.
        renderRestoredPermissionForTool(msg.call.toolCallId, msg.call.title);
        break;
      case "toolCallUpdate": {
        advanceHistoryEvent();
        if (state.suppressReplayTurn) break;
        if (isPlanReviewTool(msg.call)) break;
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
        // Fold the refined title and arguments into the row before OUT / diffs
        // — Claude's first call is a bare verb; the path (and Read details)
        // arrive on this update. Attach the IN box first so maybeAttach can
        // fill OUT from this same completed payload.
        refreshToolRowFromUpdate(msg.call);
        // A self-executed command (cursor/Composer runs it in its own shell and
        // reports the result here, not via terminal/create) — fill the row's #41
        // IN/OUT box by toolCallId. Same path now fills a Read row's View all.
        // Takes precedence over the generic failure path so a non-zero command
        // reads as an [Error] exit N in its OUT box, matching grok-build's
        // terminal-fed rows. No-op (returns false) for grok-build, whose row
        // already has OUT.
        if (String(msg.call?.status).toLowerCase() === "completed" && maybeAttachToolResultOutput(msg.call)) {
          break;
        }
        // A failed tool (e.g. `image_to_video failed: image reference not readable`)
        // — surface the reason on its row instead of silently dropping it.
        // ZDR video-gen 400s name a useless API field; append a CLI settings path
        // when this is a known media-gen call (tracked at toolCall — updates often
        // have title:null) and the error signature matches.
        const failure = toolFailureText(msg.call);
        if (failure) {
          const id = msg.call?.toolCallId;
          const isMedia =
        (id && state.mediaGenCallIds.has(id)) || isMediaGenToolCall(msg.call, state.activeProvider);
          const hint = isMedia ? mediaGenZeroRetentionHint(failure) : null;
          markToolFailed(id, hint ? failure + "\n" + hint : failure);
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
        if (u.sessionUpdate === "turn_completed") {
          if (state.replaying) {
            commitAgentTurn();
            revealTurnFooter(msg.timestampMs);
          }
          break;
        }
        // A restore-built card CAN receive its own lifecycle when grok re-forwards
        // the `_x.ai/session/update` rail on session/load (fills Composer's missing
        // duration + the completion backstop). But a LATER LIVE spawn/finish must
        // never touch it (that would stamp the new run onto the old card). So skip
        // replayed cards only for live events — during replay they're eligible.
        const cards = [...state.subagentCards.values()].filter(
          (c) => state.replaying || !c.dataset.subagentReplayed,
        );
        if (u.sessionUpdate === "subagent_spawned") {
          // Exact id first: a started-ack can tag card A before this event,
          // and FIFO-first would then stamp B as A (B's stream + finish drop).
          // Untagged FIFO is only the fallback. Done-ness is deliberately
          // IGNORED — a tool-channel completion routinely races ahead of the
          // lifecycle spawn for the SAME card. Only tag when there's a real
          // id — an empty id would leave the card falsy-untagged and let the
          // NEXT spawn steal it.
          if (u.subagent_id) {
            const id = String(u.subagent_id);
            const el = cards.find((c) => c.dataset.subagentId === id)
              || cards.find((c) => !c.dataset.subagentId);
            if (el) tagSubagentChildSession(el, u);
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
      case "childStream":
        applyChildStream(msg);
        break;
      case "runProgress":
        applyRunProgress(msg.update);
        break;
      case "permissionRequest":
        addPermissionCard(msg.req);
        if (!state.replaying) {
          // Tool titles can expose commands or file operations. The accessibility
          // cue says what the user must do without reading tool details aloud.
          speakWaitingPrompt("Grok is waiting for your permission. Review the request and choose an option.");
        }
        break;
      case "permissionOptions":
        updatePermissionOptions(msg.requestId, msg.options);
        break;
      case "permissionResolved": {
        // Replayed (on re-focus) right after the buffered permissionRequest, or
        // live right after the user answers — collapse the matching card if it's
        // still active. Idempotent: a live click already collapsed it.
        const cards = liveTranscriptQueryAll(".card.permission");
        const el = cards.find((c) =>
          c.dataset.permReqId === String(msg.requestId) &&
          !c.classList.contains("perm-resolved") &&
          !c.classList.contains("resolved")
        );
        if (el) {
          const opt = (el._permOptions || []).find((o) => o.optionId === msg.optionId);
          resolvePermissionCardEl(el, opt, el._permTitle);
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
        const cards = liveTranscriptQueryAll(".card.plan");
        const el = cards.find((c) => c.dataset.planReqId === String(msg.requestId) && !c.classList.contains("resolved"));
        if (el) resolvePlanCardEl(el, msg.verdict);
        break;
      }
      case "questionRequest":
        addQuestionCard(msg.req);
        if (!state.replaying) {
          const questions = (msg.req?.questions || [])
            .map((question) => questionText(question))
            .filter(Boolean)
            .join(" ");
          speakWaitingPrompt(questions || "Grok is waiting for your answer.");
        }
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
        // clear busy here. agentEnd is the authoritative "user can send again"
        // signal for the host-owned prompt lifecycle.
        commitAgentTurn();
        // Deliberately NOT revealTurnFooter(): promptComplete ends one
        // client.prompt(), not necessarily the TURN. More tool calls and text
        // routinely follow, so revealing here put a footer mid-conversation that
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
        // Host-authoritative occupancy: grok's signals.json / live envelope,
        // or the remembered adapter prompt size. A window-only frame updates
        // the denominator without inventing a used count.
        // Structured addends are one snapshot (`nextContextBreakdown`). A
        // used-only frame keeps them; currency is `contextBreakdownIsCurrent`.
        state.contextBreakdown = nextContextBreakdown(state.contextBreakdown, msg);
        if (msg.window) state.contextWindow = msg.window;
        if (msg.used != null) updateDonut(msg.used);
        else updateDonut();
        break;
      case "expandCommandOutputs":
        // Live toggle (grok.expandCommandOutputs): applies to existing rows
        // too, and sets the default for rows still to come. Clears the
        // per-session Expand/Collapse All latch — last action wins.
        state.expandCommandOutputs = !!msg.value;
        state.toolExpandOverride = null;
        applyExpandCommandOutputs();
        break;
      case "setAllToolDetails":
        // Command Palette: Grok: Expand/Collapse All Tool Details — one-shot,
        // current session only, doesn't touch the persisted expandCommandOutputs.
        setAllToolDetails(!!msg.open);
        break;
      case "commandOutput": {
        // MCP output is keyed by toolCallId (always stated on that path).
        // Do not fall back to a fabricated "Run …" shell row — the tool_call
        // already owns the row, and argument text is not a correlation key.
        const wantedId = typeof msg.toolCallId === "string" ? msg.toolCallId.trim() : "";
        if (wantedId) {
          let pending = state.pendingCommandDetails.find((p) => !p.done && p.toolCallId === wantedId);
          if (!pending) {
            const item = state.toolItemsByToolCallId.get(wantedId);
            if (item) {
              const cmd = commandDetailText(item._call)
                || (typeof msg.command === "string" && msg.command.trim())
                || "{}";
              if (!item.querySelector(".cmd-block")) attachCommandDetails(item, cmd, wantedId);
              pending = state.pendingCommandDetails.find((p) => p.toolCallId === wantedId);
            }
          }
          if (pending) {
            pending.done = true;
            attachCommandOutput(pending.details, msg);
          }
          break;
        }
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
        stopProcessingCue();
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
        stopProcessingCue();
        hideGrokking(); // turn ended (possibly before any content)
        hideThinkingIndicator();
        revealTurnFooter();
        // Image-read failures fire agentError before a turn starts — don't
        // restamp the previous reply. A prompt that actually failed is busy.
        if (state.busy) markLiveTurnFeedback();
        addError(msg.text);
        state.busy = false;
        state.busyLocked = false; // an error ends any startup lock too
        updateSendButton();
        if (!state.replaying) maybeNotifySound("error"); // #59 — live turns only, and only when away
        state.ttsTurnText = "";
        break;
      case "agentEnd":
        stopProcessingCue();
        hideGrokking(); // turn ended (defensive — content normally clears it first)
        hideThinkingIndicator();
        // A turn that ends with NO content (grok's [Plan cancelled] ack can be
        // empty) would otherwise orphan the dots forever — content-based
        // clearing never fires.
        revealTurnFooter();
        markLiveTurnFeedback();
        state.busy = false;
        updateSendButton();
        if (!state.replaying) maybeNotifySound("done"); // #59 — live turns only, and only when away
        speakCompletedTurn();
        break;
      case "exit":
        stopProcessingCue();
        hideGrokking();
        // A clean exit on an empty view is not an error: the composer's own
        // "send to start" affordance already says what to do, and this event
        // replays into freshly-refreshed empty sessions where it describes
        // nothing real. welcomeVisible is the empty-transcript flag — it stays
        // true until any conversation content (or an error) calls clearWelcome.
        if (!(msg.code === 0 && state.welcomeVisible)) {
          addError(`Grok exited (code ${msg.code}). Send a message to restart this session, or start a new one.`);
        }
        // A process that dies takes the host's send queue with it: that text
        // never reached Grok, and the host empties the queue in the very next
        // breath after this message — so this is the last moment it exists
        // anywhere. Hand it back as the "Not sent" recovery block, which is
        // exactly what it is.
        //
        // Read from the QUEUE, not from the pending submission. A queued
        // contribution can be merged with another view's and flushed under a
        // combined text this tab cannot recognise as its own, which leaves the
        // pending marker set on a message that WAS delivered — rebuilding that
        // as "Not sent" would invite sending it twice. The queue is the honest
        // source: it still holds what never left, and is already empty once it
        // did.
        //
        // Remote only. The same text loss exists in the VS Code webview, but
        // there the queued block disappearing on exit is long-standing,
        // deliberate behaviour with a test of its own — and the desk still has
        // the composer, the transcript and the terminal in front of it. This
        // fixes the surface where the loss was actually reported and where a
        // phone has nothing else to fall back on.
        if (IS_REMOTE && state.sendQueue.length) {
          state.rejectedSubmissionText = queuedSendsText(state.sendQueue);
          state.sendQueue = [];
          renderQueuedBlocks();
        }
        state.busy = false;
        state.busyLocked = false; // a dead process ends any startup lock too
        updateSendButton();
        break;
      case "queuedSends":
        // Snapshot of the focused session's host-owned send queue — replayed on
        // re-focus like everything else, so queued blocks survive session swaps.
        // Prefer additive `queued` (text + chips); `items` is the text-only fallback.
        state.sendQueue = normalizeQueuedSends(msg);
        if (!state.sendQueue.length) {
          state.queuedSubmissionPending = false;
          state.queuedSubmissionRejected = false;
        }
        // A send the host QUEUED never produces the `userMessage` echo that
        // normally retires the optimistic placeholder, so the same text was left
        // on screen twice — once as a sent bubble, once as a queued block. The
        // queue is the host's answer to that submission, so treat it as the
        // acknowledgement: the queued block is now the truthful rendering, and
        // it carries Steer/edit/cancel the placeholder never had.
        //
        // Matched on text because the queue deliberately collapses several
        // contributions into one string and cannot carry a submission id (see
        // divertRacingSend in the host).
        if (state.optimisticSendEl && state.pendingSubmissionText) {
          if (queueHoldsContribution(state.sendQueue, state.pendingSubmissionText)) {
            // ONLY the placeholder. The pending submission id and text stay put:
            // they are what the "Not sent" recovery block is rebuilt from if the
            // relay bounces this send, and a queue snapshot is not proof the
            // send was accepted — only the host's own `userMessage` echo is, and
            // that path clears them. Retiring them here would mean a wrong match
            // could swallow the text instead of merely tidying the transcript.
            clearOptimisticSend();
            // The placeholder's Grokking was ours to show and ours to take back;
            // a genuinely running turn re-shows it from agentStart.
            if (!state.busy) hideGrokking();
          }
        }
        renderQueuedBlocks();
        break;
      case "submitQueuedSend":
        // Remote dequeue boundary: echo the host-owned text through the browser
        // as the exact ordinary send frame the relay meters. Do not optimistically
        // enter busy state — an over-quota relay bounces `error` and never
        // forwards the frame, so the queued block stays pending and usable.
        if (
          IS_REMOTE &&
          typeof msg.id === "string" &&
          msg.id &&
          typeof msg.text === "string" &&
          !state.submittedQueuedSendIds.has(msg.id)
        ) {
          state.submittedQueuedSendIds.add(msg.id);
          if (state.submittedQueuedSendIds.size > 32) {
            state.submittedQueuedSendIds.delete(state.submittedQueuedSendIds.values().next().value);
          }
          state.queuedSubmissionPending = true;
          state.queuedSubmissionRejected = false;
          state.queuedSubmissionId = msg.id;
          renderQueuedBlocks();
          vscode.postMessage({ type: "send", text: msg.text.trim(), queuedSendId: msg.id });
        }
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
      case "feedbackAvailability":
        state.feedbackAvailable = msg.available === true;
        if (!state.feedbackAvailable) {
          for (const actions of liveTranscriptQueryAll(".msg.agent .msg-actions")) {
            delete actions.dataset.feedbackPending;
          }
        }
        syncFeedbackButtons();
        break;
      case "turnFeedbackAck":
        applyTurnFeedbackAck(msg.rating);
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
        if (!state.busy && !state.replaying) {
          state.repoSwitchPending = false;
          renderRepoChip();
        }
        updateSendButton();
        if (!state.busy) {
          // Anything typed during startup is flushed by the host. Reveal the
          // version only now; initialized fires before session startup finishes.
          if (state.startingPhase) {
            state.startingPhase = false;
            const ver = state.cliVersion ? ` · v${state.cliVersion}` : "";
            if (!welcomeHoldActive()) setWelcomeStatus(`Connected${ver}`, false); // settled — no spinner
          }
        }
        // Refresh the gear popover's model/effort lock state if it's open.
        if (!gearPopover.hidden) renderGearMain();
        break;
      case "summarizing": {
        clearWelcome();
        const si = document.createElement("div");
        si.id = "summarizing-indicator";
        si.className = "session-context-banner";
        si.textContent = "Summarizing";
        si.insertAdjacentHTML("beforeend", BLINK_DOTS);
        appendTranscriptChild(si);
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
          // Record the host-launched terminal BEFORE rendering, so the panel is
          // painted with the done mark already on rather than flashing an
          // untouched button first.
          showOnboarding(msg.state, { platform: msg.platform, reason: msg.reason, provider: msg.provider, device: msg.device }, () => {
            if (msg.launched) markOnboardingLaunchedByHost(msg.provider);
          });
          // Mirror the device flow into Settings → Providers. The welcome card
          // above cannot render over a painted conversation, so for a click
          // made from the settings overlay this mirror IS the feedback.
          if (msg.provider) {
            // A terminal "done" is only worth mirroring while the snapshot has
            // not caught up. Storing it unconditionally left a latent card that
            // reappeared as "Connected" after a later sign-out in the same tab,
            // hiding the real Connect row (review, 2026-08-31) -- providerState
            // can arrive BEFORE this frame, so the retirement below cannot be
            // the only cure.
            var settledDone = msg.device && msg.device.status === "done";
            var alreadyConnected = (state.providers || []).some(function (p) {
              return p && p.id === msg.provider && p.connected;
            });
            if (msg.device && !(settledDone && alreadyConnected)) {
              state.deviceLoginByProvider[msg.provider] = msg.device;
            } else {
              delete state.deviceLoginByProvider[msg.provider];
            }
            refreshSettingsOverlay();
            // AFTER the mirror: renderConnectWizard reads it, and syncing
            // first painted the previous state every time (caught by driving
            // the states in a browser, 2026-08-31).
            syncConnectWizard(msg.provider, msg.device);
          }
        break;
      case "error":
        // The host refused to restore a specific conversation, and named it.
        // Keeping that id meant the next reload asked for the same dead
        // session, drew the same error, and re-armed itself — the owner could
        // only escape by clicking New session (2026-08-31).
        if (msg.resumeFailed && typeof msg.resumeFailed.id === "string"
          && rememberedRemoteSession && rememberedRemoteSession.id === msg.resumeFailed.id) {
          saveRememberedRemoteSession(null);
        }
        // The relay bounces a quota-refused frame as a plain error, which
        // renders in the transcript — behind the settings overlay the reader is
        // looking at. At the paywall that made Create appear to do nothing, at
        // exactly the moment being clear matters most. Attribute it to the save
        // it answers and let the Routines page show it.
        if (state.routineSavePending) {
          state.routineSavePending = false;
          state.routineError = msg.text || "That could not be saved.";
          state.routineErrorId = "";
          refreshSettingsOverlay();
        }
        if (state.repoSwitchPending) {
          state.repoSwitchPending = false;
          setConversationLoading(false);
          renderRepoChip();
        }
        {
          const supersededId = msg.code === SESSION_SUPERSEDED_CODE
            && msg.resumeFailed && typeof msg.resumeFailed.id === "string"
            ? msg.resumeFailed.id
            : (msg.code === SESSION_SUPERSEDED_CODE ? (state.activeSessionId || "") : "");
          // A takeover names the conversation it displaced. Abort only a rail
          // transition TO that id — an unrelated newer click must not be
          // cancelled by it, and must not freeze this view into the old one.
          if (supersededId) {
            const resumeToThis = state.railTransition
              && state.railTransition.kind === "resume"
              && state.railTransition.sessionId === supersededId;
            const transitioningElsewhere = !!state.railTransition && !resumeToThis;
            if (resumeToThis) abortRailTransition();
            if (!transitioningElsewhere) {
              // Deliberately no transcript error. The card IS the message, and
              // adding one printed the same sentence twice — once calmly where
              // the composer used to be, once in red above it, which reads as
              // two different things having gone wrong (owner, 2026-09-01).
              // Nothing failed here: the conversation moved, and it is one tap
              // back.
              enterSessionSuperseded(supersededId, sessionSupersededCwd(supersededId));
            }
            break;
          }
        }
        // A generic error cannot be attributed to a specific rail transition
        // (the frame carries no request id). An error from a superseded resume
        // therefore aborts whatever is currently in flight — worst case the
        // highlight backs out early and the real confirmation re-establishes
        // it (a flicker, not work loss). Leaving a stranded highlight forever
        // would be worse.
        if (state.railTransition) abortRailTransition();
        if (state.queuedSubmissionPending && isRelaySendRejection(msg.text)) {
          state.queuedSubmissionPending = false;
          state.queuedSubmissionRejected = true;
          if (state.queuedSubmissionId) state.submittedQueuedSendIds.delete(state.queuedSubmissionId);
          state.queuedSubmissionId = null;
          renderQueuedBlocks();
        } else if (
          state.pendingSubmissionId &&
          isRelaySendRejection(msg.text)
        ) {
          // Rejected by the relay (quota/rate cap): the message was never
          // sent, so the optimistic bubble must go — the "Not sent" recovery
          // block below is the honest representation.
          clearOptimisticSend();
          hideGrokking();
          state.rejectedSubmissionText = state.pendingSubmissionText;
          state.pendingSubmissionText = "";
          state.pendingSubmissionId = null;
          state.pendingSubmissionChipIds = [];
          state.busy = false;
          state.busyLocked = false;
          renderQueuedBlocks();
          updateSendButton();
        }
        addError(msg.text, msg.code);
        break;
      case "hostNotice":
        addPlanNotice(msg.text);
        break;
      case "xaiNotification":
        break;
      case "sessionRemoved": {
        if (!msg.id) break;
        const removed = state.sessions.find((s) => s.id === msg.id);
        state.sessions = state.sessions.filter((s) => s.id !== msg.id);
        state.railSelectedRows = state.railSelectedRows.filter((s) => s.id !== msg.id);
        state.pinnedSessions = state.pinnedSessions.filter((s) => s.id !== msg.id);
        for (const preview of Object.values(state.repoPreviews)) {
          const before = preview.entries.length;
          preview.entries = preview.entries.filter((s) => s.id !== msg.id);
          if (typeof preview.total === "number") {
            preview.total = Math.max(0, preview.total - (before - preview.entries.length));
          }
        }
        if (removed) {
          state.sessionTotal = Math.max(0, state.sessionTotal - 1);
          if (state.sessionNextOffset != null) state.sessionNextOffset = Math.max(0, state.sessionNextOffset - 1);
          if (state.sessionProviderCursor && (!removed.provider || removed.provider === "grok")) {
            state.sessionProviderCursor.grokOffset = Math.max(0, state.sessionProviderCursor.grokOffset - 1);
          }
        }
        delete state.dots[msg.id];
        if (rememberedRemoteSession?.id === msg.id) saveRememberedRemoteSession(null);
        // A removal carries no focus confirmation. Preserve an in-flight rail
        // transition until sessionName names the conversation being opened.
        if (!historyPopover.hidden) renderSessionRows(false);
        renderRail();
        break;
      }
      case "sessions": {
        const entries = uniqueSessionRows(msg.entries);
        const offset = msg.offset || 0;
        const open = !historyPopover.hidden;
        // Sticky search: a host-driven refresh (rename/delete/new session) posts an
        // unfiltered first page. If the user has a search active, re-request with it
        // rather than clobbering their filtered view with the full list.
        if (open && offset === 0 && (msg.query || "") !== state.sessionSearch) {
          // The popover wants its filtered view back, but an unfiltered first
          // page is exactly what the RAIL needs — and it is the only unfiltered
          // page it will see while a search is open. Dropping it wholesale left
          // the rail pinned on "Loading…" after switching projects with a search
          // still active, until the search was cleared or the page refreshed.
          if (!(msg.query || "")) adoptRailRows(entries);
          // Still an identity frame for the rail transition — activeId is this
          // tab's, even when the popover is about to re-request a filtered page.
          if (msg.activeId !== undefined) {
            state.activeSessionId = msg.activeId || null;
            noteRailTransitionSessions(msg, entries);
            noteHostIdentityKnown(msg.activeId || null);
          }
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
          for (const e of entries) {
            if (seen.has(e.id)) continue;
            seen.add(e.id);
            state.sessions.push(e);
          }
        } else {
          // Fresh list or new search result: replace.
          state.sessions = entries;
          state.sessionQuery = msg.query || "";
          state.sessionLastAutoPageKey = "";
        }
        settlePendingRename(state.sessions);
        if (msg.activeId !== undefined) {
          // Host-confirmed only — never an optimistic rail-transition id.
          // noteHostIdentityKnown is deliberately NOT here — this handler's
          // noteRailTransitionSessions runs at the end (it needs the adopted
          // rows), and the latch has to be read after it. See below.
          state.activeSessionId = msg.activeId || null;
          if (state.activeSessionId) {
            const activeEntry = entries.find((entry) => entry.id === state.activeSessionId)
              || state.sessions.find((entry) => entry.id === state.activeSessionId);
            // repoCwd must name the repo this SESSION lives in, not the one the
            // list happens to be showing. Those diverge whenever you browse
            // another repo's history (the chip literally says "Browsing X; live
            // session is in Y"), and remembering the browsed one pairs a repo
            // with a session that does not belong to it. On the next reconnect
            // restoreRememberedRemoteSession then issues two contradictory
            // commands — selectRepo(X) followed by resumeSession(a session in
            // Y) — and the host obeys both in order. That is the A→B→A→B
            // bouncing: the second command lands after the first has finished
            // loading, and whichever repo you end on gets remembered, so the
            // next reconnect can flip you straight back.
            // repoCwd must be something `selectRepo` can actually accept — i.e.
            // a row in the catalog. A worktree session's activeCwd is the
            // ISOLATED CHECKOUT, which is deliberately not a repo row, so
            // remembering it produced a reconnect that asked to select a repo
            // the host would silently refuse: identity restore then never
            // completed and the outbox stayed queued until the tab was closed,
            // taking anything typed meanwhile with it. Fall back to the repo
            // that owns it.
            // Also deliberately uses host-confirmed activeSessionId only — a
            // pending rail click must not be remembered as this tab's session.
            const activeRepoRow = state.repos.find((r) => sameCwd(r.cwd, state.activeRepoCwd));
            // An EMPTY conversation is deliberately forgotten, not remembered:
            // the host reaps an untouched session the moment this tab lets go
            // of it (#24), so a remembered empty id turns every refresh into
            // "could not restore — it may have been deleted" over a perfectly
            // healthy new tab (owner-hit, 2026-08-15). Nothing to restore must
            // mean no restore attempt. Both signals have to agree — the host's
            // message count AND a blank view — so a refresh mid-first-turn,
            // where the count still lags at 0, keeps remembering.
            if (activeEntry?.numMessages === 0 && transcriptHasNoTurns()) {
              saveRememberedRemoteSession(null);
            } else saveRememberedRemoteSession({
              id: state.activeSessionId,
              repoCwd: (activeRepoRow && activeRepoRow.cwd) ||
                state.selectedRepoCwd || state.activeRepoCwd || state.cwd || "",
              cwd: activeEntry?.cwd || state.activeRepoCwd || state.cwd || "",
            });
          } else saveRememberedRemoteSession(null);
        }
        // Merge (not replace) so dots from earlier pages survive a load-more, which
        // only carries dots for the new page.
        state.dots = Object.assign({}, state.dots, msg.dots || {});
        if (msg.total !== undefined) state.sessionTotal = msg.total;
        state.sessionHasMore = !!msg.hasMore;
        // Where the next load-more should start: index slots CONSUMED by the host
        // (hidden subagent sessions occupy slots without producing rows), so a
        // filtered page never makes us re-request the same slice.
        state.sessionNextOffset = typeof msg.nextOffset === "number" ? msg.nextOffset : null;
        state.sessionProviderCursor = msg.providerCursor &&
          typeof msg.providerCursor.grokOffset === "number"
          ? {
              grokOffset: msg.providerCursor.grokOffset,
              ...(msg.providerCursor.codexHighWater &&
                typeof msg.providerCursor.codexHighWater.updatedAt === "number" &&
                typeof msg.providerCursor.codexHighWater.id === "string"
                ? { codexHighWater: { ...msg.providerCursor.codexHighWater } }
                : {}),
            }
          : null;
        state.sessionLoading = false;
        if (open) renderSessionRows();
        renderSessionName();
        // The rail's selected-repo section reads this list directly, so every
        // host-driven refresh (rename, delete, new session) repaints it for free.
        // Skipped for a filtered/paged answer: those are the history popover's
        // search state, not the repo's newest sessions.
        if (offset === 0 && !(msg.query || "")) adoptRailRows(entries);
        // A searched or paged answer skips adoptRailRows, but it can still be
        // the frame that renames the open conversation — the header reads the
        // active record, so refresh it either way.
        else renderSessionHead();
        // After adopt so railCatalogHasSession sees the new rows. Confirms a
        // resume only when activeId equals the requested id; for new, binds /
        // drops the placeholder only when activeId left the previous session
        // and the real row is present (never on a foreign tab's activeId).
        if (offset === 0) noteRailTransitionSessions(msg, entries);
        // AFTER the note, and only for a frame that actually carried identity.
        // A paged/filtered answer says nothing about what the host is focused
        // on, so it must not disarm the latch.
        if (msg.activeId !== undefined && offset === 0) noteHostIdentityKnown(msg.activeId || null);
        break;
      }
      case "pinnedSessions": {
        state.pinnedSessionsKnown = true;
        state.pinnedSessions = uniqueSessionRows(msg.entries);
        state.dots = Object.assign({}, state.dots, msg.dots || {});
        if (settlePendingRename(state.pinnedSessions)) {
          renderSessionName();
          renderSessionHead();
        }
        renderRail();
        break;
      }
      case "repoSessions": {
        // Proof this host answers per-repo previews — until now the rail has
        // only probed with a single request.
        const known = state.repoPreviewsSupported;
        const key = cwdKey(msg.cwd);
        state.repoPreviewsSupported = true;
        clearRailProbeDeadline(msg.cwd);
        delete state.repoPreviewsAsked[key];
        if (msg.error) {
          delete state.repoPreviews[key];
          state.repoPreviewErrors[key] = msg.error;
          console.warn(`[rail] listRepoSessions host refusal: ${msg.error}`);
        } else {
          delete state.repoPreviewErrors[key];
          state.repoPreviews[key] = {
            entries: uniqueSessionRows(msg.entries),
            total: typeof msg.total === "number" ? msg.total : (msg.entries || []).length,
          };
        }
        state.dots = Object.assign({}, state.dots, msg.dots || {});
        if (!msg.error && settlePendingRename(state.repoPreviews[key].entries)) {
          renderSessionName();
          renderSessionHead();
        }
        // First answer: the probe only asked about one repo, so now ask for the rest.
        if (!known) requestRailPreviews();
        renderRail();
        break;
      }
      case "repos": {
        state.reposKnown = true;
        state.repos = Array.isArray(msg.entries) ? msg.entries : [];
        settlePendingRepoColor(state.repos);
        const wasSelected = state.selectedRepoCwd;
        state.selectedRepoCwd = msg.selectedCwd || "";
        state.activeRepoCwd = msg.activeCwd || "";
        // The folder the EDITOR has open — not the selection. The header names
        // the conversation's project only when it differs from this one.
        state.workspaceRepoCwd = msg.workspaceCwd || "";
        // A repo we just left keeps stale cached rows; drop them so its section
        // re-reads rather than showing the list from before the switch. The repo
        // we arrived in reads the live `sessions` list, so its cache is dead weight.
        if (wasSelected && !sameCwd(wasSelected, state.selectedRepoCwd)) {
          // Hand the repo we are LEAVING its own rows before the holder is
          // overwritten, so it keeps showing them as a sibling instead of
          // dropping to a spinner the moment we walk away from it. The repo we
          // are arriving in keeps whatever preview it already had — that is
          // exactly the data that makes the switch look instant (railRowsFor).
          if (!state.railSessionsStale && state.railSelectedRows.length) {
            state.repoPreviews[cwdKey(wasSelected)] = {
              entries: state.railSelectedRows.slice(0, RAIL_EXPANDED),
              total: state.railSelectedRows.length,
            };
          }
          // The list for the new repo has not arrived yet — see railRowsFor.
          state.railSessionsStale = true;
        }
        // The switch we asked for has landed. Release the lock here rather than
        // waiting for a session to start: a selection that opens no conversation
        // produces no replay, no setBusy and no error, so those releases never
        // fire and every rail "+" stays disabled indefinitely. Gated on the
        // catalog naming the repo we actually asked for, so an unrelated catalog
        // push mid-switch cannot unlock a transition still in flight.
        if (state.repoSwitchTarget && sameCwd(state.selectedRepoCwd, state.repoSwitchTarget)) {
          state.repoSwitchTarget = "";
          state.repoSwitchPending = false;
          // …and now the other half of the rail "+" on a project we were not in.
          // `newSession` names no repo — it starts wherever the host is — so the
          // switch has to land first and this is where it lands. Without it the
          // desktop only switched: the conversation on screen stayed whatever it
          // was, which reads as "it started one in the wrong project", and with
          // an empty session already open it reads as nothing happening at all.
          //
          // Single-shot, and coordinated through the flag itself rather than a
          // host check: the browser page consumes __grokRailNewIntent as it
          // forwards the selectRepo, so there it is already null here and this
          // cannot fire twice. Where nothing consumed it — the desktop — it is
          // still set, and this is the only place that acts on it.
          if (window.__grokRailNewIntent && sameCwd(window.__grokRailNewIntent, state.selectedRepoCwd)) {
            window.__grokRailNewIntent = null;
            // Advance the optimistic new-transition (if any) before posting so
            // the placeholder stays in creating rather than looking stuck on
            // a switch that already completed.
            noteRailTransitionRepos(msg);
            vscode.postMessage({ type: "newSession" });
          } else {
            noteRailTransitionRepos(msg);
          }
        } else {
          // Unrelated catalog push, or a switch that has not named our target
          // yet — still allow phase advance when selectedCwd matches.
          noteRailTransitionRepos(msg);
        }
        renderRepoChip();
        // The catalog is what decides whether the conversation's project label
        // is worth showing at all (one project — nothing to disambiguate) and
        // what it reads. It usually lands after the name.
        renderSessionName();
        if (!repoPopover.hidden) renderRepoPopover();
        renderRail();
        requestRailPreviews();
        // Selected repo is the file-browse root — a switch must not leave the
        // panel listing another project's paths under the new name.
        //
        // Unconditionally, NOT only while the panel is open. A closed panel kept
        // its viewer, and reopening skips the directory request whenever a
        // viewer exists — so close the panel in project A, switch to B, reopen,
        // and A's file was sitting there under B's heading.
        // Shared state is keyed by scope. Switching projects changes the active
        // scope but keeps each project's tabs/drafts parked in memory; it cannot
        // render one scope's content under another scope's title.
        ensureRemoteFilesBrowser();
        // A rail "+" on another repo waits for the switch to land before starting
        // the session, so it can never open one in the repo we were leaving.
        break;
      }
      case "sessionDot":
        if (msg.dot && msg.dot !== "none") state.dots[msg.id] = msg.dot;
        else delete state.dots[msg.id];
        if (!historyPopover.hidden) patchSessionDot(msg.id);
        patchSessionDot(msg.id, rail());
        break;
      case "projectDirListing":
        handleProjectDirListing(msg);
        break;
      case "projectFileContent":
        handleProjectFileContent(msg);
        break;
      case "projectFileWriteResult":
        handleProjectFileWriteResult(msg);
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
    if (SETTINGS_LIVE_MSGS.has(msg.type)) refreshSettingsOverlay();
    // After any step grok takes mid-turn, make sure the chat still shows it's
    // working — never a dead frame while a turn is unfinished (esp. with thinking
    // traces hidden). The turn-end boundary (promptComplete) is excluded so the
    // stand-in doesn't flash between it and agentEnd.
    if (TURN_PROGRESS_MSGS.has(msg.type)) {
      ensureActivityIndicator();
      // Queued blocks live at the END of the conversation — re-pin them under
      // freshly streamed content.
      if (state.sendQueue.length && state.queuedWrapEl) appendTranscriptChild(state.queuedWrapEl);
    }
    if (find.open && (
      TURN_PROGRESS_MSGS.has(msg.type) ||
      msg.type === "userMessage" ||
      msg.type === "commandOutput" ||
      msg.type === "agentEnd"
    )) {
      // Debounced — a 5 MB live turn must not re-scan on every token, and
      // finishFindSearch does not scroll, so the current match stays put.
      scheduleFindSearch();
    }
    if (!state.historyHydrating && shouldRecordExportEvent(msg)) {
      state.exportEvents.push(msg);
    }
  }

  window.addEventListener("message", (e) => handleHostMessage(e.data));

  // ---------- wire ----------

  sendBtn.onclick = sendOrStop;
  updateSendButton();
  if (micBtn) {
    micBtn.onclick = (e) => { e.stopPropagation(); toggleMic(); };
    renderMic();
  }
  newBtn.onclick = () => beginNewSession();
  fillSessionHeadActions();
  // Desktop and cloud ship the rail mount in the first HTML frame. Paint the
  // skeleton before catalog frames arrive so the window never starts
  // panel-less — on a cloud machine that gap is however long the host takes to
  // wake, and what showed instead was the layout this product had before it
  // had a rail (owner, 2026-08-31).
  if (railChromeBeforeCatalog()) renderRail();
  modeBtn.onclick = (e) => { e.stopPropagation(); if (state.busyLocked) return; openModePopover(); };
  gearBtn.onclick = (e) => { e.stopPropagation(); openGearPopover(); };

  // ---------- remote project files ----------
  //
  // Browse + open under the tab's selected repo; edit+save when the host also
  // advertises editProjectFiles. Host fence is repoScopeFor + resolveTreePath
  // (see src/remote-files.ts). No create/delete/rename. Capability-gated (field
  // presence); local VS Code / desktop never mount it even when the host
  // advertises the flag.

  function remoteFilesBrowseAvailable() {
    return IS_REMOTE && !!(state.hostCaps && state.hostCaps.browseProjectFiles);
  }

  /** Edit is a separate capability so a host can offer browse without a write path. */
  function remoteFilesEditAvailable() {
    return remoteFilesBrowseAvailable() && !!(state.hostCaps && state.hostCaps.editProjectFiles);
  }

  function remoteFilesRepoCwd() {
    return state.selectedRepoCwd || state.activeRepoCwd || state.cwd || "";
  }

  // Promise adapter over the relay's message round trip. New hosts echo the
  // additive requestId; released extensions may not, so requests to an
  // unproven/legacy host are serialized per operation+repo+path. A timed-out
  // legacy key is poisoned until refresh: sending another indistinguishable
  // request would let the late first answer satisfy the second and cross-wire
  // editor state. Refresh is the intentionally acceptable recovery here.
  let remoteFileRequestSeq = 0;
  let remoteFileRequestIdsSupported = null;
  const remoteFilePending = new Map();
  const remoteFileTails = new Map();
  const remoteFilePoisoned = new Set();

  function remoteFileRequestKey(kind, cwd, relPath) {
    return kind + "\0" + String(cwd || "") + "\0" + String(relPath || "");
  }

  function postRemoteFileRequest(kind, payload) {
    const key = remoteFileRequestKey(kind, payload.cwd, payload.relPath);
    if (remoteFilePoisoned.has(key)) {
      return Promise.resolve({ ok: false, reason: "Request state is stale. Refresh this page and try again." });
    }
    const send = () => new Promise((resolve) => {
      const requestId = "file-" + (++remoteFileRequestSeq);
      const timer = setTimeout(() => {
        remoteFilePending.delete(requestId);
        if (remoteFileRequestIdsSupported !== true) remoteFilePoisoned.add(key);
        resolve({ ok: false, reason: "File request timed out. Refresh this page and try again." });
      }, 30000);
      remoteFilePending.set(requestId, {
        requestId,
        kind,
        cwd: payload.cwd,
        relPath: payload.relPath || "",
        key,
        timer,
        resolve,
      });
      vscode.postMessage({ ...payload, requestId });
    });
    if (remoteFileRequestIdsSupported === true) return send();
    const previous = remoteFileTails.get(key) || Promise.resolve();
    const request = previous.then(send, send);
    remoteFileTails.set(key, request);
    request.finally(() => {
      if (remoteFileTails.get(key) === request) remoteFileTails.delete(key);
    });
    return request;
  }

  function settleRemoteFileRequest(kind, msg) {
    if (!state.filesBrowse.component) return false;
    let pending = null;
    if (typeof msg.requestId === "string") {
      remoteFileRequestIdsSupported = true;
      const candidate = remoteFilePending.get(msg.requestId) || null;
      // Correlation is necessary but not sufficient: retain the repo/path fence
      // at the renderer boundary too. A relayed response carrying a real id for
      // a different operation or scope must not populate this request's tab.
      if (
        candidate
        && candidate.kind === kind
        && candidate.cwd === msg.cwd
        && candidate.relPath === (msg.relPath || "")
      ) {
        pending = candidate;
      }
    } else {
      if (remoteFileRequestIdsSupported === null) remoteFileRequestIdsSupported = false;
      for (const candidate of remoteFilePending.values()) {
        if (
          candidate.kind === kind
          && candidate.cwd === msg.cwd
          && candidate.relPath === (msg.relPath || "")
        ) {
          pending = candidate;
          break;
        }
      }
    }
    // A response with no live consumer is stale. Once the shared component is
    // mounted it must never fall through into the legacy renderer's state.
    if (!pending) return true;
    clearTimeout(pending.timer);
    remoteFilePending.delete(pending.requestId);
    pending.resolve(msg);
    return true;
  }

  function currentRemoteFileScope() {
    const cwd = remoteFilesRepoCwd();
    return cwd ? { id: cwd, label: cwdLeaf(cwd) || "Project", title: cwd } : null;
  }

  function ensureSharedRemoteFilePanel() {
    if (!remoteFilesBrowseAvailable()) return false;
    const shared = window.GrokFilePanel;
    if (!shared || typeof shared.createFilePanel !== "function") return false;
    let panel = state.filesBrowse.component;
    if (!panel) {
      const componentScript = document.querySelector('script[src*="file-panel.js"]');
      const iconBase = componentScript && componentScript.src
        ? new URL("file-icons/", componentScript.src).href
        : "";
      const access = {
        currentScope: async () => currentRemoteFileScope(),
        list: (cwd, relPath) => postRemoteFileRequest("list", {
          type: "listProjectDir", cwd, relPath: relPath || "",
        }),
        read: (cwd, relPath) => postRemoteFileRequest("read", {
          type: "readProjectFile", cwd, relPath,
        }),
      };
      if (remoteFilesEditAvailable()) {
        access.write = (cwd, request) => postRemoteFileRequest("write", {
          type: "writeProjectFile",
          cwd,
          relPath: request.relPath,
          text: request.text,
          stamp: request.stamp,
          expectedAbsPath: request.expectedAbsPath,
        });
      }
      let initialOpen = false;
      try {
        initialOpen = sessionStorage.getItem("grok.remote.filesOpen") === "1"
          && !remoteUsesTouchComposer();
      } catch (_) { /* private mode */ }
      panel = shared.createFilePanel({
        access,
        mount: {
          panelHost: document.querySelector(".app-main") || document.body,
          // The relay adds this right-column host. Until then (and on phones),
          // responsive presentation deliberately falls back to an overlay.
          dockHost: document.getElementById("file-panel-dock"),
          // The element the panel must not starve. Available width is this plus
          // whatever the panel already occupies — NOT the whole row, which also
          // contains the projects rail and would let a drag squeeze the chat to
          // nothing.
          widthPeer: document.getElementById("chat-stack")
            || document.getElementById("chat-column"),
          // As an overlay the panel stops below the bar its toggle lives in,
          // the way the docked one does, rather than covering that bar and the
          // button that opened it. A function because which bar that is changes
          // at runtime: `.top-bar` is hidden and `#session-head` takes over the
          // moment a project catalog arrives.
          overlayTopFrom: () => remoteFilesButtonHost(),
          toggleHost: remoteFilesButtonHost(),
          presentation: "responsive",
          id: "files-browse-panel",
          // Same content-area maximize as desktop. The panel hides the control
          // while it is an overlay (phone / <900) and toggles the shared body
          // class itself.
          maximize: true,
        },
        ui: {
          confirm: uiChoice,
          renderMarkdown,
          fileIcons: { baseUrl: iconBase },
        },
        initialOpen,
        onOpenChanged: (open) => {
          state.filesBrowse.open = open;
          document.body.classList.toggle("files-browse-open", open);
          try { sessionStorage.setItem("grok.remote.filesOpen", open ? "1" : "0"); } catch (_) { /* private mode */ }
        },
      });
      state.filesBrowse.component = panel;
      panel.toggleElement.id = "files-browse-btn";
      panel.toggleElement.classList.add("icon-btn");
    }
    placeRemoteFilesButton(panel.toggleElement);
    panel.toggleElement.hidden = false;
    void panel.setScope(currentRemoteFileScope());
    return true;
  }
  function remoteFilesButtonHost() {
    if (document.body.classList.contains("has-rail")) {
      const head = document.getElementById("session-head");
      if (head) return head;
    }
    return document.querySelector(".top-bar");
  }

  function placeRemoteFilesButton(btn) {
    const host = remoteFilesButtonHost();
    if (!host) return;
    let sep = document.getElementById("files-browse-sep");
    if (!sep) {
      sep = document.createElement("span");
      sep.id = "files-browse-sep";
      sep.className = "files-browse-sep";
      sep.setAttribute("aria-hidden", "true");
    }
    if (host.lastElementChild === btn && sep.nextElementSibling === btn) return;
    host.appendChild(sep);
    host.appendChild(btn);
  }

  function ensureRemoteFilesBrowser() {
    const available = remoteFilesBrowseAvailable();
    const panel = state.filesBrowse.component;
    if (!available) {
      const button = document.getElementById("files-browse-btn");
      if (button) button.hidden = true;
      if (panel) panel.setOpen(false);
      return;
    }
    // file-panel.js is part of the remote page's vendored UI bundle. There is no
    // second renderer here: a missing component is a packaging error, surfaced
    // visibly and recoverable by refreshing after the deploy is corrected.
    if (!ensureSharedRemoteFilePanel()) {
      console.error("Remote project files require media/file-panel.js");
    }
  }

  function handleProjectDirListing(msg) {
    settleRemoteFileRequest("list", msg);
  }

  function handleProjectFileContent(msg) {
    if (settlePreviewFileRequest(msg)) return;
    settleRemoteFileRequest("read", msg);
  }

  function handleProjectFileWriteResult(msg) {
    settleRemoteFileRequest("write", msg);
  }
  // Welcome screen's "about" link → Settings → About.
  const welcomeAboutLink = $("welcome-about-link");
  if (welcomeAboutLink) welcomeAboutLink.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openAboutPanel(); };
  addBtn.onclick = (e) => { e.stopPropagation(); openAddPopover(); };
  historyBtn.onclick = (e) => { e.stopPropagation(); openHistoryPopover(); };
  repoBtn.onclick = (e) => {
    e.stopPropagation();
    if (repoSwitcherLocked()) return;
    openRepoPopover();
  };
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
      if (LAUNCH_ACTS.includes(act)) markOnboardingLaunched(act, onbAction.dataset.provider);
      if (act === "runInstall") vscode.postMessage({ type: "runInstallCmd" });
      else if (act === "installCodex") vscode.postMessage({ type: "installCodex" });
      else if (act === "cancelCodexInstall") vscode.postMessage({ type: "cancelCodexInstall" });
      else if (act === "runLogin") vscode.postMessage({ type: "runGrokLogin" });
      else if (act === "recheck") vscode.postMessage({ type: "recheckConnection", provider: onbAction.dataset.provider });
      else if (act === "connectProvider") vscode.postMessage({ type: "runGrokLogin", provider: onbAction.dataset.provider });
      else if (act === "recheckProvider") vscode.postMessage({ type: "recheckConnection", provider: onbAction.dataset.provider });
      else if (act === "retryProvider") vscode.postMessage({ type: "retryProviderSession", provider: onbAction.dataset.provider });
      // Same message the desk sends. The host, not the client, decides that a
      // remote request means the headless flow — so there is one capability
      // here, not two, and nothing new for the policy table to gate.
      else if (act === "connectRemote") vscode.postMessage({ type: "runGrokLogin", provider: onbAction.dataset.provider });
      else if (act === "submitDeviceLoginCode") {
        const root = onbAction.closest(".onb");
        const input = root && root.querySelector(".onb-code-input");
        const code = input ? String(input.value || "").trim() : "";
        if (!code) return;
        vscode.postMessage({ type: "submitDeviceLoginCode", provider: onbAction.dataset.provider, code: code });
        // Deliberately NOT disabled here. This message can be dropped: the
        // relay client's outbox keeps queue releases and authored input across
        // a reconnect and drops everything else, and the reconnect is not an
        // edge case in this flow — a phone leaves for the vendor's page to get
        // the code and comes back on a new socket, which is the ONLY way to
        // reach this button. Disabling on the click meant a dropped code left a
        // dead field, a waiting CLI, and no way back but reopening Connect.
        //
        // The host echoes `submitted: true` once it has actually written the
        // code to the CLI, and the card disables the field on that frame. No
        // acknowledgement, no disable — so tapping Submit again just works.
      }
      else if (act === "cancelDeviceLogin") {
        vscode.postMessage({ type: "cancelDeviceLogin", provider: onbAction.dataset.provider });
        // Close on the click, not on the host's answer. The person has said
        // they are done; leaving the dialog up until a frame comes back makes
        // Cancel feel ignored, and if the answer never comes it stays up over
        // a flow that is already gone.
        if (connectWizardProvider() === onbAction.dataset.provider) closeConnectWizard();
      }
      else if (act === "addProjectFolder") openAddProjectMenu(onbAction);
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
    const thumbBtn = e.target.closest(".msg-thumb-btn");
    if (thumbBtn) {
      e.preventDefault();
      e.stopPropagation();
      if (state.replaying || !feedbackOffered()) return;
      const actions = thumbBtn.closest(".msg-actions");
      if (!actions || actions.dataset.feedbackPending === "1") return;
      if (actions !== liveTurnActions()) return;
      const clicked = Number(thumbBtn.dataset.rating);
      if (clicked !== 1 && clicked !== -1) return;
      const current = state.turnRating === 1 || state.turnRating === -1 ? state.turnRating : 0;
      const next = current === clicked ? 0 : clicked;
      actions.dataset.feedbackPending = "1";
      vscode.postMessage({ type: "turnFeedback", rating: next });
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
      if (isPendingClearNode(msgEl)) return;
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
      if (isPendingClearNode(msgEl)) return;
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
    // The browser client is a real web page with real navigation in its chrome:
    // the AFK Pilot brand in the top bar, the same brand in the rail, and the
    // "Pick another device" link in a connection notice. All of them point at
    // `/`, and this handler swallowed every one — preventDefault, then an
    // openFile for a path named "/" that the host correctly refused. Clicking
    // the logo did nothing and logged a policy drop.
    //
    // The page marks those anchors. Deliberately an explicit opt-out rather
    // than a rule about what the href looks like: a plan link is `/home/…` and
    // resolves same-origin exactly like `/` does, so any positional or
    // origin-based guess turns real file references into navigation away from
    // the conversation, which is worse than the bug.
    if (a.closest("[data-native-link]")) return;
    e.preventDefault();
    const href = a.getAttribute("href") || "";
    if (/^https?:\/\//i.test(href)) {
      // A remote has no host to route through: openUrl is host-local and is
      // dropped there, which is why the gear's repository link already opens
      // its own window. Same rule for a link in the transcript.
      if (IS_REMOTE) window.open(href, "_blank", "noopener");
      else vscode.postMessage({ type: "openUrl", url: href });
    } else if (/^[a-zA-Z]:[\\/]/.test(href) || href.startsWith("\\\\") || !/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      vscode.postMessage({ type: "openFile", path: href });
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const input = e.target && e.target.closest && e.target.closest(".onb-code-input");
    if (!input || input.disabled) return;
    e.preventDefault();
    const btn = input.closest(".onb") && input.closest(".onb").querySelector('[data-act="submitDeviceLoginCode"]');
    if (btn && !btn.disabled) btn.click();
  });

  /** Href a user would paste elsewhere, or "" when the link has no external
   *  form (chrome `data-native-link`, empty, javascript:, in-page hash). */
  function copyableLinkHref(anchor) {
    if (!anchor || typeof anchor.getAttribute !== "function") return "";
    if (anchor.closest && anchor.closest("[data-native-link]")) return "";
    const href = String(anchor.getAttribute("href") || "").trim();
    if (!href || href.charAt(0) === "#" || /^javascript:/i.test(href)) return "";
    return href;
  }

  function elementFromNode(node) {
    if (!node) return null;
    return node.nodeType === 1 ? node : node.parentElement;
  }

  function linkFromContextEvent(e) {
    const el = elementFromNode(e && e.target);
    if (el && el.closest) {
      const hit = el.closest("a[href]");
      if (hit) return hit;
    }
    const sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed) return null;
    const a = elementFromNode(sel.anchorNode);
    const f = elementFromNode(sel.focusNode);
    const aLink = a && a.closest ? a.closest("a[href]") : null;
    const fLink = f && f.closest ? f.closest("a[href]") : null;
    if (aLink && aLink === fLink) return aLink;
    if (aLink && (!f || aLink.contains(sel.focusNode))) return aLink;
    if (fLink && fLink.contains(sel.anchorNode)) return fLink;
    return null;
  }

  function writeClipboardText(text) {
    if (!navigator.clipboard || !navigator.clipboard.writeText) return;
    navigator.clipboard.writeText(text || "");
  }

  // Cut/Copy/Paste stay on the host/browser menu. Copy Link is ours, and only
  // when a real target is under the pointer — a disabled row would be a lie.
  document.addEventListener("contextmenu", (e) => {
    if (e.defaultPrevented) return;
    const a = linkFromContextEvent(e);
    const href = copyableLinkHref(a);
    if (!href) return;
    e.preventDefault();
    e.stopPropagation();
    closePopovers();
    closeRailMenu();
    const selected = String((window.getSelection && window.getSelection().toString()) || "");
    const items = [];
    if (selected) {
      items.push({
        label: "Copy",
        icon: ICON.copy,
        onSelect: () => writeClipboardText(selected),
      });
    }
    items.push({
      label: "Copy Link",
      icon: ICON.copy,
      onSelect: () => writeClipboardText(href),
    });
    openRailMenu(a, items, "chat-copy-link", { x: e.clientX, y: e.clientY });
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
        if (m) {
          const previewId = newRemoteTabToken();
          rememberImagePreview(previewId, dataUrl);
          vscode.postMessage({ type: "pasteImage", mimeType: m[1], data: m[2], previewId });
        }
        settle();
      };
      reader.readAsDataURL(blob);
    }
  });

  input.addEventListener("focus", () => {
    if (!IS_REMOTE) vscode.postMessage({ type: "composerFocus", focused: true });
  });
  input.addEventListener("blur", () => {
    composerPreferredColumn = null;
    if (!IS_REMOTE) vscode.postMessage({ type: "composerFocus", focused: false });
  });
  input.addEventListener("pointerdown", () => { composerPreferredColumn = null; });
  input.addEventListener("input", () => {
    composerPreferredColumn = null;
    updateSlash();
    updateMention();
    renderInputHighlight();
  });
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
    if (!(e.ctrlKey && String(e.key).toLowerCase() === "p")) composerPreferredColumn = null;
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
      : !remoteUsesTouchComposer() && e.key === "Enter" && !e.shiftKey;
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
    // The SAME anchor the opener used. Where the rail exists, `historyBtn` sits
    // in a display:none top bar and measures as a zero rect, so a rotate or a
    // window drag would re-place the popover against nothing.
    if (!historyPopover.hidden) positionDropdownPopover(historyPopover, railHistoryAnchor() || historyBtn);
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
  // clicking back into a panel that stayed alive.
  // Desktop launch always claims the composer on the first focused-window
  // event (Chromium otherwise lands on the first tabbable — rail search /
  // history). Later window-focus only claims when it landed on <body> — a
  // click that focused a real control keeps it, and a reconnect/resync must
  // not steal. VS Code never takes this launch shot: focus belongs to the
  // editor the user was already in.
  // applyChatZoom first: a stored desktop/remote scale must be on the body
  // before focus, or the first layout is at 1 and focus scrolls the overflow.
  // preventScroll: a taller-than-window first frame must not stick html.
  applyChatZoom();
  wireClientFontScaleShortcuts();
  window.addEventListener("focus", () => {
    if (takeDesktopLaunchComposerFocus()) return;
    const el = document.activeElement;
    if (!el || el === document.body) input.focus({ preventScroll: true });
  });
  input.focus({ preventScroll: true });
  if (IS_DESKTOP_CLIENT) resetDocumentScroll();

  if (IS_REMOTE) {
    // Host-page TTS seam; changes also emit `grokRemoteTtsChange` with { available, enabled }.
    window.grokRemoteTts = Object.freeze({
      get available() { return ttsAvailable; },
      get enabled() { return state.remoteTts; },
      setEnabled: setRemoteTtsEnabled,
      toggle: () => setRemoteTtsEnabled(!state.remoteTts),
    });
  }
  syncProviderVoice();
  initMermaid();
  initMathJax();
  claimRemoteTabIdentity((finalToken) => {
    resolveRemoteTabTokenReady(finalToken);
    vscode.postMessage({
      type: "ready",
      ...(IS_REMOTE && finalToken ? { tabToken: finalToken } : {}),
    });
    reportRemotePreferences();
  });
})();
