(function (root) {
  const FILE_EXTS = new Set([
    "ts","tsx","js","jsx","mjs","cjs","json","md","mdx","toml","yml","yaml",
    "css","scss","sass","less","html","htm","xml","svg",
    "py","rb","go","rs","java","kt","kts","swift","c","cc","cpp","cxx","h","hh","hpp",
    "cs","php","lua","sh","bash","zsh","fish","ps1","bat","cmd",
    "txt","lock","env","ini","cfg","conf","gitignore","dockerignore",
    "vue","svelte","astro","sql","prisma","graphql","gql",
  ]);

  // The host <-> webview message contract. These MUST stay in sync with the TS
  // discriminated unions in src/protocol.ts (which is the source of truth) — the
  // webview is plain JS and can't import the compiled types, so it carries its own
  // copy and test/protocol.test.ts asserts the two are set-equal in both
  // directions (and that chat.js actually handles every host type).
  const HOST_MESSAGE_TYPES = [
    "initialState", "showThinking", "fontScale", "grokUpdateStatus", "initialized",
    "cliUpdating", "session", "modelChanged", "modeChanged", "openModePopover",
    "voiceState", "voiceConfigured", "voicePartial", "voiceSubmit", "voiceTranscript",
    "voiceError", "chips", "commandsUpdate", "userMessage", "agentStart", "thoughtChunk",
    "messageChunk", "media", "userMessageChunk", "historyReplay", "permissionHistoryQueue",
    "planHistoryQueue", "planProcessing", "toolCall", "toolCallUpdate", "permissionRequest",
    "permissionResolved", "exitPlanRequest", "questionRequest", "planNotice", "planBlocked",
    "promptComplete", "agentReset", "agentError", "agentEnd", "exit", "setBusy", "summarizing",
    "sessionContext", "clearMessages", "onboarding", "error", "xaiNotification", "sessions",
    "sessionDot", "historyPanelVisible", "queuedSends",
  ];
  const WEBVIEW_MESSAGE_TYPES = [
    "ready", "send", "newSession", "cancel", "pickModel", "setMode", "removeChip",
    "toggleChip", "openFile", "openUrl", "openDiff", "exportExpr", "setEffort",
    "openGlobalConfig", "openProjectConfig", "runMcpList", "showLogs", "moveView",
    "setShowThinking",
    "dropFile", "permissionAnswer", "exitPlanAnswer", "questionAnswer", "questionCancel",
    "setModel", "runInstallCmd", "runGrokLogin", "logout", "checkGrokUpdate", "updateGrok",
    "recheckConnection", "listSessions", "resumeSession", "renameSession", "deleteSession",
    "clearAllSessions", "pickFile", "pasteImage", "voiceStart", "voiceStop",
    "queueSend", "dequeueSend", "clearQueuedSends",
  ];
  const HOST_MESSAGE_TYPE_SET = new Set(HOST_MESSAGE_TYPES);
  /** True when `type` is a host->webview message the contract knows about. A
   *  false here means the host posted a type this webview build can't handle —
   *  drift the sync test is designed to prevent, warned at runtime as a backstop. */
  function isKnownHostMessage(type) {
    return HOST_MESSAGE_TYPE_SET.has(type);
  }

  function looksLikeFileRef(s) {
    if (!s || s.length > 200) return false;
    const core = s.replace(/[:#].*$/, "");
    if (/[\s"'`<>|&;]/.test(core)) return false;
    const m = core.match(/\.([A-Za-z0-9]+)$/);
    if (!m) return false;
    return FILE_EXTS.has(m[1].toLowerCase());
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

  // Resolve a model ID to its user-facing name (e.g. "grok-build" → "Grok Build")
  // using the availableModels list from session/new. Falls back to the ID when
  // the model isn't in the list or has no name, so the label is never blank.
  function modelDisplayName(modelId, availableModels) {
    if (!modelId) return "";
    const m = (availableModels || []).find((x) => x && x.modelId === modelId);
    return (m && m.name) || modelId;
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
  function isSubagentToolCall(call) {
    if (!call) return false;
    if (call.kind === "subagent" || call.kind === "agent") return true;
    const n = String(call.tool || call.name || call.title || "")
      .replace(/[_\s-]/g, "").toLowerCase();
    // grok's `get_command_or_subagent_output` polls a background task's output —
    // its name carries "subagent" but it is NOT a delegation, so never card it.
    if (/output$/.test(n) || n.startsWith("getcommand")) return false;
    if (/subagent|spawnagent|launchagent|dispatchagent|runagent|delegat/.test(n)) return true;
    if (n === "task" || n === "agent" || n === "agents") return true;
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
  // lets a near-bottom position still count as pinned.
  function shouldStickToBottom(scrollTop, scrollHeight, clientHeight, threshold) {
    const t = typeof threshold === "number" ? threshold : 40;
    const distanceFromBottom = scrollHeight - (scrollTop + clientHeight);
    return distanceFromBottom <= t;
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
    return "Tool call failed.";
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

  const api = { FILE_EXTS, HOST_MESSAGE_TYPES, WEBVIEW_MESSAGE_TYPES, isKnownHostMessage, looksLikeFileRef, formatRelativeTime, modelDisplayName, MIC_STATES, nextMicState, trailingSendPhrase, buildQuestionAnswers, isSubagentToolCall, subagentLabel, shouldStickToBottom, splitMath, stripUnsupportedTex, toolFailureText, parseAttachmentContext, parseSelectionBlocks, parseImageTags };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.GrokWebviewHelpers = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
