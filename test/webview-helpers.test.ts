import { describe, it, expect } from "vitest";
// @ts-expect-error — plain JS module, no types
import { looksLikeFileRef, formatRelativeTime, FILE_EXTS, modelDisplayName, nextMicState, trailingSendPhrase, buildQuestionAnswers, isSubagentToolCall, subagentLabel, cleanSubagentOutput, parseSubagentTaskResult, shouldStickToBottom, splitMath, stripUnsupportedTex, parseAttachmentContext, parseSelectionBlocks, parseImageTags, toolFailureText, commandProgramLabel, commandTextPreview, extractToolResultOutput, computeLineDiff, aggregateTurnEdits, turnDiffSummaryTitle, normalizeTurnEditPathKey, parseShellDeletePaths } from "../media/webview-helpers.js";
import { buildPrompt, buildPromptWithImages } from "../src/prompt-builder";
import { makeExplicitChip, makeImplicitChip, makeImageChip } from "../src/chips";

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
    expect(r).toEqual({ output: "v20.19.0\n10.8.2", exitCode: 0, truncated: false });
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
    expect(r).toEqual({ output: "boom", exitCode: 1, truncated: true });
  });

  it("returns null when there's no command result to show", () => {
    expect(extractToolResultOutput(null as unknown as object)).toBeNull();
    expect(extractToolResultOutput({})).toBeNull();
    expect(extractToolResultOutput({ rawOutput: {} })).toBeNull(); // no output, no exit code
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

describe("normalizeTurnEditPathKey / parseShellDeletePaths", () => {
  it("case-folds and slash-normalizes path keys", () => {
    expect(normalizeTurnEditPathKey("d:\\Temp\\AITest\\F1.txt"))
      .toBe(normalizeTurnEditPathKey("d:/Temp/AITest/f1.txt"));
    expect(normalizeTurnEditPathKey("src/A.ts")).toBe("src/a.ts");
  });

  it("parses PowerShell Remove-Item and POSIX rm delete targets", () => {
    expect(parseShellDeletePaths("Remove-Item -Force 'd:\\Temp\\AITest\\to-delete-1.txt'"))
      .toEqual(["d:\\Temp\\AITest\\to-delete-1.txt"]);
    expect(parseShellDeletePaths('Remove-Item -ErrorAction SilentlyContinue "C:\\work\\F2.txt"'))
      .toEqual(["C:\\work\\F2.txt"]);
    expect(parseShellDeletePaths("rm -f /tmp/x.txt")).toEqual(["/tmp/x.txt"]);
    expect(parseShellDeletePaths("rm -rf a b")).toEqual(["a", "b"]);
    expect(parseShellDeletePaths("Start-Sleep -Seconds 3")).toEqual([]);
    expect(parseShellDeletePaths("git status")).toEqual([]);
  });
});

describe("aggregateTurnEdits (turn-level file change summary)", () => {
  /** Build an entry with +/− from the same LCS the row renderer uses. */
  function edit(path: string, oldText: string, newText: string) {
    const r = computeLineDiff(oldText, newText);
    return {
      path,
      added: r.added,
      removed: r.removed,
      oldText,
      newText,
      openDiff: { type: "openDiff" as const, path, oldText, newText },
    };
  }

  it("returns empty when there are no entries", () => {
    expect(aggregateTurnEdits([])).toEqual({ files: [], totalAdded: 0, totalRemoved: 0 });
    expect(aggregateTurnEdits(null as unknown as [])).toEqual({ files: [], totalAdded: 0, totalRemoved: 0 });
    expect(turnDiffSummaryTitle({ files: [], totalAdded: 0, totalRemoved: 0 })).toBe("");
  });

  it("merges case-variant paths, sums multi-edit +/−, openDiff spans first→last", () => {
    const e1 = edit("src/A.ts", "x", "y");
    const e2 = edit("src/a.ts", "y", "z");
    const b = edit("src/b.ts", "", "hi");
    const r = aggregateTurnEdits([b, e1, e2]);
    expect(r.files).toHaveLength(2);
    const a = r.files.find((f) => /a\.ts$/i.test(f.path))!;
    expect(a.added).toBe(e1.added + e2.added);
    expect(a.removed).toBe(e1.removed + e2.removed);
    expect(a.openDiff).toMatchObject({ oldText: "x", newText: "z" });
    expect(r.totalAdded).toBe(a.added + b.added);
    expect(r.totalRemoved).toBe(a.removed + b.removed);
    expect(turnDiffSummaryTitle(r)).toBe("Changed 2 files");
  });

  it("singular title for one file; pathless rows merge under empty path", () => {
    const r = aggregateTurnEdits([
      edit("", "a", "b"),
      { ...edit("", "b", "cd"), path: undefined as unknown as string },
    ]);
    expect(r.files).toHaveLength(1);
    expect(r.files[0].path).toBe("");
    expect(r.files[0].added).toBe(edit("", "a", "b").added + edit("", "b", "cd").added);
    expect(r.files[0].openDiff).toMatchObject({ oldText: "a", newText: "cd" });
    expect(turnDiffSummaryTitle(r)).toBe("Changed 1 file");
  });

  describe("same file edited multiple times in one turn", () => {
    it("sums three sequential appends and openDiffs first.old → last.new", () => {
      const v0 = "base\n";
      const v1 = "base\npass1\n";
      const v2 = "base\npass1\npass2\n";
      const v3 = "base\npass1\npass2\npass3\n";
      const e1 = edit("F3.txt", v0, v1);
      const e2 = edit("F3.txt", v1, v2);
      const e3 = edit("F3.txt", v2, v3);
      const r = aggregateTurnEdits([e1, e2, e3]);
      expect(r.files).toHaveLength(1);
      expect(r.files[0].added).toBe(e1.added + e2.added + e3.added);
      expect(r.files[0].removed).toBe(e1.removed + e2.removed + e3.removed);
      // Each append is pure +1; three passes → +3 −0
      expect(r.files[0].added).toBe(3);
      expect(r.files[0].removed).toBe(0);
      expect(r.files[0].openDiff).toMatchObject({ oldText: v0, newText: v3 });
      expect(r.files[0].action).toBe("edited");
    });

    it("create then append: empty first.old so openDiff includes batch-1 lines", () => {
      const batch1 = "F1 initial content\nCreated in batch 1 (tracked).\n";
      const batch2 = batch1 + "F1 edited in batch 2 (tracked).\n";
      const e1 = edit("F1.txt", "", batch1);
      const e2 = edit("f1.txt", batch1, batch2); // case variant of same path
      const r = aggregateTurnEdits([e1, e2]);
      expect(r.files).toHaveLength(1);
      expect(r.files[0].added).toBe(e1.added + e2.added);
      expect(r.files[0].removed).toBe(0);
      expect(r.files[0].action).toBe("created");
      expect(r.files[0].openDiff).toMatchObject({ oldText: "", newText: batch2 });
    });

    it("add content then remove that same content (sum + and −)", () => {
      // Batch 1: insert a line. Batch 2: delete that line again.
      const before = "keep\n";
      const withExtra = "keep\nTEMP\n";
      const after = "keep\n";
      const e1 = edit("note.txt", before, withExtra); // +1 −0
      const e2 = edit("note.txt", withExtra, after); // +0 −1
      expect(e1.added).toBe(1);
      expect(e1.removed).toBe(0);
      expect(e2.added).toBe(0);
      expect(e2.removed).toBe(1);

      const r = aggregateTurnEdits([e1, e2]);
      expect(r.files).toHaveLength(1);
      // Sum of activity, not net zero — both the add and the remove count.
      expect(r.files[0].added).toBe(1);
      expect(r.files[0].removed).toBe(1);
      expect(r.files[0].openDiff).toMatchObject({ oldText: before, newText: after });
      expect(r.totalAdded).toBe(1);
      expect(r.totalRemoved).toBe(1);
    });

    it("add content then rewrite that same content", () => {
      const v0 = "header\n";
      const v1 = "header\nDRAFT\n";
      const v2 = "header\nFINAL\n";
      const e1 = edit("doc.txt", v0, v1); // +1
      const e2 = edit("doc.txt", v1, v2); // −1 +1 (DRAFT→FINAL)
      expect(e2.added).toBe(1);
      expect(e2.removed).toBe(1);

      const r = aggregateTurnEdits([e1, e2]);
      expect(r.files[0].added).toBe(e1.added + e2.added); // 1+1
      expect(r.files[0].removed).toBe(e1.removed + e2.removed); // 0+1
      expect(r.files[0].openDiff).toMatchObject({ oldText: v0, newText: v2 });
    });

    it("add then fully delete the file content (empty newText)", () => {
      // No trailing newline — split("\n") would otherwise invent an empty line.
      const e1 = edit("wipe.txt", "", "only\nline"); // +2
      const e2 = edit("wipe.txt", "only\nline", ""); // −2
      expect(e1.added).toBe(2);
      expect(e2.removed).toBe(2);
      const r = aggregateTurnEdits([e1, e2]);
      expect(r.files[0].added).toBe(2);
      expect(r.files[0].removed).toBe(2);
      expect(r.files[0].openDiff).toMatchObject({ oldText: "", newText: "" });
      expect(r.files[0].action).toBe("created"); // first old was empty
    });

    it("three passes: append, edit that line, remove that line", () => {
      const v0 = "stable\n";
      const v1 = "stable\nX\n";
      const v2 = "stable\nY\n";
      const v3 = "stable\n";
      const e1 = edit("f.txt", v0, v1);
      const e2 = edit("f.txt", v1, v2);
      const e3 = edit("f.txt", v2, v3);
      const r = aggregateTurnEdits([e1, e2, e3]);
      expect(r.files[0].added).toBe(e1.added + e2.added + e3.added);
      expect(r.files[0].removed).toBe(e1.removed + e2.removed + e3.removed);
      // append +1, rewrite +1−1, remove −1 → +2 −2
      expect(r.files[0].added).toBe(2);
      expect(r.files[0].removed).toBe(2);
      expect(r.files[0].openDiff).toMatchObject({ oldText: v0, newText: v3 });
    });

    it("interleaved edits on two files still path-dedupe each", () => {
      const a1 = edit("a.ts", "1", "2");
      const b1 = edit("b.ts", "", "x\n");
      const a2 = edit("a.ts", "2", "3");
      const b2 = edit("b.ts", "x\n", "x\ny\n");
      const r = aggregateTurnEdits([a1, b1, a2, b2]);
      expect(r.files).toHaveLength(2);
      const a = r.files.find((f) => f.path === "a.ts")!;
      const b = r.files.find((f) => f.path === "b.ts")!;
      expect(a.added).toBe(a1.added + a2.added);
      expect(a.openDiff).toMatchObject({ oldText: "1", newText: "3" });
      expect(b.added).toBe(b1.added + b2.added);
      expect(b.openDiff).toMatchObject({ oldText: "", newText: "x\ny\n" });
      expect(b.action).toBe("created");
    });

    it("unchained independent regions still sum and span first.old → last.new", () => {
      // Non-overlapping search_replace-style regions (old of #2 ≠ new of #1).
      const e1 = edit("f.txt", "tokenA", "tokenB");
      const e2 = edit("f.txt", "otherX", "otherY");
      expect(e1.newText).not.toBe(e2.oldText);
      const r = aggregateTurnEdits([e1, e2]);
      expect(r.files[0].added).toBe(e1.added + e2.added);
      expect(r.files[0].removed).toBe(e1.removed + e2.removed);
      expect(r.files[0].openDiff).toMatchObject({ oldText: "tokenA", newText: "otherY" });
    });
  });

  describe("deletes mixed with edits", () => {
    it("create then shell-style delete drops prior +/− (Deleted wins)", () => {
      const r = aggregateTurnEdits([
        edit("F2.txt", "", "a\nb\nc"),
        { path: "f2.txt", kind: "delete" },
        edit("keep.txt", "x", "y"),
      ]);
      expect(r.files).toHaveLength(2);
      expect(r.files.find((f) => /f2/i.test(f.path))).toMatchObject({
        action: "deleted",
        added: 0,
        removed: 0,
        openDiff: null,
      });
      expect(r.files.find((f) => /keep/i.test(f.path))).toMatchObject({ action: "edited", added: 1, removed: 1 });
      expect(r.totalAdded).toBe(1);
      expect(r.totalRemoved).toBe(1);
    });

    it("edit then delete then recreate: only the post-delete edits count", () => {
      const r = aggregateTurnEdits([
        edit("x.txt", "old", "mid"), // wiped by delete
        { path: "x.txt", kind: "delete" },
        edit("x.txt", "", "brand\nnew\n"), // recreate
        edit("x.txt", "brand\nnew\n", "brand\nnew\nplus\n"),
      ]);
      expect(r.files).toHaveLength(1);
      const f = r.files[0];
      // Only the two post-delete edits
      const e3 = edit("x.txt", "", "brand\nnew\n");
      const e4 = edit("x.txt", "brand\nnew\n", "brand\nnew\nplus\n");
      expect(f.added).toBe(e3.added + e4.added);
      expect(f.removed).toBe(e3.removed + e4.removed);
      expect(f.action).toBe("created");
      expect(f.openDiff).toMatchObject({ oldText: "", newText: "brand\nnew\nplus\n" });
    });

    it("delete-only path has no openDiff and is sorted after edits", () => {
      const r = aggregateTurnEdits([
        { path: "gone.txt", kind: "delete" },
        edit("a.txt", "x", "y"),
      ]);
      expect(r.files.map((f) => f.path)).toEqual(["a.txt", "gone.txt"]);
      expect(r.files[1].action).toBe("deleted");
      expect(r.files[1].openDiff).toBeNull();
    });
  });
});
