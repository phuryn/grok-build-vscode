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
    "initialState", "moveViewHint", "providerState", "mcpServers", "codexInstallProgress", "planModeAvailability", "showThinking", "appPurpose", "fontScale", "grokUpdateStatus", "updateAvailable", "updateReady", "telemetryEnabled", "initialized",
    "cliUpdating", "session", "sessionName", "modelChanged", "modeChanged", "openModePopover",
    "voiceState", "voiceConfigured", "voicePartial", "voiceSubmit", "voiceTranscript",
    "voiceError", "chips", "commandsUpdate", "mentionResults", "projectDirListing", "projectFileContent", "projectFileWriteResult", "userMessage", "agentStart", "thoughtChunk",
    "messageChunk", "media", "userMessageChunk", "historyReplay", "historyBatch", "permissionHistoryQueue",
    "planHistoryQueue", "toolCall", "toolCallUpdate", "permissionRequest", "permissionOptions",
    "permissionResolved", "exitPlanRequest", "planResolved", "questionRequest", "planNotice", "autoCompactNotice", "planBlocked",
    "promptComplete", "contextUsage", "commandOutput", "expandCommandOutputs", "setAllToolDetails", "focusInput", "restoreComposer", "truncateMessages", "uiConfirmRequest", "agentReset", "agentError", "agentEnd", "exit", "setBusy", "summarizing",
    "sessionContext", "clearMessages", "onboarding", "error", "hostNotice", "xaiNotification", "subagentUpdate", "childStream", "runProgress", "sessions", "repoSessions", "pinnedSessions", "repos",
    "sessionDot", "queuedSends", "submitQueuedSend", "steerUnavailable", "usage", "steerByDefault", "soundNotifications", "processingSound", "readRepliesAloud", "summarizeRepliesAloud", "speechSummary", "imageFull", "moveComposerCaret",
    "remoteStatus",
  ];
  const WEBVIEW_MESSAGE_TYPES = [
    "ready", "remotePreferences", "send", "newSession", "cancel", "pickModel", "setMode", "removeChip",
    "toggleChip", "openFile", "showInFolder", "openUrl", "openText", "openDiff", "exportExpr", "setEffort",
    "addProjectFolder", "removeProjectFolder",
    "openGlobalConfig", "openProjectConfig", "listMcpServers", "setMcpServerEnabled", "showLogs", "toggleDevTools", "openSettings", "openSettingsSurface", "closeSettingsSurface", "moveView",
    "setShowThinking", "setAppPurpose", "setExpandCommandOutputs",
    "dropFile", "permissionAnswer", "exitPlanAnswer", "questionAnswer", "questionCancel",
    "setModel", "installCodex", "cancelCodexInstall", "runInstallCmd", "runGrokLogin", "logout", "checkGrokUpdate", "updateGrok",
    "recheckConnection", "refreshProviders", "retryProviderSession", "listSessions", "listRepoSessions", "selectRepo", "toggleRepoPin", "setRepoArchived", "setRepoColor", "toggleSessionPin", "resumeSession", "renameSession", "deleteSession",
      "clearAllSessions", "pickFile", "mentionQuery", "addMentionFile", "listProjectDir", "readProjectFile", "writeProjectFile", "pasteImage", "uploadFile", "voiceStart", "voiceStop",
      "remoteVoiceStart", "remoteVoiceChunk", "remoteVoiceStop",
    "queueSend", "dequeueSend", "clearQueuedSends", "steerSend", "forkSession", "setSteerByDefault",
    "setSoundNotifications", "setProcessingSound", "setReadRepliesAloud", "setSummarizeRepliesAloud", "setVoiceSendPhrase", "setVoiceKeyterms", "setTelemetryEnabled", "summarizeSpeech", "requestImageFull", "composerFocus",
    "newWorktreeSession", "applyWorktree", "removeWorktree", "rewindSession", "editLastMessage", "uiConfirmAnswer", "workflowControl",
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

  // Pull a self-executed shell command's result off a completed `tool_call_update`.
  // The cursor/Composer agent runs commands in its OWN CLI-side persistent shell
  // and reports the result on the completed update (keyed by `toolCallId`) instead
  // of delegating via `terminal/create` — so the #41 IN/OUT box, fed only by the
  // terminal `commandOutput` path, never gets output for those rows. Recover the
  // output + exit code here so the box can render it, matched reliably by
  // `toolCallId` (Composer completes commands OUT of issue order, so no order-based
  // guess is safe). Returns `{output, exitCode, truncated}` or null when the update
  // carries no command result. Pure.
  function extractToolResultOutput(call) {
    if (!call || typeof call !== "object") return null;
    const ro = call.rawOutput;
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
    return { output, exitCode, truncated: !!(ro && ro.truncated) };
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
  function isRelaySendRejection(text) {
    return /^(?:Slow down \u2014 at most \d+ messages per minute\.|Free plan limit reached \(\d+ messages this week\)\. Resets in .+ Upgrade to Remote Max for unlimited use\.)$/
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
    lines.push(`- ${title}`);
    if (rec.output) {
      lines.push("", exportFence(exportTrimmed(rec.output)));
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
      const command = typeof msg.command === "string" ? msg.command : "";
      for (let i = toolOrder.length - 1; i >= 0; i--) {
        const rec = tools.get(toolOrder[i]);
        if (rec && rec.command === command) {
          if (typeof msg.output === "string") rec.output = msg.output;
          return;
        }
      }
      const id = `cmd-${toolOrder.length}`;
      const rec = newToolRec(id);
      rec.command = command;
      rec.output = typeof msg.output === "string" ? msg.output : "";
      rec.kind = "execute";
      tools.set(id, rec);
      toolOrder.push(id);
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

  const api = { FILE_EXTS, HOST_MESSAGE_TYPES, WEBVIEW_MESSAGE_TYPES, isKnownHostMessage, createPendingOverlay, getMentionQuery, applyMentionPick, looksLikeFileRef, formatRelativeTime, modelPickerLabel, modelDisplayName, MIC_STATES, nextMicState, trailingSendPhrase, versionedSiblingUrl, buildQuestionAnswers, isFreeTextOptionLabel, isSubagentToolCall, subagentLabel, cleanSubagentOutput, parseSubagentTaskResult, shouldStickToBottom, stickThresholdPx, splitMath, stripUnsupportedTex, toolFailureText, isMediaGenToolCall, mediaGenZeroRetentionHint, commandProgramLabel, commandTextPreview, extractToolResultOutput, computeLineDiff, parseAttachmentContext, parseSelectionBlocks, parseImageTags, orderPermissionOptions, defaultPermissionIndex, shouldFocusPermissionCard, isTypeThroughKey, isInterjectionText, stripInterjectionEnvelope, spokenTextFromMarkdown, isRelaySendRejection, panelReclampOnResizeAllowed, wireFullscreenSafeReclamp, distributeSidePanelWidths, chatZoomFactor, unzoomClientPx, exportSessionMarkdown, exportSessionFilename, isExportableSessionEvent, replayedUserBubbleVerdict, truncateExportEvents };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.GrokWebviewHelpers = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
