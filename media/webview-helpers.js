(function (root) {
  const FILE_EXTS = new Set([
    "ts","tsx","js","jsx","mjs","cjs","json","md","mdx","toml","yml","yaml",
    "css","scss","sass","less","html","htm","xml","svg",
    "py","rb","go","rs","java","kt","kts","swift","c","cc","cpp","cxx","h","hh","hpp",
    "cs","php","lua","sh","bash","zsh","fish","ps1","bat","cmd",
    "txt","lock","env","ini","cfg","conf","gitignore","dockerignore",
    "vue","svelte","astro","sql","prisma","graphql","gql",
  ]);

  /**
   * The members of FILE_EXTS that are WHOLE FILENAMES, not type names.
   *
   * The set above conflates two things, which is fine everywhere except for a
   * token that is nothing but a dot and a suffix. `.env` and `.gitignore` are
   * files someone can open; `.md` and `.json` are kinds of file. Only these
   * three survive as bare tokens.
   */
  const BARE_DOTFILE_NAMES = new Set(["env", "gitignore", "dockerignore"]);

  // The host <-> webview message contract. These MUST stay in sync with the TS
  // discriminated unions in src/protocol.ts (which is the source of truth) — the
  // webview is plain JS and can't import the compiled types, so it carries its own
  // copy and test/protocol.test.ts asserts the two are set-equal in both
  // directions (and that chat.js actually handles every host type).
  const HOST_MESSAGE_TYPES = [
    "initialState", "moveViewHint", "welcomeTips", "projectSetup", "githubState", "githubRepos", "providerState", "mcpServers", "mcpConnectors", "routines", "codexInstallProgress", "planModeAvailability", "showThinking", "appPurpose", "fontScale", "grokUpdateStatus", "updateAvailable", "updateReady", "telemetryEnabled", "thumbsFeedback", "initialized",
    "cliUpdating", "session", "sessionName", "modelChanged", "modeChanged", "openModePopover",
    "voiceState", "voiceConfigured", "voicePartial", "voiceSubmit", "voiceTranscript",
    "voiceError", "chips", "commandsUpdate", "mentionResults", "projectDirListing", "projectFileContent", "projectFileWriteResult", "userMessage", "agentStart", "thoughtChunk",
    "messageChunk", "media", "userMessageChunk", "historyReplay", "historyBatch", "permissionHistoryQueue",
    "planHistoryQueue", "toolCall", "toolCallUpdate", "permissionRequest", "permissionOptions",
    "permissionResolved", "exitPlanRequest", "planResolved", "questionRequest", "planNotice", "autoCompactNotice", "planBlocked",
    "promptComplete", "contextUsage", "commandOutput", "expandCommandOutputs", "setAllToolDetails", "focusInput", "findInSession", "restoreComposer", "truncateMessages", "uiConfirmRequest", "agentReset", "agentError", "agentEnd", "exit", "setBusy", "summarizing",
    "sessionContext", "clearMessages", "onboarding", "error", "hostNotice", "xaiNotification", "subagentUpdate", "childStream", "runProgress", "sessions", "repoSessions", "pinnedSessions", "repos",
    "sessionDot", "queuedSends", "submitQueuedSend", "steerUnavailable", "feedbackAvailability", "turnFeedbackAck", "usage", "steerByDefault", "soundNotifications", "processingSound", "readRepliesAloud", "summarizeRepliesAloud", "speechSummary", "imageFull", "moveComposerCaret",
    "remoteStatus",
  ];
  const WEBVIEW_MESSAGE_TYPES = [
    "ready", "remotePreferences", "send", "newSession", "cancel", "pickModel", "setMode", "removeChip",
    "toggleChip", "openFile", "showInFolder", "openUrl", "openText", "openDiff", "exportExpr", "setEffort",
    "addProjectFolder", "removeProjectFolder", "createProject", "cloneProject", "setupGithubCli", "listGithubRepos", "githubSignOut", "githubLoginWithToken",
    "openGlobalConfig", "openProjectConfig", "listMcpServers", "connectMcpConnector", "disconnectMcpConnector", "showLogs", "toggleDevTools", "openSettings", "openSettingsSurface", "closeSettingsSurface", "dismissWelcomeTip", "welcomeTipShown", "moveView",
    "listRoutines", "saveRoutine", "deleteRoutine", "setRoutinePaused", "runRoutineNow",
    "setShowThinking", "setAppPurpose", "setExpandCommandOutputs",
    "dropFile", "permissionAnswer", "exitPlanAnswer", "questionAnswer", "questionCancel",
    "setModel", "installCodex", "cancelCodexInstall", "runInstallCmd", "runGrokLogin", "cancelDeviceLogin", "submitDeviceLoginCode", "logout", "checkGrokUpdate", "updateGrok",
    "recheckConnection", "refreshProviders", "retryProviderSession", "listSessions", "listRepoSessions", "selectRepo", "toggleRepoPin", "setRepoArchived", "setRepoColor", "toggleSessionPin", "resumeSession", "renameSession", "deleteSession",
      "clearAllSessions", "pickFile", "mentionQuery", "addMentionFile", "listProjectDir", "readProjectFile", "writeProjectFile", "pasteImage", "uploadFile", "voiceStart", "voiceStop",
      "remoteVoiceStart", "remoteVoiceChunk", "remoteVoiceStop",
    "queueSend", "dequeueSend", "clearQueuedSends", "steerSend", "turnFeedback", "forkSession", "setSteerByDefault",
    "setSoundNotifications", "setProcessingSound", "setReadRepliesAloud", "setSummarizeRepliesAloud", "setVoiceSendPhrase", "setVoiceKeyterms", "setTelemetryEnabled", "setThumbsFeedback", "summarizeSpeech", "requestImageFull", "composerFocus",
    "newWorktreeSession", "applyWorktree", "removeWorktree", "rewindSession", "editLastMessage", "uiConfirmAnswer", "workflowControl", "refreshContextDetails",
    "remoteSignIn", "remoteSignOut", "unlinkRemoteDevice", "openRemotePortal",
    "openUpdateRelease", "restartToUpdate",
  ];
  const HOST_MESSAGE_TYPE_SET = new Set(HOST_MESSAGE_TYPES);
  /** True when `type` is a host->webview message the contract knows about. A
   *  false here means the host posted a type this webview build can't handle —
   *  drift the sync test is designed to prevent, warned at runtime as a backstop. */
  function isKnownHostMessage(type) {
    return HOST_MESSAGE_TYPE_SET.has(type);
  }

  function isImplicitChipId(id) {
    return String(id || "").startsWith("implicit:");
  }

  /** Explicit (user-staged) visible chips — images, files, @-mentions. */
  function explicitVisibleChips(chips) {
    return (chips || []).filter((chip) => chip && !chip.hidden && !isImplicitChipId(chip.id));
  }

  /** Typed text or a staged attachment — the implicit editor chip is not send-intent. */
  function composerHasSendIntent(text, chips) {
    if (String(text || "").trim()) return true;
    return explicitVisibleChips(chips).length > 0;
  }

  /**
   * Prefer additive `queued` entries (text + chips). Fall back to `items: string[]`
   * so an older host still renders the text-only block.
   */
  function normalizeQueuedSends(msg) {
    if (msg && Array.isArray(msg.queued)) {
      return msg.queued.map((entry) => ({
        text: typeof entry?.text === "string" ? entry.text : String(entry || ""),
        chips: Array.isArray(entry?.chips) ? entry.chips : [],
      }));
    }
    const items = msg && Array.isArray(msg.items) ? msg.items : [];
    return items.map((text) => ({ text: String(text || ""), chips: [] }));
  }

  function queuedSendsText(entries) {
    return (entries || []).map((entry) => entry.text || "").join("\n\n");
  }

  function queuedSendsChips(entries) {
    const chips = [];
    for (const entry of entries || []) {
      if (Array.isArray(entry.chips)) chips.push(...entry.chips);
    }
    return chips;
  }

  /**
   * CLI legend-row remainder: `used - (system + messages)`, floored at 0.
   * Null when either input is missing or the remainder is 0 — tool
   * definitions and usage categories are already inside those addends.
   * Callers must pass addends from the same snapshot as `used`.
   */
  function contextOverheadTokens(used, system, messages) {
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0) return null;
    if (typeof system !== "number" || !Number.isFinite(system) || system < 0) return null;
    if (typeof messages !== "number" || !Number.isFinite(messages) || messages < 0) return null;
    const overhead = used - (system + messages);
    return overhead > 0 ? overhead : null;
  }

  function finiteNonNeg(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  }

  /** True when a contextUsage frame carries session/info addends, not just occupancy. */
  function contextUsageHasBreakdown(msg) {
    if (!msg || typeof msg !== "object") return false;
    return msg.systemPromptTokens != null
      || msg.toolDefinitionsTokens != null
      || msg.toolDefinitionsCount != null
      || msg.messageTokens != null
      || msg.freeTokens != null
      || msg.autoCompactThresholdPercent != null
      || (Array.isArray(msg.categories) && msg.categories.length > 0);
  }

  /**
   * Bind structured session/info rows to the `used` they were measured with.
   * Occupancy-only frames keep the previous snapshot (overhead is computed
   * from that snapshot's used, never live occupancy minus stale addends).
   * Currency is `contextBreakdownIsCurrent`; an open popover re-fetches
   * rather than dropping the group. A live envelope that restates the same
   * used/window keeps the snapshot.
   */
  function nextContextBreakdown(prev, msg) {
    if (!msg || typeof msg !== "object") return prev || null;
    if (contextUsageHasBreakdown(msg)) {
      const used = finiteNonNeg(msg.used);
      if (used == null) return null;
      const win = typeof msg.window === "number" && Number.isFinite(msg.window) && msg.window > 0
        ? msg.window
        : null;
      return {
        used,
        window: win,
        systemPromptTokens: finiteNonNeg(msg.systemPromptTokens),
        toolDefinitionsTokens: finiteNonNeg(msg.toolDefinitionsTokens),
        toolDefinitionsCount: finiteNonNeg(msg.toolDefinitionsCount),
        messageTokens: finiteNonNeg(msg.messageTokens),
        freeTokens: finiteNonNeg(msg.freeTokens),
        autoCompactPct: typeof msg.autoCompactThresholdPercent === "number"
          && Number.isFinite(msg.autoCompactThresholdPercent)
          && msg.autoCompactThresholdPercent > 0
          ? msg.autoCompactThresholdPercent
          : null,
        categories: Array.isArray(msg.categories) && msg.categories.length ? msg.categories : null,
      };
    }
    if (!prev) return null;
    return prev;
  }

  /**
   * True while live occupancy still matches the used (and window, when both
   * known) the snapshot was measured with. promptComplete and modelChanged
   * can move occupancy without a contextUsage frame; an open popover then
   * re-fetches session/info instead of hiding the group.
   */
  function contextBreakdownIsCurrent(snapshot, used, window) {
    if (!snapshot || typeof snapshot.used !== "number") return false;
    if (snapshot.used !== used) return false;
    if (snapshot.window != null && typeof window === "number" && snapshot.window !== window) return false;
    return true;
  }

  /**
   * One pending user write. Paint immediately; the next frame that names
   * `key` is the authority and the overlay dies. Not a store — confirm,
   * contradict, and refuse all look like "a frame for this entity" from
   * here. A silent host cannot leave a lie: `timeoutMs` (default 8s)
   * clears the overlay and calls `onExpire`.
   */
  function createPendingOverlay(opts) {
    const onExpire = opts && typeof opts.onExpire === "function" ? opts.onExpire : null;
    let pending = null;
    let timer = null;
    function resolveTimeout() {
      if (opts && typeof opts.timeoutMs === "function") {
        const n = Number(opts.timeoutMs());
        return n > 0 ? n : 8000;
      }
      if (opts && Number(opts.timeoutMs) > 0) return Number(opts.timeoutMs);
      return 8000;
    }
    function clearTimer() {
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
    }
    function expire() {
      timer = null;
      if (!pending) return;
      pending = null;
      if (onExpire) onExpire();
    }
    return {
      paint(key, value) {
        clearTimer();
        pending = { key: String(key), value };
        timer = setTimeout(expire, resolveTimeout());
      },
      valueFor(key) {
        if (key == null || !pending || pending.key !== String(key)) return undefined;
        return pending.value;
      },
      has(key) {
        return !!(pending && key != null && pending.key === String(key));
      },
      peek() {
        return pending;
      },
      settle(key) {
        if (!pending || key == null || pending.key !== String(key)) return false;
        clearTimer();
        pending = null;
        return true;
      },
      settleAny(keys) {
        if (!pending) return false;
        for (const key of keys || []) {
          if (key != null && pending.key === String(key)) {
            clearTimer();
            pending = null;
            return true;
          }
        }
        return false;
      },
      clear() {
        clearTimer();
        pending = null;
      },
    };
  }

  // ---- "@" file mention (composer autocomplete) ----

  /** The `@token` under the caret, or null when no mention popover applies. `@`
   *  must start the text or follow whitespace, so emails/handles mid-word
   *  ("user@host") never trigger; the token can't contain whitespace or a second
   *  `@` (a space closes the popover). Caret-anchored like getSlashQuery. */
  function getMentionQuery(text, caret) {
    const before = String(text || "").slice(0, caret);
    const m = before.match(/(?:^|\s)@([^\s@]*)$/);
    return m ? m[1] : null;
  }

  /** Replace the partial `@token` before the caret with `@relPath ` (a popover
   *  pick) and return the new text + caret. Replacement is a function so `$`
   *  sequences in a path can't be misread as replace directives. */
  function applyMentionPick(text, caret, relPath) {
    const t = String(text || "");
    const before = t.slice(0, caret);
    const after = t.slice(caret);
    const newBefore = before.replace(/@[^\s@]*$/, () => "@" + relPath + " ");
    return { text: newBefore + after, caret: newBefore.length };
  }

  function looksLikeFileRef(s) {
    if (!s || s.length > 200) return false;
    if (s.includes("://")) return false; // URLs are never file refs
    // Strip only a TRAILING line ref (`:12`, `:12-34`, `:12:5`, `#L12[-L34]`) —
    // the shapes parseFileRef (src/file-ref.ts) can open. Stripping from the
    // FIRST `:`/`#` collapsed `C:\work\file.ts` to `C` (the drive colon), so
    // absolute Windows paths never linkified.
    const core = s.replace(/(?::\d+(?:-\d+|:\d+)?|#L\d+(?:-L?\d+)?)$/i, "");
    if (/[\s"'`<>|&;]/.test(core)) return false;
    const m = core.match(/\.([A-Za-z0-9]+)$/);
    if (!m) return false;
    const ext = m[1].toLowerCase();
    if (!FILE_EXTS.has(ext)) return false;
    // "I'll list the main `.md` files" — a bare extension names a TYPE. There is
    // no file behind it, so the link fails: the desk opens an editor on a
    // missing path and the phone asks the host for a file it hasn't got. A link
    // that leads nowhere is worse than a missing one, because it teaches people
    // not to trust the ones that work.
    //
    // Only applied to a token with no directory part. `docs/.md` would be a
    // strange filename but it is unambiguously a PATH — nobody writes that
    // while talking about a file type — whereas `.md` on its own is almost
    // always prose.
    if (/^\.[A-Za-z0-9]+$/.test(core)) return BARE_DOTFILE_NAMES.has(ext);
    return true;
  }

  function formatRelativeTime(ts, now) {
    if (!ts) return "";
    const base = typeof now === "number" ? now : Date.now();
    const diff = base - ts;
    const sec = Math.round(diff / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.round(hr / 24);
    if (day < 7) return `${day}d ago`;
    return new Date(ts).toLocaleDateString();
  }

  // Prefer the description's versioned lead when the advertised name is only a
  // family label (Claude: "Sonnet" + "Sonnet 5 · …" → "Sonnet 5"). Grok and
  // Codex already bake the generation into `name`, so this is a no-op there.
  function modelPickerLabel(model) {
    const name = String((model && (model.name || model.modelId)) || "").trim();
    const lead = String((model && model.description) || "").split("·")[0].trim();
    if (!lead) return name;
    if (!name) return lead;
    const family = name.replace(/\s*\([^)]*\)\s*$/, "").trim();
    if (family && lead.toLowerCase().startsWith(family.toLowerCase()) && lead.length > name.length) {
      return lead;
    }
    return name;
  }

  // Resolve a model ID to its user-facing name (e.g. "grok-build" → "Grok Build")
  // using the availableModels list from session/new. Falls back to the ID when
  // the model isn't in the list or has no name, so the label is never blank.
  function modelDisplayName(modelId, availableModels) {
    if (!modelId) return "";
    const m = (availableModels || []).find((x) => x && x.modelId === modelId);
    if (!m) return modelId;
    return modelPickerLabel(m) || modelId;
  }

  // Mic button state machine for voice control:
  //   idle → (start) → connecting → [host ready] → listening → (stop) → transcribing → (transcript) → idle
  // "connecting" covers the ~½–1s while the stream (ws + ffmpeg) spins up, so the
  // blue "listening" waves only appear once it's actually ready to capture — the
  // host moves connecting→listening by posting voiceState "listening". Any failure
  // resolves back to idle ("error"/"reset"). Pure + here so it's unit-testable.
  const MIC_STATES = ["idle", "connecting", "listening", "transcribing"];
  function nextMicState(current, event) {
    switch (event) {
      case "start":
        // Begin connecting (not yet capturing). Don't interrupt a transcription.
        return current === "idle" ? "connecting" : current;
      case "stop":
        // Stoppable while connecting or listening.
        return current === "listening" || current === "connecting" ? "transcribing" : current;
      case "transcript":
      case "error":
      case "reset":
        return "idle";
      default:
        return current;
    }
  }

  // Locate a TRAILING send-phrase (e.g. "grok send", any capitalization) in the
  // composer text — the occurrence that actually acts as the submit command — so
  // the webview can highlight it. Tolerates a comma/whitespace between words and
  // trailing punctuation, mirroring the host's parseVoiceCommand. Returns the
  // {index, length} of the match, or null. An empty phrase disables it.
  // One phrase word, tolerating the "send" ⇄ "sent" STT confusion (kept in sync
  // with phraseWordPattern in src/voice.ts).
  function phraseWordPattern(word) {
    const lower = word.toLowerCase();
    if (lower === "send" || lower === "sent") return "sen[dt]";
    return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  function trailingSendPhrase(text, phrase) {
    const t = text == null ? "" : String(text);
    const p = (phrase || "").trim();
    if (!p) return null;
    const words = p.split(/\s+/).map(phraseWordPattern);
    // Lookahead for trailing punctuation so the highlight covers only the phrase
    // words — the trailing "?"/"." stays part of the message and unhighlighted.
    const re = new RegExp("\\b" + words.join("[,\\s]+") + "\\b(?=[\\s.!?…]*$)", "i");
    const m = re.exec(t);
    if (!m) return null;
    return { index: m.index, length: m[0].length };
  }

  // Does this option already offer the "none of these, let me type" escape the
  // tool contract promises? Only used to decide whether the card must add one
  // itself (#85), so it errs toward recognising the CLI's: injecting a second
  // free-text choice beside grok's own is worse than not injecting at all, and
  // the CLI is free to word it differently the day it starts sending one.
  // Trailing ellipsis and punctuation are stripped because "Other…" and
  // "Other:" are the same offer.
  function isFreeTextOptionLabel(label) {
    const text = String(label ?? "").trim().toLowerCase()
      .replace(/[…\.\:\s]+$/, "")
      .replace(/\s+/g, " ");
    if (!text) return false;
    if (text === "other" || text.startsWith("other (") || text.startsWith("other -")) return true;
    return text === "something else" || text === "none of these" || text === "none of the above";
  }

  // Build the `answers` map for an ask_user_question response from the user's
  // per-question selections. `selections` is an array parallel to `questions`,
  // each entry the array of chosen option labels for that question. Returns the
  // map keyed by question text (multi-select labels joined with ", ", matching
  // grok's HashMap<String,String> contract) and `allAnswered` so the card knows
  // when Submit should be enabled.
  function buildQuestionAnswers(questions, selections) {
    const answers = {};
    let allAnswered = true;
    (questions || []).forEach((q, i) => {
      const picked = (selections && selections[i]) || [];
      if (picked.length === 0) allAnswered = false;
      answers[q.question] = picked.join(", ");
    });
    return { answers, allAnswered };
  }

  // Recognize a tool call that *spawns* a subagent, so the webview can give it a
  // distinct labeled card instead of burying it in the generic tool group.
  // grok's bundled docs describe a `spawn_subagent` tool with a `subagent_type`
  // parameter (general-purpose | explore | plan | custom), and we match that
  // shape (forward-compat; some builds may emit it). BUT the native-Windows
  // grok 0.2.x build does NOT actually emit `spawn_subagent` over ACP — it
  // delegates via a *background* `run_terminal_command` (`is_background:true`),
  // which we DO card, and then reads its output with
  // `get_command_or_subagent_output`. That output READER is not a delegation,
  // yet its name contains the substring "subagent", so it must be explicitly
  // excluded or it false-fires a card on the poller. See research/subagents.md
  // for the wire capture. Degrades gracefully (no match → the call stays in the
  // generic tool group).
  // EXACT tool names only (normalized: separators stripped, lowercased).
  // Titles routinely embed user content — grok titles a Grep call with its
  // query and a Read with its filename — so substring matching false-cards
  // ordinary tools the moment the user works ON subagent code (a search for
  // "isSubagentToolCall" produced a fake Subagent card).
  const SUBAGENT_TOOL_NAMES = new Set([
    "spawnsubagent", "subagent", "runsubagent", "spawnagent", "launchagent",
    "dispatchagent", "runagent", "delegate", "delegatetask", "task", "agent", "agents",
  ]);

  function isSubagentToolCall(call) {
    if (!call) return false;
    if (call.kind === "subagent" || call.kind === "agent") return true;
    // Structural marker on grok 0.2.9x: _meta["x.ai/tool"].name carries the
    // real tool id regardless of how the call is titled — and when present it
    // is AUTHORITATIVE both ways. grok-build names its delegation tool
    // "spawn_subagent", the Composer agent names it "Task"; anything else
    // (Grep/Read/…) is NOT a delegation no matter what the title says — grok
    // titles a Grep with its search pattern, so a grep FOR "spawn_subagent"
    // is titled exactly "spawn_subagent" (captured in
    // test/fixtures/composer-subagent-session.jsonl).
    const metaTool = call._meta && call._meta["x.ai/tool"];
    const metaName = metaTool && String(metaTool.name || "").replace(/[_\s-]/g, "").toLowerCase();
    if (metaName) return metaName === "spawnsubagent" || metaName === "task";
    const n = String(call.tool || call.name || call.title || "")
      .replace(/[_\s-]/g, "").toLowerCase();
    // grok's `get_command_or_subagent_output` polls a background task's output —
    // its name carries "subagent" but it is NOT a delegation, so never card it.
    if (/output$/.test(n) || n.startsWith("getcommand")) return false;
    if (SUBAGENT_TOOL_NAMES.has(n)) return true;
    const r = call.rawInput || call.input || {};
    if (r.subagent_type || r.subagentType || r.subagent ||
      r.agent_type || r.agentType || r.agent) return true;
    // grok 0.2.x has no spawn_subagent tool — it delegates by *backgrounding* a
    // run_terminal_command (rawInput.is_background:true, or a "[bg]" title) and
    // reads the result with the get_command_or_subagent_output poller (already
    // excluded above). Backgrounding IS grok's subagent mechanism on the native
    // build, so surface the spawn as a card. See research/subagents.md § Ground
    // truth. (A foreground command — is_background:false/absent — is untouched.)
    if (r.is_background === true || r.background === true) return true;
    if (/^\s*\[bg\]/i.test(String(call.title || ""))) return true;
    return false;
  }

  // Strip the CLI's envelope from a subagent result so the card shows the
  // child's actual words: <subagent_meta>/<subagent_result> plumbing blocks,
  // the leading "This is the output of the subagent:" / "response:" lines, ONE
  // wrapping <response>…</response> pair, and the trailing "Agent ID: …
  // (resume …)" hint. Every pattern is anchored to the leading/trailing
  // position, so identical text mid-answer survives untouched.
  function cleanSubagentOutput(text) {
    let s = String(text == null ? "" : text)
      .replace(/<subagent_(meta|result)>[\s\S]*?<\/subagent_\1>/g, "")
      .replace(/<\/?subagent_(meta|result)>/g, "")
      .trim();
    // Defense: if a whole poller blob (=== Task … === / Command / Status / …
    // === Output ===) reaches here unparsed, keep only the child's words.
    const outDivider = /^[\s\S]*?^===\s*Output\s*===\s*\n?/im;
    if (/^===\s*Task\s+/im.test(s) && outDivider.test(s)) s = s.replace(outDivider, "").trim();
    // A restored card's persisted body can lead with a `[subagent:<type>]` label
    // (the live path never shows it) — strip it FIRST so a label + lead-in combo
    // ("[subagent:x] response: …") still reaches the lead-in strips below.
    s = s.replace(/^\[subagent:[^\]]*\]\s*/i, "");
    s = s.replace(/^this is the output of the subagent:\s*/i, "");
    s = s.replace(/^response:\s*/i, "");
    // The Agent ID hint trails AFTER </response>, so strip it before the
    // end-anchored wrapping-pair check.
    s = s.replace(/\n\s*agent id:\s*[0-9a-f][0-9a-f-]*\s*(\([^)]*\))?\s*$/i, "").trim();
    const wrapped = /^<response>\s*([\s\S]*?)\s*<\/response>$/i.exec(s);
    if (wrapped) s = wrapped[1];
    return s.trim();
  }

  // A background subagent's result comes back on the `get_command_or_subagent_output`
  // poller. Live, that's a structured `rawOutput.TaskOutput.Result`; on a cold
  // `session/load` grok replays it FLATTENED to a text blob instead:
  //   === Task <id> ===
  //   Command: [subagent:<type>] <description>
  //   Status: completed|failed|cancelled
  //   Duration: 18.78s
  //   === Output ===
  //   <the child's actual words>
  //   <subagent_meta …>/<subagent_result …>
  // Parse that back into the same shape finishSubagentCard wants, so a restored
  // background delegation shows its result + duration instead of a bare, dead
  // poller row. Returns null unless the blob is genuinely a SUBAGENT task result
  // (a backgrounded shell command polls through the same tool — leave those be).
  function parseSubagentTaskResult(text) {
    const s = String(text == null ? "" : text);
    const taskM = /^===\s*Task\s+(\S+)\s*===/im.exec(s);
    if (!taskM) return null;
    const isSubagent = /Command:\s*\[subagent:/i.test(s) || /<subagent_(meta|result)\b/i.test(s);
    if (!isSubagent) return null;
    const statusM = /^\s*Status:\s*(\w+)/im.exec(s);
    const status = statusM ? statusM[1].toLowerCase() : "completed";
    let durationMs = null;
    const metaMs = /duration_ms\s*=\s*(\d+)/i.exec(s);
    const durSecs = /^\s*Duration:\s*([\d.]+)\s*s/im.exec(s);
    if (metaMs) durationMs = parseInt(metaMs[1], 10);
    else if (durSecs) durationMs = Math.round(parseFloat(durSecs[1]) * 1000);
    // Everything after the "=== Output ===" divider is the child's words; the
    // envelope trailers (<subagent_meta>/<subagent_result>) are stripped by
    // cleanSubagentOutput downstream. No divider → nothing usable.
    const outM = /^===\s*Output\s*===\s*\n?([\s\S]*)$/im.exec(s);
    const output = outM ? outM[1].trim() : "";
    return { taskId: taskM[1], status, durationMs, output, failed: status !== "completed" };
  }

  // Human label for a subagent card: the agent type grok delegated to
  // (`subagent_type`, e.g. "general-purpose"/"explore"/"plan"), or a description,
  // else a generic fallback.
  function subagentLabel(call) {
    const r = (call && (call.rawInput || call.input)) || {};
    // Prefer a named agent type; for a background-task delegation (no type) fall
    // back to the command being backgrounded, truncated for the card.
    const name = r.subagent_type || r.subagentType || r.agent_type || r.agentType ||
      r.subagent || r.agent || r.description || r.name || r.command;
    let s = name != null ? String(name).trim() : "";
    if (s.length > 48) s = s.slice(0, 47).replace(/\s+$/, "") + "…";
    if (s) return s;
    if (r.is_background === true || r.background === true) return "background task";
    return "Subagent";
  }

  // True when the scroll viewport is at (or within `threshold` px of) the
  // bottom. Drives the chat's "stick to bottom" auto-scroll: while the user is
  // pinned we follow streaming output, but once they scroll up to read history
  // we leave the view alone (#16). The threshold absorbs sub-pixel rounding and
  // lets a near-bottom position still count as pinned. Callers that have a
  // live line height should pass stickThresholdPx() so the slack is one-to-two
  // lines at the current zoom, not a fixed CSS-px constant.
  function shouldStickToBottom(scrollTop, scrollHeight, clientHeight, threshold) {
    const t = typeof threshold === "number" ? threshold : 40;
    const distanceFromBottom = scrollHeight - (scrollTop + clientHeight);
    return distanceFromBottom <= t;
  }

  // Slack for "still at the bottom" after a USER scroll. Scales with the
  // current line height so Cmd+= / --chat-zoom cannot turn one line of slack
  // into an unpin. Programmatic, focus-induced, and content-growth scrolls
  // must not consult this — they are not user intent.
  function stickThresholdPx(lineHeightPx) {
    const line = Number(lineHeightPx);
    const base = Number.isFinite(line) && line > 0 ? line : 20;
    return Math.max(24, base * 2);
  }

  // Split a string into text/math segments so the markdown renderer can pull
  // LaTeX out before HTML-escaping (math is full of \ { } & < > * _, which the
  // inline-markdown pass would otherwise mangle). grok emits TeX with backslash
  // delimiters — `\(...\)` inline and `\[...\]` display (confirmed against the
  // CLI), plus the conventional `$$...$$` for display. Single `$...$` is NOT a
  // delimiter: too many false positives with prose currency ("$5 and $10").
  // Each math segment carries `display` (block vs inline). Non-greedy + requires
  // at least one char so empty `\(\)`/`$$$$` stays literal text. Pure so it's
  // unit-testable; the actual KaTeX render lives in chat.js (impure global).
  function splitMath(text) {
    const src = text == null ? "" : String(text);
    const segs = [];
    const re = /\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$\$([\s\S]+?)\$\$/g;
    let last = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      if (m.index > last) segs.push({ type: "text", value: src.slice(last, m.index) });
      if (m[1] !== undefined) segs.push({ type: "math", value: m[1], display: true });
      else if (m[2] !== undefined) segs.push({ type: "math", value: m[2], display: false });
      else segs.push({ type: "math", value: m[3], display: true });
      last = re.lastIndex;
    }
    if (last < src.length) segs.push({ type: "text", value: src.slice(last) });
    return segs;
  }

  // Drop TeX macros KaTeX can't handle before rendering, so one unsupported
  // command doesn't paint a red error into an otherwise-fine equation. grok
  // emits `\label{...}` inside align/equation blocks for cross-referencing, but
  // KaTeX has no \ref/\eqref system so it renders \label as a red error token —
  // even though \label produces NO visible output in real LaTeX (it only sets a
  // reference target). Stripping it loses nothing visually and lets the
  // surrounding equation render. Pure so it's unit-testable.
  function stripUnsupportedTex(tex) {
    return (tex == null ? "" : String(tex)).replace(/\\label\s*\{[^}]*\}/g, "");
  }

  // Error text for a failed tool_call_update (status "failed"/"error"), else null.
  // grok reports the reason in rawOutput.message and/or a content[].content.text
  // blob (e.g. "Tool `image_to_video` failed: image reference not readable: …").
  // The extension never surfaced these, so a failed tool just looked like grok
  // giving up — this is what the chat renders on the row instead.
  function toolFailureText(call) {
    if (!call) return null;
    const status = String(call.status || "").toLowerCase();
    if (status !== "failed" && status !== "error") return null;
    const raw = call.rawOutput || {};
    if (typeof raw.message === "string" && raw.message.trim()) return raw.message.trim();
    const content = call.content;
    if (Array.isArray(content)) {
      for (const c of content) {
        const t = (c && c.content && c.content.text) || (c && c.text);
        if (typeof t === "string" && t.trim()) return t.trim();
      }
    }
    if (typeof raw.error === "string" && raw.error.trim()) return raw.error.trim();
    // Some tools put the reason under a variant-specific key rather than
    // message/error, with no content[] blob (e.g. list_dir → rawOutput.NotFound,
    // read_file → rawOutput.FileReadError). Mine the first stringy value —
    // skipping the "type" discriminant — so the row shows the real error instead
    // of the generic fallback.
    for (const k of Object.keys(raw)) {
      if (k === "type") continue;
      const v = raw[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "Tool call failed.";
  }

  // MIRROR of `isMediaGenToolCall` in src/acp-dispatch.ts — media-gen titles /
  // variants for /imagine, /imagine-video, image_edit, reference_to_video. Kept
  // in the webview so tool-result rendering (incl. remote) can gate failure
  // hints without a host rewrite or a new message type.
  // KEEP THE TWO IN STEP: test/media-gen-mirror.test.ts drives one fixture set
  // through both and fails if either is changed alone.
  function isMediaGenToolCall(payload, provider) {
    if (!payload || typeof payload !== "object") return false;
    const title = String(payload.title ?? "");
    if (provider === "codex") return payload.kind === "other" && title === "Image generation";
    // claude falls through to the grok-shaped title/variant checks and typically matches nothing.
    if (/^imagine(-video|-edit)?:/i.test(title)) return true;
    if (/^(image_gen|image_edit|video_gen|image_to_video|reference_to_video)\b/i.test(title)) return true;
    if (/^(image-to-video:|reference-to-video:)/i.test(title)) return true;
    const ri = payload.rawInput;
    return !!(ri && typeof ri === "object" && typeof ri.variant === "string" &&
      /imagegen|imageedit|videogen|imagetovideo|referencetovideo/i.test(ri.variant));
  }

  // Hint for Zero Data Retention blocking video generation. The API 400 names
  // output.upload_url (not user-settable); the fix is a Grok CLI privacy setting.
  // Narrow: only when the failure text carries that specific ZDR + upload_url
  // signature — not every 400, not every invalid-argument. Caller must already
  // know the tool is media-gen (isMediaGenToolCall / tracked mediaGenCallIds).
  // Text only — no host action.
  function mediaGenZeroRetentionHint(failureText) {
    if (typeof failureText !== "string" || !failureText) return null;
    if (!/Zero Data Retention/i.test(failureText)) return null;
    if (!/upload_url/i.test(failureText)) return null;
    return "Grok CLI /settings → Privacy → Coding data, retention, and training → Opt in.";
  }

  // Unpredicted tool titles (MCP dotted names especially) share a long prefix,
  // so tail-truncating them leaves a column of indistinguishable rows. Budget
  // includes the ellipsis; an odd remainder goes to the tail (the distinguisher).
  const TOOL_LABEL_MAX = 50;
  function middleElide(text, max) {
    const s = text == null ? "" : String(text);
    const limit = Number(max);
    if (!Number.isFinite(limit) || limit <= 0) return s;
    if (s.length <= limit) return s;
    if (limit === 1) return "…";
    const keep = limit - 1;
    const head = Math.floor(keep / 2);
    const tail = keep - head;
    return s.slice(0, head) + "…" + s.slice(s.length - tail);
  }

  // KEEP IN STEP with src/slash-filter.ts isAdvertisedSkill: grok advertises
  // skills with `_meta.scope` + `_meta.path`; builtins omit those keys.
  function isAdvertisedSkill(cmd) {
    if (!cmd || typeof cmd !== "object") return false;
    const meta = cmd._meta || cmd.meta;
    if (!meta || typeof meta !== "object") return false;
    const path = meta.path;
    const scope = meta.scope;
    return typeof path === "string" && path.length > 0 && typeof scope === "string" && scope.length > 0;
  }

  function isSlashBoundary(ch) {
    return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
  }

  // KEEP IN STEP with src/slash-filter.ts getSlashQuery. Skills load anywhere
  // (`atStart: false` after whitespace); commands dispatch only at position 0.
  function getSlashQuery(text, caret) {
    const src = text == null ? "" : String(text);
    const pos = Math.max(0, Math.min(Number(caret) || 0, src.length));
    const before = src.slice(0, pos);
    const m = before.match(/\/(\S*)$/);
    if (!m) return null;
    const slashIndex = before.length - m[0].length;
    if (slashIndex > 0 && !isSlashBoundary(before.charAt(slashIndex - 1))) return null;
    return { query: m[1], atStart: slashIndex === 0 };
  }

  // KEEP IN STEP with src/slash-filter.ts applySlashPick.
  function applySlashPick(text, caret, name) {
    const src = text == null ? "" : String(text);
    const pos = Math.max(0, Math.min(Number(caret) || 0, src.length));
    const before = src.slice(0, pos);
    const after = src.slice(pos);
    const hit = getSlashQuery(src, pos);
    if (!hit) return { text: src, caret: pos };
    const m = before.match(/\/(\S*)$/);
    if (!m) return { text: src, caret: pos };
    const slashIndex = before.length - m[0].length;
    const newBefore = before.slice(0, slashIndex) + "/" + name + " ";
    return { text: newBefore + after, caret: newBefore.length };
  }

  // KEEP IN STEP with src/slash-filter.ts filterCommands: name prefix, then
  // mid-name, then description-only; advertised order inside each tier (#110).
  function filterCommands(commands, query) {
    const list = Array.isArray(commands) ? commands : [];
    const q = String(query || "").toLowerCase();
    if (!q) return list;
    const prefix = [];
    const substring = [];
    const description = [];
    for (const c of list) {
      if (!c || typeof c.name !== "string") continue;
      const name = c.name.toLowerCase();
      if (name.startsWith(q)) prefix.push(c);
      else if (name.includes(q)) substring.push(c);
      else if (String(c.description || "").toLowerCase().includes(q)) description.push(c);
    }
    return prefix.concat(substring, description);
  }

  // First case-insensitive run of `query` in `text`, as text parts. Never
  // markup — the caller turns `hit` parts into a textContent span.
  function highlightQueryParts(text, query) {
    const src = text == null ? "" : String(text);
    const q = query == null ? "" : String(query);
    if (!src) return [];
    if (!q) return [{ text: src, hit: false }];
    const i = src.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return [{ text: src, hit: false }];
    const parts = [];
    if (i > 0) parts.push({ text: src.slice(0, i), hit: false });
    parts.push({ text: src.slice(i, i + q.length), hit: true });
    if (i + q.length < src.length) parts.push({ text: src.slice(i + q.length), hit: false });
    return parts;
  }

  function appendHighlightedText(el, text, query) {
    if (!el) return;
    const doc = el.ownerDocument;
    el.textContent = "";
    if (!doc) {
      el.textContent = text == null ? "" : String(text);
      return;
    }
    for (const part of highlightQueryParts(text, query)) {
      if (!part.text) continue;
      if (part.hit) {
        const mark = doc.createElement("span");
        mark.className = "slash-hl";
        mark.textContent = part.text;
        el.appendChild(mark);
      } else {
        el.appendChild(doc.createTextNode(part.text));
      }
    }
  }

  // Scannable program label for a command tool row: the executable (first token,
  // path-stripped, de-quoted) plus one following BARE word when it isn't a flag —
  // so `git status` / `npm test` stay distinguishable while a long `node -e "…"`
  // payload collapses to just `node`. The full command lives in the row's IN/OUT
  // detail. PowerShell `Verb-Noun` cmdlets survive (the hyphen is mid-token; only
  // a LEADING -/ marks a flag). A QUOTED next token is an argument/data (an echo
  // banner like `Write-Output '=== 1. git status ==='`), not a subcommand, so it's
  // dropped — otherwise it drags a long quoted string into the label. Only the
  // first statement is summarized (a ; | & or newline ends it). Always returns
  // something → "command" fallback, so an unparseable command still reads "Run command".
  function commandProgramLabel(command) {
    if (typeof command !== "string") return "command";
    let cleaned = command.trim();
    // A `(…)` subshell is grok's navigate-then-run idiom (`(cd dir ; cmd)`, the
    // POSIX form it emits even against a PowerShell host): strip the wrapping
    // parens and skip a leading `cd <dir>` prelude so the label names the command
    // that does the work, not the `(cd` plumbing. Outside a subshell the first
    // statement is used verbatim — a user-typed `cd src && npm test` keeps its `cd`.
    const subshell = cleaned.startsWith("(");
    if (subshell) cleaned = cleaned.replace(/^\(+\s*/, "").replace(/\s*\)+$/, "");
    const statements = cleaned.split(/\s*(?:&&|\|\||;|\||&|\n)\s*/).map((s) => s.trim()).filter(Boolean);
    const stmt = (subshell ? statements.find((s) => !/^cd(\s|$)/.test(s)) : undefined) || statements[0] || "";
    if (!stmt) return "command";
    // Tokenize, tracking whether each token was quoted (Windows paths / banners).
    const tokens = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(stmt)) !== null) {
      tokens.push({ text: m[1] ?? m[2] ?? m[3], quoted: m[1] !== undefined || m[2] !== undefined });
    }
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_]\w*=/.test(tokens[i].text)) i++; // skip FOO=bar env prefixes
    const rawProg = tokens[i] && tokens[i].text;
    if (!rawProg) return "command";
    const prog = rawProg.split(/[\\/]/).pop() || rawProg; // basename
    const nextTok = tokens[i + 1];
    // Append the next token only when it's a bare, non-flag word — a real
    // subcommand (`git status`), never a quoted argument value, a flag, or a
    // path/filename argument (`node research/x.cjs` → "node", not the script path).
    const next =
      nextTok && !nextTok.quoted && !/^[-/]/.test(nextTok.text) && !/[\\/]/.test(nextTok.text)
        ? nextTok.text
        : null;
    const label = next ? `${prog} ${next}` : prog;
    return label.length > 30 ? label.slice(0, 29) + "…" : label;
  }

  function commandTextPreview(text, maxLines) {
    const fullText = text == null ? "" : String(text);
    const lines = fullText.split("\n");
    const lineCount = lines.length;
    const shown = Math.max(0, Math.floor(maxLines));
    return {
      text: lines.slice(0, shown).join("\n"),
      lineCount,
      truncated: lineCount > shown,
    };
  }

  /** Resolve a sibling asset while preserving the deploy-version query carried
   * by the parent script URL. URL resolution drops that query by default. */
  function versionedSiblingUrl(relativePath, baseUrl) {
    const sibling = new URL(relativePath, baseUrl);
    sibling.search = new URL(baseUrl).search;
    return sibling.href;
  }

  // Same 100K display cap the host applies in `capCommandOutput` (acp-dispatch).
  // The webview attach path must produce the identical payload so a live Claude
  // row and an ACP session/load restore cannot disagree, and so the first
  // arriver is already correct.
  const MAX_COMMAND_OUTPUT_CHARS = 100000;

  function capCommandOutput(output, truncated, maxChars) {
    const cap = typeof maxChars === "number" ? maxChars : MAX_COMMAND_OUTPUT_CHARS;
    const text = typeof output === "string" ? output : "";
    const over = text.length > cap;
    return {
      output: over ? text.slice(0, cap) : text,
      truncated: !!(truncated || over),
    };
  }

  // Pull a self-executed shell command's result off a completed `tool_call_update`.
  // The cursor/Composer agent runs commands in its OWN CLI-side persistent shell
  // and reports the result on the completed update (keyed by `toolCallId`) instead
  // of delegating via `terminal/create` — so the #41 IN/OUT box, fed only by the
  // terminal `commandOutput` path, never gets output for those rows. Recover the
  // output + exit code here so the box can render it, matched reliably by
  // `toolCallId` (Composer completes commands OUT of issue order, so no order-based
  // guess is safe). Returns `{output, exitCode, truncated, cancelled, agentSawCut}`
  // or null when the update carries no command result. Pure. Claude's string
  // rawOutput is preferred over fenced `content`; the 100K cap matches the
  // host restore path. Always states `cancelled: false` — this path is never
  // a live terminal kill, and omitting the field would trip the old-host
  // fallback. Always states `agentSawCut: true` — this is a shell result.
  function extractToolResultOutput(call) {
    if (!call || typeof call !== "object") return null;
    // Host-normalized MCP rows carry `detailInput` (string or null). Their
    // OUT arrives as commandOutput with `agentSawCut: false`. Do not invent
    // a shell payload here — that would claim the agent saw a display cut.
    if (Object.prototype.hasOwnProperty.call(call, "detailInput")) return null;
    const ro = call.rawOutput;
    // Claude session/load (and the same live shape): rawOutput is the bare
    // stdout string; content is that stdout wrapped in a ```console fence, or
    // the tool description on the first row. Prefer the string.
    if (typeof ro === "string") {
      const capped = capCommandOutput(ro, false);
      return { output: capped.output, exitCode: null, truncated: capped.truncated, cancelled: false, agentSawCut: true };
    }
    // Output text: the decoded `content` text is cleanest; else decode rawOutput.output
    // (a byte array on the wire), else a plain string.
    let output = "";
    if (Array.isArray(call.content)) {
      const c = call.content.find((b) => b && b.content && typeof b.content.text === "string");
      if (c) output = c.content.text;
    }
    if (!output && ro) {
      if (typeof ro.output === "string") output = ro.output;
      else if (Array.isArray(ro.output)) {
        try { output = new TextDecoder().decode(Uint8Array.from(ro.output)); } catch { output = ""; }
      }
    }
    // grok reports the exit code as snake_case `exit_code`; tolerate camelCase too.
    const exitCode =
      ro && typeof ro.exit_code === "number" ? ro.exit_code
      : ro && typeof ro.exitCode === "number" ? ro.exitCode
      : null;
    if (!output && exitCode == null) return null; // nothing to show
    const capped = capCommandOutput(output, !!(ro && ro.truncated));
    return { output: capped.output, exitCode, truncated: capped.truncated, cancelled: false, agentSawCut: true };
  }

  // Paint [Cancelled] only for a live kill. A host that distinguishes kill from
  // "exit not reported" always includes `cancelled` (true or false) on every
  // commandOutput. Absence is an older host, which never hydrated replay
  // commandOutput, so null exit was a kill.
  function commandOutputWasCancelled(msg) {
    if (!msg || typeof msg !== "object") return false;
    if (Object.prototype.hasOwnProperty.call(msg, "cancelled")) return msg.cancelled === true;
    return msg.exitCode === null;
  }

  // Wording for a truncated OUT. This host always states `agentSawCut`
  // (true = the agent already saw this cut; false = display cap only).
  // Absence is an older host — do not attribute the cut either way.
  function commandOutputTruncationNote(msg) {
    if (!msg || typeof msg !== "object" || !msg.truncated) return "";
    if (Object.prototype.hasOwnProperty.call(msg, "agentSawCut")) {
      return msg.agentSawCut === true
        ? "output truncated — grok saw the same cut"
        : "output truncated — display only; the agent saw the full result";
    }
    return "output truncated";
  }

  // Parse the <vscode-context> envelope that prompt-builder.ts wraps around the
  // file-path context (attached files + the open-editor file). On session restore
  // grok replays the full prompt text; pulling the block back out lets us re-render
  // filename-only chips + the user's own text, instead of showing raw paths inline.
  // Must stay in sync with buildPrompt's format (src/prompt-builder.ts). Returns
  // { files: string[], body: string } — body is the prompt minus the block. When
  // there's no block (a plain message) files is empty and body is the input.
  function parseAttachmentContext(text) {
    if (typeof text !== "string") return { files: [], body: text || "" };
    const m = text.match(/<vscode-context[^>]*>\n?([\s\S]*?)\n?<\/vscode-context>\s*/);
    if (!m) return { files: [], body: text };
    const files = [];
    for (const raw of m[1].split("\n")) {
      const line = raw.trim();
      let mm;
      if ((mm = line.match(/^- (.+)$/))) files.push(mm[1]);
      else if ((mm = line.match(/^Attached file: (.+)$/))) files.push(mm[1]);
      else if ((mm = line.match(/^Currently open in the editor \(for context\): (.+)$/))) files.push(mm[1]);
    }
    const body = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
    return { files, body };
  }

  // Parse the leading fenced selection snippets buildPrompt (src/prompt-builder.ts)
  // emits for chips carrying a selection range, so restore re-renders them as
  // ranged chips (`a.ts:2-4`) instead of inline code blocks — matching the live
  // bubble. Must stay in sync with buildPrompt's block format:
  //
  //   `src/a.ts` (lines 2-4):
  //   ```ts
  //   …the selected lines…
  //   ```
  //
  // On the wire the snippets sit between the <vscode-context> envelope and the
  // user's own text, blank-line separated. Only complete blocks anchored at the
  // START of the body are peeled: a selection-shaped block in the middle of the
  // user's words stays put, and a half-streamed block (replay re-parses the whole
  // bubble on every chunk) stays in the body until its closing fence arrives.
  // buildPrompt does no fence escaping, so selected code containing a bare ```
  // line is ambiguous on the wire — we stop at the first standalone closing
  // fence, exactly as a markdown renderer would. Returns
  // { body, selections: [{path, start, end}] } with selections in block order.
  function parseSelectionBlocks(body) {
    const input = typeof body === "string" ? body : body || "";
    if (input.indexOf("(lines ") === -1 || input.indexOf("```") === -1) {
      return { body: input, selections: [] };
    }
    const HEADER = /^`([^`\n]+)` \(lines ([1-9]\d*)-([1-9]\d*)\):\n```[^\n]*\n/;
    const CLOSE = /(?:^|\n)```[ \t]*(?:\n|$)/;
    const selections = [];
    let rest = input;
    for (;;) {
      rest = rest.replace(/^\n+/, "");
      const header = rest.match(HEADER);
      if (!header) break;
      const start = Number(header[2]);
      const end = Number(header[3]);
      if (end < start) break; // not a shape buildPrompt produces
      const afterHeader = rest.slice(header[0].length);
      const close = afterHeader.match(CLOSE);
      if (!close) break; // half-streamed block — leave it for the next chunk
      selections.push({ path: header[1], start, end });
      rest = afterHeader.slice(close.index + close[0].length);
    }
    if (!selections.length) return { body: input, selections: [] };
    return { body: rest.trim(), selections };
  }

  // Parse the `[Image #N]` tags that buildPromptWithImages (src/prompt-builder.ts)
  // puts in the prompt text back out of a replayed body, so restore re-renders
  // image chips instead of raw tags. Must stay in sync with that format.
  // Current wire shape: one tag per TRAILING line, whose parenthetical carries a
  // do-not-Read hint — `[Image #N] (attached inline — …)` for pasted images,
  // `[Image #N] (origin/rel/path.png — attached inline; …)` for disk imports
  // (grok's CLI keeps its own copy of an inline image under the session's
  // assets/ dir and surfaces that path to the model, which then Read-attempts
  // the binary and fails — the hint stops that). Hint-less legacy shapes
  // (`[Image #N]`, `[Image #N] (path)`, LEADING tag lines, a single leading
  // inline `[Image #N] ` prefix) still parse. A tag-looking string in the
  // MIDDLE of the body is the user's own words and is left alone. Returns
  // { body, images: [{index, path?}] } with images in tag order.
  function parseImageTags(body) {
    if (typeof body !== "string" || body.indexOf("[Image #") === -1) {
      return { body: typeof body === "string" ? body : body || "", images: [] };
    }
    // Path capture is greedy + $-anchored so a parenthesized filename parses —
    // `shots/screenshot (1).png`, the browser-download dedup shape: backtracking
    // puts the close on the LAST `)`. A literal empty `()` no longer matches
    // (buildPromptWithImages never emits one), so that stays user text.
    const TAG_LINE = /^\[Image #(\d+)\](?: \((.+)\))?$/;
    // Strip the do-not-Read hint from the captured parenthetical: a capture
    // that IS the hint (pasted image) has no path; a `path — attached inline…`
    // capture keeps only the path. No hint marker → legacy capture, kept whole.
    const HINT = " — attached inline";
    const pathFromTag = (raw) => {
      if (!raw || raw.indexOf("attached inline") === 0) return undefined;
      const staged = raw.indexOf(" — local staged copy; thumbnail only; do not access this path");
      if (staged !== -1) return raw.slice(0, staged);
      const cut = raw.indexOf(HINT);
      return cut === -1 ? raw : raw.slice(0, cut);
    };
    const lines = body.split("\n");
    const trailing = [];
    let end = lines.length;
    while (end > 0) {
      const line = lines[end - 1].trim();
      if (line === "" && trailing.length === 0) { end -= 1; continue; } // trailing blank lines
      const m = line.match(TAG_LINE);
      if (!m) break;
      trailing.unshift({ index: Number(m[1]), path: pathFromTag(m[2]) });
      end -= 1;
    }
    let start = 0;
    const leading = [];
    while (start < end) {
      const m = lines[start].trim().match(TAG_LINE);
      if (!m) break;
      leading.push({ index: Number(m[1]), path: pathFromTag(m[2]) });
      start += 1;
    }
    let rest = lines.slice(start, end).join("\n").trim();
    // Legacy single-image shape: "[Image #1] what is this?" — tag inline at the
    // very start of the text. Only strip when it's the body's first characters.
    const inline = rest.match(/^\[Image #(\d+)\] (?=\S)/);
    if (inline) {
      leading.push({ index: Number(inline[1]), path: undefined });
      rest = rest.slice(inline[0].length);
    }
    return { body: rest.trim(), images: [...leading, ...trailing] };
  }

  // Line-level diff between two text regions, for rendering an edit's change
  // INLINE in the chat. grok sends the *replaced region* (search_replace's
  // old_string/new_string) as `oldText`/`newText`, NOT a computed diff — so we
  // compute one here (LCS backtrack), which also yields the honest `+added
  // −removed` line counts. Returns { lines: [{type:'ctx'|'add'|'del', text}],
  // added, removed, truncated }.
  //   - CRLF is normalized for BOTH comparison and display (a stray `\r` on
  //     native-Windows grok would otherwise make identical lines miscompare into
  //     phantom ±N across the whole region).
  //   - An empty region is ZERO lines, not one blank line — so a new-file create
  //     (oldText:"") reads as pure additions, not "−1".
  //   - Pathological huge regions skip the O(m·n) table and fall back to a flat
  //     replace (all-del then all-add), flagged `truncated`, so the UI never hangs.
  // A mid-turn interjection (Steer, #52) as the CLI persists and REPLAYS it:
  // it comes back on session/load as a user_message_chunk wrapped in this
  // envelope. It is folded into the turn that was already running, so it is not
  // its own prompt and gets NO rewind point — a bubble built from it must not
  // consume a rewind index, or every later bubble maps to the wrong turn.
  // Verified against a real session's chat_history/updates (synthetic_reason:
  // "interjection"); see research/rewind.md.
  const INTERJECTION_RE = /^\s*The user sent a message while you were working:\s*\r?\n/;

  function isInterjectionText(text) {
    return INTERJECTION_RE.test(String(text || ""));
  }

  /** Remove the CLI's replay-only interjection envelope while preserving the
   * user's original text. Classification still uses the untouched raw value. */
  function stripInterjectionEnvelope(text) {
    const raw = String(text || "");
    if (!isInterjectionText(raw)) return raw;
    const body = raw.replace(INTERJECTION_RE, "");
    const wrapped = /^\s*<user_query>\s*\r?\n?([\s\S]*?)\r?\n?\s*<\/user_query>\s*$/i.exec(body);
    return (wrapped ? wrapped[1] : body).trim();
  }

  // Replayed user-turn hide rules. appendUserChunk applies this verdict; the
  // export recorder reads the flags it sets, and truncateExportEvents uses it
  // directly, so a turn the transcript hid cannot appear in the markdown or
  // consume a surviving-turn slot.
  const SYSTEM_REMINDER_RE = /^\s*<system-reminder>/;
  const PLAN_MARKER_RE = /^\s*\[Plan (approved|rejected|cancelled)\]\s*/i;
  const LEGACY_PRIMER_RE = /^\s*\[grok-build-vscode primer v\d+\]/;

  function stripPlanMarker(text) {
    const raw = String(text || "");
    const m = PLAN_MARKER_RE.exec(raw);
    if (!m) return { matched: false, rest: raw };
    return { matched: true, rest: raw.slice(m[0].length) };
  }

  function replayedUserBubbleVerdict(text) {
    const raw = String(text || "");
    if (LEGACY_PRIMER_RE.test(raw)) return { hide: "turn", text: raw };
    if (SYSTEM_REMINDER_RE.test(raw)) return { hide: "reminder", text: raw };
    const mk = stripPlanMarker(raw);
    if (mk.matched && !mk.rest.trim()) return { hide: "marker", text: raw };
    return { hide: null, text: mk.matched ? mk.rest : raw };
  }

  // Permission-card option order (#68). The CLI sends `options` in its own
  // order, so the approve action isn't reliably first and the keyboard default
  // could land on a reject. Sort to a fixed, predictable order — approve first,
  // destructive last — and keep it STABLE within a rank so two options of the
  // same kind stay in the CLI's relative order. Unknown kinds sort between
  // allow and reject: a card must never make an unrecognized action the default,
  // and must never push it below the reject either.
  const PERM_OPTION_RANK = { allow_once: 0, allow_always: 1, reject_once: 3, reject_always: 4 };

  function orderPermissionOptions(options) {
    if (!Array.isArray(options)) return [];
    return options
      .map((opt, i) => ({ opt, i }))
      .sort((a, b) => {
        const ra = PERM_OPTION_RANK[a.opt && a.opt.kind] ?? 2;
        const rb = PERM_OPTION_RANK[b.opt && b.opt.kind] ?? 2;
        return ra === rb ? a.i - b.i : ra - rb;
      })
      .map((x) => x.opt);
  }

  // Which button should hold the keyboard default? The first plain-approve
  // option, never an "always" (a keystroke must not widen permission scope for
  // the rest of the session) and never a reject. Returns -1 when there is no
  // safe default, in which case the card takes no focus at all.
  function defaultPermissionIndex(orderedOptions) {
    if (!Array.isArray(orderedOptions)) return -1;
    return orderedOptions.findIndex((o) => o && o.kind === "allow_once");
  }

  // Should an arriving permission card steal keyboard focus? Only when there is
  // nothing to steal it FROM: a composer with text (or a live IME composition)
  // means the user is mid-thought, and replay means this card is history being
  // re-rendered, not a live ask.
  function shouldFocusPermissionCard(state) {
    const s = state || {};
    if (s.replaying) return false;
    if (s.composing) return false;
    if ((s.composerText || "").trim().length > 0) return false;
    return s.defaultIndex >= 0;
  }

  // A printable keystroke on a focused card button means the user wants to
  // type, not to answer — redirect it to the composer instead of activating a
  // button (or worse, silently swallowing the character). Modified keys and
  // named keys (Tab/Enter/Escape/arrows) are navigation, not text.
  function isTypeThroughKey(e) {
    if (!e || e.ctrlKey || e.metaKey || e.altKey) return false;
    return typeof e.key === "string" && e.key.length === 1;
  }

  // Browser TTS receives raw Markdown, not the rendered DOM. Omit fenced code
  // entirely, then flatten the remaining lightweight Markdown into speech.
  function spokenTextFromMarkdown(markdown) {
    return String(markdown || "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/~~~[\s\S]*?~~~/g, " ")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, " ")
      .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gm, "")
      .replace(/[*_~`]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // The relay currently returns plain HostMsg-shaped errors without a request
  // id. Only these canonical texts are attributable to a refused browser send.
  //
  // The quota tail is deliberately loose. It used to require the whole
  // sentence, which made the relay's exact wording a wire contract with this
  // regex. The relay later shortened that sentence; this stopped matching, the
  // refused send never became the editable "Not sent" block, and the user's
  // text was lost on the next reload. Match the stable identifying prefix and
  // let the tail vary \u2014 the anchors plus the message-count shape are what make
  // the text attributable, not the wording that follows.
  function isRelaySendRejection(text) {
    return /^(?:Slow down \u2014 at most \d+ messages per minute\.|Free plan limit reached \(\d+ messages this week\)\. Resets in .+)$/
      .test(String(text || ""));
  }

  /**
   * Side-panel re-clamp on window resize: skip while any element is full-screen.
   * Entering full-screen fires resize mid-transition; measuring then captures a
   * bogus width that sticks after exit. Callers still re-clamp once on
   * fullscreenchange exit (see wireFullscreenSafeReclamp).
   */
  function panelReclampOnResizeAllowed(fullscreenElement) {
    return !fullscreenElement;
  }

  /**
   * When preferred side-panel widths + chat floor exceed the available window,
   * shrink open panels proportionally (never below each panel's floor). When
   * there is room, return preferred widths so a drag the user made is honoured
   * again after the window grows. Closed panels contribute 0.
   *
   * @param {{
   *   available: number,
   *   chatMin: number,
   *   panels: Array<{ id: string, preferred: number, min: number, open: boolean }>
   * }} opts
   * @returns {Record<string, number>}
   */
  function distributeSidePanelWidths(opts) {
    const available = Math.max(0, Math.round(Number(opts && opts.available) || 0));
    const chatMin = Math.max(0, Math.round(Number(opts && opts.chatMin) || 0));
    const panels = opts && Array.isArray(opts.panels) ? opts.panels : [];
    /** @type {Record<string, number>} */
    const out = {};
    /** @type {Array<{ id: string, min: number, preferred: number }>} */
    const open = [];
    for (const p of panels) {
      const id = String((p && p.id) || "");
      if (!id) continue;
      const min = Math.max(0, Math.round(Number(p.min) || 0));
      const preferred = Math.max(min, Math.round(Number(p.preferred) || min));
      if (!p || !p.open) {
        out[id] = 0;
        continue;
      }
      open.push({ id, min, preferred });
    }
    if (open.length === 0) return out;

    const preferredSum = open.reduce((s, p) => s + p.preferred, 0);
    const minSum = open.reduce((s, p) => s + p.min, 0);
    const budget = Math.max(0, available - chatMin);

    if (budget >= preferredSum) {
      for (const p of open) out[p.id] = p.preferred;
      return out;
    }
    if (budget <= minSum) {
      for (const p of open) out[p.id] = p.min;
      return out;
    }

    // Shrink only the above-floor slack, in proportion to how much each panel
    // sits above its floor — so a wide rail and a narrow panel both give ground.
    const slackTotal = preferredSum - minSum;
    const slackBudget = budget - minSum;
    let assigned = 0;
    for (let i = 0; i < open.length; i++) {
      const p = open[i];
      const above = p.preferred - p.min;
      let w;
      if (i === open.length - 1) {
        w = budget - assigned; // last absorbs rounding residue
      } else {
        const share = slackTotal > 0 ? above / slackTotal : 1 / open.length;
        w = Math.round(p.min + share * slackBudget);
      }
      w = Math.max(p.min, w);
      out[p.id] = w;
      assigned += w;
    }
    return out;
  }

  /**
   * Wire resize re-clamp that ignores full-screen transitions and re-runs once
   * after full-screen exits (window size may have changed meanwhile).
   * @param {() => void} reclamp measure + apply (caller owns the math)
   * @param {{ window?: Window, document?: Document }} [roots] inject for tests
   * @returns {() => void} dispose
   */
  function wireFullscreenSafeReclamp(reclamp, roots) {
    const win = (roots && roots.window) || (typeof window !== "undefined" ? window : null);
    const doc = (roots && roots.document) || (typeof document !== "undefined" ? document : null);
    if (!win || !doc || typeof reclamp !== "function") return function () {};
    function onResize() {
      if (!panelReclampOnResizeAllowed(doc.fullscreenElement)) return;
      reclamp();
    }
    function onFullscreenChange() {
      if (!doc.fullscreenElement) reclamp();
    }
    win.addEventListener("resize", onResize);
    doc.addEventListener("fullscreenchange", onFullscreenChange);
    return function dispose() {
      win.removeEventListener("resize", onResize);
      doc.removeEventListener("fullscreenchange", onFullscreenChange);
    };
  }

  /**
   * Body `--chat-zoom` (CSS zoom). getBoundingClientRect is in visual/client px;
   * style.top/left/width under a zoomed body are layout px — divide by this.
   */
  function chatZoomFactor(doc) {
    const d = doc || (typeof document !== "undefined" ? document : null);
    if (!d || !d.body) return 1;
    let raw = "";
    try {
      raw = d.body.style.getPropertyValue("--chat-zoom") || "";
    } catch (_) { /* */ }
    if (!raw && typeof getComputedStyle === "function") {
      try {
        raw = getComputedStyle(d.body).getPropertyValue("--chat-zoom") || "";
      } catch (_) { /* */ }
    }
    const z = Number(String(raw).trim());
    return Number.isFinite(z) && z > 0 ? z : 1;
  }

  /** Visual/client px → layout CSS px under body chat zoom. */
  function unzoomClientPx(clientPx, zoom) {
    const z = zoom == null ? 1 : Number(zoom);
    const n = Number(clientPx);
    if (!Number.isFinite(n)) return 0;
    if (!Number.isFinite(z) || z === 0 || z === 1) return n;
    return n / z;
  }

  function computeLineDiff(oldText, newText, opts) {
    const maxProduct = (opts && opts.maxProduct) || 4000000; // ~2000×2000 line cap
    const norm = (t) => (t == null ? "" : String(t).replace(/\r\n?/g, "\n"));
    const o = norm(oldText);
    const n = norm(newText);
    const oldLines = o === "" ? [] : o.split("\n");
    const newLines = n === "" ? [] : n.split("\n");
    const m = oldLines.length;
    const k = newLines.length;
    if (m * k > maxProduct) {
      const lines = [];
      for (const t of oldLines) lines.push({ type: "del", text: t });
      for (const t of newLines) lines.push({ type: "add", text: t });
      return { lines, added: k, removed: m, truncated: true };
    }
    // LCS length table, filled from the bottom-right so a forward backtrack emits
    // lines in source order.
    const dp = [];
    for (let i = 0; i <= m; i++) dp.push(new Int32Array(k + 1));
    for (let i = m - 1; i >= 0; i--) {
      const row = dp[i];
      const next = dp[i + 1];
      for (let j = k - 1; j >= 0; j--) {
        row[j] = oldLines[i] === newLines[j]
          ? next[j + 1] + 1
          : (next[j] >= row[j + 1] ? next[j] : row[j + 1]);
      }
    }
    const lines = [];
    let added = 0;
    let removed = 0;
    let i = 0;
    let j = 0;
    while (i < m && j < k) {
      if (oldLines[i] === newLines[j]) {
        lines.push({ type: "ctx", text: oldLines[i] });
        i++; j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        lines.push({ type: "del", text: oldLines[i] });
        removed++; i++;
      } else {
        lines.push({ type: "add", text: newLines[j] });
        added++; j++;
      }
    }
    while (i < m) { lines.push({ type: "del", text: oldLines[i] }); removed++; i++; }
    while (j < k) { lines.push({ type: "add", text: newLines[j] }); added++; j++; }
    return { lines, added, removed, truncated: false };
  }

  // Session → Markdown. Consumes the same host→webview event shapes the
  // renderer already sees (userMessage / messageChunk / toolCall / …), so an
  // export is exactly what this client holds — including a remote snapshot's
  // recent window. Thinking traces stay out; images are named, not embedded.
  const EXPORT_TOOL_OUTPUT_LINES = 8;
  const EXPORT_EVENT_TYPES = new Set([
    "userMessage", "userMessageChunk", "messageChunk",
    "toolCall", "toolCallUpdate", "commandOutput", "media",
    "agentStart", "agentEnd", "agentError",
  ]);

  function exportSessionFilename(title) {
    const base = String(title || "conversation")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\.md$/i, "")
      .slice(0, 80) || "conversation";
    return base + ".md";
  }

  function isExportableSessionEvent(msg) {
    return !!(msg && EXPORT_EVENT_TYPES.has(msg.type));
  }

  /** Flatten nested `historyBatch` frames into the host-message stream they wrap. */
  function flattenHistoryMessages(messages) {
    const out = [];
    const walk = (list) => {
      if (!Array.isArray(list)) return;
      for (const ev of list) {
        if (!ev || typeof ev !== "object") continue;
        if (ev.type === "historyBatch") walk(ev.messages);
        else if (ev.type !== "historyReplay") out.push(ev);
      }
    };
    walk(messages);
    return out;
  }

  const HISTORY_EVENT_TYPES = new Set([
    "thoughtChunk", "messageChunk", "toolCall", "toolCallUpdate",
  ]);

  /**
   * Split a replay stream so only the last `windowTurns` counted user bubbles
   * render on open (#102). Prefix is older complete turns, never the live tail.
   * `windowTurns <= 0` keeps everything in prefix (used to trim a prefix head).
   */
  function splitHistoryWindow(messages, windowTurns) {
    const flat = flattenHistoryMessages(messages);
    const n = Math.floor(Number(windowTurns));
    const starts = [];
    let i = 0;
    while (i < flat.length) {
      const ev = flat[i];
      if (ev.type === "userMessage") {
        if (!ev.steer) starts.push(i);
        i += 1;
        continue;
      }
      if (ev.type === "userMessageChunk") {
        const start = i;
        let text = String(ev.text || "");
        i += 1;
        while (i < flat.length && flat[i].type === "userMessageChunk") {
          text += String(flat[i].text || "");
          i += 1;
        }
        if (isInterjectionText(text)) continue;
        if (replayedUserBubbleVerdict(text).hide) continue;
        starts.push(start);
        continue;
      }
      i += 1;
    }
    if (!Number.isFinite(n) || n <= 0) {
      return { prefix: flat, suffix: [], prefixUserCount: starts.length };
    }
    if (starts.length <= n) {
      return { prefix: [], suffix: flat, prefixUserCount: 0 };
    }
    const splitAt = starts[starts.length - n];
    return {
      prefix: flat.slice(0, splitAt),
      suffix: flat.slice(splitAt),
      prefixUserCount: starts.length - n,
    };
  }

  /**
   * Cards whose `afterUserMessage` falls in `[startUserCount, endUserCount]`
   * belong to this hydrated chunk. The rest stay deferred for later prepends.
   */
  function partitionHistoryCards(cards, startUserCount, endUserCount) {
    const inChunk = [];
    const rest = [];
    const start = Number(startUserCount);
    const end = Number(endUserCount);
    for (const card of Array.isArray(cards) ? cards : []) {
      const pos = card && card.afterUserMessage;
      if (typeof pos === "number" && Number.isFinite(pos) && pos >= start && pos <= end) {
        inChunk.push(card);
      } else {
        rest.push(card);
      }
    }
    return { inChunk, rest };
  }

  /** Counters the live replay handlers would have reached after `messages`. */
  function countHistoryReplayCounters(messages) {
    const flat = flattenHistoryMessages(messages);
    let userMsgCount = 0;
    let interjectionCount = 0;
    let historyEventCount = 0;
    let suppressTurn = false;
    let i = 0;
    while (i < flat.length) {
      const ev = flat[i];
      if (ev.type === "userMessage") {
        suppressTurn = false;
        if (ev.steer) interjectionCount += 1;
        else userMsgCount += 1;
        i += 1;
        continue;
      }
      if (ev.type === "userMessageChunk") {
        let text = String(ev.text || "");
        i += 1;
        while (i < flat.length && flat[i].type === "userMessageChunk") {
          text += String(flat[i].text || "");
          i += 1;
        }
        const verdict = replayedUserBubbleVerdict(text);
        if (verdict.hide === "turn") {
          suppressTurn = true;
          continue;
        }
        if (verdict.hide === "reminder" || verdict.hide === "marker") continue;
        suppressTurn = false;
        if (isInterjectionText(text)) {
          interjectionCount += 1;
          continue;
        }
        userMsgCount += 1;
        continue;
      }
      if (!suppressTurn && HISTORY_EVENT_TYPES.has(ev.type)) historyEventCount += 1;
      i += 1;
    }
    return { userMsgCount, interjectionCount, historyEventCount };
  }

  function exportBasename(pathStr) {
    const s = String(pathStr || "");
    if (!s) return "";
    return s.split(/[\\/]/).pop() || s;
  }

  function exportFence(text) {
    const body = String(text || "").replace(/\r\n/g, "\n").replace(/\s+$/, "");
    let ticks = "```";
    while (body.indexOf(ticks) !== -1) ticks += "`";
    return ticks + "\n" + body + "\n" + ticks;
  }

  function exportTrimmed(text) {
    const preview = commandTextPreview(text, EXPORT_TOOL_OUTPUT_LINES);
    return preview.truncated ? preview.text.replace(/\s+$/, "") + "\n…" : preview.text;
  }

  function exportImageRef(index, pathStr) {
    const name = exportBasename(pathStr);
    if (name && !/^Image #\d+$/i.test(name)) {
      return typeof index === "number" ? `[Image #${index}] (${name})` : `[Image: ${name}]`;
    }
    return typeof index === "number" ? `[Image #${index}]` : "[Image]";
  }

  function exportUserParts(text, chips, extraImages) {
    const stripped = stripInterjectionEnvelope(text || "");
    const ctx = parseAttachmentContext(stripped);
    const sel = parseSelectionBlocks(ctx.body);
    const img = parseImageTags(sel.body);
    const files = ctx.files.slice();
    for (const s of sel.selections) {
      const label = s.start === s.end ? `${s.path}:${s.start}` : `${s.path}:${s.start}-${s.end}`;
      if (files.indexOf(label) === -1) files.push(label);
    }
    const images = img.images.slice();
    const pushImage = (index, pathStr) => {
      if (images.some((im) => im.index === index && (im.path || "") === (pathStr || ""))) return;
      if (typeof index === "number" && images.some((im) => im.index === index)) return;
      images.push({ index, path: pathStr || undefined });
    };
    for (const chip of chips || []) {
      if (!chip) continue;
      if (chip.imageIndex != null) {
        const p = chip.originRelPath || chip.relPath || chip.path;
        pushImage(chip.imageIndex, typeof p === "string" ? p : undefined);
      } else {
        const p = chip.relPath || chip.path;
        if (p && files.indexOf(p) === -1) files.push(p);
      }
    }
    for (const im of extraImages || []) {
      if (!im) continue;
      pushImage(im.imageIndex != null ? im.imageIndex : im.index, im.path || im.originRelPath);
    }
    return { text: img.body, files, images };
  }

  function flattenExportEvents(events) {
    const out = [];
    const walk = (list) => {
      if (!Array.isArray(list)) return;
      for (const ev of list) {
        if (!ev || typeof ev !== "object") continue;
        if (ev.type === "historyBatch") walk(ev.messages);
        else out.push(ev);
      }
    };
    walk(events);
    return out;
  }

  // Same counted-user-turn notion as `.msg.user:not(.queued)` with
  // `dataset.steer !== "1"`: live `userMessage` counts unless posted as a
  // steer; replayed chunks use replayedUserBubbleVerdict + isInterjectionText.
  function exportUserGroupCountsAsTurn(group) {
    if (!group.length) return false;
    if (group.some((ev) => ev && ev.steer)) return false;
    const text = group.map((ev) => (ev && ev.text) || "").join("");
    if (group[0].type === "userMessage") return true;
    if (isInterjectionText(text)) return false;
    return !replayedUserBubbleVerdict(text).hide;
  }

  function truncateExportEvents(events, surviving) {
    const keep = Math.max(0, Number(surviving) || 0);
    const list = flattenExportEvents(events);
    const out = [];
    let counted = 0;
    for (let i = 0; i < list.length; ) {
      const ev = list[i];
      if (ev && (ev.type === "userMessage" || ev.type === "userMessageChunk")) {
        const group = [ev];
        if (ev.type === "userMessageChunk") {
          while (
            i + group.length < list.length &&
            list[i + group.length] &&
            list[i + group.length].type === "userMessageChunk"
          ) {
            group.push(list[i + group.length]);
          }
        }
        if (exportUserGroupCountsAsTurn(group)) {
          if (counted >= keep) return out;
          counted += 1;
        }
        for (const item of group) out.push(item);
        i += group.length;
        continue;
      }
      out.push(ev);
      i += 1;
    }
    return out;
  }

  function exportToolLine(rec) {
    const lines = [];
    const call = rec.call || {};
    if (rec.subagent) {
      const label = (typeof call.rawInput?.description === "string" && call.rawInput.description.trim())
        || (typeof call.title === "string" && call.title.trim() && !/^(spawn_subagent|task)$/i.test(call.title) ? call.title.trim() : "")
        || subagentLabel(call)
        || "subagent";
      lines.push(`- Subagent · ${label}`);
      const rawOut = call.rawOutput || {};
      const nested = rawOut.SubagentCompleted && typeof rawOut.SubagentCompleted.output === "string"
        ? rawOut.SubagentCompleted.output
        : (typeof rawOut.output === "string" ? rawOut.output : rec.output);
      const cleaned = cleanSubagentOutput(nested || "");
      if (cleaned) {
        lines.push("", exportFence(exportTrimmed(cleaned)));
      }
      return lines;
    }
    if (rec.command) {
      const label = commandProgramLabel(rec.command);
      lines.push(`- Run \`${label}\``);
      const body = rec.output
        ? `$ ${rec.command}\n${rec.output}`
        : rec.command;
      lines.push("", exportFence(exportTrimmed(body)));
      return lines;
    }
    const title = (typeof call.title === "string" && call.title.trim())
      || (typeof rec.kind === "string" && rec.kind)
      || "tool";
    const detailInput = typeof call.detailInput === "string" && call.detailInput.trim()
      ? call.detailInput.trim()
      : "";
    const parts = [];
    if (detailInput) parts.push(detailInput);
    if (rec.output) parts.push(rec.output);
    lines.push(`- ${title}`);
    if (parts.length) {
      lines.push("", exportFence(exportTrimmed(parts.join("\n\n"))));
    }
    return lines;
  }

  function exportSessionMarkdown(events, opts) {
    const options = opts || {};
    const title = String(options.title || "Conversation").trim() || "Conversation";
    const windowed = !!options.windowed;
    const sections = [];
    let userText = "";
    let userChips = [];
    let userImages = [];
    let agentText = "";
    let tools = new Map();
    let toolOrder = [];
    let mediaItems = [];

    const newToolRec = (id) => ({ id, call: {}, command: "", output: "", kind: "", subagent: false });

    const mergeTool = (call) => {
      if (!call || typeof call !== "object") return;
      const id = call.toolCallId || `anon-${toolOrder.length}`;
      let rec = tools.get(id);
      if (!rec) {
        rec = newToolRec(id);
        tools.set(id, rec);
        toolOrder.push(id);
      }
      rec.call = Object.assign({}, rec.call, call);
      if (call.kind) rec.kind = call.kind;
      if (isSubagentToolCall(call) || isSubagentToolCall(rec.call)) rec.subagent = true;
      const ri = call.rawInput || {};
      if (typeof ri.command === "string") rec.command = ri.command;
      const extracted = extractToolResultOutput(call);
      if (extracted && extracted.output) rec.output = extracted.output;
    };

    const attachCommand = (msg) => {
      const id = typeof msg.toolCallId === "string" && msg.toolCallId.trim()
        ? msg.toolCallId.trim()
        : "";
      if (id) {
        let rec = tools.get(id);
        if (!rec) {
          rec = newToolRec(id);
          tools.set(id, rec);
          toolOrder.push(id);
        }
        if (typeof msg.output === "string") rec.output = msg.output;
        return;
      }
      const command = typeof msg.command === "string" ? msg.command : "";
      for (let i = toolOrder.length - 1; i >= 0; i--) {
        const rec = tools.get(toolOrder[i]);
        if (rec && rec.command === command) {
          if (typeof msg.output === "string") rec.output = msg.output;
          return;
        }
      }
      const fallbackId = `cmd-${toolOrder.length}`;
      const rec = newToolRec(fallbackId);
      rec.command = command;
      rec.output = typeof msg.output === "string" ? msg.output : "";
      rec.kind = "execute";
      tools.set(fallbackId, rec);
      toolOrder.push(fallbackId);
    };

    const flushUser = () => {
      if (!userText && !userChips.length && !userImages.length) return;
      const parts = exportUserParts(userText, userChips, userImages);
      const lines = ["## User", ""];
      if (parts.text) lines.push(parts.text);
      for (const file of parts.files) lines.push(`Attached: ${file}`);
      for (const im of parts.images) lines.push(exportImageRef(im.index, im.path));
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      sections.push(lines.join("\n"));
      userText = "";
      userChips = [];
      userImages = [];
    };

    const flushAgent = () => {
      if (!agentText && !toolOrder.length && !mediaItems.length) return;
      const lines = ["## Assistant"];
      if (agentText.trim()) {
        lines.push("", agentText.trim());
      }
      if (toolOrder.length) {
        lines.push("");
        for (const id of toolOrder) {
          const rec = tools.get(id);
          if (!rec) continue;
          const chunk = exportToolLine(rec);
          if (chunk.length) lines.push(chunk.join("\n"));
        }
      }
      for (const item of mediaItems) {
        const kind = item.media === "video" ? "Video" : "Image";
        const name = exportBasename(item.path) || (item.media === "video" ? "generated-video" : "generated-image");
        lines.push(`[${kind}: ${name}]`);
      }
      sections.push(lines.join("\n"));
      agentText = "";
      tools = new Map();
      toolOrder = [];
      mediaItems = [];
    };

    for (const ev of flattenExportEvents(events)) {
      switch (ev.type) {
        case "userMessage":
          flushAgent();
          userText = ev.text || "";
          userChips = Array.isArray(ev.chips) ? ev.chips : [];
          flushUser();
          break;
        case "userMessageChunk":
          flushAgent();
          userText += ev.text || "";
          if (Array.isArray(ev.images)) userImages = userImages.concat(ev.images);
          break;
        case "messageChunk":
          flushUser();
          agentText += ev.text || "";
          break;
        case "agentStart":
          flushUser();
          flushAgent();
          break;
        case "toolCall":
        case "toolCallUpdate":
          flushUser();
          mergeTool(ev.call);
          break;
        case "commandOutput":
          flushUser();
          attachCommand(ev);
          break;
        case "media":
          flushUser();
          mediaItems.push(ev);
          break;
        case "agentEnd":
        case "agentError":
          flushUser();
          if (ev.type === "agentError" && ev.text) agentText += (agentText ? "\n\n" : "") + ev.text;
          flushAgent();
          break;
        default:
          break;
      }
    }
    flushUser();
    flushAgent();

    const userTurns = sections.reduce((n, block) => n + (block.indexOf("## User") === 0 ? 1 : 0), 0);
    const header = ["# " + title, ""];
    if (windowed) {
      header.push(userTurns === 1 ? "Last 1 turn." : `Last ${userTurns} turns.`, "");
    }
    const body = sections.join("\n\n");
    return header.join("\n") + (body ? body + "\n" : "");
  }

  /**
   * Empty-state advice — the tip catalogue and the rule for choosing one.
   *
   * The welcome screen is the most-seen surface in the product and, once an
   * agent is connected, the only one that says nothing. This fills that slot
   * with one line naming a capability the user has NOT set up yet.
   *
   * ELIGIBILITY, NOT RANDOMNESS. Every entry declares the condition under
   * which it is worth saying, and all of those conditions read state the
   * client already holds. Shuffling a fixed list would eventually advertise
   * Codex to someone running Codex, and one visibly wrong tip discredits every
   * later one. So the pool is the tips that are still true, and rotation only
   * chooses among those — which is why this needs no randomness and stays a
   * pure function.
   *
   * `deskOnly` is the same rule that keeps the move-view hint off phones: a
   * remote may not sign an agent in or link a connector (both `host-local`),
   * so suggesting it there is advice the reader cannot take from where they
   * are standing.
   *
   * Copy carries ONE `{braced}` span — the actionable phrase. The renderer
   * splits on it and builds text nodes plus a single control, so tip text
   * never reaches innerHTML.
   */
  const WELCOME_TIPS = [
    {
      id: "providers",
      copy: "Grok isn’t your only agent. {Connect Codex or Claude Code} and pick one per conversation.",
      target: "settings:providers",
      // Was deskOnly, on the rule that a remote may not sign an agent in. It
      // can since 3.19.x, and on a cloud machine this is the only surface
      // there is (owner asked why it never appears, 2026-08-31).
      deskOnly: false,
      remoteNeedsSignIn: true,
      // Not "fewer than all three": the moment a SECOND agent exists the user
      // has discovered that agents are interchangeable here, which is the only
      // thing this tip was ever teaching.
      eligible: (f) => !f.altAgentConnected,
    },
    {
      id: "routines",
      copy: "Work that repeats can run itself. {Set up a routine} and it opens a session on schedule.",
      target: "settings:routines",
      deskOnly: false,
      eligible: (f) => f.routineCount === 0,
    },
    {
      id: "connectors",
      copy: "Give your agent your tools. {Connect Notion, Linear or GitHub} and it can read and write them.",
      target: "settings:connectors",
      deskOnly: true,
      eligible: (f) => f.connectorCount === 0,
    },
    {
      id: "remote",
      copy: "Leave the desk without leaving the work. {Continue on your phone.}",
      target: "settings:account",
      deskOnly: true,
      // Three states, not two (see state.remoteLinked): null means the host has
      // not read the token yet, and inviting an already-linked machine to link
      // again is the exact confusion that tri-state exists to prevent.
      eligible: (f) => f.remoteLinked === false,
    },
    {
      id: "readAloud",
      copy: "Grok can read its replies out loud — turn it on in {Voice settings}.",
      target: "settings:voice",
      deskOnly: false,
      eligible: (f) => !f.readRepliesAloud,
    },
    {
      id: "voice",
      copy: "Talk instead of typing — set up {voice control} and dictate into the composer.",
      target: "settings:voice",
      deskOnly: false,
      eligible: (f) => !f.voiceConfigured,
    },
    {
      id: "mentions",
      // The actionable phrase, not the character: "@" alone is about six pixels
      // wide, and no amount of padding turns that into a finger-sized target
      // without visibly shoving the sentence around it.
      copy: "{Mention a file with @}, or drop one onto the composer.",
      // Dropping a file works in the host's own webview only: the browser's
      // drop handler reads file:// URIs and posts HOST paths, which a phone
      // does not have. Advising it there is advice that cannot be taken.
      copyWhen: (f) => (f.isRemote ? "{Mention a file with @} to bring it into the conversation." : undefined),
      target: "mention",
      deskOnly: false,
      eligible: () => true,
    },
    {
      id: "worktrees",
      // It DOES have an action, which the first version of this tip missed:
      // `newWorktreeSession` takes no source conversation — it cuts from the
      // current project — so it works perfectly well from an empty screen. The
      // copy names what the click does rather than describing a menu path
      // nobody remembers ("… > Continue in a new chat > Use a new worktree").
      copy: "Trying something risky? {Start it in a worktree} — your checkout stays untouched.",
      target: "worktree",
      deskOnly: true,
      // Every condition the destination list itself applies, so the link can
      // never fire something the host would refuse: coding mode, a CLI that
      // supports worktrees, and not already inside one (they do not nest).
      eligible: (f) => f.appPurpose === "coding" && f.worktreeSupported && !f.inWorktree,
    },
  ];

  /** Catalogue entry by id, or undefined for an id this client doesn't know. */
  function welcomeTipById(id) {
    for (const tip of WELCOME_TIPS) if (tip.id === id) return tip;
    return undefined;
  }

  /** A tip's copy for these facts: some tips say something different where the
   *  action behind them differs (a cloud machine cannot connect Claude Code; a
   *  browser cannot drop a file onto the composer). */
  function welcomeTipCopy(tip, facts) {
    if (!tip) return "";
    const variant = typeof tip.copyWhen === "function" ? tip.copyWhen(facts || {}) : undefined;
    return typeof variant === "string" && variant ? variant : tip.copy;
  }

  /**
   * The tips still worth showing, in catalogue order (most useful first).
   *
   * Facts are read defensively: an older host sends no counts at all, and a
   * count we do not have must not become "zero routines" — that would advertise
   * routines to the one user who already has twenty. Absent counts suppress the
   * tips that depend on them rather than guessing.
   */
  function welcomeTipsFor(facts) {
    const f = facts || {};
    const dismissed = Array.isArray(f.dismissed)
      ? new Set(f.dismissed)
      : new Set(Object.keys(f.dismissed || {}));
    // Seen already today. The pool is small, so without this the same two or
    // three lines come round again every time a conversation ends — which is
    // how advice turns into wallpaper.
    const shownToday = new Set(Array.isArray(f.shownToday) ? f.shownToday : []);
    // …except whatever is on screen RIGHT NOW. It was added to that set the
    // moment it rendered, and a repaint must not make the line the reader is
    // in the middle of vanish from under them.
    if (f.keepId) shownToday.delete(f.keepId);
    const known = {
      appPurpose: f.appPurpose === "coding" ? "coding" : "knowledge",
      isRemote: !!f.isRemote,
      altAgentConnected: !!f.altAgentConnected,
      routineCount: typeof f.routineCount === "number" ? f.routineCount : -1,
      connectorCount: typeof f.connectorCount === "number" ? f.connectorCount : -1,
      readRepliesAloud: !!f.readRepliesAloud,
      voiceConfigured: !!f.voiceConfigured,
      // Opt-OUT, matching the client's own default: a CLI is assumed to support
      // worktrees until a create says otherwise, and reading absence as "no"
      // here would have hidden the tip on every host that never mentions it.
      worktreeSupported: f.worktreeSupported !== false,
      inWorktree: !!f.inWorktree,
      cloudHost: !!f.cloudHost,
      remoteCanConnectAgents: !!f.remoteCanConnectAgents,
      remoteLinked: f.remoteLinked === true ? true : f.remoteLinked === false ? false : null,
    };
    return WELCOME_TIPS.filter((tip) => {
      if (dismissed.has(tip.id)) return false;
      if (shownToday.has(tip.id)) return false;
      if (known.isRemote && tip.deskOnly) return false;
      // A tip whose action needs a capability this remote does not have is the
      // same dead end deskOnly was invented to prevent — just decided by what
      // the host advertises rather than by where the reader is standing.
      if (known.isRemote && tip.remoteNeedsSignIn && !known.remoteCanConnectAgents) return false;
      // -1 is "the host never told us" — see the doc comment.
      if (tip.id === "routines" && known.routineCount < 0) return false;
      if (tip.id === "connectors" && known.connectorCount < 0) return false;
      return tip.eligible(known);
    });
  }

  /**
   * Split a tip's copy into [before, action, after]. Exactly one `{...}` span
   * is expected; copy without one yields the whole string as `before` and no
   * action, which renders as a plain sentence rather than throwing.
   */
  function splitWelcomeTipCopy(copy) {
    const text = typeof copy === "string" ? copy : "";
    const open = text.indexOf("{");
    const close = text.indexOf("}", open + 1);
    if (open < 0 || close < 0) return { before: text, action: "", after: "" };
    return {
      before: text.slice(0, open),
      action: text.slice(open + 1, close),
      after: text.slice(close + 1),
    };
  }

  /* ------------------------------------------------- Add project */

  /**
   * The Add project menu, as data.
   *
   * Two rails render this — the desktop/remote one in chat.js and VS Code's own
   * in projects-rail.js — and they have different popover primitives but must
   * not have different menus. So the SPEC lives here and each surface draws it.
   *
   * Cloning is available in every mode. A preference most people never open
   * must not be able to hide a way in.
   */
  function addProjectMenuItems(opts) {
    const o = opts || {};
    const items = [];
    if (o.canClone) {
      items.push({
        id: "clone",
        label: "Clone from GitHub",
        description: "Pick a repository, or type a URL.",
      });
    }
    if (o.canCreate) {
      items.push({
        id: "new",
        label: "New project",
        description: "Name it. We make the folder.",
      });
    }
    if (o.canImport !== false) {
      items.push({
        id: "import",
        label: "Import a folder",
        description: "Choose one you already have.",
      });
    }
    return items;
  }

  /** Copy for each form, keyed the same way the menu items are. */
  const ADD_PROJECT_FORMS = {
    "new": {
      title: "New project",
      body: "We'll create the folder for you. You can move it later.",
      label: "Project name",
      placeholder: "Q3 Positioning",
      confirm: "Create",
      busy: "Creating",
    },
    clone: {
      title: "Clone from GitHub",
      body: "Pick a repository, or type a URL or owner/repo.",
      label: "Repository",
      placeholder: "owner/repo or https://github.com/you/project",
      confirm: "Clone",
      busy: "Cloning",
    },
  };

  /**
   * The folder name a typed value would produce, for the live destination
   * preview. Empty string when there is nothing to show yet.
   *
   * A PREVIEW, not a validator: the host owns both, and re-implementing its
   * rules here would be a second registry that drifts. This only has to be
   * right about the common case, and wrong quietly rather than loudly — an
   * empty preview is a blank line, and the host answers a bad name with the
   * real reason.
   */
  function addProjectFolderPreview(kind, value) {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw) return "";
    if (kind !== "clone") return raw.replace(/[\\/:*?"<>|]/g, "");
    const stripped = raw.split("#")[0].split("?")[0].replace(/\/+$/, "");
    const segment = (stripped.split(/[/:]/).pop() || "").replace(/\.git$/i, "");
    return segment.replace(/[\\/:*?"<>|]/g, "");
  }

  const GITHUB_OWNER_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/;

  /**
   * What the clone combobox should do with the current field.
   *
   * A URL or `owner/repo` becomes a typed row ("Clone <that>"); anything else
   * is a filter over the fetched list. The host still validates before clone.
   */
  function parseCloneQuery(raw) {
    const text = String(raw || "").trim();
    if (!text) return { filter: "", typed: null };
    if (/^https?:\/\//i.test(text) || /^git@/i.test(text) || /^ssh:\/\//i.test(text)) {
      return { filter: text, typed: { kind: "url", value: text, label: "Clone " + text } };
    }
    const nwo = text.replace(/\.git$/i, "");
    if (GITHUB_OWNER_REPO.test(nwo)) {
      return { filter: text, typed: { kind: "ownerRepo", value: nwo, label: "Clone " + nwo } };
    }
    return { filter: text, typed: null };
  }

  function filterGithubRepos(repos, filter) {
    const list = Array.isArray(repos) ? repos : [];
    const q = String(filter || "").trim().toLowerCase();
    if (!q) return list.slice();
    return list.filter((repo) => {
      const nwo = String(repo && repo.nameWithOwner || "").toLowerCase();
      if (!nwo) return false;
      const name = nwo.split("/")[1] || "";
      return nwo.indexOf(q) !== -1 || name.indexOf(q) !== -1;
    });
  }

  function githubRepoNameParts(nameWithOwner) {
    const nwo = String(nameWithOwner || "");
    const cut = nwo.lastIndexOf("/");
    if (cut <= 0) return { owner: "", name: nwo };
    return { owner: nwo.slice(0, cut), name: nwo.slice(cut + 1) };
  }

  /**
   * Build the Add project form.
   *
   * Owns its own DOM and nothing else: the caller mounts it, hands it host
   * frames through `update`, and gets the typed value back through `onSubmit`.
   * Both rails use this one so the two cannot drift into different forms.
   *
   * Returns { el, update, focus, destroy }.
   */
  function addProjectForm(opts) {
    const o = opts || {};
    const kind = o.kind === "clone" ? "clone" : "new";
    const copy = ADD_PROJECT_FORMS[kind];
    const doc = o.document || (typeof document !== "undefined" ? document : null);
    if (!doc) return null;

    const el = doc.createElement("div");
    el.className = "add-project-form";
    el.dataset.kind = kind;
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", copy.title);

    const title = doc.createElement("div");
    title.className = "add-project-title";
    title.textContent = copy.title;
    el.appendChild(title);

    const body = doc.createElement("div");
    body.className = "add-project-body";
    body.textContent = copy.body;
    el.appendChild(body);

    const label = doc.createElement("label");
    label.className = "add-project-label";
    label.textContent = copy.label;
    const inputId = "add-project-input-" + kind;
    label.setAttribute("for", inputId);
    el.appendChild(label);

    const input = doc.createElement("input");
    input.id = inputId;
    input.type = "text";
    input.className = "add-project-input";
    input.placeholder = copy.placeholder;
    input.autocomplete = "off";
    input.spellcheck = false;
    el.appendChild(input);

    const listboxId = "add-project-list-" + kind;
    const listbox = doc.createElement("div");
    listbox.id = listboxId;
    listbox.className = "add-project-list";
    listbox.setAttribute("role", "listbox");
    listbox.hidden = kind !== "clone";
    if (kind === "clone") {
      input.setAttribute("role", "combobox");
      input.setAttribute("aria-autocomplete", "list");
      input.setAttribute("aria-expanded", "true");
      input.setAttribute("aria-controls", listboxId);
      input.setAttribute("aria-haspopup", "listbox");
    }
    el.appendChild(listbox);

    const collisionLabel = doc.createElement("label");
    collisionLabel.className = "add-project-label";
    collisionLabel.textContent = "Folder name";
    collisionLabel.hidden = true;
    const collisionId = "add-project-collision-" + kind;
    collisionLabel.setAttribute("for", collisionId);
    el.appendChild(collisionLabel);
    const collisionInput = doc.createElement("input");
    collisionInput.id = collisionId;
    collisionInput.type = "text";
    collisionInput.className = "add-project-input add-project-collision";
    collisionInput.autocomplete = "off";
    collisionInput.spellcheck = false;
    collisionInput.hidden = true;
    el.appendChild(collisionInput);

    // Where it will land, updated as they type. The whole point of the feature
    // is that nobody has to choose a folder, so the folder has to be visible.
    const dest = doc.createElement("div");
    dest.className = "add-project-dest";
    el.appendChild(dest);

    const problem = doc.createElement("div");
    problem.className = "add-project-error";
    problem.setAttribute("role", "alert");
    problem.hidden = true;
    el.appendChild(problem);

    const fixBtn = doc.createElement("button");
    fixBtn.type = "button";
    fixBtn.className = "add-project-fix";
    fixBtn.hidden = true;
    el.appendChild(fixBtn);

    // GitHub connect, two steps — same shape as the agent cards. Step 1 is
    // a choice (CLI, plus a quieter token path). Step 2 replaces that
    // choice with the device card or the token form, never appends below
    // the clone fields: those hide so the card is what is on screen.
    const githubBox = doc.createElement("div");
    githubBox.className = "add-project-github";
    githubBox.hidden = true;

    const githubChoice = doc.createElement("div");
    githubChoice.className = "add-project-github-choice";
    const githubChoiceHeading = doc.createElement("div");
    githubChoiceHeading.className = "add-project-github-heading";
    githubChoiceHeading.textContent = "Connect GitHub";
    const githubChoiceDesc = doc.createElement("p");
    githubChoiceDesc.className = "add-project-github-desc";
    githubChoiceDesc.textContent = "Sign in with the GitHub CLI. You will open a link and confirm a short code.";
    const githubConnect = doc.createElement("button");
    githubConnect.type = "button";
    githubConnect.className = "onb-action add-project-github-connect";
    githubConnect.textContent = "Connect with GitHub CLI";
    const githubAdvanced = doc.createElement("button");
    githubAdvanced.type = "button";
    githubAdvanced.className = "add-project-github-advanced";
    githubAdvanced.textContent = "Use a token instead";
    githubChoice.appendChild(githubChoiceHeading);
    githubChoice.appendChild(githubChoiceDesc);
    githubChoice.appendChild(githubConnect);
    githubChoice.appendChild(githubAdvanced);

    const githubCard = doc.createElement("div");
    githubCard.className = "add-project-github-card";
    githubCard.hidden = true;
    const githubHeading = doc.createElement("div");
    githubHeading.className = "add-project-github-heading";
    const githubDesc = doc.createElement("p");
    githubDesc.className = "add-project-github-desc";
    const githubCmd = doc.createElement("div");
    githubCmd.className = "add-project-github-cmd";
    const githubCode = doc.createElement("code");
    const githubCopy = doc.createElement("button");
    githubCopy.type = "button";
    githubCopy.className = "add-project-github-copy";
    githubCopy.title = "Copy";
    githubCopy.textContent = "Copy";
    githubCmd.appendChild(githubCode);
    githubCmd.appendChild(githubCopy);
    const githubOpen = doc.createElement("a");
    githubOpen.className = "onb-action add-project-github-open";
    githubOpen.target = "_blank";
    githubOpen.rel = "noopener noreferrer";
    githubOpen.textContent = "Open the sign-in page";
    const githubNote = doc.createElement("p");
    githubNote.className = "add-project-github-note";
    githubCard.appendChild(githubHeading);
    githubCard.appendChild(githubDesc);
    githubCard.appendChild(githubCmd);
    githubCard.appendChild(githubOpen);
    githubCard.appendChild(githubNote);

    const githubToken = doc.createElement("div");
    githubToken.className = "add-project-github-token";
    githubToken.hidden = true;
    const githubTokenHeading = doc.createElement("div");
    githubTokenHeading.className = "add-project-github-heading";
    githubTokenHeading.textContent = "Connect with a token";
    const githubTokenHint = doc.createElement("p");
    githubTokenHint.className = "add-project-github-desc";
    githubTokenHint.textContent = "Paste a fine-grained token (one repository, Contents: Read, an expiry) or a classic PAT. It is sent once and never shown again.";
    const githubTokenInput = doc.createElement("input");
    githubTokenInput.type = "password";
    githubTokenInput.className = "add-project-github-token-input";
    githubTokenInput.autocomplete = "off";
    githubTokenInput.spellcheck = false;
    githubTokenInput.setAttribute("aria-label", "GitHub token");
    const githubTokenError = doc.createElement("p");
    githubTokenError.className = "add-project-github-token-error";
    githubTokenError.setAttribute("role", "alert");
    githubTokenError.hidden = true;
    const githubTokenSubmit = doc.createElement("button");
    githubTokenSubmit.type = "button";
    githubTokenSubmit.className = "onb-action add-project-github-token-submit";
    githubTokenSubmit.textContent = "Connect with token";
    const githubTokenBack = doc.createElement("button");
    githubTokenBack.type = "button";
    githubTokenBack.className = "add-project-github-advanced";
    githubTokenBack.textContent = "Back";
    githubToken.appendChild(githubTokenHeading);
    githubToken.appendChild(githubTokenHint);
    githubToken.appendChild(githubTokenInput);
    githubToken.appendChild(githubTokenError);
    githubToken.appendChild(githubTokenSubmit);
    githubToken.appendChild(githubTokenBack);

    githubBox.appendChild(githubChoice);
    githubBox.appendChild(githubCard);
    githubBox.appendChild(githubToken);
    el.appendChild(githubBox);

    githubCopy.addEventListener("click", function () {
      const code = githubCopy.dataset.cmd || "";
      if (!code || !navigator.clipboard || typeof navigator.clipboard.writeText !== "function") return;
      navigator.clipboard.writeText(code).then(function () {
        githubCopy.textContent = "Copied";
        githubCopy.classList.add("copied");
        setTimeout(function () {
          githubCopy.textContent = "Copy";
          githubCopy.classList.remove("copied");
        }, 1500);
      }).catch(function () { /* clipboard blocked */ });
    });

    const actions = doc.createElement("div");
    actions.className = "add-project-actions";
    const cancel = doc.createElement("button");
    cancel.type = "button";
    cancel.className = "add-project-btn";
    cancel.textContent = "Cancel";
    const submit = doc.createElement("button");
    submit.type = "button";
    submit.className = "add-project-btn add-project-primary";
    submit.textContent = copy.confirm;
    actions.appendChild(cancel);
    actions.appendChild(submit);
    el.appendChild(actions);

    let root = typeof o.root === "string" ? o.root : "";
    let busy = false;
    let githubState = o.githubState && typeof o.githubState === "object" ? o.githubState : null;
    let repos = Array.isArray(o.repos) ? o.repos : null;
    let reposTruncated = false;
    let activeIndex = 0;
    let paintedRows = [];
    let requestedRepos = false;
    // `choice` until they press Connect / token. Reopening builds a new form,
    // so this cannot carry a stale card across opens.
    let githubPhase = "choice";

    function cloneUrlFromRow(row) {
      if (!row) return "";
      if (row.kind === "repo") return "https://github.com/" + row.nameWithOwner;
      if (row.kind === "typed") return row.value;
      return "";
    }

    function currentCloneUrl() {
      if (kind !== "clone") return input.value.trim();
      const row = paintedRows[activeIndex];
      const fromRow = cloneUrlFromRow(row);
      if (fromRow) return fromRow;
      const parsed = parseCloneQuery(input.value);
      return parsed.typed ? parsed.typed.value : "";
    }

    function paintDest() {
      const value = kind === "clone" ? currentCloneUrl() : input.value;
      const folder = collisionInput.hidden
        ? addProjectFolderPreview(kind === "clone" ? "clone" : kind, value)
        : collisionInput.value.trim();
      dest.textContent = root ? root + "/" + (folder || "…") : folder;
      submit.disabled = busy || (kind === "clone" ? !currentCloneUrl() : !folder);
    }

    function rowEl(row, index) {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "add-project-option";
      btn.setAttribute("role", "option");
      btn.id = listboxId + "-" + index;
      btn.setAttribute("aria-selected", index === activeIndex ? "true" : "false");
      if (index === activeIndex) btn.classList.add("is-active");
      if (row.kind === "typed") {
        btn.textContent = row.label;
        return btn;
      }
      const parts = githubRepoNameParts(row.nameWithOwner);
      const glyph = doc.createElement("span");
      glyph.className = "add-project-option-glyph" + (row.isPrivate ? " is-private" : " is-public");
      glyph.setAttribute("aria-hidden", "true");
      glyph.title = row.isPrivate ? "Private" : "Public";
      glyph.textContent = row.isPrivate ? "\u25CF" : "\u25CB";
      const copy = doc.createElement("span");
      copy.className = "add-project-option-copy";
      const name = doc.createElement("span");
      name.className = "add-project-option-name";
      name.textContent = parts.name;
      const owner = doc.createElement("span");
      owner.className = "add-project-option-owner";
      owner.textContent = parts.owner;
      copy.appendChild(name);
      copy.appendChild(owner);
      const when = doc.createElement("span");
      when.className = "add-project-option-when";
      when.textContent = row.updatedAt ? formatRelativeTime(Date.parse(row.updatedAt)) : "";
      btn.appendChild(glyph);
      btn.appendChild(copy);
      btn.appendChild(when);
      return btn;
    }

    function paintList() {
      if (kind !== "clone") return;
      const parsed = parseCloneQuery(input.value);
      const rows = [];
      const connected = !!(githubState && githubState.connected && githubState.error !== true);
      if (parsed.typed) rows.push({ kind: "typed", value: parsed.typed.value, label: parsed.typed.label });
      if (connected && !parsed.typed) {
        const matches = filterGithubRepos(repos || [], parsed.filter);
        for (const repo of matches) {
          rows.push({ kind: "repo", nameWithOwner: repo.nameWithOwner, isPrivate: !!repo.isPrivate, updatedAt: repo.updatedAt });
        }
      }
      paintedRows = rows;
      if (activeIndex >= rows.length) activeIndex = Math.max(0, rows.length - 1);
      listbox.textContent = "";
      rows.forEach((row, index) => {
        const node = rowEl(row, index);
        node.addEventListener("mousedown", function (e) { e.preventDefault(); });
        node.addEventListener("click", function () {
          activeIndex = index;
          activateRow(row);
        });
        listbox.appendChild(node);
      });
      input.setAttribute("aria-expanded", rows.length ? "true" : "false");
      const active = rows[activeIndex] && listboxId + "-" + activeIndex;
      if (active) input.setAttribute("aria-activedescendant", active);
      else input.removeAttribute("aria-activedescendant");
      listbox.hidden = githubPhase !== "choice" || rows.length === 0;
    }

    function activateRow(row) {
      if (row.kind === "typed") input.value = row.value;
      else if (row.kind === "repo") input.value = row.nameWithOwner;
      paintDest();
      fire();
    }

    function fire() {
      if (submit.disabled) return;
      if (kind === "clone") {
        if (githubPhase !== "choice") return;
        const url = currentCloneUrl();
        if (!url) return;
        const extra = !collisionInput.hidden && collisionInput.value.trim()
          ? { name: collisionInput.value.trim() }
          : undefined;
        if (typeof o.onSubmit === "function") o.onSubmit(url, extra);
        return;
      }
      if (typeof o.onSubmit === "function") o.onSubmit(input.value.trim());
    }

    input.addEventListener("input", function () {
      paintList();
      paintDest();
    });
    input.addEventListener("keydown", function (e) {
      if (kind === "clone" && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        if (!paintedRows.length) return;
        activeIndex = e.key === "ArrowDown"
          ? (activeIndex + 1) % paintedRows.length
          : (activeIndex + paintedRows.length - 1) % paintedRows.length;
        paintList();
        return;
      }
      if (e.key === "Enter") { e.preventDefault(); fire(); }
    });
    collisionInput.addEventListener("input", paintDest);
    collisionInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); fire(); }
    });
    submit.addEventListener("click", fire);
    cancel.addEventListener("click", function () {
      if (typeof o.onCancel === "function") o.onCancel();
    });
    fixBtn.addEventListener("click", function () {
      if (fixBtn.dataset.fix === "auth-gh") {
        startGithubCli();
        return;
      }
      if (typeof o.onFix === "function") o.onFix(fixBtn.dataset.fix);
    });

    function canGithubCli() {
      return o.canGithubCli !== false;
    }

    function canUseToken() {
      return o.canUseToken !== false;
    }

    function setCloneFieldsHidden(hidden) {
      body.hidden = hidden;
      label.hidden = hidden;
      input.hidden = hidden;
      dest.hidden = hidden;
      submit.hidden = hidden;
    }

    function paintGithubCard(g) {
      const status = g && typeof g.status === "string" ? g.status : "starting";
      githubBox.dataset.status = status;
      const url = g && typeof g.url === "string" && /^https?:\/\//i.test(g.url) ? g.url : "";
      const code = g && typeof g.code === "string" ? g.code : "";
      githubOpen.removeAttribute("href");
      if (status === "waiting" && url) {
        githubHeading.textContent = "Finish signing in to GitHub";
        githubDesc.textContent = code
          ? "Open the link, then confirm this code:"
          : "Open the link to finish signing in.";
        githubDesc.hidden = false;
        githubCmd.hidden = !code;
        githubCode.textContent = code;
        githubCopy.dataset.cmd = code;
        githubCopy.textContent = "Copy";
        githubCopy.classList.remove("copied");
        githubOpen.hidden = false;
        githubOpen.href = url;
        githubNote.hidden = false;
        githubNote.textContent = "Keep this page open — it finishes on its own.";
        return true;
      }
      if (status === "done") {
        githubHeading.textContent = "GitHub connected";
        githubDesc.textContent = g && typeof g.message === "string" && g.message
          ? g.message
          : "Signed in to GitHub. Try to clone again.";
        githubDesc.hidden = false;
        githubCmd.hidden = true;
        githubOpen.hidden = true;
        githubNote.hidden = true;
        return false;
      }
      if (status === "failed") {
        githubHeading.textContent = "Could not connect GitHub";
        githubDesc.textContent = g && typeof g.message === "string" ? g.message : "";
        githubDesc.hidden = !githubDesc.textContent;
        githubCmd.hidden = true;
        githubOpen.hidden = true;
        githubNote.hidden = true;
        return false;
      }
      githubHeading.textContent = "Connecting GitHub";
      githubDesc.textContent = "Asking the GitHub CLI for a sign-in code…";
      githubDesc.hidden = false;
      githubCmd.hidden = true;
      githubOpen.hidden = true;
      githubNote.hidden = true;
      return true;
    }

    function startGithubCli() {
      if (typeof o.onConnect === "function") o.onConnect();
      if (!canGithubCli()) return;
      githubPhase = "cli";
      paintGithub({ github: { status: "starting" } });
    }

    function startGithubToken() {
      if (!canUseToken()) return;
      githubPhase = "token";
      githubTokenInput.value = "";
      githubTokenError.hidden = true;
      githubTokenError.textContent = "";
      paintGithub({});
    }

    githubConnect.addEventListener("click", startGithubCli);
    githubAdvanced.addEventListener("click", startGithubToken);
    githubTokenBack.addEventListener("click", function () {
      githubPhase = "choice";
      githubTokenInput.value = "";
      paintGithub({});
    });
    githubTokenSubmit.addEventListener("click", function () {
      const token = githubTokenInput.value;
      githubTokenInput.value = "";
      if (!token.trim()) return;
      if (typeof o.onLoginWithToken === "function") o.onLoginWithToken(token.trim());
    });
    githubTokenInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); githubTokenSubmit.click(); }
    });

    function paintGithub(s) {
      if (kind !== "clone") {
        githubBox.hidden = true;
        return false;
      }
      const connected = !!(githubState && githubState.connected && githubState.error !== true);
      if (connected) {
        githubPhase = "choice";
        githubBox.hidden = true;
        githubBox.dataset.phase = "hidden";
        delete githubBox.dataset.status;
        setCloneFieldsHidden(false);
        return false;
      }
      githubBox.hidden = false;
      githubAdvanced.hidden = !canUseToken();
      if (githubPhase === "token") {
        githubBox.dataset.phase = "token";
        delete githubBox.dataset.status;
        githubChoice.hidden = true;
        githubCard.hidden = true;
        githubToken.hidden = false;
        setCloneFieldsHidden(true);
        const tokenErr = githubState && githubState.error && typeof githubState.message === "string"
          ? githubState.message
          : "";
        githubTokenError.textContent = tokenErr;
        githubTokenError.hidden = !tokenErr;
        return false;
      }
      if (githubPhase === "cli") {
        const g = (s.github && typeof s.github === "object") ? s.github : null;
        // A failed login is posted as `error` / `fix`, not as github.failed —
        // drop back to the choice so that message is readable.
        if (!g && s.error) {
          githubPhase = "choice";
        } else {
          githubBox.dataset.phase = "cli";
          githubChoice.hidden = true;
          githubToken.hidden = true;
          githubCard.hidden = false;
          setCloneFieldsHidden(true);
          return paintGithubCard(g || { status: "starting" });
        }
      }
      githubPhase = "choice";
      githubBox.dataset.phase = "choice";
      delete githubBox.dataset.status;
      githubChoice.hidden = false;
      githubCard.hidden = true;
      githubToken.hidden = true;
      setCloneFieldsHidden(false);
      return false;
    }

    /** Apply a `projectSetup` frame. Everything the host says, in one place. */
    function update(state) {
      const s = state || {};
      if (typeof s.root === "string" && s.root) root = s.root;
      if (s.githubState && typeof s.githubState === "object") githubState = s.githubState;
      if (Array.isArray(s.repos)) repos = s.repos;
      if (s.reposTruncated === true) reposTruncated = true;
      busy = s.busy === kind;
      input.disabled = busy;
      collisionInput.disabled = busy;
      // A static "Cloning…" reads as a stuck button — the owner could not tell
      // anything was happening. Reuse the SAME three blinking dots every other
      // progress indicator here uses (.blink-dots, animated in chat.css) rather
      // than inventing a second spinner. Built as nodes, not innerHTML: this
      // component is shared and takes no HTML anywhere else.
      submit.textContent = "";
      submit.appendChild(doc.createTextNode(busy ? copy.busy : copy.confirm));
      if (busy) {
        const dots = doc.createElement("span");
        dots.className = "blink-dots";
        dots.setAttribute("aria-hidden", "true");
        for (let i = 0; i < 3; i++) {
          const d = doc.createElement("span");
          d.textContent = ".";
          dots.appendChild(d);
        }
        submit.appendChild(dots);
      }
      el.classList.toggle("is-busy", busy);
      const githubLive = paintGithub(s);
      const githubStepped = githubPhase === "cli" || githubPhase === "token";
      const message = busy || githubLive || githubStepped ? "" : (typeof s.error === "string" ? s.error : "");
      problem.textContent = message;
      problem.hidden = !message;
      // The fix button only ever appears with the failure that earned it, so a
      // stale "Sign in to GitHub" cannot outlive the error it belonged to.
      const fix = busy || githubLive || githubStepped || !message ? "" : (s.fix || "");
      fixBtn.hidden = !fix;
      fixBtn.dataset.fix = fix || "";
      if (fix === "auth-gh") fixBtn.textContent = "Sign in to GitHub";
      else if (fix === "install-gh") {
        fixBtn.textContent = s.fixCommand ? "Install the GitHub CLI (" + s.fixCommand + ")" : "Install the GitHub CLI";
      }
      const taken = typeof s.collision === "string" ? s.collision : "";
      collisionLabel.hidden = githubStepped || !taken;
      collisionInput.hidden = githubStepped || !taken;
      if (taken && !collisionInput.value) collisionInput.value = taken;
      if (kind === "clone" && !requestedRepos && githubState && githubState.connected && githubState.error !== true) {
        requestedRepos = true;
        if (typeof o.onRequestRepos === "function") o.onRequestRepos();
      }
      paintList();
      paintDest();
    }

    if (kind === "clone") {
      paintList();
      paintGithub({});
      if (githubState && githubState.connected && githubState.error !== true && typeof o.onRequestRepos === "function") {
        requestedRepos = true;
        o.onRequestRepos();
      } else if (!githubState && typeof o.onRequestRepos === "function") {
        // Host may still be sending githubState; ask once so an already-connected
        // machine fills the list without a second open.
        requestedRepos = true;
        o.onRequestRepos();
      }
    }
    paintDest();
    return {
      el: el,
      update: update,
      focus: function () {
        if (o.touch) return;
        try { input.focus(); } catch (_) { /* detached */ }
      },
      value: function () { return input.value.trim(); },
    };
  }

  /**
   * How long the waiting indicator has been on screen, for its label.
   *
   * A turn has no deadline the user can see. `session/prompt` tolerates 30
   * minutes of CLI silence before it gives up (`src/acp-timeout.ts`), and until
   * then the only thing on screen is a spinner — so "working" and "wedged" look
   * identical, and users reasonably report the second one as broken (#126). A
   * running count is the cheapest honest signal: it does not claim to know
   * whether anything is wrong, only how long the wait has lasted.
   *
   * FLOOR, never round: a counter reading 25s at 24.9s is showing time that has
   * not passed yet.
   */
  function formatWaitElapsed(ms) {
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ${sec % 60}s`;
    const hr = Math.floor(min / 60);
    return `${hr}h ${min % 60}m`;
  }

  const api = { WELCOME_TIPS, welcomeTipById, welcomeTipsFor, welcomeTipCopy, splitWelcomeTipCopy, addProjectMenuItems, addProjectFolderPreview, addProjectForm, parseCloneQuery, filterGithubRepos, githubRepoNameParts, formatWaitElapsed, FILE_EXTS, HOST_MESSAGE_TYPES, WEBVIEW_MESSAGE_TYPES, isKnownHostMessage, composerHasSendIntent, explicitVisibleChips, normalizeQueuedSends, queuedSendsText, queuedSendsChips, contextOverheadTokens, nextContextBreakdown, contextBreakdownIsCurrent, createPendingOverlay, getMentionQuery, applyMentionPick, looksLikeFileRef, formatRelativeTime, modelPickerLabel, modelDisplayName, MIC_STATES, nextMicState, trailingSendPhrase, versionedSiblingUrl, buildQuestionAnswers, isFreeTextOptionLabel, isSubagentToolCall, subagentLabel, cleanSubagentOutput, parseSubagentTaskResult, shouldStickToBottom, stickThresholdPx, splitMath, stripUnsupportedTex, toolFailureText, isMediaGenToolCall, mediaGenZeroRetentionHint, TOOL_LABEL_MAX, middleElide, isAdvertisedSkill, getSlashQuery, applySlashPick, filterCommands, highlightQueryParts, appendHighlightedText, commandProgramLabel, commandTextPreview, MAX_COMMAND_OUTPUT_CHARS, capCommandOutput, extractToolResultOutput, commandOutputWasCancelled, commandOutputTruncationNote, computeLineDiff, parseAttachmentContext, parseSelectionBlocks, parseImageTags, orderPermissionOptions, defaultPermissionIndex, shouldFocusPermissionCard, isTypeThroughKey, isInterjectionText, stripInterjectionEnvelope, spokenTextFromMarkdown, isRelaySendRejection, panelReclampOnResizeAllowed, wireFullscreenSafeReclamp, distributeSidePanelWidths, chatZoomFactor, unzoomClientPx, exportSessionMarkdown, exportSessionFilename, isExportableSessionEvent, replayedUserBubbleVerdict, truncateExportEvents, flattenHistoryMessages, splitHistoryWindow, countHistoryReplayCounters, partitionHistoryCards };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.GrokWebviewHelpers = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
