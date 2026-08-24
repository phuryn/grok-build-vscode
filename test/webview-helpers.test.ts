import { describe, it, expect, vi } from "vitest";
// @ts-expect-error — plain JS module, no types
import { formatWaitElapsed, looksLikeFileRef, formatRelativeTime, FILE_EXTS, modelPickerLabel, modelDisplayName, nextMicState, trailingSendPhrase, versionedSiblingUrl, buildQuestionAnswers, isFreeTextOptionLabel, isSubagentToolCall, subagentLabel, cleanSubagentOutput, parseSubagentTaskResult, shouldStickToBottom, stickThresholdPx, splitMath, stripUnsupportedTex, parseAttachmentContext, parseSelectionBlocks, parseImageTags, toolFailureText, isMediaGenToolCall, mediaGenZeroRetentionHint, TOOL_LABEL_MAX, middleElide, filterCommands, highlightQueryParts, appendHighlightedText, commandProgramLabel, commandTextPreview, MAX_COMMAND_OUTPUT_CHARS, capCommandOutput, extractToolResultOutput, commandOutputWasCancelled, commandOutputTruncationNote, computeLineDiff, spokenTextFromMarkdown, isRelaySendRejection, panelReclampOnResizeAllowed, wireFullscreenSafeReclamp, distributeSidePanelWidths, chatZoomFactor, unzoomClientPx, createPendingOverlay, contextOverheadTokens, nextContextBreakdown, contextBreakdownIsCurrent, flattenHistoryMessages, splitHistoryWindow, countHistoryReplayCounters, partitionHistoryCards, isCountableUserBubble } from "../media/webview-helpers.js";
import { Window } from "happy-dom";
import { buildPrompt, buildPromptWithImages } from "../src/prompt-builder";
import { makeExplicitChip, makeImplicitChip, makeImageChip } from "../src/chips";

describe("contextOverheadTokens", () => {
  it("is used minus system minus messages when that remainder is positive", () => {
    expect(contextOverheadTokens(24273, 1516, 22757)).toBeNull();
    expect(contextOverheadTokens(25000, 2000, 20000)).toBe(3000);
  });

  it("floors a negative remainder and hides a zero row", () => {
    expect(contextOverheadTokens(10, 8, 5)).toBeNull();
    expect(contextOverheadTokens(10, 6, 4)).toBeNull();
  });

  it("needs used, system, and messages together", () => {
    expect(contextOverheadTokens(100, 10, undefined)).toBeNull();
    expect(contextOverheadTokens(100, undefined, 40)).toBeNull();
    expect(contextOverheadTokens(undefined, 10, 40)).toBeNull();
  });
});

describe("nextContextBreakdown", () => {
  const snapshot = {
    type: "contextUsage" as const,
    used: 100,
    window: 200000,
    systemPromptTokens: 10,
    messageTokens: 80,
    freeTokens: 199890,
  };

  it("binds session/info addends to the used they arrived with", () => {
    const next = nextContextBreakdown(null, snapshot);
    expect(next).toMatchObject({ used: 100, window: 200000, systemPromptTokens: 10, messageTokens: 80, freeTokens: 199890 });
    expect(contextBreakdownIsCurrent(next, 100, 200000)).toBe(true);
    expect(contextOverheadTokens(next.used, next.systemPromptTokens, next.messageTokens)).toBe(10);
  });

  it("keeps the snapshot when a used-only frame moves occupancy", () => {
    const prev = nextContextBreakdown(null, snapshot);
    expect(nextContextBreakdown(prev, { type: "contextUsage", used: 130 })).toBe(prev);
    expect(contextBreakdownIsCurrent(prev, 130, 200000)).toBe(false);
    // Overhead stays bound to the snapshot's used, never live occupancy minus
    // stale addends (100→130 would invent Reasoning/overhead 40).
    expect(contextOverheadTokens(prev.used, prev.systemPromptTokens, prev.messageTokens)).toBe(10);
    expect(contextOverheadTokens(130, prev.systemPromptTokens, prev.messageTokens)).toBe(40);
  });

  it("keeps the snapshot when a used-only frame restates the same used", () => {
    const prev = nextContextBreakdown(null, snapshot);
    expect(nextContextBreakdown(prev, { type: "contextUsage", used: 100 })).toBe(prev);
    expect(contextBreakdownIsCurrent(prev, 100, 200000)).toBe(true);
  });

  it("keeps the snapshot when a window-only frame rescales the denominator", () => {
    const prev = nextContextBreakdown(null, snapshot);
    expect(nextContextBreakdown(prev, { type: "contextUsage", window: 1000000 })).toBe(prev);
    expect(contextBreakdownIsCurrent(prev, 100, 1000000)).toBe(false);
  });

  it("replaces an older snapshot wholesale instead of merging fields", () => {
    const prev = nextContextBreakdown(null, snapshot);
    const next = nextContextBreakdown(prev, {
      type: "contextUsage",
      used: 110,
      window: 200000,
      systemPromptTokens: 10,
      messageTokens: 100,
      freeTokens: 199890,
    });
    expect(next).toMatchObject({ used: 110, messageTokens: 100, systemPromptTokens: 10 });
    expect(next.toolDefinitionsTokens).toBeNull();
    expect(contextBreakdownIsCurrent(next, 110, 200000)).toBe(true);
  });

  it("refuses a structured frame that cannot bind to a used value", () => {
    expect(nextContextBreakdown(null, { type: "contextUsage", systemPromptTokens: 10, messageTokens: 80 })).toBeNull();
  });
});

describe("createPendingOverlay", () => {
  it("paints until a frame for that key arrives, then dies", () => {
    const overlay = createPendingOverlay({ timeoutMs: 60_000 });
    overlay.paint("s1", "New name");
    expect(overlay.valueFor("s1")).toBe("New name");
    expect(overlay.valueFor("s2")).toBeUndefined();
    expect(overlay.settle("s2")).toBe(false);
    expect(overlay.valueFor("s1")).toBe("New name");
    expect(overlay.settle("s1")).toBe(true);
    expect(overlay.valueFor("s1")).toBeUndefined();
  });

  it("a contradicting settle still clears — the frame is the authority", () => {
    const overlay = createPendingOverlay({ timeoutMs: 60_000 });
    overlay.paint("/work/a", "blue");
    expect(overlay.settleAny(["/work/b", "/work/a"])).toBe(true);
    expect(overlay.peek()).toBeNull();
  });

  it("expires a silent host so a lie cannot stick", async () => {
    vi.useFakeTimers();
    try {
      let expired = 0;
      const overlay = createPendingOverlay({ timeoutMs: 50, onExpire: () => { expired += 1; } });
      overlay.paint("s1", "Ghost");
      expect(overlay.valueFor("s1")).toBe("Ghost");
      await vi.advanceTimersByTimeAsync(50);
      expect(overlay.valueFor("s1")).toBeUndefined();
      expect(expired).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("spokenTextFromMarkdown", () => {
  it("keeps prose and link labels while omitting fenced code", () => {
    expect(spokenTextFromMarkdown(
      "## Done\nSee [the guide](https://example.com).\n```ts\nconst noisy = true;\n```\n- Restart now.",
    )).toBe("Done See the guide. Restart now.");
  });
});

describe("isRelaySendRejection", () => {
  it("accepts only the relay's canonical refused-frame errors", () => {
    expect(isRelaySendRejection("Slow down — at most 5 messages per minute.")).toBe(true);
    expect(isRelaySendRejection(
      "Free plan limit reached (25 messages this week). Resets in 2 days. Upgrade to Remote Max for unlimited use.",
    )).toBe(true);
    expect(isRelaySendRejection("Device offline — VS Code isn't connected to the relay.")).toBe(false);
    expect(isRelaySendRejection("Could not rename this conversation.")).toBe(false);
    expect(isRelaySendRejection("Weekly prompt limit reached.")).toBe(false);
  });

  // The relay shortened this sentence. Pinning the full text here meant a
  // refused send silently stopped becoming the editable "Not sent" block,
  // losing the user's text. Both shapes must classify, so the relay's exact
  // wording and this regex are no longer coupled.
  it("classifies the quota refusal with or without the trailing sentence", () => {
    expect(isRelaySendRejection("Free plan limit reached (100 messages this week). Resets in 2d.")).toBe(true);
    expect(isRelaySendRejection(
      "Free plan limit reached (100 messages this week). Resets in 2d. Upgrade to Remote Max for unlimited use.",
    )).toBe(true);
    // Still anchored on the identifying shape — a bare mention is not a refusal.
    expect(isRelaySendRejection("Free plan limit reached.")).toBe(false);
    expect(isRelaySendRejection("Free plan limit reached (100 messages this week).")).toBe(false);
  });
});

describe("versionedSiblingUrl", () => {
  it("propagates the chat script deploy query to the audio worklet", () => {
    expect(versionedSiblingUrl(
      "pcm-worklet.js",
      "https://relay.example/media/chat.js?v=deploy-123",
    )).toBe("https://relay.example/media/pcm-worklet.js?v=deploy-123");
  });
});

describe("looksLikeFileRef", () => {
  it("accepts a bare filename with a known extension", () => {
    expect(looksLikeFileRef("package.json")).toBe(true);
    expect(looksLikeFileRef("CLAUDE.md")).toBe(true);
    expect(looksLikeFileRef("AGENTS.md")).toBe(true);
    expect(looksLikeFileRef("tsconfig.json")).toBe(true);
  });

  it("accepts a path with separators", () => {
    expect(looksLikeFileRef("src/sidebar.ts")).toBe(true);
    expect(looksLikeFileRef("media/chat.js")).toBe(true);
    expect(looksLikeFileRef("test\\sessions.test.ts")).toBe(true);
  });

  it("accepts a path with a :line suffix and strips it before checking", () => {
    expect(looksLikeFileRef("src/sidebar.ts:42")).toBe(true);
    expect(looksLikeFileRef("media/chat.js:1-100")).toBe(true);
    expect(looksLikeFileRef("src/sidebar.ts:12:5")).toBe(true); // compiler line:col
  });

  it("accepts a path with a #Lstart-Lend anchor", () => {
    expect(looksLikeFileRef("src/sidebar.ts#L10-L20")).toBe(true);
  });

  // The bug: stripping from the FIRST `:` collapsed `C:\work\file.ts` to `C`
  // (the drive colon), so absolute Windows paths never linkified.
  it("accepts absolute Windows paths, with and without a line suffix", () => {
    expect(looksLikeFileRef("C:\\work\\file.ts")).toBe(true);
    expect(looksLikeFileRef("C:\\work\\file.ts:42")).toBe(true);
    expect(looksLikeFileRef("C:/work/file.ts:7-9")).toBe(true);
    expect(looksLikeFileRef("c:\\Users\\p\\proj\\CLAUDE.md")).toBe(true);
  });

  it("still rejects an absolute Windows path with an unknown extension", () => {
    expect(looksLikeFileRef("C:\\work\\file.xyz")).toBe(false);
  });

  it("rejects URLs even when they end in a known extension", () => {
    expect(looksLikeFileRef("https://x.ai/a.ts")).toBe(false);
    expect(looksLikeFileRef("file:///C:/work/file.ts")).toBe(false);
  });

  it("rejects a #fragment that is not a line anchor", () => {
    expect(looksLikeFileRef("foo.ts#section")).toBe(false); // unopenable — parseFileRef can't split it
  });

  it("is case-insensitive on the extension", () => {
    expect(looksLikeFileRef("Foo.TS")).toBe(true);
    expect(looksLikeFileRef("Bar.Json")).toBe(true);
  });

  it("rejects plain identifiers without an extension", () => {
    expect(looksLikeFileRef("undefined")).toBe(false);
    expect(looksLikeFileRef("null")).toBe(false);
    expect(looksLikeFileRef("foo")).toBe(false);
    expect(looksLikeFileRef("myVariable")).toBe(false);
  });

  it("rejects unknown extensions", () => {
    expect(looksLikeFileRef("foo.unknownextname")).toBe(false);
    expect(looksLikeFileRef("foo.xyz")).toBe(false);
  });

  it("rejects strings with whitespace or shell metacharacters", () => {
    expect(looksLikeFileRef("foo bar.ts")).toBe(false);
    expect(looksLikeFileRef("rm -rf foo.ts")).toBe(false);
    expect(looksLikeFileRef('"foo.ts"')).toBe(false);
    expect(looksLikeFileRef("a;b.ts")).toBe(false);
    expect(looksLikeFileRef("a|b.ts")).toBe(false);
    expect(looksLikeFileRef("a&b.ts")).toBe(false);
  });

  it("rejects empty, null-ish, or absurdly long strings", () => {
    expect(looksLikeFileRef("")).toBe(false);
    expect(looksLikeFileRef(null as unknown as string)).toBe(false);
    expect(looksLikeFileRef(undefined as unknown as string)).toBe(false);
    expect(looksLikeFileRef("a".repeat(201) + ".ts")).toBe(false);
  });

  it("rejects a BARE extension, which names a file type and not a file", () => {
    // Owner, 2026-08-10, from a real reply: "I'll list the main `.md` files and
    // what each is for." `.md` became a link to nothing.
    expect(looksLikeFileRef(".md")).toBe(false);
    expect(looksLikeFileRef(".json")).toBe(false);
    expect(looksLikeFileRef(".ts")).toBe(false);
    expect(looksLikeFileRef(".TSX")).toBe(false);
  });

  it("still accepts the bare dotted tokens that ARE whole filenames", () => {
    // The set of known extensions conflates suffixes with dotfile names, and
    // only these are files someone can actually open.
    expect(looksLikeFileRef(".env")).toBe(true);
    expect(looksLikeFileRef(".gitignore")).toBe(true);
    expect(looksLikeFileRef(".dockerignore")).toBe(true);
  });

  it("leaves dotted names with a directory part alone", () => {
    // A path is a claim about a location, which is never how a file TYPE is
    // written in prose — so the bare-token rule stops at the first separator.
    expect(looksLikeFileRef("config/.env")).toBe(true);
    expect(looksLikeFileRef("packages/app/.gitignore")).toBe(true);
    expect(looksLikeFileRef("src/index.md")).toBe(true);
  });

  it("rejects code-looking spans with a trailing dot only", () => {
    expect(looksLikeFileRef("obj.")).toBe(false);
    expect(looksLikeFileRef(".")).toBe(false);
  });

  it("FILE_EXTS exposes the configured set", () => {
    expect(FILE_EXTS.has("ts")).toBe(true);
    expect(FILE_EXTS.has("json")).toBe(true);
    expect(FILE_EXTS.has("lock")).toBe(true);
    expect(FILE_EXTS.has("env")).toBe(true);
    expect(FILE_EXTS.has("gitignore")).toBe(true);
    expect(FILE_EXTS.has("zzz")).toBe(false);
  });
});

describe("formatRelativeTime", () => {
  const now = Date.UTC(2026, 4, 22, 12, 0, 0);

  it("returns '' for falsy timestamps", () => {
    expect(formatRelativeTime(0, now)).toBe("");
    expect(formatRelativeTime(undefined, now)).toBe("");
    expect(formatRelativeTime(null, now)).toBe("");
  });

  it("formats seconds when under a minute", () => {
    expect(formatRelativeTime(now - 5_000, now)).toBe("5s ago");
    expect(formatRelativeTime(now - 30_000, now)).toBe("30s ago");
  });

  it("formats minutes when under an hour", () => {
    expect(formatRelativeTime(now - 2 * 60_000, now)).toBe("2m ago");
    expect(formatRelativeTime(now - 45 * 60_000, now)).toBe("45m ago");
  });

  it("formats hours when under a day", () => {
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatRelativeTime(now - 23 * 3_600_000, now)).toBe("23h ago");
  });

  it("formats days when under a week", () => {
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe("2d ago");
    expect(formatRelativeTime(now - 6 * 86_400_000, now)).toBe("6d ago");
  });

  it("falls back to localeDateString for timestamps older than a week", () => {
    const ts = now - 30 * 86_400_000;
    const out = formatRelativeTime(ts, now);
    expect(out).not.toMatch(/ago$/);
    expect(out.length).toBeGreaterThan(0);
  });

  it("uses Date.now() when no second arg is provided", () => {
    const out = formatRelativeTime(Date.now() - 2_000);
    expect(out).toMatch(/s ago$/);
  });
});

describe("modelDisplayName", () => {
  const models = [
    { modelId: "grok-build", name: "Grok Build" },
    { modelId: "grok-composer-2.5-fast", name: "Composer 2.5 Fast" },
  ];

  it("resolves a model ID to its user-facing name", () => {
    expect(modelDisplayName("grok-build", models)).toBe("Grok Build");
    expect(modelDisplayName("grok-composer-2.5-fast", models)).toBe("Composer 2.5 Fast");
  });

  it("falls back to the ID when the model is unknown or unnamed", () => {
    expect(modelDisplayName("grok-mystery", models)).toBe("grok-mystery");
    expect(modelDisplayName("grok-build", [{ modelId: "grok-build" }])).toBe("grok-build");
    expect(modelDisplayName("grok-build", [])).toBe("grok-build");
    expect(modelDisplayName("grok-build", undefined)).toBe("grok-build");
  });

  it("returns '' for a falsy model ID", () => {
    expect(modelDisplayName("", models)).toBe("");
    expect(modelDisplayName(undefined, models)).toBe("");
  });

  it("uses a Claude description lead so the gear button shows the generation", () => {
    expect(modelDisplayName("claude-sonnet-4-5", [
      { modelId: "claude-sonnet-4-5", name: "Sonnet", description: "Sonnet 5 · Efficient for routine tasks" },
    ])).toBe("Sonnet 5");
  });
});

describe("modelPickerLabel", () => {
  it("keeps grok and Codex names that already include a generation", () => {
    expect(modelPickerLabel({ name: "Grok Build", description: "The default Grok Build agent" })).toBe("Grok Build");
    expect(modelPickerLabel({ name: "GPT-5.6 Sol", description: "GPT-5.6 Sol · Codex" })).toBe("GPT-5.6 Sol");
  });

  it("promotes Claude's versioned description lead over a family-only name", () => {
    expect(modelPickerLabel({ name: "Sonnet", description: "Sonnet 5 · Efficient for routine tasks" })).toBe("Sonnet 5");
    expect(modelPickerLabel({ name: "Haiku", description: "Haiku 4.5 · Fastest for quick answers" })).toBe("Haiku 4.5");
    expect(modelPickerLabel({ name: "Fable", description: "Fable 5 · Most capable for your hardest and longest-running tasks" })).toBe("Fable 5");
    expect(modelPickerLabel({
      name: "Opus (1M context)",
      description: "Opus 5 with 1M context · Best for everyday, complex tasks",
    })).toBe("Opus 5 with 1M context");
  });

  it("falls back to name or id when there is no usable description", () => {
    expect(modelPickerLabel({ name: "Sonnet" })).toBe("Sonnet");
    expect(modelPickerLabel({ modelId: "claude-sonnet-4-5" })).toBe("claude-sonnet-4-5");
    expect(modelPickerLabel({})).toBe("");
  });
});

describe("parseAttachmentContext", () => {
  const deps = { readFile: () => "", extName: (p: string) => (p.includes(".") ? p.slice(p.lastIndexOf(".")) : "") };

  it("returns the input as body with no files when there's no envelope", () => {
    expect(parseAttachmentContext("just a message")).toEqual({ files: [], body: "just a message" });
  });

  it("round-trips a single attached file from buildPrompt", () => {
    const prompt = buildPrompt("fix it", [makeExplicitChip("/x/CLAUDE.md", "CLAUDE.md")], deps);
    expect(parseAttachmentContext(prompt)).toEqual({ files: ["CLAUDE.md"], body: "fix it" });
  });

  it("round-trips multiple attached files + an open-editor file", () => {
    const prompt = buildPrompt(
      "compare these",
      [
        makeExplicitChip("/x/CLAUDE.md", "CLAUDE.md"),
        makeExplicitChip("/d/pic.png", "c:\\Users\\Dell\\Downloads\\pic.png"),
        makeImplicitChip("/x/src/foo.ts", "src/foo.ts"),
      ],
      deps,
    );
    expect(parseAttachmentContext(prompt)).toEqual({
      files: ["CLAUDE.md", "c:\\Users\\Dell\\Downloads\\pic.png", "src/foo.ts"],
      body: "compare these",
    });
  });

  it("leaves a fenced selection block in the body (parseSelectionBlocks owns it)", () => {
    const prompt = buildPrompt("what is this", [makeExplicitChip("/x/a.ts", "a.ts", 1, 1)], {
      readFile: () => "const x = 1;",
      extName: () => ".ts",
    });
    const { files, body } = parseAttachmentContext(prompt);
    expect(files).toEqual([]);
    expect(body).toContain("`a.ts` (lines 1-1):");
    expect(body).toContain("what is this");
  });
});

describe("parseSelectionBlocks", () => {
  const deps = {
    readFile: () => "line1\nline2\nline3\nline4\nline5",
    extName: () => ".ts",
  };

  it("passes plain text through untouched", () => {
    expect(parseSelectionBlocks("just a message")).toEqual({ body: "just a message", selections: [] });
  });

  it("round-trips a buildPrompt selection snippet back into path + range", () => {
    const prompt = buildPrompt("what is this", [makeExplicitChip("/x/a.ts", "src/a.ts", 2, 4)], deps);
    const { body } = parseAttachmentContext(prompt);
    expect(parseSelectionBlocks(body)).toEqual({
      body: "what is this",
      selections: [{ path: "src/a.ts", start: 2, end: 4 }],
    });
  });

  it("round-trips multiple leading snippets, including a single-line one", () => {
    const prompt = buildPrompt(
      "compare",
      [makeExplicitChip("/x/a.ts", "src/a.ts", 2, 4), makeImplicitChip("/x/b.ts", "src/b.ts", 5, 5)],
      deps,
    );
    expect(parseSelectionBlocks(prompt)).toEqual({
      body: "compare",
      selections: [
        { path: "src/a.ts", start: 2, end: 4 },
        { path: "src/b.ts", start: 5, end: 5 },
      ],
    });
  });

  it("survives an envelope + snippet + text prompt end to end", () => {
    const prompt = buildPrompt(
      "explain",
      [makeExplicitChip("/x/CLAUDE.md", "CLAUDE.md"), makeExplicitChip("/x/a.ts", "src/a.ts", 2, 4)],
      deps,
    );
    const env = parseAttachmentContext(prompt);
    expect(env.files).toEqual(["CLAUDE.md"]);
    expect(parseSelectionBlocks(env.body)).toEqual({
      body: "explain",
      selections: [{ path: "src/a.ts", start: 2, end: 4 }],
    });
  });

  it("leaves a half-streamed block alone until the closing fence arrives", () => {
    const partial = "`src/a.ts` (lines 2-4):\n```ts\nline2\nline3";
    expect(parseSelectionBlocks(partial)).toEqual({ body: partial, selections: [] });
  });

  it("does not strip a selection-shaped block in the middle of the user's own words", () => {
    const body =
      "please explain this\n\n`src/a.ts` (lines 2-4):\n```ts\nline2\n```";
    expect(parseSelectionBlocks(body)).toEqual({ body, selections: [] });
  });

  it("stops at the first standalone closing fence when the snippet contains ``` itself", () => {
    // buildPrompt does no fence escaping, so a selection containing a bare ```
    // line produces an ambiguous wire — match short, exactly like markdown would.
    const body = "`a.md` (lines 1-3):\n```md\nsome\n```\n\nrest of message";
    expect(parseSelectionBlocks(body)).toEqual({
      body: "rest of message",
      selections: [{ path: "a.md", start: 1, end: 3 }],
    });
  });

  it("chains with the envelope and image parsers over a full buildPromptWithImages wire", () => {
    // envelope → selection snippet → user text → trailing [Image #N] tag: each
    // parser peels exactly its own layer of the real combined wire.
    const { text } = buildPromptWithImages(
      "explain",
      [makeExplicitChip("/x/CLAUDE.md", "CLAUDE.md"), makeExplicitChip("/x/a.ts", "src/a.ts", 2, 4)],
      [{ index: 1, mimeType: "image/png", data: "AA" }],
      deps,
    );
    const env = parseAttachmentContext(text);
    expect(env.files).toEqual(["CLAUDE.md"]);
    const sel = parseSelectionBlocks(env.body);
    expect(sel.selections).toEqual([{ path: "src/a.ts", start: 2, end: 4 }]);
    expect(parseImageTags(sel.body)).toEqual({
      body: "explain",
      images: [{ index: 1, path: undefined }],
    });
  });
});

describe("parseImageTags", () => {
  const deps = { readFile: () => "", extName: (p: string) => (p.includes(".") ? p.slice(p.lastIndexOf(".")) : "") };

  it("passes plain text through untouched", () => {
    expect(parseImageTags("just a message")).toEqual({ body: "just a message", images: [] });
  });

  it("round-trips the current wire shape (text first, trailing tag lines)", () => {
    const img = makeImageChip("/staging/a.png", 1, "image/png");
    const { text } = buildPromptWithImages(
      "what is this?",
      [img],
      [{ index: 1, mimeType: "image/png", data: "AA" }],
      deps,
    );
    expect(parseImageTags(text)).toEqual({
      body: "what is this?",
      images: [{ index: 1, path: undefined }],
    });
  });

  it("recovers the origin path from a disk-import tag", () => {
    const out = parseImageTags("compress this\n\n[Image #2] (assets/hero.png)");
    expect(out.body).toBe("compress this");
    expect(out.images).toEqual([{ index: 2, path: "assets/hero.png" }]);
  });

  it("strips the do-not-Read hint from a pasted-image tag (current wire)", () => {
    const out = parseImageTags(
      "what is this?\n\n[Image #1] (attached inline — already visible to you; do not read it from disk)",
    );
    expect(out).toEqual({ body: "what is this?", images: [{ index: 1, path: undefined }] });
  });

  it("keeps only the basename from a staged pasted-image tag", () => {
    const out = parseImageTags(
      "what is this?\n\n[Image #1] (image-123.png — local staged copy; thumbnail only; do not access this path)",
    );
    expect(out).toEqual({ body: "what is this?", images: [{ index: 1, path: "image-123.png" }] });
  });

  it("strips the do-not-Read hint but keeps the path on a disk-import tag (current wire)", () => {
    const out = parseImageTags(
      "compress this\n\n[Image #2] (assets/hero.png — attached inline; act on the path if needed, but do not Read it)",
    );
    expect(out).toEqual({ body: "compress this", images: [{ index: 2, path: "assets/hero.png" }] });
  });

  it("round-trips a disk-import tag whose filename contains parentheses", () => {
    // Browser-download dedup names — `screenshot (1).png` — put a `)` inside
    // the path; the tag's close paren must resolve to the LAST one on the line.
    const origin = "shots/screenshot (1).png";
    const img = makeImageChip("/staging/s.png", 1, "image/png", origin);
    const { text } = buildPromptWithImages(
      "describe it",
      [img],
      [{ index: 1, mimeType: "image/png", data: "AA", relPath: origin }],
      deps,
    );
    expect(parseImageTags(text)).toEqual({
      body: "describe it",
      images: [{ index: 1, path: origin }],
    });
  });

  it("leaves a literal empty-parens tag shape in the body", () => {
    // buildPromptWithImages never emits `()` — that's the user's own text.
    const body = "describe\n\n[Image #1] ()";
    expect(parseImageTags(body)).toEqual({ body, images: [] });
  });

  it("collects multiple trailing tag lines in order", () => {
    const out = parseImageTags("compare\n\n[Image #1]\n[Image #3] (a b/c.png)");
    expect(out.body).toBe("compare");
    expect(out.images).toEqual([
      { index: 1, path: undefined },
      { index: 3, path: "a b/c.png" },
    ]);
  });

  it("round-trips a non-contiguous #2 / #5 set without inventing a sequence", () => {
    const out = parseImageTags("edit both\n\n[Image #2] (two.png)\n[Image #5] (five.png)");
    expect(out.body).toBe("edit both");
    expect(out.images).toEqual([
      { index: 2, path: "two.png" },
      { index: 5, path: "five.png" },
    ]);
  });

  it("strips the legacy leading tag lines (first-build wire)", () => {
    const out = parseImageTags("[Image #1]\n[Image #2]\n\ndescribe both");
    expect(out.body).toBe("describe both");
    expect(out.images.map((i: { index: number }) => i.index)).toEqual([1, 2]);
  });

  it("strips the legacy single-image inline prefix", () => {
    const out = parseImageTags("[Image #1] what is this?");
    expect(out.body).toBe("what is this?");
    expect(out.images).toEqual([{ index: 1, path: undefined }]);
  });

  it("leaves a tag-looking string in the MIDDLE of the body alone", () => {
    const body = "the TUI shows [Image #1] before the text\n\nsee?";
    expect(parseImageTags(body)).toEqual({ body, images: [] });
  });

  it("leaves a tag inside a fenced code block alone", () => {
    const body = "explain:\n```\n[Image #1]\n```\ntrailing words";
    expect(parseImageTags(body)).toEqual({ body, images: [] });
  });

  it("handles a tags-only body (image sent with no text)", () => {
    expect(parseImageTags("[Image #1]")).toEqual({
      body: "",
      images: [{ index: 1, path: undefined }],
    });
  });
});

describe("nextMicState", () => {
  it("start enters 'connecting' (the listening waves come from the host, not the reducer)", () => {
    expect(nextMicState("idle", "start")).toBe("connecting");
    expect(nextMicState("listening", "stop")).toBe("transcribing");
    expect(nextMicState("transcribing", "transcript")).toBe("idle");
  });

  it("is stoppable while connecting (cancel before the stream is ready)", () => {
    expect(nextMicState("connecting", "stop")).toBe("transcribing");
  });

  it("resets to idle on error or reset from any state", () => {
    expect(nextMicState("connecting", "error")).toBe("idle");
    expect(nextMicState("listening", "error")).toBe("idle");
    expect(nextMicState("transcribing", "error")).toBe("idle");
    expect(nextMicState("listening", "reset")).toBe("idle");
  });

  it("does not start a new recording while transcribing or already active", () => {
    expect(nextMicState("transcribing", "start")).toBe("transcribing");
    expect(nextMicState("listening", "start")).toBe("listening");
  });

  it("ignores stop from idle or transcribing", () => {
    expect(nextMicState("idle", "stop")).toBe("idle");
    expect(nextMicState("transcribing", "stop")).toBe("transcribing");
  });

  it("ignores unknown events", () => {
    expect(nextMicState("listening", "wat")).toBe("listening");
  });
});

describe("trailingSendPhrase", () => {
  it("locates a trailing 'grok send' (returns its range)", () => {
    expect(trailingSendPhrase("fix the bug grok send", "grok send")).toEqual({ index: 12, length: 9 });
  });

  it("is case-insensitive and highlights only the phrase, not trailing punctuation", () => {
    const r = trailingSendPhrase("Refactor this Grok Send!", "grok send");
    expect(r).not.toBeNull();
    // The "!" stays part of the message, so it is NOT inside the highlighted span.
    expect("Refactor this Grok Send!".slice(r!.index, r!.index + r!.length)).toBe("Grok Send");
  });

  it("does NOT match a non-trailing or partial occurrence", () => {
    expect(trailingSendPhrase("explain grok send to me", "grok send")).toBeNull();
    expect(trailingSendPhrase("press send", "grok send")).toBeNull();
  });

  it("also highlights the 'grok sent' STT variant", () => {
    const r = trailingSendPhrase("add a button grok sent", "grok send");
    expect(r).not.toBeNull();
    expect("add a button grok sent".slice(r!.index, r!.index + r!.length)).toBe("grok sent");
  });

  it("does NOT match a bare 'sent' without 'grok' before it", () => {
    expect(trailingSendPhrase("the file was sent", "grok send")).toBeNull();
    expect(trailingSendPhrase("make sure it gets sent", "grok send")).toBeNull();
  });

  it("returns null for empty text or empty phrase", () => {
    expect(trailingSendPhrase("", "grok send")).toBeNull();
    expect(trailingSendPhrase("grok send", "")).toBeNull();
    expect(trailingSendPhrase(null as unknown as string, "grok send")).toBeNull();
  });

  it("supports a custom phrase", () => {
    expect(trailingSendPhrase("do it now go", "go")).toEqual({ index: 10, length: 2 });
  });
});

describe("isFreeTextOptionLabel", () => {
  it("recognises the CLI's own free-text choice however it is worded", () => {
    for (const label of [
      "Other", "other", "  OTHER  ", "Other…", "Other...", "Other:",
      "Other (describe)", "Other - tell me", "Something else", "None of these", "none of the above",
    ]) {
      expect(isFreeTextOptionLabel(label)).toBe(true);
    }
  });

  it("does not mistake an ordinary option for one", () => {
    // The cost of a false positive is a question with no free-text path at all,
    // which is the bug this whole mechanism exists to fix (#85).
    for (const label of ["Another approach", "Other repos should change", "Motherboard", "", null, undefined]) {
      expect(isFreeTextOptionLabel(label as any)).toBe(false);
    }
  });
});

describe("buildQuestionAnswers", () => {
  it("keys the answer map by question text → chosen label", () => {
    const questions = [{ question: "Pick a color?", options: [{ label: "Red" }, { label: "Blue" }] }];
    const { answers, allAnswered } = buildQuestionAnswers(questions, [["Blue"]]);
    expect(answers).toEqual({ "Pick a color?": "Blue" });
    expect(allAnswered).toBe(true);
  });

  it("joins multi-select labels with ', '", () => {
    const questions = [{ question: "Which?", options: [], multiSelect: true }];
    const { answers } = buildQuestionAnswers(questions, [["A", "C"]]);
    expect(answers).toEqual({ "Which?": "A, C" });
  });

  it("flags allAnswered=false while any question is unanswered", () => {
    const questions = [{ question: "Q1" }, { question: "Q2" }];
    const r = buildQuestionAnswers(questions, [["A"], []]);
    expect(r.allAnswered).toBe(false);
    expect(r.answers).toEqual({ Q1: "A", Q2: "" });
  });

  it("handles empty / missing inputs", () => {
    expect(buildQuestionAnswers([], [])).toEqual({ answers: {}, allAnswered: true });
    expect(buildQuestionAnswers(undefined, undefined)).toEqual({ answers: {}, allAnswered: true });
  });
});

describe("isSubagentToolCall", () => {
  it("matches grok's confirmed spawn_subagent shape", () => {
    // Real shape from grok 0.2.33 (research/subagents.md): tool `spawn_subagent`
    // with a `subagent_type` parameter.
    expect(isSubagentToolCall({
      title: "spawn_subagent",
      rawInput: { subagent_type: "general-purpose", prompt: "investigate" },
    })).toBe(true);
  });

  it("matches by tool name", () => {
    expect(isSubagentToolCall({ tool: "task" })).toBe(true);
    expect(isSubagentToolCall({ name: "spawn_agent" })).toBe(true);
    expect(isSubagentToolCall({ name: "run_subagent" })).toBe(true);
    expect(isSubagentToolCall({ title: "Delegate" })).toBe(true);
  });

  it("matches by kind", () => {
    expect(isSubagentToolCall({ kind: "subagent" })).toBe(true);
    expect(isSubagentToolCall({ kind: "agent" })).toBe(true);
  });

  it("matches by rawInput shape", () => {
    expect(isSubagentToolCall({ tool: "x", rawInput: { subagent_type: "tester" } })).toBe(true);
    expect(isSubagentToolCall({ tool: "x", input: { agentType: "reviewer" } })).toBe(true);
  });

  it("does not match ordinary tools", () => {
    expect(isSubagentToolCall({ tool: "read_file", kind: "read" })).toBe(false);
    expect(isSubagentToolCall({ tool: "bash", kind: "execute" })).toBe(false);
    expect(isSubagentToolCall(null)).toBe(false);
    expect(isSubagentToolCall({})).toBe(false);
  });

  it("does NOT match tools whose titles merely CONTAIN 'subagent' (working on subagent code)", () => {
    // Real false positive: grok titles a Grep call with its search query and a
    // Read with its filename — substring matching turned both into fake cards.
    expect(isSubagentToolCall({ title: "isSubagentToolCall", kind: "search" })).toBe(false);
    expect(isSubagentToolCall({ title: "Search isSubagentToolCall" })).toBe(false);
    expect(isSubagentToolCall({ title: "Read research/subagents.md", kind: "read" })).toBe(false);
    expect(isSubagentToolCall({ title: "Edit addSubagentCard in chat.js", kind: "edit" })).toBe(false);
  });

  it("matches the structural _meta marker regardless of title (grok 0.2.9x)", () => {
    expect(isSubagentToolCall({
      title: "whatever grok titles it",
      _meta: { "x.ai/tool": { name: "spawn_subagent", kind: "task", label: "Subagent" } },
    })).toBe(true);
  });

  it("_meta is authoritative BOTH ways — a Grep titled 'spawn_subagent' is not a delegation", () => {
    // Captured live (test/fixtures/composer-subagent-session.jsonl): grok
    // titles a Grep with its search pattern, so a grep FOR "spawn_subagent"
    // is titled exactly "spawn_subagent". Only _meta tells the truth.
    expect(isSubagentToolCall({ title: "spawn_subagent", _meta: { "x.ai/tool": { name: "Grep" } } })).toBe(false);
    expect(isSubagentToolCall({ title: "isSubagentToolCall", _meta: { "x.ai/tool": { name: "Grep" } } })).toBe(false);
    // The Composer agent's delegation tool is named "Task".
    expect(isSubagentToolCall({ title: "Task", _meta: { "x.ai/tool": { name: "Task" } } })).toBe(true);
  });
});

describe("cleanSubagentOutput", () => {
  it("strips the full CLI envelope (verbatim shape from a real background delegation)", () => {
    const raw =
      "This is the output of the subagent:\n\n" +
      "response:\n<response>\n" +
      "```json\n{ \"rootFileCount\": 37 }\n```\n\n**Notes:**\n- counts include dirs\n" +
      "</response>\n\n" +
      "Agent ID: 019f52c8-67d6-7b13-a335-fea6d5e218cd (can be used with the resume parameter to send a follow-up after it completes)";
    const cleaned = cleanSubagentOutput(raw);
    expect(cleaned).toBe("```json\n{ \"rootFileCount\": 37 }\n```\n\n**Notes:**\n- counts include dirs");
  });

  it("strips <subagent_meta>/<subagent_result> blocks and unpaired leftovers", () => {
    expect(cleanSubagentOutput("The answer.\n\n<subagent_meta>id=x, tool_calls=2</subagent_meta>")).toBe("The answer.");
    expect(cleanSubagentOutput("The answer.\n\n</subagent_result>")).toBe("The answer.");
  });

  it("leaves plain prose untouched, including envelope-like text mid-answer", () => {
    expect(cleanSubagentOutput("The add() function returns the sum.")).toBe("The add() function returns the sum.");
    const mid = "Step 1: wrap the payload in <response> tags.\nStep 2: read the response: field.";
    expect(cleanSubagentOutput(mid)).toBe(mid);
  });

  it("does not strip an unmatched <response> (only a full wrapping pair)", () => {
    const truncated = "<response>\npartial output that got cut off";
    expect(cleanSubagentOutput(truncated)).toBe(truncated);
  });

  it("strips a leading [subagent:<type>] label (shown only on restore)", () => {
    expect(cleanSubagentOutput("[subagent:general-purpose] Counted 3 lines.")).toBe("Counted 3 lines.");
    expect(cleanSubagentOutput("[subagent:explore]  found it")).toBe("found it");
    // …but a mid-answer occurrence is left alone (leading-anchored).
    const mid = "See [subagent:general-purpose] for the sub-run.";
    expect(cleanSubagentOutput(mid)).toBe(mid);
  });

  it("strips the label BEFORE the lead-in (a label + 'response:' combo)", () => {
    expect(cleanSubagentOutput("[subagent:explore] response: the answer")).toBe("the answer");
  });

  it("as defense, keeps only the child's words if a whole poller blob leaks in", () => {
    const blob = "=== Task 019f6a ===\nCommand: [subagent:general-purpose] Do it\nStatus: completed\nDuration: 2.0s\n\n=== Output ===\nAll done.";
    expect(cleanSubagentOutput(blob)).toBe("All done.");
  });

  it("handles null/empty", () => {
    expect(cleanSubagentOutput(null)).toBe("");
    expect(cleanSubagentOutput("")).toBe("");
  });

  it("does NOT match grok's get_command_or_subagent_output poller", () => {
    // Native-Windows grok 0.2.x delegates via a background run_terminal_command
    // and reads its output with `get_command_or_subagent_output` (variant
    // "TaskOutput", task_id). That output reader's NAME contains "subagent" but
    // it is not a delegation — it must never get a Subagent card. Verbatim wire
    // shape from research/subagents.md.
    expect(isSubagentToolCall({ title: "get_command_or_subagent_output", rawInput: { task_id: "t1" } })).toBe(false);
    expect(isSubagentToolCall({ title: "Get task output: t1", rawInput: { variant: "TaskOutput", task_id: "t1", block: true } })).toBe(false);
  });

  it("matches grok 0.2.x's background-task delegation (its real subagent mechanism)", () => {
    // No spawn_subagent on the native build — a delegation is a backgrounded
    // run_terminal_command (research/subagents.md § Ground truth). Card it so it
    // doesn't disappear into the generic tool group.
    expect(isSubagentToolCall({ title: "run_terminal_command", rawInput: { variant: "Bash", command: "Spawn background subagent to investigate", is_background: true } })).toBe(true);
    expect(isSubagentToolCall({ title: "[bg] Background task t1 started", rawInput: { variant: "Bash" } })).toBe(true);
  });

  it("does NOT match a foreground run_terminal_command", () => {
    // A normal command (is_background false or absent) stays in the tool group —
    // this is the shape grok used in the real session that prompted the fix.
    expect(isSubagentToolCall({ title: "run_terminal_command", rawInput: { variant: "Bash", command: "git status", is_background: false } })).toBe(false);
    expect(isSubagentToolCall({ title: "run_terminal_command", rawInput: { variant: "Bash", command: "git status" } })).toBe(false);
  });
});

describe("parseSubagentTaskResult (restore folds a background delegation's poller blob into its card)", () => {
  // The exact flattened shape grok replays on session/load (real capture).
  const BLOB = [
    "=== Task 019f6aa8-d3dc-70d2-bfac-785e0e5f3e03 ===",
    "Command: [subagent:general-purpose] Quick subagent smoke test",
    "Status: completed",
    "Started: 2026-07-16T11:21:17Z",
    "Ended: 2026-07-16T11:21:35Z",
    "Duration: 18.78s",
    "Exit Code: 0",
    "Output File: ",
    "",
    "=== Output ===",
    "Subagent smoke test ran successfully.",
    "",
    "<subagent_meta>id=019f6aa8, type=general-purpose, tool_calls=1, turns=1, duration_ms=18778</subagent_meta>",
  ].join("\n");

  it("parses task id, status, duration (prefers duration_ms), and the output section", () => {
    const r = parseSubagentTaskResult(BLOB)!;
    expect(r.taskId).toBe("019f6aa8-d3dc-70d2-bfac-785e0e5f3e03");
    expect(r.status).toBe("completed");
    expect(r.durationMs).toBe(18778); // <subagent_meta> duration_ms wins over "18.78s"
    expect(r.failed).toBe(false);
    expect(r.output).toContain("Subagent smoke test ran successfully.");
    expect(cleanSubagentOutput(r.output)).toBe("Subagent smoke test ran successfully.");
  });

  it("falls back to the Duration: Ns line when no meta duration_ms is present", () => {
    const noMeta = "=== Task t9 ===\nCommand: [subagent:explore] look\nStatus: completed\nDuration: 3.4s\n\n=== Output ===\ndone";
    expect(parseSubagentTaskResult(noMeta)!.durationMs).toBe(3400);
  });

  it("flags a failed / cancelled task from its Status line", () => {
    const failed = "=== Task t1 ===\nCommand: [subagent:general-purpose] x\nStatus: failed\n\n=== Output ===\nboom";
    expect(parseSubagentTaskResult(failed)!.failed).toBe(true);
    const cancelled = "=== Task t2 ===\nCommand: [subagent:general-purpose] x\nStatus: cancelled\n\n=== Output ===\n";
    expect(parseSubagentTaskResult(cancelled)!.status).toBe("cancelled");
  });

  it("returns null for a backgrounded shell COMMAND poll (same tool, not a subagent)", () => {
    // get_command_or_subagent_output also polls plain background commands — those
    // must stay as a normal tool row, so no subagent marker => null.
    const cmd = "=== Task t3 ===\nCommand: node build.js\nStatus: completed\n\n=== Output ===\nBuilt OK";
    expect(parseSubagentTaskResult(cmd)).toBeNull();
  });

  it("returns null when the blob isn't a task-output envelope at all", () => {
    expect(parseSubagentTaskResult("just some agent prose")).toBeNull();
    expect(parseSubagentTaskResult("")).toBeNull();
    expect(parseSubagentTaskResult(null as any)).toBeNull();
  });
});

describe("subagentLabel", () => {
  it("prefers the named agent type", () => {
    expect(subagentLabel({ title: "spawn_subagent", rawInput: { subagent_type: "general-purpose" } })).toBe("general-purpose");
    expect(subagentLabel({ tool: "task", rawInput: { subagent_type: "tester" } })).toBe("tester");
    expect(subagentLabel({ tool: "task", input: { agentType: "Explore" } })).toBe("Explore");
    expect(subagentLabel({ tool: "task", rawInput: { description: "Fix the build" } })).toBe("Fix the build");
  });

  it("derives a label from the backgrounded command, truncating if long", () => {
    expect(subagentLabel({ title: "run_terminal_command", rawInput: { command: "investigate the parser", is_background: true } })).toBe("investigate the parser");
    const long = subagentLabel({ rawInput: { command: "x".repeat(80), is_background: true } });
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(48);
  });

  it("falls back to a generic label", () => {
    expect(subagentLabel({ tool: "task" })).toBe("Subagent");
    expect(subagentLabel({ rawInput: { is_background: true } })).toBe("background task");
    expect(subagentLabel(null)).toBe("Subagent");
  });
});

describe("distributeSidePanelWidths", () => {
  it("honours preferred widths when the window is large enough", () => {
    const dist = distributeSidePanelWidths({
      available: 1400,
      chatMin: 360,
      panels: [
        { id: "rail", preferred: 300, min: 180, open: true },
        { id: "panel", preferred: 400, min: 200, open: true },
      ],
    });
    expect(dist).toEqual({ rail: 300, panel: 400 });
  });

  it("shrinks open panels proportionally when preferred + chat exceed available", () => {
    // preferred 500+500 + chat 360 = 1360 > 1000 → budget for panels = 640
    const dist = distributeSidePanelWidths({
      available: 1000,
      chatMin: 360,
      panels: [
        { id: "rail", preferred: 500, min: 180, open: true },
        { id: "panel", preferred: 500, min: 200, open: true },
      ],
    });
    expect(dist.rail + dist.panel).toBe(640);
    // Both above floor; neither collapses to min alone while the other stays fat.
    expect(dist.rail).toBeGreaterThan(180);
    expect(dist.panel).toBeGreaterThan(200);
    expect(dist.rail).toBeLessThan(500);
    expect(dist.panel).toBeLessThan(500);
    // Proportional: rail and panel had equal above-floor slack (320 vs 300), so
    // rail ends slightly smaller only by min difference — both mid-range.
    expect(Math.abs(dist.rail - dist.panel)).toBeLessThan(40);
  });

  it("never shrinks a panel below its floor", () => {
    const dist = distributeSidePanelWidths({
      available: 500,
      chatMin: 360,
      panels: [
        { id: "rail", preferred: 400, min: 180, open: true },
        { id: "panel", preferred: 400, min: 200, open: true },
      ],
    });
    // budget 140 < minSum 380 → floors
    expect(dist.rail).toBe(180);
    expect(dist.panel).toBe(200);
  });

  it("ignores a closed panel so the open one can keep more width", () => {
    const dist = distributeSidePanelWidths({
      available: 800,
      chatMin: 360,
      panels: [
        { id: "rail", preferred: 300, min: 180, open: true },
        { id: "panel", preferred: 500, min: 200, open: false },
      ],
    });
    expect(dist.panel).toBe(0);
    expect(dist.rail).toBe(300); // 300 + 360 <= 800
  });

  it("mutation: equal preferred widths share a deficit instead of leaving chat starved", () => {
    // Without proportional distribute, each panel would keep 350 and chat gets 300.
    const dist = distributeSidePanelWidths({
      available: 1000,
      chatMin: 360,
      panels: [
        { id: "rail", preferred: 350, min: 180, open: true },
        { id: "panel", preferred: 350, min: 200, open: true },
      ],
    });
    expect(dist.rail + dist.panel).toBe(640);
    expect(1000 - dist.rail - dist.panel).toBe(360);
  });
});

describe("panelReclampOnResizeAllowed / wireFullscreenSafeReclamp", () => {
  it("blocks re-clamp while any element is full-screen", () => {
    expect(panelReclampOnResizeAllowed(null)).toBe(true);
    expect(panelReclampOnResizeAllowed(undefined)).toBe(true);
    expect(panelReclampOnResizeAllowed({ tagName: "VIDEO" })).toBe(false);
  });

  it("skips resize during full-screen and re-clamps once on exit", () => {
    let fs: unknown = null;
    const listeners: Record<string, Array<(...a: unknown[]) => void>> = {
      resize: [],
      fullscreenchange: [],
    };
    const win = {
      addEventListener: (type: string, fn: (...a: unknown[]) => void) => {
        listeners[type] = listeners[type] || [];
        listeners[type].push(fn);
      },
      removeEventListener: (type: string, fn: (...a: unknown[]) => void) => {
        listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
      },
    };
    const doc = {
      get fullscreenElement() {
        return fs;
      },
      addEventListener: (type: string, fn: (...a: unknown[]) => void) => {
        listeners[type] = listeners[type] || [];
        listeners[type].push(fn);
      },
      removeEventListener: (type: string, fn: (...a: unknown[]) => void) => {
        listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
      },
    };
    let n = 0;
    const dispose = wireFullscreenSafeReclamp(() => {
      n += 1;
    }, { window: win as any, document: doc as any });

    for (const fn of listeners.resize) fn();
    expect(n).toBe(1);

    fs = { tagName: "VIDEO" };
    for (const fn of listeners.resize) fn();
    expect(n).toBe(1); // mutation: without the guard this would be 2

    fs = null;
    for (const fn of listeners.fullscreenchange) fn();
    expect(n).toBe(2);

    dispose();
    for (const fn of listeners.resize) fn();
    expect(n).toBe(2);
  });
});

describe("chatZoomFactor / unzoomClientPx", () => {
  it("reads --chat-zoom and converts visual px to layout px", () => {
    const doc = {
      body: {
        style: {
          getPropertyValue: (k: string) => (k === "--chat-zoom" ? "1.5" : ""),
        },
      },
    };
    expect(chatZoomFactor(doc as any)).toBe(1.5);
    expect(unzoomClientPx(150, 1.5)).toBe(100);
    expect(unzoomClientPx(150, 1)).toBe(150);
    expect(unzoomClientPx(150, 0)).toBe(150);
    expect(chatZoomFactor({ body: { style: { getPropertyValue: () => "" } } } as any)).toBe(1);
  });
});

describe("shouldStickToBottom", () => {
  it("is pinned when scrolled exactly to the bottom", () => {
    // scrollTop + clientHeight === scrollHeight
    expect(shouldStickToBottom(900, 1000, 100)).toBe(true);
  });

  it("is pinned when within the default threshold of the bottom", () => {
    // 30px from the bottom (default threshold 40)
    expect(shouldStickToBottom(870, 1000, 100)).toBe(true);
  });

  it("is NOT pinned once scrolled up past the threshold", () => {
    // 200px from the bottom — the user is reading history (#16)
    expect(shouldStickToBottom(700, 1000, 100)).toBe(false);
  });

  it("is pinned when content fits without scrolling", () => {
    // scrollHeight <= clientHeight, scrollTop 0 → distance is negative
    expect(shouldStickToBottom(0, 80, 100)).toBe(true);
  });

  it("honors a custom threshold", () => {
    // 150px from bottom: pinned only with a generous threshold
    expect(shouldStickToBottom(750, 1000, 100, 200)).toBe(true);
    expect(shouldStickToBottom(750, 1000, 100, 50)).toBe(false);
  });

  it("stickThresholdPx scales with line height and floors at 24", () => {
    expect(stickThresholdPx(13)).toBe(26);
    expect(stickThresholdPx(20)).toBe(40);
    expect(stickThresholdPx(32)).toBe(64);
    expect(stickThresholdPx(0)).toBe(40);
    expect(stickThresholdPx(undefined)).toBe(40);
  });
});

describe("splitMath", () => {
  it("returns the whole string as one text segment when there is no math", () => {
    expect(splitMath("just plain prose with no tex")).toEqual([
      { type: "text", value: "just plain prose with no tex" },
    ]);
  });

  it("extracts inline \\(...\\) math with display:false", () => {
    expect(splitMath("the value \\(x^2\\) here")).toEqual([
      { type: "text", value: "the value " },
      { type: "math", value: "x^2", display: false },
      { type: "text", value: " here" },
    ]);
  });

  it("extracts display \\[...\\] math with display:true", () => {
    expect(splitMath("before\n\\[E = mc^2\\]\nafter")).toEqual([
      { type: "text", value: "before\n" },
      { type: "math", value: "E = mc^2", display: true },
      { type: "text", value: "\nafter" },
    ]);
  });

  it("treats $$...$$ as display math", () => {
    expect(splitMath("$$a+b$$")).toEqual([
      { type: "math", value: "a+b", display: true },
    ]);
  });

  it("handles multiple math spans in one string", () => {
    const segs = splitMath("\\(a\\) and \\(b\\) then \\[c\\]");
    expect(segs.map((s) => s.type)).toEqual(["math", "text", "math", "text", "math"]);
    expect(segs.filter((s) => s.type === "math").map((s) => s.display)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("supports multi-line display math (e.g. matrices)", () => {
    const src = "\\[\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}\\]";
    const segs = splitMath(src);
    expect(segs).toHaveLength(1);
    expect(segs[0].type).toBe("math");
    expect(segs[0].display).toBe(true);
    expect(segs[0].value).toContain("\\begin{pmatrix}");
  });

  it("does NOT treat bare dollar amounts as math", () => {
    expect(splitMath("it costs $5 and then $10 total")).toEqual([
      { type: "text", value: "it costs $5 and then $10 total" },
    ]);
  });

  it("leaves empty delimiters as literal text", () => {
    expect(splitMath("a \\(\\) b")).toEqual([
      { type: "text", value: "a \\(\\) b" },
    ]);
  });

  it("coerces null/undefined to an empty result", () => {
    expect(splitMath(null)).toEqual([]);
    expect(splitMath(undefined)).toEqual([]);
  });
});

describe("stripUnsupportedTex", () => {
  it("removes \\label{...} (KaTeX can't render it — shows a red error otherwise)", () => {
    expect(stripUnsupportedTex("f(x) = x^2 \\label{eq:quadratic} + 1")).toBe(
      "f(x) = x^2  + 1",
    );
  });

  it("strips every \\label in an align block, leaving the equations intact", () => {
    const src =
      "\\begin{align} a &= b \\label{one} \\\\ c &= d \\label{two} \\end{align}";
    const out = stripUnsupportedTex(src);
    expect(out).not.toContain("\\label");
    expect(out).toContain("\\begin{align}");
    expect(out).toContain("a &= b");
    expect(out).toContain("c &= d");
  });

  it("tolerates whitespace before the brace", () => {
    expect(stripUnsupportedTex("x \\label {foo} y")).toBe("x  y");
  });

  it("leaves math without \\label unchanged", () => {
    const src = "\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}";
    expect(stripUnsupportedTex(src)).toBe(src);
  });

  it("coerces null/undefined to an empty string", () => {
    expect(stripUnsupportedTex(null)).toBe("");
    expect(stripUnsupportedTex(undefined)).toBe("");
  });
});

describe("toolFailureText", () => {
  it("returns null for a non-failed call", () => {
    expect(toolFailureText({ status: "completed" })).toBe(null);
    expect(toolFailureText({ status: "in_progress" })).toBe(null);
    expect(toolFailureText(null)).toBe(null);
  });

  it("prefers rawOutput.message", () => {
    expect(
      toolFailureText({ status: "failed", rawOutput: { message: "boom" } }),
    ).toBe("boom");
  });

  it("falls back to a content[].content.text blob", () => {
    expect(
      toolFailureText({
        status: "failed",
        content: [{ type: "content", content: { type: "text", text: "no such file" } }],
      }),
    ).toBe("no such file");
  });

  it("mines a variant-specific rawOutput key when there is no message/content (list_dir NotFound)", () => {
    // Real wire shape from a failed list_dir on a missing directory — the error
    // lives only under rawOutput.NotFound, which the generic fallback used to hide.
    expect(
      toolFailureText({
        status: "failed",
        rawOutput: { type: "ListDir", NotFound: "Error: c:\\x\\fkjgk does not exist." },
      }),
    ).toBe("Error: c:\\x\\fkjgk does not exist.");
  });

  it("mines rawOutput.FileReadError as the variant key too", () => {
    expect(
      toolFailureText({
        status: "failed",
        rawOutput: { type: "FileRead", FileReadError: "Cannot read binary file: x.png" },
      }),
    ).toBe("Cannot read binary file: x.png");
  });

  it("skips the 'type' discriminant and non-string variant values", () => {
    expect(
      toolFailureText({ status: "failed", rawOutput: { type: "Whatever", count: 3, note: "the reason" } }),
    ).toBe("the reason");
  });

  it("returns the generic fallback when nothing stringy is present", () => {
    expect(toolFailureText({ status: "failed", rawOutput: { type: "X" } })).toBe("Tool call failed.");
    expect(toolFailureText({ status: "error" })).toBe("Tool call failed.");
  });
});

describe("isMediaGenToolCall (webview mirror)", () => {
  it("flags /imagine and /imagine-video titles and variants", () => {
    expect(isMediaGenToolCall({ title: "imagine-video: a cube" })).toBe(true);
    expect(isMediaGenToolCall({ title: "video_gen" })).toBe(true);
    expect(isMediaGenToolCall({ title: "image_to_video", rawInput: { variant: "ImageToVideo" } })).toBe(true);
    expect(isMediaGenToolCall({ title: "imagine: red cube" })).toBe(true);
    expect(isMediaGenToolCall({ rawInput: { variant: "VideoGen" } })).toBe(true);
  });

  it("does not flag ordinary tools", () => {
    expect(isMediaGenToolCall({ title: "Read `/a.ts`", kind: "read" })).toBe(false);
    expect(isMediaGenToolCall({ title: "run_terminal_command" })).toBe(false);
    expect(isMediaGenToolCall(null)).toBe(false);
  });
});

describe("mediaGenZeroRetentionHint", () => {
  const ZDR =
    'Video generation failed with HTTP 400 Bad Request: {"code":"invalid-argument","error":"Zero Data Retention teams must provide output.upload_url for video generation."}';

  it("returns the CLI Opt-in path only for the ZDR + upload_url signature", () => {
    expect(mediaGenZeroRetentionHint(ZDR)).toBe(
      "Grok CLI /settings → Privacy → Coding data, retention, and training → Opt in.",
    );
  });

  it("returns null for other failures and non-strings", () => {
    expect(mediaGenZeroRetentionHint("image reference not readable")).toBe(null);
    expect(mediaGenZeroRetentionHint('HTTP 400: {"code":"invalid-argument","error":"prompt too long"}')).toBe(null);
    expect(mediaGenZeroRetentionHint("Zero Data Retention but no upload field")).toBe(null);
    expect(mediaGenZeroRetentionHint("must provide output.upload_url without ZDR wording")).toBe(null);
    expect(mediaGenZeroRetentionHint(null as any)).toBe(null);
    expect(mediaGenZeroRetentionHint("")).toBe(null);
  });
});

describe("commandProgramLabel", () => {
  it("keeps a non-flag subcommand", () => {
    expect(commandProgramLabel("git status")).toBe("git status");
    expect(commandProgramLabel("git status --short")).toBe("git status");
    expect(commandProgramLabel("npm test")).toBe("npm test");
    expect(commandProgramLabel("node build.js")).toBe("node build.js");
  });

  it("drops a flag or payload, leaving just the program", () => {
    expect(commandProgramLabel('node -e "console.log(1)"')).toBe("node");
    expect(commandProgramLabel("ls -la /tmp")).toBe("ls");
    expect(commandProgramLabel("dir /s /b foo")).toBe("dir"); // Windows /-flags
  });

  it("summarizes only the first statement (stops at ; | && || &)", () => {
    expect(commandProgramLabel('Get-Date; Write-Output "done"')).toBe("Get-Date");
    expect(commandProgramLabel("cat foo | grep bar")).toBe("cat foo");
    expect(commandProgramLabel("cd src && npm test")).toBe("cd src");
  });

  it("handles PowerShell Verb-Noun cmdlets (leading dash only marks a flag)", () => {
    expect(commandProgramLabel("Get-ChildItem -Path . -Recurse")).toBe("Get-ChildItem");
    expect(commandProgramLabel("Get-Date")).toBe("Get-Date");
  });

  it("drops a QUOTED next token (an argument/banner, not a subcommand)", () => {
    // A quoted arg is data — dragging it in makes the label a long truncated slab
    // (the reported "Run Write-Output === 1. git statu…"). Just show the program.
    expect(commandProgramLabel('Write-Output "hello"')).toBe("Write-Output");
    expect(commandProgramLabel("Write-Output '=== 1. git status ==='; git status")).toBe("Write-Output");
    expect(commandProgramLabel('Set-Location "c:\\GitHub\\a b"; git status')).toBe("Set-Location");
    expect(commandProgramLabel("echo 'a long banner message here'")).toBe("echo");
    // …but a bare next word (a real subcommand) is still kept.
    expect(commandProgramLabel("git commit -m x")).toBe("git commit");
  });

  it("path-strips the executable and de-quotes a spaced path", () => {
    expect(commandProgramLabel("/usr/bin/node script.js")).toBe("node script.js");
    expect(commandProgramLabel('"C:\\Program Files\\tool.exe" run')).toBe("tool.exe run");
  });

  it("skips leading FOO=bar env assignments", () => {
    expect(commandProgramLabel("DEBUG=1 node app.js")).toBe("node app.js");
  });

  it("strips a `(cd dir ; cmd)` subshell and skips the cd prelude (grok's navigate-then-run idiom)", () => {
    // The reported "Run (cd" — should name the command that does the work, not the
    // `(cd` plumbing. This POSIX subshell is what grok emits even against PowerShell.
    expect(commandProgramLabel('(cd "c:\\GitHub\\grok-build-vscode" ; node research/auto-compact-probe.cjs)')).toBe("node");
    expect(commandProgramLabel("(cd dir ; git status)")).toBe("git status");
    expect(commandProgramLabel("(cd a && cd b && node build.js)")).toBe("node build.js");
    expect(commandProgramLabel("(npm test)")).toBe("npm test"); // subshell, no cd prelude
    expect(commandProgramLabel("(cd foo)")).toBe("cd foo"); // a lone cd still shows cd
  });

  it("only reinterprets cd inside a () subshell — a user-typed cd chain is left alone", () => {
    expect(commandProgramLabel("cd src && npm test")).toBe("cd src"); // unchanged (regression guard)
  });

  it("does not append a path/filename argument as if it were a subcommand", () => {
    // A token containing a path separator is an argument, not a `git status`-style verb.
    expect(commandProgramLabel("node research/auto-compact-probe.cjs")).toBe("node");
    expect(commandProgramLabel("python scripts/run.py")).toBe("python");
    // …but a bare filename with no path separator is still kept (unchanged).
    expect(commandProgramLabel("node build.js")).toBe("node build.js");
  });

  it("caps very long labels", () => {
    const out = commandProgramLabel("someverylongprogramname anotherverylongsubcommandword extra");
    expect(out.length).toBeLessThanOrEqual(30);
    expect(out.endsWith("…")).toBe(true);
  });

  it("falls back to 'command' for empty / unparseable input", () => {
    expect(commandProgramLabel("")).toBe("command");
    expect(commandProgramLabel("   ")).toBe("command");
    expect(commandProgramLabel(null as unknown as string)).toBe("command");
    expect(commandProgramLabel("FOO=bar")).toBe("command"); // only an env assignment, no program
  });
});

describe("commandTextPreview", () => {
  it("shows up to the requested number of logical lines", () => {
    expect(commandTextPreview("1\n2\n3\n4\n5", 6)).toEqual({
      text: "1\n2\n3\n4\n5",
      lineCount: 5,
      truncated: false,
    });
    expect(commandTextPreview("1\n2\n3\n4\n5\n6", 6)).toEqual({
      text: "1\n2\n3\n4\n5\n6",
      lineCount: 6,
      truncated: false,
    });
    expect(commandTextPreview("1\n2\n3\n4\n5\n6\n7", 6)).toEqual({
      text: "1\n2\n3\n4\n5\n6",
      lineCount: 7,
      truncated: true,
    });
  });

  it("treats one very long line as one line", () => {
    const oneLiner = `python -c "${"x".repeat(2000)}"`;
    expect(commandTextPreview(oneLiner, 6)).toEqual({
      text: oneLiner,
      lineCount: 1,
      truncated: false,
    });
  });

});

describe("extractToolResultOutput (cursor/Composer self-executed command result)", () => {
  it("reads the decoded content text + exit code", () => {
    const r = extractToolResultOutput({
      rawOutput: { type: "Bash", output: [1, 2, 3], exit_code: 0, truncated: false },
      content: [{ type: "content", content: { type: "text", text: "v20.19.0\n10.8.2" } }],
    });
    expect(r).toEqual({ output: "v20.19.0\n10.8.2", exitCode: 0, truncated: false, cancelled: false, agentSawCut: true });
  });

  it("decodes rawOutput.output bytes when there's no content text", () => {
    const bytes = [...Buffer.from("hi ✓", "utf8")]; // multibyte survives TextDecoder
    const r = extractToolResultOutput({ rawOutput: { type: "Bash", output: bytes, exit_code: 0 } });
    expect(r!.output).toBe("hi ✓");
  });

  it("carries a non-zero exit code (for the [Error] marker)", () => {
    const r = extractToolResultOutput({
      rawOutput: { type: "Bash", exit_code: 1, truncated: true },
      content: [{ type: "content", content: { type: "text", text: "boom" } }],
    });
    expect(r).toEqual({ output: "boom", exitCode: 1, truncated: true, cancelled: false, agentSawCut: true });
  });

  it("returns null when there's no command result to show", () => {
    expect(extractToolResultOutput(null as unknown as object)).toBeNull();
    expect(extractToolResultOutput({})).toBeNull();
    expect(extractToolResultOutput({ rawOutput: {} })).toBeNull(); // no output, no exit code
  });

  it("prefers Claude's string rawOutput over fenced content and leaves exitCode null", () => {
    expect(extractToolResultOutput({
      status: "completed",
      rawOutput: "REPLAY_MARKER_4b7c",
      content: [{ type: "content", content: { type: "text", text: "```console\nREPLAY_MARKER_4b7c\n```" } }],
    })).toEqual({ output: "REPLAY_MARKER_4b7c", exitCode: null, truncated: false, cancelled: false, agentSawCut: true });
  });

  it("applies the same 100K display cap as the host restore path", () => {
    const huge = "x".repeat(MAX_COMMAND_OUTPUT_CHARS + 25);
    const fromString = extractToolResultOutput({
      rawOutput: huge,
      content: [{ type: "content", content: { type: "text", text: "```console\n" + huge + "\n```" } }],
    });
    expect(fromString).toEqual({
      output: "x".repeat(MAX_COMMAND_OUTPUT_CHARS),
      exitCode: null,
      truncated: true,
      cancelled: false,
      agentSawCut: true,
    });
    expect(fromString!.output).not.toContain("```");
    const fromContent = extractToolResultOutput({
      rawOutput: { type: "Bash", exit_code: 0, truncated: false },
      content: [{ type: "content", content: { type: "text", text: huge } }],
    });
    expect(fromContent?.output).toHaveLength(MAX_COMMAND_OUTPUT_CHARS);
    expect(fromContent?.truncated).toBe(true);
    expect(capCommandOutput("short", false)).toEqual({ output: "short", truncated: false });
    expect(capCommandOutput("already", true)).toEqual({ output: "already", truncated: true });
  });

  it("does not invent shell output for a host-normalized MCP row", () => {
    expect(extractToolResultOutput({
      detailInput: JSON.stringify({ message: "x" }, null, 2),
      rawOutput: [{ type: "text", text: "Echo: x" }],
      content: [{ type: "content", content: { type: "text", text: "Echo: x" } }],
    })).toBeNull();
    expect(extractToolResultOutput({
      detailInput: null,
      rawOutput: "REPLAY_MARKER_4b7c",
    })).toBeNull();
  });
});

describe("commandOutputWasCancelled", () => {
  it("trusts an explicit cancelled flag from a host that states it", () => {
    expect(commandOutputWasCancelled({ exitCode: null, cancelled: true })).toBe(true);
    expect(commandOutputWasCancelled({ exitCode: null, cancelled: false })).toBe(false);
    expect(commandOutputWasCancelled({ exitCode: 0, cancelled: false })).toBe(false);
    expect(commandOutputWasCancelled({ exitCode: 1, cancelled: true })).toBe(true);
  });

  it("falls back to null exit when an older host omitted the field", () => {
    expect(commandOutputWasCancelled({ exitCode: null })).toBe(true);
    expect(commandOutputWasCancelled({ command: "sleep 999", output: "partial", exitCode: null, truncated: true })).toBe(true);
    expect(commandOutputWasCancelled({ exitCode: 0 })).toBe(false);
    expect(commandOutputWasCancelled({ exitCode: 1 })).toBe(false);
  });

  it("does not treat a missing payload as cancelled", () => {
    expect(commandOutputWasCancelled(null)).toBe(false);
    expect(commandOutputWasCancelled(undefined)).toBe(false);
    expect(commandOutputWasCancelled({})).toBe(false);
  });
});

describe("commandOutputTruncationNote", () => {
  it("states the agent saw a shell cut when this host says so", () => {
    expect(commandOutputTruncationNote({ truncated: true, agentSawCut: true }))
      .toBe("output truncated — grok saw the same cut");
  });

  it("does not claim the agent saw an MCP display cut", () => {
    expect(commandOutputTruncationNote({ truncated: true, agentSawCut: false }))
      .toBe("output truncated — display only; the agent saw the full result");
  });

  it("does not attribute a cut when an older host omitted agentSawCut", () => {
    expect(commandOutputTruncationNote({ truncated: true })).toBe("output truncated");
    expect(commandOutputTruncationNote({ truncated: true, command: "x", output: "y" }))
      .toBe("output truncated");
  });

  it("is empty when nothing was truncated", () => {
    expect(commandOutputTruncationNote({ truncated: false, agentSawCut: true })).toBe("");
    expect(commandOutputTruncationNote(null)).toBe("");
    expect(commandOutputTruncationNote({})).toBe("");
  });
});

describe("computeLineDiff", () => {
  const types = (r: { lines: { type: string; text: string }[] }) => r.lines.map((l) => l.type + ":" + l.text);

  it("a one-line word change is one del + one add", () => {
    const r = computeLineDiff("alpha", "beta");
    expect(r.added).toBe(1);
    expect(r.removed).toBe(1);
    expect(types(r)).toEqual(["del:alpha", "add:beta"]);
  });

  it("keeps unchanged lines as context and counts only the real change", () => {
    // "a\nb" -> "a\nB\nc": 'a' is context, 'b' removed, 'B' and 'c' added.
    const r = computeLineDiff("a\nb", "a\nB\nc");
    expect(r.added).toBe(2);
    expect(r.removed).toBe(1);
    expect(types(r)).toEqual(["ctx:a", "del:b", "add:B", "add:c"]);
  });

  it("a new file (empty oldText) is pure additions, never a phantom -1", () => {
    const r = computeLineDiff("", "line1\nline2");
    expect(r.removed).toBe(0);
    expect(r.added).toBe(2);
    expect(types(r)).toEqual(["add:line1", "add:line2"]);
  });

  it("a full deletion (empty newText) is pure removals", () => {
    const r = computeLineDiff("x\ny", "");
    expect(r.added).toBe(0);
    expect(r.removed).toBe(2);
    expect(types(r)).toEqual(["del:x", "del:y"]);
  });

  it("normalizes CRLF so a \\r\\n region does not fabricate changes", () => {
    // Identical content, only line endings differ → zero changes.
    const r = computeLineDiff("a\r\nb\r\n", "a\nb\n");
    expect(r.added).toBe(0);
    expect(r.removed).toBe(0);
    expect(r.lines.every((l) => l.type === "ctx")).toBe(true);
    // And no stray \r survives into the rendered text.
    expect(r.lines.some((l) => /\r/.test(l.text))).toBe(false);
  });

  it("identical text yields no additions or removals", () => {
    const r = computeLineDiff("same\ntext", "same\ntext");
    expect(r.added).toBe(0);
    expect(r.removed).toBe(0);
  });

  it("an inserted line in the middle is a single addition", () => {
    const r = computeLineDiff("a\nc", "a\nb\nc");
    expect(r.added).toBe(1);
    expect(r.removed).toBe(0);
    expect(types(r)).toEqual(["ctx:a", "add:b", "ctx:c"]);
  });

  it("both empty is an empty diff", () => {
    const r = computeLineDiff("", "");
    expect(r.lines).toEqual([]);
    expect(r.added).toBe(0);
    expect(r.removed).toBe(0);
  });

  it("falls back to a flat replace (flagged truncated) past the size cap", () => {
    const big = Array.from({ length: 40 }, (_, i) => "l" + i).join("\n");
    const big2 = Array.from({ length: 40 }, (_, i) => "m" + i).join("\n");
    const r = computeLineDiff(big, big2, { maxProduct: 100 }); // 40*40=1600 > 100
    expect(r.truncated).toBe(true);
    expect(r.removed).toBe(40);
    expect(r.added).toBe(40);
  });
});

describe("middleElide", () => {
  const title = "mcp.codex_apps.codex_document_control.list_documents";

  it("keeps a short string untouched", () => {
    expect(middleElide("mcp.canva.search-designs", TOOL_LABEL_MAX)).toBe("mcp.canva.search-designs");
  });

  it("keeps both ends of a long MCP title", () => {
    const shown = middleElide(title, TOOL_LABEL_MAX);
    expect(shown.length).toBe(TOOL_LABEL_MAX);
    expect(shown).toContain("…");
    expect(shown.startsWith("mcp.codex")).toBe(true);
    expect(shown.endsWith("list_documents")).toBe(true);
    expect(shown).not.toBe(title);
    // Tail-only cut was "mcp.codex_apps.codex_document_control.list_docu…"
    expect(shown.endsWith("…")).toBe(false);
  });

  it("gives an odd leftover character to the tail", () => {
    expect(middleElide("abcdefghijklmnopqrstuvwxyz", 9)).toBe("abcd…wxyz");
  });
});

describe("filterCommands (webview copy)", () => {
  it("includes description-only matches after name matches", () => {
    const skills = [
      { name: "web-design", description: "UI components" },
      { name: "ui-kit", description: "buttons" },
      { name: "notes", description: "quick ui tips" },
    ];
    expect(filterCommands(skills, "ui").map((c: { name: string }) => c.name)).toEqual([
      "ui-kit",
      "web-design",
      "notes",
    ]);
  });
});

describe("highlightQueryParts", () => {
  it("splits on the first case-insensitive run", () => {
    expect(highlightQueryParts("Compress conversation", "con")).toEqual([
      { text: "Compress ", hit: false },
      { text: "con", hit: true },
      { text: "versation", hit: false },
    ]);
    expect(highlightQueryParts("/ui-kit", "UI")).toEqual([
      { text: "/", hit: false },
      { text: "ui", hit: true },
      { text: "-kit", hit: false },
    ]);
  });

  it("leaves angle brackets as text parts, not markup", () => {
    expect(highlightQueryParts("<img src=x onerror=alert(1)> design", "design")).toEqual([
      { text: "<img src=x onerror=alert(1)> ", hit: false },
      { text: "design", hit: true },
    ]);
  });
});

describe("appendHighlightedText", () => {
  it("paints a match with text nodes so markup in the source stays inert", () => {
    const win = new Window();
    const el = win.document.createElement("div");
    appendHighlightedText(el, "<img src=x onerror=alert(1)> design", "design");
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toBe("<img src=x onerror=alert(1)> design");
    const hit = el.querySelector(".slash-hl");
    expect(hit).not.toBeNull();
    expect(hit!.textContent).toBe("design");
    expect(el.childNodes.length).toBe(2);
    expect(el.childNodes[0].nodeType).toBe(win.document.TEXT_NODE);
  });
});

describe("splitHistoryWindow (#102)", () => {
  function turns(n: number, start = 0) {
    const out: { type: string; text?: string }[] = [];
    for (let i = 0; i < n; i++) {
      out.push({ type: "userMessage", text: `u${start + i}` });
      out.push({ type: "agentStart" });
      out.push({ type: "messageChunk", text: `a${start + i}` });
      out.push({ type: "agentEnd" });
    }
    return out;
  }

  it("keeps a short replay intact", () => {
    const msgs = turns(3);
    const split = splitHistoryWindow(msgs, 80);
    expect(split.prefixUserCount).toBe(0);
    expect(split.prefix).toEqual([]);
    expect(split.suffix).toHaveLength(msgs.length);
  });

  it("splits on counted user bubbles and keeps the live tail", () => {
    const msgs = turns(10);
    const split = splitHistoryWindow(msgs, 4);
    expect(split.prefixUserCount).toBe(6);
    expect(countHistoryReplayCounters(split.prefix).userMsgCount).toBe(6);
    expect(split.suffix.find((m) => m.type === "userMessage")?.text).toBe("u6");
    expect(split.suffix.filter((m) => m.type === "userMessage")).toHaveLength(4);
  });

  it("flattens historyBatch and skips steer / primer user turns", () => {
    const msgs = [
      { type: "historyBatch", messages: turns(2) },
      { type: "userMessage", text: "steer", steer: true },
      { type: "userMessageChunk", text: "<system-reminder> plumbing" },
      { type: "userMessage", text: "kept" },
      { type: "messageChunk", text: "ok" },
    ];
    const flat = flattenHistoryMessages(msgs);
    expect(flat.some((m) => m.type === "historyBatch")).toBe(false);
    const split = splitHistoryWindow(msgs, 1);
    expect(split.prefixUserCount).toBe(2);
    expect(split.suffix.filter((m) => m.type === "userMessage" && !m.steer)).toHaveLength(1);
    expect(split.suffix.find((m) => m.type === "userMessage" && !m.steer)?.text).toBe("kept");
  });

  it("windowTurns <= 0 parks everything in prefix", () => {
    const split = splitHistoryWindow(turns(3), 0);
    expect(split.suffix).toEqual([]);
    expect(split.prefixUserCount).toBe(3);
  });
});

describe("partitionHistoryCards", () => {
  const cards = [
    { text: "early", afterUserMessage: 10 },
    { text: "start", afterUserMessage: 1380 },
    { text: "mid", afterUserMessage: 1390 },
    { text: "end", afterUserMessage: 1420 },
    { text: "unpositioned" },
  ];

  it("gives a hydrated chunk only the cards whose turns it renders", () => {
    const { inChunk, rest } = partitionHistoryCards(cards, 1380, 1420);
    expect(inChunk.map((c: { text: string }) => c.text)).toEqual(["start", "mid", "end"]);
    expect(rest.map((c: { text: string }) => c.text)).toEqual(["early", "unpositioned"]);
  });

  it("keeps earlier cards deferred for the chunks that will render theirs", () => {
    const { inChunk, rest } = partitionHistoryCards(cards, 1340, 1380);
    expect(inChunk.map((c: { text: string }) => c.text)).toEqual(["start"]);
    expect(rest.map((c: { text: string }) => c.text)).toEqual(["early", "mid", "end", "unpositioned"]);
  });
});

describe("formatWaitElapsed", () => {
  it("FLOORS, so it never shows time that has not passed", () => {
    // Rounding would read 25s at 24.9s. A counter may lag reality; it may not
    // run ahead of it.
    expect(formatWaitElapsed(24_900)).toBe("24s");
    expect(formatWaitElapsed(0)).toBe("0s");
    expect(formatWaitElapsed(59_999)).toBe("59s");
  });

  it("switches to minutes and hours so a long stall stays readable", () => {
    // The reason the hour tier exists: promptAbsoluteTimeoutMs is 24h, so a
    // seconds-only counter would end up reading "86399s".
    expect(formatWaitElapsed(60_000)).toBe("1m 0s");
    expect(formatWaitElapsed(1_847_000)).toBe("30m 47s");
    expect(formatWaitElapsed(3_600_000)).toBe("1h 0m");
    expect(formatWaitElapsed(9_000_000)).toBe("2h 30m");
  });

  it("returns '' rather than NaN for junk", () => {
    for (const bad of [undefined, null, "20000", NaN, Infinity, -1]) {
      expect(formatWaitElapsed(bad as never)).toBe("");
    }
  });
});

describe("isCountableUserBubble", () => {
  const { document } = new Window();
  function el(cls: string, attrs: Record<string, string> = {}) {
    const node = document.createElement("div");
    node.className = cls;
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  }

  it("counts a sent user bubble", () => {
    expect(isCountableUserBubble(el("msg user"))).toBe(true);
  });

  it("rejects queued and steer bubbles", () => {
    expect(isCountableUserBubble(el("msg user queued"))).toBe(false);
    expect(isCountableUserBubble(el("msg user", { "data-steer": "1" }))).toBe(false);
  });

  it("rejects agent and missing nodes", () => {
    expect(isCountableUserBubble(el("msg agent"))).toBe(false);
    expect(isCountableUserBubble(null)).toBe(false);
  });
});
