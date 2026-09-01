import { describe, it, expect } from "vitest";
import { isPrimerSummary } from "../src/grok-primer";
import { occupancyFromUsageLog, sumUsage } from "../src/acp-dispatch";
import * as path from "node:path";
import {
  AUTO_NAME_MAX_CHARS,
  capAutoName,
  capSessionMetaAutoNames,
  capSessionMetaUsageLogs,
  capUsageLog,
  USAGE_LOG_MAX_ENTRIES,
  forkDisplayName,
  FsLike,
  SessionMetaOverrides,
  carrySessionName,
  classifyUserQueries,
  clearSessions,
  cliSessionTitle,
  deleteSessionDir,
  extractUserQueries,
  fallbackName,
  findSessionCatalogCwd,
  indexSessions,
  isEmptySession,
  isPathInside,
  listSessions,
  mostRecentSession,
  normalizeRepoPath,
  orderedResumeCwdCandidates,
  readContextUsage,
  readSessionEntries,
  remoteAuthorizedCwds,
  archivedProjectKeys,
  expiredArchiveChoiceKeys,
  newestTranscriptMtime,
  encodeSessionCatalogLeaf,
  resolveGrokHome,
  sessionCatalogDirs,
  sessionDirFor,
  sessionsDirFor,
  discoverRepos,
  type SessionListEntry,
} from "../src/sessions";

// Real grok chat_history.jsonl shape: role keyed on `type`, content is an array of
// {type:"text",text}, injected context (<user_info>/<system-reminder>) carries a
// `synthetic_reason`, and the user's prompt is wrapped in <user_query>. The primer
// is always the first real query.
const userMsg = (text: string, synthetic?: string) =>
  JSON.stringify({ type: "user", content: [{ type: "text", text }], ...(synthetic ? { synthetic_reason: synthetic } : {}) });
const PRIMER_LINE = userMsg("<user_query>\n[grok-build-vscode primer v4]\n\n## HIDDEN PRIMER\nstuff\n</user_query>");
const SYSTEM_LINE = JSON.stringify({ type: "system", content: [{ type: "text", text: "You are an AI coding assistant…" }] });
const USERINFO_LINE = userMsg("<user_info>\nOS: darwin\n</user_info>");
const REMINDER_LINE = userMsg("<system-reminder>\nbackground task X completed\n</system-reminder>", "system_reminder");
const ASSISTANT_LINE = JSON.stringify({ type: "assistant", content: [{ type: "text", text: "ok" }] });
const realQuery = (q: string) => userMsg(`<user_query>\n${q}\n</user_query>`);
// grok/composer sends some prompts (notably slash commands) UNWRAPPED — a plain
// user message with no <user_query>. These must still count as real queries.
const unwrappedQuery = (q: string) => userMsg(q);

describe("capAutoName", () => {
  const words = Array.from({ length: 40 }, (_, i) => `word${String(i).padStart(2, "0")}`);
  const longPrompt = words.join(" ");

  it("cuts a long prompt on a nearby word boundary", () => {
    expect(longPrompt.length).toBeGreaterThan(AUTO_NAME_MAX_CHARS);
    const capped = capAutoName(longPrompt);
    expect(capped.length).toBeLessThanOrEqual(AUTO_NAME_MAX_CHARS);
    expect(capped.length).toBeGreaterThan(AUTO_NAME_MAX_CHARS - 20);
    expect(capped.endsWith(" ")).toBe(false);
    expect(longPrompt.startsWith(capped)).toBe(true);
    expect(capped).not.toContain("word39");
    expect(capAutoName(capped)).toBe(capped);
  });

  it("collapses newlines and extra whitespace in a multi-line prompt", () => {
    expect(capAutoName("hello\n\nworld\tfrom\rprompt")).toBe("hello world from prompt");
    const multi = `${"alpha ".repeat(30).trim()}\n${"bravo ".repeat(30).trim()}`;
    const capped = capAutoName(multi);
    expect(capped).not.toMatch(/\s{2,}/);
    expect(capped).not.toMatch(/\n/);
    expect(capped.length).toBeLessThanOrEqual(AUTO_NAME_MAX_CHARS);
  });

  it("leaves an already-short name unchanged", () => {
    expect(capAutoName("fix the flaky test")).toBe("fix the flaky test");
  });

  it("leaves a name that is exactly the limit unchanged", () => {
    const exact = "a".repeat(AUTO_NAME_MAX_CHARS);
    expect(exact.length).toBe(AUTO_NAME_MAX_CHARS);
    expect(capAutoName(exact)).toBe(exact);
  });

  it("hard-cuts when no word boundary is near the limit", () => {
    expect(capAutoName("x".repeat(AUTO_NAME_MAX_CHARS + 50))).toBe("x".repeat(AUTO_NAME_MAX_CHARS));
    expect(capAutoName("hello " + "x".repeat(AUTO_NAME_MAX_CHARS))).toBe("hello " + "x".repeat(AUTO_NAME_MAX_CHARS - 6));
  });

  it("returns empty for empty or undefined input", () => {
    expect(capAutoName("")).toBe("");
    expect(capAutoName("   \n\t  ")).toBe("");
    expect(capAutoName(undefined)).toBe("");
    expect(capAutoName(null)).toBe("");
    expect(capAutoName(12)).toBe("");
  });
});

describe("capSessionMetaAutoNames", () => {
  it("caps fat autoName values and leaves everything else on the same object", () => {
    const fat = "prompt ".repeat(40).trim();
    const short = "fix the flaky test";
    const custom = "A name the user typed that can be as long as they like ".repeat(5).trim();
    const meta: SessionMetaOverrides = {
      fat: { autoName: fat, customName: custom, pinnedAt: 9 },
      short: { autoName: short, unread: true },
      none: { provider: "grok" },
    };
    const { value, changed } = capSessionMetaAutoNames(meta);
    expect(changed).toBe(true);
    expect(value).not.toBe(meta);
    expect(value.fat.autoName).toBe(capAutoName(fat));
    expect(value.fat.autoName!.length).toBeLessThanOrEqual(AUTO_NAME_MAX_CHARS);
    expect(value.fat.customName).toBe(custom);
    expect(value.fat.pinnedAt).toBe(9);
    expect(value.short).toBe(meta.short);
    expect(JSON.stringify(value.short)).toBe(JSON.stringify(meta.short));
    expect(value.none).toBe(meta.none);
  });

  it("is a no-op on an already-capped map", () => {
    const meta: SessionMetaOverrides = { a: { autoName: "short" } };
    const first = capSessionMetaAutoNames(meta);
    expect(first.changed).toBe(false);
    expect(first.value).toBe(meta);
    const second = capSessionMetaAutoNames(first.value);
    expect(second.changed).toBe(false);
    expect(second.value).toBe(first.value);
  });
});

describe("capUsageLog", () => {
  const entry = (n: number) => ({
    afterUserMessage: n,
    afterHistoryEvent: n * 10,
    usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, costUsdTicks: 7 },
    contextUsed: n * 1000,
  });
  const log = (count: number) => Array.from({ length: count }, (_, i) => entry(i + 1));

  it("returns the SAME array below the ceiling, so a load sweep can skip the write", () => {
    const under = log(USAGE_LOG_MAX_ENTRIES);
    expect(capUsageLog(under)).toBe(under);
  });

  it("folds down to exactly the ceiling and keeps the newest turns intact", () => {
    const over = log(USAGE_LOG_MAX_ENTRIES + 50);
    const folded = capUsageLog(over);
    expect(folded.length).toBe(USAGE_LOG_MAX_ENTRIES);
    // The tail is untouched — a rewind still finds the turns it can reach.
    expect(folded.slice(1)).toEqual(over.slice(51));
  });

  it("preserves the token total exactly — the carry entry is a sum, not a drop", () => {
    const over = log(USAGE_LOG_MAX_ENTRIES + 50);
    const before = sumUsage(over)!;
    const after = sumUsage(capUsageLog(over))!;
    expect(after.totalTokens).toBe(before.totalTokens);
    expect(after.inputTokens).toBe(before.inputTokens);
    expect(after.outputTokens).toBe(before.outputTokens);
    expect(after.costUsdTicks).toBe(before.costUsdTicks);
  });

  it("preserves context occupancy — contextUsed is monotonic, so the boundary IS the max", () => {
    const over = log(USAGE_LOG_MAX_ENTRIES + 50);
    expect(occupancyFromUsageLog(capUsageLog(over)).used)
      .toBe(occupancyFromUsageLog(over).used);
  });

  it("carries a compaction boundary rather than losing the reset", () => {
    const over = log(USAGE_LOG_MAX_ENTRIES + 50);
    over[50] = { ...over[50], compacted: true, contextUsed: 5 };
    const folded = capUsageLog(over);
    expect(folded[0].compacted).toBe(true);
    expect(folded[0].contextUsed).toBe(5);
    expect(occupancyFromUsageLog(folded).used).toBe(occupancyFromUsageLog(over).used);
  });

  it("is idempotent — folding an already-folded log changes nothing", () => {
    const once = capUsageLog(log(USAGE_LOG_MAX_ENTRIES + 50));
    expect(capUsageLog(once)).toBe(once);
  });

  it("survives entries with no usage at all (a zero-inference turn such as /compact)", () => {
    const over = log(USAGE_LOG_MAX_ENTRIES + 2).map((e) => ({ ...e, usage: undefined }));
    const folded = capUsageLog(over);
    expect(folded.length).toBe(USAGE_LOG_MAX_ENTRIES);
    expect(folded[0].usage).toBeUndefined();
  });
});

describe("capSessionMetaUsageLogs", () => {
  it("folds only the maps that need it and leaves the rest identical", () => {
    const fat = Array.from({ length: USAGE_LOG_MAX_ENTRIES + 5 }, (_, i) => ({ afterUserMessage: i + 1 }));
    const meta: SessionMetaOverrides = {
      fat: { usageLog: fat, autoName: "a name" },
      thin: { usageLog: [{ afterUserMessage: 1 }] },
      none: { provider: "grok" },
    };
    const { value, changed } = capSessionMetaUsageLogs(meta);
    expect(changed).toBe(true);
    expect(value.fat.usageLog!.length).toBe(USAGE_LOG_MAX_ENTRIES);
    expect(value.fat.autoName).toBe("a name");
    expect(value.thin).toBe(meta.thin);
    expect(value.none).toBe(meta.none);
  });

  it("is a no-op on an already-folded map", () => {
    const meta: SessionMetaOverrides = { a: { usageLog: [{ afterUserMessage: 1 }] } };
    const first = capSessionMetaUsageLogs(meta);
    expect(first.changed).toBe(false);
    expect(first.value).toBe(meta);
  });
});

describe("mostRecentSession", () => {
  const entry = (id: string, updatedAt: number, kind?: "subagent"): SessionListEntry => ({
    id,
    cwd: "/work/repo",
    displayName: id,
    rawSummary: id,
    updatedAt,
    createdAt: updatedAt,
    numMessages: 1,
    kind,
  });

  it("chooses the newest session in a repository scope", () => {
    expect(mostRecentSession([entry("older", 10), entry("newest", 30), entry("middle", 20)])?.id)
      .toBe("newest");
  });

  it("returns no session when the scoped history is empty", () => {
    expect(mostRecentSession([])).toBeUndefined();
  });

  it("does not treat a subagent catalog entry as conversation history", () => {
    expect(mostRecentSession([entry("child", 40, "subagent"), entry("chat", 20)])?.id).toBe("chat");
  });
});

describe("extractUserQueries / classifyUserQueries (empty-session detection)", () => {
  it("pulls only <user_query> text, skipping system / <user_info> / <system-reminder> / assistant", () => {
    const jsonl = [SYSTEM_LINE, USERINFO_LINE, REMINDER_LINE, PRIMER_LINE, ASSISTANT_LINE].join("\n");
    const qs = extractUserQueries(jsonl);
    expect(qs).toHaveLength(1);
    expect(qs[0]).toMatch(/^\[grok-build-vscode primer v4\]/);
  });

  it("classifies a primer-only history (with injected context turns) as primer:1 real:0", () => {
    const jsonl = [SYSTEM_LINE, USERINFO_LINE, REMINDER_LINE, PRIMER_LINE, ASSISTANT_LINE].join("\n");
    expect(classifyUserQueries(jsonl)).toEqual({ primer: 1, real: 0 });
  });

  it("counts a real follow-up as real:1", () => {
    const jsonl = [SYSTEM_LINE, USERINFO_LINE, PRIMER_LINE, realQuery("fix the login bug")].join("\n");
    expect(classifyUserQueries(jsonl)).toEqual({ primer: 1, real: 1 });
  });

  it("counts an UNWRAPPED prompt (composer slash command, no <user_query>) as real", () => {
    // The composer-format session that exposed the bug: the real query is a plain
    // user message, only the primer is wrapped. Must read as a real session.
    const jsonl = [SYSTEM_LINE, USERINFO_LINE, unwrappedQuery("/imagine-video Elon Musk celebrating"), REMINDER_LINE, PRIMER_LINE].join("\n");
    expect(classifyUserQueries(jsonl)).toEqual({ primer: 1, real: 1 });
  });

  it("tolerates blank and unparseable lines", () => {
    const jsonl = ["", "not json", PRIMER_LINE, "  "].join("\n");
    expect(classifyUserQueries(jsonl)).toEqual({ primer: 1, real: 0 });
  });
});

describe("isEmptySession", () => {
  const primerOnly = [SYSTEM_LINE, USERINFO_LINE, PRIMER_LINE, ASSISTANT_LINE].join("\n");
  const withRealTurn = [SYSTEM_LINE, USERINFO_LINE, PRIMER_LINE, realQuery("do the thing")].join("\n");
  // What a session opened by today's extension and never typed into looks like:
  // grok's own boot lines and nothing else. Requiring a primer here is exactly what
  // made the sweep a no-op after v2.2.0 (#97).
  const neverTypedInto = [SYSTEM_LINE, USERINFO_LINE, REMINDER_LINE].join("\n");

  it("content is authoritative: a session with no real query at all ⇒ empty", () => {
    expect(isEmptySession({ numMessages: 0, chatHistory: neverTypedInto })).toBe(true);
  });

  it("content is authoritative: legacy primer-only ⇒ empty", () => {
    expect(isEmptySession({ numMessages: 4, chatHistory: primerOnly })).toBe(true);
  });

  it("content is authoritative: any real query ⇒ NOT empty, even at low message count", () => {
    expect(isEmptySession({ numMessages: 6, chatHistory: withRealTurn })).toBe(false);
  });

  it("never flags a session the user renamed", () => {
    expect(isEmptySession({ numMessages: 4, customName: "My work", chatHistory: primerOnly })).toBe(false);
  });

  it("never flags a pinned, worktree-bound, or subagent session", () => {
    expect(isEmptySession({ numMessages: 0, pinnedAt: 1, chatHistory: neverTypedInto })).toBe(false);
    expect(isEmptySession({ numMessages: 0, worktreePath: "/work/wt", chatHistory: neverTypedInto })).toBe(false);
    expect(isEmptySession({ numMessages: 0, kind: "subagent", chatHistory: neverTypedInto })).toBe(false);
  });

  it("never flags a session whose composer draft is persisted for recovery", () => {
    expect(isEmptySession({
      numMessages: 0,
      chatHistory: neverTypedInto,
      queuedDraft: "recover me after sign-in",
    })).toBe(false);
  });

  it("never flags a session whose history exists but could not be read", () => {
    // A locked or unreadable file proves nothing; claiming emptiness there would
    // delete real work on a transient error.
    expect(isEmptySession({ numMessages: 0, historyUnreadable: true })).toBe(false);
  });

  it("never flags a session whose history is in a shape we cannot read", () => {
    // The interlock that keeps one CLI schema change from turning the sweep into a
    // shredder: a reader that skips what it does not recognise cannot tell "nothing
    // was said" from "the format moved".
    const alien = ["not json at all", "{\"speaker\":\"user\",\"body\":\"do the thing\"}"].join("\n");
    expect(isEmptySession({ numMessages: 12, chatHistory: alien })).toBe(false);
    expect(isEmptySession({ numMessages: 0, chatHistory: alien })).toBe(false);
  });

  it("a truncated final line does not hide the real queries before it", () => {
    // An ordinary mid-write read. The earlier lines still parse, so the session is
    // correctly seen as having work in it.
    const midWrite = [SYSTEM_LINE, USERINFO_LINE, realQuery("fix the flaky test"), '{"type":"assis'].join("\n");
    expect(isEmptySession({ numMessages: 3, chatHistory: midWrite })).toBe(false);
  });

  it("an empty history FILE falls through to the message count, not to a parse failure", () => {
    // Zero bytes is not an unreadable format — it is a session grok registered and
    // never wrote a turn into.
    expect(isEmptySession({ numMessages: 0, chatHistory: "" })).toBe(true);
    expect(isEmptySession({ numMessages: 0, chatHistory: "\n\n" })).toBe(true);
    expect(isEmptySession({ numMessages: 4, chatHistory: "", summary: "Fix the login bug" })).toBe(false);
  });

  it("never flags a session that isn't ours (a real query from the CLI)", () => {
    const foreign = [SYSTEM_LINE, USERINFO_LINE, realQuery("hello from the CLI")].join("\n");
    expect(isEmptySession({ numMessages: 3, chatHistory: foreign })).toBe(false);
  });

  it("never flags a composer session whose real prompt is UNWRAPPED (the #24 composer near-miss)", () => {
    const composer = [SYSTEM_LINE, USERINFO_LINE, unwrappedQuery("/imagine a desert scene"), REMINDER_LINE, PRIMER_LINE].join("\n");
    expect(isEmptySession({ numMessages: 8, chatHistory: composer })).toBe(false);
  });

  it("content stays authoritative ABOVE the message gate (agentic primer-only turn)", () => {
    // Regression: a primer turn can balloon to dozens of tool/reasoning messages with
    // NO real user query (and grok re-primes on restore/compact). num_messages must
    // not veto the content signal, or such a session (the real 74-message one) lingers.
    expect(isEmptySession({ numMessages: 999, chatHistory: primerOnly })).toBe(true);
  });

  it("a directory holding nothing but summary.json is empty (#97's unloadable rows)", () => {
    expect(isEmptySession({ numMessages: 0 })).toBe(true);
    expect(isEmptySession({ numMessages: 0, summary: "", generatedTitle: "" })).toBe(true);
  });

  it("without any history, a session that recorded messages or earned a title is kept", () => {
    expect(isEmptySession({ numMessages: 3 })).toBe(false);
    expect(isEmptySession({ numMessages: 0, summary: "Fix the login bug" })).toBe(false);
  });

  it("falls back to the title heuristic when no chat history is available", () => {
    expect(isEmptySession({ numMessages: 4, summary: "Grok Build VSCode Primer v4 Plan Mode" })).toBe(true);
    expect(isEmptySession({ numMessages: 4, generatedTitle: "Hidden Primer v4" })).toBe(true);
    expect(isEmptySession({ numMessages: 4, summary: "Fix the login bug" })).toBe(false);
  });

  it("without chat history, the message gate still guards the title heuristic", () => {
    // The numMessages gate only applies on the no-content fallback path: a large
    // session with a primer-ish title but no readable history is NOT flagged.
    expect(isEmptySession({ numMessages: 999, summary: "Grok Build VSCode Primer v4 Plan Mode" })).toBe(false);
  });
});

describe("cliSessionTitle", () => {
  it("prefers session_summary, falling back to generated_title", () => {
    expect(cliSessionTitle("Rail archiving", "Something else")).toBe("Rail archiving");
    expect(cliSessionTitle("  ", "Rail archiving")).toBe("Rail archiving");
    expect(cliSessionTitle(undefined, undefined)).toBe("");
  });

  it("rejects legacy primer-derived titles in both forms", () => {
    // grok summarizes from message #1, which for older extension sessions was our
    // hidden primer — sometimes summarized, sometimes copied verbatim.
    expect(cliSessionTitle("Grok VSCode Plan Mode Hidden Primer")).toBe("");
    expect(cliSessionTitle("[grok-build-vscode primer v4] ## HIDDEN PRIMER This is")).toBe("");
    expect(cliSessionTitle("Grok VSCode Plan Mode Hidden Primer", "Refactor the uplink"))
      .toBe("Refactor the uplink");
  });

  it("keeps a real session that merely mentions a primer", () => {
    expect(cliSessionTitle("Write a primer for new contributors")).toBe("Write a primer for new contributors");
  });
});

interface FileEntry {
  isDir: boolean;
  content?: string;
  mtimeMs?: number;
}

function buildFs(files: Record<string, FileEntry>): FsLike {
  const removed = new Set<string>();
  const exists = (p: string) => !removed.has(p) && files[p] !== undefined;
  return {
    existsSync: exists,
    readdirSync: (p) => {
      if (!exists(p)) throw new Error(`ENOENT: ${p}`);
      const prefix = p.endsWith("/") || p.endsWith("\\") ? p : p + path.sep;
      const names = new Set<string>();
      for (const fp of Object.keys(files)) {
        if (removed.has(fp)) continue;
        const altPrefix = p + (p.endsWith("/") ? "" : "/");
        if (fp.startsWith(prefix) || fp.startsWith(altPrefix)) {
          const rest = fp.startsWith(prefix) ? fp.slice(prefix.length) : fp.slice(altPrefix.length);
          const first = rest.split(/[\\/]/)[0];
          if (first) names.add(first);
        }
      }
      return Array.from(names);
    },
    readFileSync: (p) => {
      const f = files[p];
      if (!f || removed.has(p)) throw new Error(`ENOENT: ${p}`);
      return f.content ?? "";
    },
    statSync: (p) => {
      const f = files[p];
      if (!f || removed.has(p)) throw new Error(`ENOENT: ${p}`);
      return { isDirectory: () => f.isDir, mtimeMs: f.mtimeMs ?? 0 };
    },
    rmSync: (p) => {
      for (const fp of Object.keys(files)) {
        if (fp === p || fp.startsWith(p + "/") || fp.startsWith(p + path.sep)) {
          removed.add(fp);
        }
      }
    },
    rmdirSync: (p) => {
      for (const fp of Object.keys(files)) {
        if (fp === p || fp.startsWith(p + "/") || fp.startsWith(p + path.sep)) {
          removed.add(fp);
        }
      }
    },
  };
}

const grokHome = "/home/user/.grok";
const cwd = "/tmp/project";

function dirFor(id: string): string {
  return path.join(sessionsDirFor(grokHome, cwd), id);
}

describe("sessionsDirFor", () => {
  it("URL-encodes the cwd path like grok does", () => {
    expect(sessionsDirFor("/h/.grok", "/tmp")).toBe(path.join("/h/.grok", "sessions", "%2Ftmp"));
  });

  it("URL-encodes a nested cwd path", () => {
    const out = sessionsDirFor("/h/.grok", "/work/space");
    expect(out).toBe(path.join("/h/.grok", "sessions", "%2Fwork%2Fspace"));
  });

  it.each([
    ["", "%00"],
    [".", "%2E"],
    ["..", "%2E%2E"],
  ])("keeps a non-canonical cwd catalog inside the sessions root: %j", (badCwd, leaf) => {
    expect(sessionsDirFor(grokHome, badCwd)).toBe(path.join(grokHome, "sessions", leaf));
  });

  it("preserves drive-letter case in the catalog leaf (CLI write path)", () => {
    const lower = sessionsDirFor(grokHome, "c:\\GitHub\\accredia");
    const upper = sessionsDirFor(grokHome, "C:\\GitHub\\accredia");
    expect(lower).not.toBe(upper);
    expect(path.basename(lower)).toBe("c%3A%5CGitHub%5Caccredia");
    expect(path.basename(upper)).toBe("C%3A%5CGitHub%5Caccredia");
  });
});

/**
 * Real-world Windows bug: the CLI indexes by the cwd *string*, so
 * `c:\GitHub\accredia` and `C:\GitHub\accredia` become two catalog leaves.
 * History must merge them on Windows and stay distinct on case-sensitive hosts.
 */
describe("session catalog case-aliases", () => {
  const home = "/tmp/grok-case-home";
  const sessionsRoot = path.join(home, "sessions");
  const lowerCwd = "c:\\GitHub\\accredia";
  const upperCwd = "C:\\GitHub\\accredia";
  const lowerDir = sessionsDirFor(home, lowerCwd);
  const upperDir = sessionsDirFor(home, upperCwd);

  function splitIndexFs(): FsLike {
    const lowerId = "sess-lower-1";
    const upperId = "sess-upper-1";
    return buildFs({
      [sessionsRoot]: { isDir: true },
      [lowerDir]: { isDir: true, mtimeMs: 10 },
      [upperDir]: { isDir: true, mtimeMs: 50 },
      [path.join(lowerDir, lowerId)]: { isDir: true },
      [path.join(upperDir, upperId)]: { isDir: true },
      [path.join(lowerDir, lowerId, "summary.json")]: {
        isDir: false,
        content: JSON.stringify({
          info: { id: lowerId, cwd: lowerCwd },
          session_summary: "from lower c:",
          updated_at: "2026-01-01T00:00:00Z",
          num_messages: 4,
        }),
        mtimeMs: 10,
      },
      [path.join(upperDir, upperId, "summary.json")]: {
        isDir: false,
        content: JSON.stringify({
          info: { id: upperId, cwd: upperCwd },
          session_summary: "from upper C:",
          updated_at: "2026-02-01T00:00:00Z",
          num_messages: 6,
        }),
        mtimeMs: 50,
      },
    });
  }

  it("normalizeRepoPath folds Windows drive-letter case", () => {
    expect(normalizeRepoPath(lowerCwd, "win32")).toBe(normalizeRepoPath(upperCwd, "win32"));
    expect(normalizeRepoPath(lowerCwd, "linux")).not.toBe(normalizeRepoPath(upperCwd, "linux"));
  });

  it("sessionCatalogDirs lists both casings as one project on win32", () => {
    const fs = splitIndexFs();
    const dirs = sessionCatalogDirs({ fs, grokHome: home, cwd: upperCwd, platform: "win32" });
    expect(dirs.map((d) => path.normalize(d)).sort()).toEqual(
      [lowerDir, upperDir].map((d) => path.normalize(d)).sort(),
    );
    // Exact encode of the query cwd is first.
    expect(path.normalize(dirs[0])).toBe(path.normalize(upperDir));
  });

  it("on Windows, two drive-letter casings resolve to one project with the union of sessions", () => {
    const fs = splitIndexFs();
    const index = indexSessions({ fs, grokHome: home, cwd: upperCwd, platform: "win32" });
    expect(index.map((e) => e.id).sort()).toEqual(["sess-lower-1", "sess-upper-1"]);
    // Open via the *other* casing — must still see both sides.
    const entries = listSessions({
      fs,
      grokHome: home,
      cwd: lowerCwd,
      overrides: {},
      platform: "win32",
    });
    expect(entries.map((e) => e.id).sort()).toEqual(["sess-lower-1", "sess-upper-1"]);
    expect(entries.map((e) => e.displayName).sort()).toEqual(["from lower c:", "from upper C:"]);
  });

  it("finds a session stored under the other casing when resuming", () => {
    const fs = splitIndexFs();
    // Workspace is uppercase; session only exists under lowercase catalog.
    expect(
      findSessionCatalogCwd({
        fs,
        grokHome: home,
        id: "sess-lower-1",
        candidates: [upperCwd],
        platform: "win32",
      }),
    ).toBe(upperCwd);
    expect(
      sessionDirFor(home, upperCwd, "sess-lower-1", { fs, platform: "win32" }),
    ).toBe(path.join(lowerDir, "sess-lower-1"));
  });

  // Windows only, and not because of the logic — `platform: "win32"` is injected
  // below, so the merge itself is decidable anywhere. It is the FIXTURE that
  // cannot travel: the availability check resolves the decoded cwd through the
  // real `path` module, so on Linux "c:\GitHub\accredia" resolves to a
  // nonexistent relative directory and every row is filtered out as unavailable
  // before the merge is reached.
  //
  // Not a coverage hole: the case-INSENSITIVE merge is a Windows behaviour, CI
  // is Linux, and the case-sensitive counterpart directly below runs everywhere
  // and asserts the opposite property. Making this portable means injecting a
  // path module through discoverRepos, which is worth doing when something else
  // needs it — not for a test whose subject only exists on the platform it
  // already runs on.
  it.skipIf(process.platform !== "win32")("discoverRepos merges split casings into one row (max mtime)", () => {
    // Availability check stats the decoded cwd path — plant both as dirs.
    const full = buildFs({
      [sessionsRoot]: { isDir: true },
      [lowerDir]: { isDir: true, mtimeMs: 10 },
      [upperDir]: { isDir: true, mtimeMs: 50 },
      [lowerCwd]: { isDir: true },
      [upperCwd]: { isDir: true },
    });
    const repos = discoverRepos({
      fs: full,
      grokHome: home,
      pins: {},
      tmpDir: "/tmp",
      platform: "win32",
    });
    const hit = repos.filter((r) => normalizeRepoPath(r.cwd, "win32") === normalizeRepoPath(upperCwd, "win32"));
    expect(hit).toHaveLength(1);
    expect(hit[0].updatedAt).toBe(50);
  });

  it("on a case-sensitive platform, different casings remain distinct projects", () => {
    const posixHome = "/home/u/.grok";
    const a = "/Work/Project";
    const b = "/work/project";
    const aDir = sessionsDirFor(posixHome, a);
    const bDir = sessionsDirFor(posixHome, b);
    const root = path.join(posixHome, "sessions");
    const fs = buildFs({
      [root]: { isDir: true },
      [aDir]: { isDir: true },
      [bDir]: { isDir: true },
      [path.join(aDir, "sess-a")]: { isDir: true },
      [path.join(bDir, "sess-b")]: { isDir: true },
      [path.join(aDir, "sess-a", "summary.json")]: {
        isDir: false,
        content: JSON.stringify({ info: { id: "sess-a" }, session_summary: "A", updated_at: "2026-01-01T00:00:00Z", num_messages: 1 }),
        mtimeMs: 1,
      },
      [path.join(bDir, "sess-b", "summary.json")]: {
        isDir: false,
        content: JSON.stringify({ info: { id: "sess-b" }, session_summary: "B", updated_at: "2026-01-02T00:00:00Z", num_messages: 1 }),
        mtimeMs: 2,
      },
    });
    expect(indexSessions({ fs, grokHome: posixHome, cwd: a, platform: "linux" }).map((e) => e.id)).toEqual(["sess-a"]);
    expect(indexSessions({ fs, grokHome: posixHome, cwd: b, platform: "linux" }).map((e) => e.id)).toEqual(["sess-b"]);
    expect(sessionCatalogDirs({ fs, grokHome: posixHome, cwd: a, platform: "linux" })).toEqual([
      path.normalize(aDir),
    ]);
  });

  it("clearSessions removes sessions from every case-alias leaf", () => {
    const fs = splitIndexFs();
    const removed = clearSessions({ fs, grokHome: home, cwd: upperCwd, platform: "win32" });
    expect(removed.sort()).toEqual(["sess-lower-1", "sess-upper-1"]);
    expect(indexSessions({ fs, grokHome: home, cwd: upperCwd, platform: "win32" })).toEqual([]);
  });
});

describe("orderedResumeCwdCandidates / findSessionCatalogCwd (resume cwd trust)", () => {
  const workspace = "/work/repo";
  const evil = "/etc/evil";
  const sessionId = "sess-real-1";

  it("never includes an untrusted message cwd among candidates", () => {
    const cands = orderedResumeCwdCandidates({
      messageCwd: evil,
      trustedCwds: [workspace],
      cachedCwd: workspace,
    });
    expect(cands).toEqual([workspace]);
    expect(cands).not.toContain(evil);
  });

  it("looks first at a message cwd that is already trusted", () => {
    const other = "/work/other";
    const cands = orderedResumeCwdCandidates({
      messageCwd: other,
      trustedCwds: [workspace, other],
      cachedCwd: workspace,
    });
    expect(cands[0]).toBe(other);
    expect(cands).toContain(workspace);
  });

  it("resolves the catalog cwd that actually holds the session id", () => {
    const dir = path.join(sessionsDirFor(grokHome, workspace), sessionId);
    const fs: FsLike = buildFs({
      [path.join(dir, "summary.json")]: {
        isDir: false,
        content: JSON.stringify({ info: { id: sessionId, cwd: workspace } }),
      },
      [dir]: { isDir: true },
      [sessionsDirFor(grokHome, workspace)]: { isDir: true },
    });
    // Forged message cwd must not win even when it would be preferred in order —
    // it is filtered out of candidates entirely when untrusted.
    const candidates = orderedResumeCwdCandidates({
      messageCwd: evil,
      trustedCwds: [workspace],
    });
    expect(findSessionCatalogCwd({ fs, grokHome, id: sessionId, candidates })).toBe(workspace);
  });

  it("returns undefined when the id only exists under an untrusted path", () => {
    // Attacker planted a session dir under /etc/evil; host must not adopt it.
    const evilDir = path.join(sessionsDirFor(grokHome, evil), sessionId);
    const fs: FsLike = buildFs({
      [path.join(evilDir, "summary.json")]: {
        isDir: false,
        content: JSON.stringify({ info: { id: sessionId, cwd: evil } }),
      },
      [evilDir]: { isDir: true },
      [sessionsDirFor(grokHome, evil)]: { isDir: true },
    });
    const candidates = orderedResumeCwdCandidates({
      messageCwd: evil,
      trustedCwds: [workspace],
    });
    expect(candidates).not.toContain(evil);
    expect(findSessionCatalogCwd({ fs, grokHome, id: sessionId, candidates })).toBeUndefined();
  });

  it("mutation: trusting messageCwd unconditionally would adopt an evil catalog", () => {
    const evilDir = path.join(sessionsDirFor(grokHome, evil), sessionId);
    const fs: FsLike = buildFs({
      [path.join(evilDir, "summary.json")]: {
        isDir: false,
        content: JSON.stringify({ info: { id: sessionId, cwd: evil } }),
      },
      [evilDir]: { isDir: true },
      [sessionsDirFor(grokHome, evil)]: { isDir: true },
    });
    // The buggy pattern from openSessionReserved: sessionCwd || workspace.
    const buggyCandidates = [evil, workspace];
    expect(findSessionCatalogCwd({ fs, grokHome, id: sessionId, candidates: buggyCandidates }))
      .toBe(evil);
    // Fixed path: ordered candidates drop evil → no match → no spawn in evil.
    const fixed = orderedResumeCwdCandidates({
      messageCwd: evil,
      trustedCwds: [workspace],
    });
    expect(findSessionCatalogCwd({ fs, grokHome, id: sessionId, candidates: fixed }))
      .toBeUndefined();
  });

  it("rejects an invalid session id without touching candidates", () => {
    expect(
      findSessionCatalogCwd({
        fs: buildFs({}),
        grokHome,
        id: "../escape",
        candidates: [workspace],
      }),
    ).toBeUndefined();
  });
});

describe("fallbackName", () => {
  it("uses the summary when available", () => {
    expect(fallbackName("Fix login bug", 0)).toBe("Fix login bug");
  });

  it("truncates very long summaries", () => {
    const long = "x".repeat(100);
    const out = fallbackName(long, 0);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith("…")).toBe(true);
  });

  it("falls back to formatted date when summary is empty", () => {
    const ts = Date.UTC(2026, 4, 22, 12, 30);
    const out = fallbackName("", ts);
    expect(out.startsWith("Untitled (")).toBe(true);
  });

  it("returns 'Untitled' on invalid updatedAt", () => {
    expect(fallbackName("", NaN)).toMatch(/Untitled/);
  });
});

describe("listSessions", () => {
  const dir = sessionsDirFor(grokHome, cwd);

  it("returns [] when sessions dir does not exist", () => {
    const fs = buildFs({});
    const out = listSessions({ fs, grokHome, cwd, overrides: {} });
    expect(out).toEqual([]);
  });

  it("returns entries sorted by updatedAt desc", () => {
    const fs = buildFs({
      [dir]: { isDir: true },
      [dirFor("a")]: { isDir: true },
      [dirFor("b")]: { isDir: true },
      [path.join(dirFor("a"), "summary.json")]: {
        isDir: false,
        content: JSON.stringify({
          info: { id: "a", cwd },
          session_summary: "first",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          num_messages: 4,
        }),
      },
      [path.join(dirFor("b"), "summary.json")]: {
        isDir: false,
        content: JSON.stringify({
          info: { id: "b", cwd },
          session_summary: "second",
          created_at: "2026-02-01T00:00:00Z",
          updated_at: "2026-02-01T00:00:00Z",
          num_messages: 2,
        }),
      },
    });
    const out = listSessions({ fs, grokHome, cwd, overrides: {} });
    expect(out.map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("prefers customName override over session_summary", () => {
    const fs = buildFs({
      [dir]: { isDir: true },
      [dirFor("a")]: { isDir: true },
      [path.join(dirFor("a"), "summary.json")]: {
        isDir: false,
        content: JSON.stringify({
          info: { id: "a", cwd },
          session_summary: "raw summary",
          updated_at: "2026-01-01T00:00:00Z",
          num_messages: 3,
        }),
      },
    });
    const overrides: SessionMetaOverrides = { a: { customName: "My session" } };
    const out = listSessions({ fs, grokHome, cwd, overrides });
    expect(out[0].displayName).toBe("My session");
    expect(out[0].customName).toBe("My session");
    expect(out[0].rawSummary).toBe("raw summary");
  });

  it("prefers grok's own title over our first-message autoName (#96)", () => {
    // The row the CLI shows for this session is "Rail archiving"; ours was a
    // truncated opening prompt. Same conversation, so it should read the same way.
    const fs = buildFs({
      [dir]: { isDir: true },
      [dirFor("a")]: { isDir: true },
      [path.join(dirFor("a"), "summary.json")]: {
        isDir: false,
        content: JSON.stringify({
          info: { id: "a", cwd },
          session_summary: "Rail archiving",
          updated_at: "2026-01-01T00:00:00Z",
          num_messages: 8,
        }),
      },
    });
    const overrides: SessionMetaOverrides = { a: { autoName: "I'd also introduce one more section in rails: P…" } };
    expect(listSessions({ fs, grokHome, cwd, overrides })[0].displayName).toBe("Rail archiving");
  });

  it("a manual rename still outranks grok's title", () => {
    const fs = buildFs({
      [dir]: { isDir: true },
      [dirFor("a")]: { isDir: true },
      [path.join(dirFor("a"), "summary.json")]: {
        isDir: false,
        content: JSON.stringify({
          info: { id: "a", cwd },
          session_summary: "Rail archiving",
          updated_at: "2026-01-01T00:00:00Z",
          num_messages: 8,
        }),
      },
    });
    const overrides: SessionMetaOverrides = { a: { customName: "My session", autoName: "opening prompt…" } };
    expect(listSessions({ fs, grokHome, cwd, overrides })[0].displayName).toBe("My session");
  });

  it("uses generated_title when session_summary is blank, and skips a primer title", () => {
    const fs = buildFs({
      [dir]: { isDir: true },
      [dirFor("a")]: { isDir: true },
      [dirFor("b")]: { isDir: true },
      [path.join(dirFor("a"), "summary.json")]: {
        isDir: false,
        content: JSON.stringify({
          info: { id: "a", cwd },
          session_summary: "",
          generated_title: "Uplink reconnect",
          updated_at: "2026-01-02T00:00:00Z",
          num_messages: 4,
        }),
      },
      [path.join(dirFor("b"), "summary.json")]: {
        isDir: false,
        content: JSON.stringify({
          info: { id: "b", cwd },
          session_summary: "Grok VSCode Plan Mode Hidden Primer",
          updated_at: "2026-01-01T00:00:00Z",
          num_messages: 4,
        }),
      },
    });
    const overrides: SessionMetaOverrides = { b: { autoName: "fix the flaky test" } };
    const out = listSessions({ fs, grokHome, cwd, overrides });
    expect(out.find((s) => s.id === "a")?.displayName).toBe("Uplink reconnect");
    // A legacy primer title must not become the permanent name; ours shows instead.
    expect(out.find((s) => s.id === "b")?.displayName).toBe("fix the flaky test");
  });

  it("falls back to autoName before the date when grok has no title yet", () => {
    const fs = buildFs({
      [dir]: { isDir: true },
      [dirFor("a")]: { isDir: true },
      [path.join(dirFor("a"), "summary.json")]: {
        isDir: false,
        content: JSON.stringify({
          info: { id: "a", cwd },
          session_summary: "",
          updated_at: "2026-01-01T12:00:00Z",
          num_messages: 1,
        }),
      },
    });
    const overrides: SessionMetaOverrides = { a: { autoName: "fix the flaky test" } };
    expect(listSessions({ fs, grokHome, cwd, overrides })[0].displayName).toBe("fix the flaky test");
  });

  it("falls back to date when summary is empty and no customName", () => {
    const fs = buildFs({
      [dir]: { isDir: true },
      [dirFor("a")]: { isDir: true },
      [path.join(dirFor("a"), "summary.json")]: {
        isDir: false,
        content: JSON.stringify({
          info: { id: "a", cwd },
          session_summary: "",
          updated_at: "2026-01-01T12:00:00Z",
          num_messages: 0,
        }),
      },
    });
    const out = listSessions({ fs, grokHome, cwd, overrides: {} });
    expect(out[0].displayName).toMatch(/Untitled/);
  });

  it("tolerates malformed summary.json by skipping the entry", () => {
    const fs = buildFs({
      [dir]: { isDir: true },
      [dirFor("a")]: { isDir: true },
      [dirFor("b")]: { isDir: true },
      [path.join(dirFor("a"), "summary.json")]: {
        isDir: false,
        content: "{ not json",
      },
      [path.join(dirFor("b"), "summary.json")]: {
        isDir: false,
        content: JSON.stringify({
          info: { id: "b", cwd },
          session_summary: "ok",
          updated_at: "2026-01-01T00:00:00Z",
          num_messages: 1,
        }),
      },
    });
    const out = listSessions({ fs, grokHome, cwd, overrides: {} });
    expect(out.map((s) => s.id)).toEqual(["b"]);
  });

  it("skips entries with missing summary.json", () => {
    const fs = buildFs({
      [dir]: { isDir: true },
      [dirFor("ghost")]: { isDir: true },
    });
    const out = listSessions({ fs, grokHome, cwd, overrides: {} });
    expect(out).toEqual([]);
  });

  it("extracts model id and num_messages from summary", () => {
    const fs = buildFs({
      [dir]: { isDir: true },
      [dirFor("a")]: { isDir: true },
      [path.join(dirFor("a"), "summary.json")]: {
        isDir: false,
        content: JSON.stringify({
          info: { id: "a", cwd },
          session_summary: "hi",
          current_model_id: "grok-build",
          num_messages: 7,
          updated_at: "2026-01-01T00:00:00Z",
        }),
      },
    });
    const out = listSessions({ fs, grokHome, cwd, overrides: {} });
    expect(out[0].modelId).toBe("grok-build");
    expect(out[0].numMessages).toBe(7);
  });
});

describe("indexSessions", () => {
  const dir = sessionsDirFor(grokHome, cwd);

  it("returns [] when the sessions dir does not exist", () => {
    const fs = buildFs({});
    expect(indexSessions({ fs, grokHome, cwd })).toEqual([]);
  });

  it("orders ids newest-first by summary.json mtime without reading content", () => {
    let reads = 0;
    const base = buildFs({
      [dir]: { isDir: true },
      [dirFor("old")]: { isDir: true },
      [dirFor("new")]: { isDir: true },
      [dirFor("mid")]: { isDir: true },
      [path.join(dirFor("old"), "summary.json")]: { isDir: false, content: "{}", mtimeMs: 100 },
      [path.join(dirFor("new"), "summary.json")]: { isDir: false, content: "{}", mtimeMs: 300 },
      [path.join(dirFor("mid"), "summary.json")]: { isDir: false, content: "{}", mtimeMs: 200 },
    });
    const fs: FsLike = { ...base, readFileSync: (p, e) => { reads++; return base.readFileSync(p, e); } };
    const out = indexSessions({ fs, grokHome, cwd });
    expect(out.map((e) => e.id)).toEqual(["new", "mid", "old"]);
    expect(reads).toBe(0);
  });

  it("skips dirs without a summary.json", () => {
    const fs = buildFs({
      [dir]: { isDir: true },
      [dirFor("ghost")]: { isDir: true },
      [dirFor("real")]: { isDir: true },
      [path.join(dirFor("real"), "summary.json")]: { isDir: false, content: "{}", mtimeMs: 1 },
    });
    expect(indexSessions({ fs, grokHome, cwd }).map((e) => e.id)).toEqual(["real"]);
  });

  it("indexes a summary-only shell (no chat_history, no events) and marks it transcript-less", () => {
    // The catalog must still list it — that is how a credential-probe leftover
    // becomes an "Untitled" row — and the sweep needs hasTranscript === false
    // so it can find the shell after it ages out of the newest-N window.
    const fs = buildFs({
      [dir]: { isDir: true },
      [dirFor("019f0000-0000-7000-8000-000000000001")]: { isDir: true },
      [path.join(dirFor("019f0000-0000-7000-8000-000000000001"), "summary.json")]: {
        isDir: false,
        content: JSON.stringify({
          info: { id: "019f0000-0000-7000-8000-000000000001", cwd },
          session_summary: "",
          generated_title: "",
          num_messages: 0,
          updated_at: "2026-08-17T12:00:00Z",
        }),
        mtimeMs: 50,
      },
    });
    const index = indexSessions({ fs, grokHome, cwd });
    expect(index).toEqual([{
      id: "019f0000-0000-7000-8000-000000000001",
      mtimeMs: 50,
      hasTranscript: false,
    }]);
    const [entry] = listSessions({ fs, grokHome, cwd, overrides: {} });
    expect(entry.id).toBe("019f0000-0000-7000-8000-000000000001");
    expect(entry.displayName.startsWith("Untitled (")).toBe(true);
    expect(entry.numMessages).toBe(0);
  });

  it("marks a conversation with events.jsonl as having a transcript", () => {
    const fs = buildFs({
      [dir]: { isDir: true },
      [dirFor("spoken")]: { isDir: true },
      [path.join(dirFor("spoken"), "events.jsonl")]: { isDir: false, content: "{}\n", mtimeMs: 80 },
      [path.join(dirFor("spoken"), "summary.json")]: { isDir: false, content: "{}", mtimeMs: 10 },
    });
    expect(indexSessions({ fs, grokHome, cwd })[0]).toMatchObject({
      id: "spoken",
      mtimeMs: 80,
      hasTranscript: true,
    });
  });
});

describe("readSessionEntries", () => {
  const dir = sessionsDirFor(grokHome, cwd);

  function buildTwo(): FsLike {
    return buildFs({
      [dir]: { isDir: true },
      [dirFor("a")]: { isDir: true },
      [dirFor("b")]: { isDir: true },
      [path.join(dirFor("a"), "summary.json")]: {
        isDir: false,
        content: JSON.stringify({
          info: { id: "a", cwd },
          session_summary: "first",
          updated_at: "2026-01-01T00:00:00Z",
          num_messages: 4,
        }),
      },
      [path.join(dirFor("b"), "summary.json")]: {
        isDir: false,
        content: JSON.stringify({
          info: { id: "b", cwd },
          session_summary: "second",
          updated_at: "2026-02-01T00:00:00Z",
          num_messages: 2,
        }),
      },
    });
  }

  it("reads only the requested ids, in the requested order", () => {
    let reads = 0;
    const base = buildTwo();
    const fs: FsLike = { ...base, readFileSync: (p, e) => { reads++; return base.readFileSync(p, e); } };
    const out = readSessionEntries({ fs, grokHome, cwd, ids: ["b"], overrides: {} });
    expect(out.map((e) => e.id)).toEqual(["b"]);
    expect(out[0].displayName).toBe("second");
    expect(reads).toBe(1); // only the one requested id was read
  });

  it("preserves the id order it was given (no internal re-sort)", () => {
    const fs = buildTwo();
    const out = readSessionEntries({ fs, grokHome, cwd, ids: ["a", "b"], overrides: {} });
    expect(out.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("lets the host say a conversation was used just now", () => {
    // Ordering reads the transcript, and the CLI writes it ~2.1s after a send —
    // measured against the real binary. Without this the row you just typed
    // into sits still for that whole wait, and a brand-new conversation is
    // absent from the list altogether.
    const fs = buildTwo();
    const now = Date.parse("2026-03-01T00:00:00Z");
    const out = readSessionEntries({
      fs, grokHome, cwd, ids: ["a", "b"], overrides: { a: { activeAt: now } },
    });
    expect(out.find((e) => e.id === "a")!.updatedAt).toBe(now);
    expect(out.find((e) => e.id === "b")!.updatedAt).toBe(Date.parse("2026-02-01T00:00:00Z"));
  });

  it("never lets a stale activity stamp outrank a newer transcript", () => {
    // A floor, not an override. It is persisted with the rest of the session
    // meta, so a value left by an earlier run has to lose to the file the
    // moment the file is newer — otherwise a conversation nobody has touched
    // keeps the top of the list.
    const fs = buildTwo();
    const out = readSessionEntries({
      fs, grokHome, cwd, ids: ["b"],
      overrides: { b: { activeAt: Date.parse("2026-01-15T00:00:00Z") } },
    });
    expect(out[0].updatedAt).toBe(Date.parse("2026-02-01T00:00:00Z"));
  });

  it("applies customName overrides", () => {
    const fs = buildTwo();
    const overrides: SessionMetaOverrides = { a: { customName: "Renamed" } };
    const out = readSessionEntries({ fs, grokHome, cwd, ids: ["a"], overrides });
    expect(out[0].displayName).toBe("Renamed");
  });

  // The projects rail reads pin state off the entry. `pinnedAt` sat declared but
  // unread for a long time; this is the assertion against it drifting back.
  it("surfaces the pin from the override, and leaves unpinned rows bare", () => {
    const fs = buildTwo();
    const overrides: SessionMetaOverrides = { a: { pinnedAt: 1234, pinnedCwd: cwd } };
    const out = readSessionEntries({ fs, grokHome, cwd, ids: ["a", "b"], overrides });
    expect(out.find((e) => e.id === "a")?.pinnedAt).toBe(1234);
    expect(out.find((e) => e.id === "b")?.pinnedAt).toBeUndefined();
  });

  it("skips malformed or missing summaries", () => {
    const fs = buildFs({
      [dir]: { isDir: true },
      [dirFor("bad")]: { isDir: true },
      [path.join(dirFor("bad"), "summary.json")]: { isDir: false, content: "{ not json" },
    });
    expect(readSessionEntries({ fs, grokHome, cwd, ids: ["bad", "gone"], overrides: {} })).toEqual([]);
  });
});

describe("deleteSessionDir", () => {
  it("removes the on-disk session directory", () => {
    const sessDir = dirFor("a");
    const fs = buildFs({
      [sessionsDirFor(grokHome, cwd)]: { isDir: true },
      [sessDir]: { isDir: true },
      [path.join(sessDir, "summary.json")]: { isDir: false, content: "{}" },
    });
    deleteSessionDir({ fs, grokHome, cwd, id: "a" });
    expect(fs.existsSync(sessDir)).toBe(false);
  });

  it("is a no-op when the directory is missing", () => {
    const fs = buildFs({});
    expect(() => deleteSessionDir({ fs, grokHome, cwd, id: "missing" })).not.toThrow();
  });

  it.each(["..", "../..", "..\\..", "/outside", "C:\\outside"])(
    "refuses an id that could escape the sessions directory: %s",
    (id) => {
      const sessionsRoot = sessionsDirFor(grokHome, cwd);
      const outside = path.resolve(sessionsRoot, id);
      const fs = buildFs({
        [sessionsRoot]: { isDir: true },
        [outside]: { isDir: true },
      });

      deleteSessionDir({ fs, grokHome, cwd, id });

      expect(fs.existsSync(outside)).toBe(true);
    },
  );

  it("cannot escape through a non-canonical cwd even with a safe session id", () => {
    const outside = path.join(grokHome, "victim");
    const fs = buildFs({ [outside]: { isDir: true } });

    deleteSessionDir({ fs, grokHome, cwd: "..", id: "victim" });

    expect(fs.existsSync(outside)).toBe(true);
  });
});

describe("clearSessions", () => {
  const dir = sessionsDirFor(grokHome, cwd);

  function buildThree(): FsLike {
    return buildFs({
      [dir]: { isDir: true },
      [dirFor("a")]: { isDir: true },
      [dirFor("b")]: { isDir: true },
      [dirFor("c")]: { isDir: true },
      [path.join(dirFor("a"), "summary.json")]: { isDir: false, content: "{}" },
      [path.join(dirFor("b"), "summary.json")]: { isDir: false, content: "{}" },
      [path.join(dirFor("c"), "summary.json")]: { isDir: false, content: "{}" },
    });
  }

  it("returns [] when the sessions dir does not exist", () => {
    const fs = buildFs({});
    expect(clearSessions({ fs, grokHome, cwd })).toEqual([]);
  });

  it("removes every session dir and returns their ids", () => {
    const fs = buildThree();
    const removed = clearSessions({ fs, grokHome, cwd });
    expect(removed.sort()).toEqual(["a", "b", "c"]);
    expect(fs.existsSync(dirFor("a"))).toBe(false);
    expect(fs.existsSync(dirFor("b"))).toBe(false);
    expect(fs.existsSync(dirFor("c"))).toBe(false);
  });

  it("keeps the exceptId session", () => {
    const fs = buildThree();
    const removed = clearSessions({ fs, grokHome, cwd, exceptId: "b" });
    expect(removed.sort()).toEqual(["a", "c"]);
    expect(fs.existsSync(dirFor("b"))).toBe(true);
    expect(fs.existsSync(dirFor("a"))).toBe(false);
    expect(fs.existsSync(dirFor("c"))).toBe(false);
  });

  it("keeps every protected session id", () => {
    const fs = buildThree();
    const removed = clearSessions({ fs, grokHome, cwd, exceptIds: ["a", "c"] });
    expect(removed).toEqual(["b"]);
    expect(fs.existsSync(dirFor("a"))).toBe(true);
    expect(fs.existsSync(dirFor("b"))).toBe(false);
    expect(fs.existsSync(dirFor("c"))).toBe(true);
  });

  it("skips non-directory entries", () => {
    const fs = buildFs({
      [dir]: { isDir: true },
      [dirFor("a")]: { isDir: true },
      [path.join(dirFor("a"), "summary.json")]: { isDir: false, content: "{}" },
      [path.join(dir, "stray.txt")]: { isDir: false, content: "x" },
    });
    const removed = clearSessions({ fs, grokHome, cwd });
    expect(removed).toEqual(["a"]);
  });

  it("removes a summary-only shell so it no longer reaches the catalog", () => {
    const id = "019f0000-0000-7000-8000-000000000002";
    const fs = buildFs({
      [dir]: { isDir: true },
      [dirFor(id)]: { isDir: true },
      [path.join(dirFor(id), "summary.json")]: {
        isDir: false,
        content: JSON.stringify({
          info: { id, cwd },
          session_summary: "",
          num_messages: 0,
        }),
      },
    });
    expect(indexSessions({ fs, grokHome, cwd }).map((e) => e.id)).toEqual([id]);
    expect(clearSessions({ fs, grokHome, cwd })).toEqual([id]);
    expect(indexSessions({ fs, grokHome, cwd })).toEqual([]);
    expect(listSessions({ fs, grokHome, cwd, overrides: {} })).toEqual([]);
  });
});

describe("carrySessionName", () => {
  it("moves a customName from the old id to the new and drops the old entry", () => {
    const overrides: SessionMetaOverrides = { old: { customName: "My renamed session" } };
    const next = carrySessionName(overrides, "old", "new");
    expect(next.old).toBeUndefined();
    expect(next.new).toEqual({ customName: "My renamed session" });
  });

  it("does not mutate the input overrides", () => {
    const overrides: SessionMetaOverrides = { old: { customName: "Keep me" } };
    const next = carrySessionName(overrides, "old", "new");
    expect(overrides.old).toEqual({ customName: "Keep me" });
    expect(next).not.toBe(overrides);
  });

  it("only carries customName, not plans/unread, from the abandoned session", () => {
    const overrides: SessionMetaOverrides = {
      old: { customName: "Named", unread: true, plans: [{ text: "p", verdict: "approved" }] },
    };
    const next = carrySessionName(overrides, "old", "new");
    expect(next.new).toEqual({ customName: "Named" });
  });

  it("merges the carried name into an existing override on the new id", () => {
    const overrides: SessionMetaOverrides = {
      old: { customName: "Carried" },
      new: { unread: true },
    };
    const next = carrySessionName(overrides, "old", "new");
    expect(next.new).toEqual({ unread: true, customName: "Carried" });
  });

  it("just drops the old entry when there is no customName to carry", () => {
    const overrides: SessionMetaOverrides = { old: { unread: true }, other: { customName: "x" } };
    const next = carrySessionName(overrides, "old", "new");
    expect(next.old).toBeUndefined();
    expect(next.new).toBeUndefined();
    expect(next.other).toEqual({ customName: "x" });
  });

  it("drops the old entry even when there is no target id (failed restart)", () => {
    const overrides: SessionMetaOverrides = { old: { customName: "Gone" } };
    const next = carrySessionName(overrides, "old", undefined);
    expect(next.old).toBeUndefined();
    expect(Object.keys(next)).toEqual([]);
  });

  it("treats a whitespace-only customName as nothing to carry", () => {
    const overrides: SessionMetaOverrides = { old: { customName: "   " } };
    const next = carrySessionName(overrides, "old", "new");
    expect(next.new).toBeUndefined();
  });
});

describe("subagent child sessions (session_kind)", () => {
  const dir = sessionsDirFor(grokHome, cwd);

  it("marks a session_kind:subagent summary so the history list can hide it", () => {
    const fs = buildFs({
      [path.join(dirFor("child"), "summary.json")]: {
        isDir: false,
        // Real child-session summary shape (grok 0.2.93): session_kind +
        // agent_name identify the delegation workspace.
        content: JSON.stringify({
          info: { id: "child", cwd },
          session_summary: "Analyze add() function in math.js file",
          session_kind: "subagent",
          agent_name: "general-purpose",
          updated_at: "2026-07-11T18:00:00Z",
        }),
      },
      [path.join(dirFor("real"), "summary.json")]: {
        isDir: false,
        content: JSON.stringify({ info: { id: "real", cwd }, session_summary: "Fix the login bug", updated_at: "2026-07-11T18:00:00Z" }),
      },
      [dir]: { isDir: true },
    });
    const out = readSessionEntries({ fs, grokHome, cwd, ids: ["child", "real"], overrides: {} });
    expect(out.find((e) => e.id === "child")?.kind).toBe("subagent");
    expect(out.find((e) => e.id === "real")?.kind).toBeUndefined();
  });

  it("marks a headless session but keeps it resumable in the list (grok 1.0.11)", () => {
    const fs = buildFs({
      [path.join(dirFor("headless"), "summary.json")]: {
        isDir: false,
        // grok ≥1.0.11 marks sessions a non-interactive run created. The list
        // must SHOW them — /resume picks up where a headless run left off —
        // while only subagent transcripts stay hidden.
        content: JSON.stringify({
          info: { id: "headless", cwd },
          session_summary: "Run the nightly benchmark",
          session_kind: "headless",
          updated_at: "2026-07-11T18:00:00Z",
        }),
      },
      [dir]: { isDir: true },
    });
    const out = readSessionEntries({ fs, grokHome, cwd, ids: ["headless"], overrides: {} });
    expect(out.find((e) => e.id === "headless")?.kind).toBe("headless");
    // Visible to the picker's newest-row pick — the filter hides only subagents.
    expect(mostRecentSession(out)?.id).toBe("headless");
  });
});

describe("readContextUsage", () => {
  const signalsPath = (id: string) => path.join(dirFor(id), "signals.json");

  // Real signals.json shape (grok 0.2.x): flat JSON with contextTokensUsed /
  // contextWindowTokens among many other counters. This sample mirrors a real
  // post-compact capture: totalTokensBeforeCompaction > contextTokensUsed.
  const realSignals = JSON.stringify({
    turnCount: 19,
    compactionCount: 1,
    totalTokensBeforeCompaction: 40088,
    contextWindowUsage: 14,
    contextTokensUsed: 29088,
    contextWindowTokens: 200000,
    primaryModelId: "grok-composer-2.5-fast",
  });

  it("reads used + window from a real-shaped signals.json (post-compact value)", () => {
    const fs = buildFs({ [signalsPath("s1")]: { isDir: false, content: realSignals } });
    expect(readContextUsage({ fs, grokHome, cwd, id: "s1" })).toEqual({ used: 29088, window: 200000 });
  });

  it("returns null when the file is missing", () => {
    const fs = buildFs({});
    expect(readContextUsage({ fs, grokHome, cwd, id: "nope" })).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    const fs = buildFs({ [signalsPath("s1")]: { isDir: false, content: "{not json" } });
    expect(readContextUsage({ fs, grokHome, cwd, id: "s1" })).toBeNull();
  });

  it("returns null when the count is missing, zero, or not a finite number", () => {
    for (const bad of [
      "{}",
      JSON.stringify({ contextTokensUsed: 0, contextWindowTokens: 200000 }),
      JSON.stringify({ contextTokensUsed: -5 }),
      JSON.stringify({ contextTokensUsed: "29088" }),
      JSON.stringify({ contextTokensUsed: null }),
    ]) {
      const fs = buildFs({ [signalsPath("s1")]: { isDir: false, content: bad } });
      expect(readContextUsage({ fs, grokHome, cwd, id: "s1" })).toBeNull();
    }
  });

  it("returns used without a window when contextWindowTokens is absent or invalid", () => {
    for (const content of [
      JSON.stringify({ contextTokensUsed: 1234 }),
      JSON.stringify({ contextTokensUsed: 1234, contextWindowTokens: 0 }),
      JSON.stringify({ contextTokensUsed: 1234, contextWindowTokens: "200000" }),
    ]) {
      const fs = buildFs({ [signalsPath("s1")]: { isDir: false, content } });
      expect(readContextUsage({ fs, grokHome, cwd, id: "s1" })).toEqual({ used: 1234, window: undefined });
    }
  });
});

// #48 — a fork is named after its parent so it's recognisable in history.
describe("forkDisplayName", () => {
  it("tags the fork with the parent's name, LEADING", () => {
    // Leading, not trailing: history rows ellipsize at the panel edge, so a
    // trailing tag is the first thing to vanish in a narrow sidebar.
    expect(forkDisplayName("Evaluate GitHub issues for implementation priorities"))
      .toBe("(Fork) Evaluate GitHub issues for implementation priorities");
  });

  it("is idempotent — forking a fork must not stack tags", () => {
    expect(forkDisplayName("(Fork) Refactor the parser")).toBe("(Fork) Refactor the parser");
    expect(forkDisplayName(forkDisplayName(forkDisplayName("Foo")))).toBe("(Fork) Foo");
  });

  it("matches the tag case-insensitively but preserves the parent's casing", () => {
    expect(forkDisplayName("(FORK) Thing")).toBe("(FORK) Thing");
    expect(forkDisplayName("(fork) Thing")).toBe("(fork) Thing");
  });

  it("degrades cleanly with no parent name — no stray separator", () => {
    expect(forkDisplayName("")).toBe("(Fork)");
    expect(forkDisplayName("   ")).toBe("(Fork)");
    expect(forkDisplayName(undefined)).toBe("(Fork)");
  });

  it("does not treat a trailing '(Fork)' as the tag — it re-tags at the front", () => {
    // A name that merely ENDS with the tag isn't tagged in our scheme.
    expect(forkDisplayName("experiments (Fork)")).toBe("(Fork) experiments (Fork)");
  });
});

// The name a fork inherits must be the one the user SEES in history — never
// grok's internal `session_summary`, which is primer-derived on every session we
// prime ("… Primer v4 Plan Mode …") and would propagate forever through a
// fork-of-a-fork. This pins the guard that rejects those.
describe("isPrimerSummary guards fork naming (#48)", () => {
  it("recognises the real primer titles grok generated on disk", () => {
    for (const t of [
      "Grok-build-vscode Primer v4 Plan Mode Handling",
      "Grok Build VSCode Primer v4 Plan Mode",
      "Grok Build VSCode Plan Mode Primer v4",
      "Grok-Build-VSCode v4 Plan Mode Primer Instructions",
    ]) {
      expect(isPrimerSummary(t)).toBe(true);
    }
  });

  it("leaves a real conversation title alone", () => {
    expect(isPrimerSummary("Evaluate GitHub issues for implementation priorities")).toBe(false);
    expect(isPrimerSummary("Analyze this solution in depth")).toBe(false);
  });
});

// resolveGrokHome must read the SAME `.grok` the CLI writes. The CLI: `$GROK_HOME`
// override first, else Rust std::env::home_dir() — which on Windows is
// USERPROFILE-based and IGNORES HOME. The old `HOME || USERPROFILE` order split
// session history from the CLI's store on Windows boxes with HOME set (git-bash).
describe("resolveGrokHome", () => {
  it("prefers USERPROFILE over HOME on Windows (matching the CLI + cli-locator)", () => {
    const env = { HOME: "C:\\weird\\gitbash-home", USERPROFILE: "C:\\Users\\p" };
    expect(resolveGrokHome(env, "win32")).toBe(path.join("C:\\Users\\p", ".grok"));
  });

  it("uses HOME on POSIX and never consults USERPROFILE there", () => {
    const env = { HOME: "/home/p", USERPROFILE: "C:\\Users\\p" };
    expect(resolveGrokHome(env, "linux")).toBe(path.join("/home/p", ".grok"));
    expect(resolveGrokHome(env, "darwin")).toBe(path.join("/home/p", ".grok"));
  });

  it("honors the CLI's GROK_HOME override verbatim on every platform", () => {
    const env = { GROK_HOME: "D:\\data\\grok-home", HOME: "/home/p", USERPROFILE: "C:\\Users\\p" };
    expect(resolveGrokHome(env, "win32")).toBe("D:\\data\\grok-home");
    expect(resolveGrokHome(env, "linux")).toBe("D:\\data\\grok-home");
  });

  it("falls back to os.homedir() when the platform env var is unset", () => {
    // Windows with only HOME set: the CLI ignores HOME (Rust home_dir uses the
    // profile dir), so we must not use it either.
    const win = resolveGrokHome({ HOME: "C:\\weird" }, "win32");
    expect(win.endsWith(".grok")).toBe(true);
    expect(win).not.toBe(path.join("C:\\weird", ".grok"));
    const posix = resolveGrokHome({}, "linux");
    expect(posix.endsWith(".grok")).toBe(true);
  });
});

// isPathInside backs isServableFromDisk (generated-media serving): a path-segment
// boundary check, not a string-prefix one.
describe("isPathInside", () => {
  const root = path.join(path.sep === "\\" ? "C:\\Users\\p" : "/home/p", ".grok");

  it("accepts a file below the root", () => {
    expect(isPathInside(root, path.join(root, "sessions", "s1", "images", "out.png"))).toBe(true);
  });

  it("accepts a dir literally named with a leading double-dot (`..foo`)", () => {
    // The old `!rel.startsWith("..")` string-prefix check rejected this legal
    // name and forced the base64 fallback.
    expect(isPathInside(root, path.join(root, "..foo", "x.jpg"))).toBe(true);
  });

  it("rejects the root itself and the parent traversal", () => {
    expect(isPathInside(root, root)).toBe(false);
    expect(isPathInside(root, path.join(root, ".."))).toBe(false);
    expect(isPathInside(root, path.join(root, "..", "escape.png"))).toBe(false);
  });

  it("rejects an unrelated absolute path", () => {
    const other = path.sep === "\\" ? "D:\\elsewhere\\x.png" : "/var/elsewhere/x.png";
    expect(isPathInside(root, other)).toBe(false);
  });
});

// Opening a conversation rewrites summary.json — the CLI rebuilds
// system_prompt.txt / prompt_context.json and restamps `updated_at` — AND
// writes an events.jsonl record, without adding a user message. Ordering on
// either made a conversation you merely glanced at jump to the top of Recent
// and of its project. updates.jsonl is the file a load leaves alone and a
// real turn advances.
describe("session ordering follows the transcript, not a visit", () => {
  const home = "/home/u/.grok";
  const cwd = "/work/repo";
  const dir = sessionsDirFor(home, cwd);
  const summary = (id: string, updatedAt: string) => JSON.stringify({
    info: { id, cwd },
    session_summary: id,
    updated_at: updatedAt,
    num_messages: 7,
  });

  /** `visited` was opened long after its last message; `spoken` was not. */
  const fsWithBoth = () => buildFs({
    [path.join(home, "sessions")]: { isDir: true },
    [dir]: { isDir: true },
    [path.join(dir, "visited")]: { isDir: true },
    [path.join(dir, "spoken")]: { isDir: true },
    // Opened just now, but the transcript is ancient.
    [path.join(dir, "visited", "summary.json")]: {
      isDir: false, content: summary("visited", "2026-05-01T00:00:00Z"), mtimeMs: 9000,
    },
    [path.join(dir, "visited", "events.jsonl")]: { isDir: false, content: "", mtimeMs: 100 },
    // Never re-opened; its transcript is the newer one.
    [path.join(dir, "spoken", "summary.json")]: {
      isDir: false, content: summary("spoken", "2026-01-01T00:00:00Z"), mtimeMs: 500,
    },
    [path.join(dir, "spoken", "events.jsonl")]: { isDir: false, content: "", mtimeMs: 500 },
  });

  it("indexSessions ranks by transcript mtime, so a visit does not promote", () => {
    const ids = indexSessions({ fs: fsWithBoth(), grokHome: home, cwd, platform: "linux" })
      .map((e) => e.id);
    // summary.json mtime would have put `visited` (9000) first.
    // This fixture has no updates.jsonl, so the clock falls back to events.jsonl.
    expect(ids).toEqual(["spoken", "visited"]);
  });

  it("readSessionEntries reports the transcript time as updatedAt", () => {
    const entries = readSessionEntries({
      fs: fsWithBoth(), grokHome: home, cwd, ids: ["visited", "spoken"],
      overrides: {}, platform: "linux",
    });
    const byId = Object.fromEntries(entries.map((e) => [e.id, e.updatedAt]));
    expect(byId.visited).toBe(100);
    expect(byId.spoken).toBe(500);
  });

  it("does not promote a session whose load-only files moved", () => {
    // Measured: a session/load with no turn restamps events.jsonl,
    // chat_history.jsonl and summary.json, and leaves updates.jsonl alone.
    // `visited` was opened just now; `spoken` has the newer real turn.
    const fs = buildFs({
      [path.join(home, "sessions")]: { isDir: true },
      [dir]: { isDir: true },
      [path.join(dir, "visited")]: { isDir: true },
      [path.join(dir, "spoken")]: { isDir: true },
      [path.join(dir, "visited", "summary.json")]: {
        isDir: false, content: summary("visited", "2026-05-01T00:00:00Z"), mtimeMs: 9000,
      },
      [path.join(dir, "visited", "events.jsonl")]: { isDir: false, content: "", mtimeMs: 9000 },
      [path.join(dir, "visited", "chat_history.jsonl")]: { isDir: false, content: "", mtimeMs: 9000 },
      [path.join(dir, "visited", "updates.jsonl")]: { isDir: false, content: "", mtimeMs: 100 },
      [path.join(dir, "spoken", "summary.json")]: {
        isDir: false, content: summary("spoken", "2026-01-01T00:00:00Z"), mtimeMs: 500,
      },
      [path.join(dir, "spoken", "events.jsonl")]: { isDir: false, content: "", mtimeMs: 500 },
      [path.join(dir, "spoken", "updates.jsonl")]: { isDir: false, content: "", mtimeMs: 500 },
    });
    const index = indexSessions({ fs, grokHome: home, cwd, platform: "linux" });
    expect(index.map((e) => e.id)).toEqual(["spoken", "visited"]);
    expect(index[0].mtimeMs).toBe(500);
    expect(index[1].mtimeMs).toBe(100);

    const entries = readSessionEntries({
      fs, grokHome: home, cwd, ids: ["visited", "spoken"],
      overrides: {}, platform: "linux",
    });
    const byId = Object.fromEntries(entries.map((e) => [e.id, e.updatedAt]));
    expect(byId.visited).toBe(100);
    expect(byId.spoken).toBe(500);
  });

  it("advances rank mtime when updates.jsonl moves, so the read cache invalidates", () => {
    // sessionCache is keyed on indexSessions mtimeMs. A load must keep that
    // key (tested above); a real turn must change it.
    const files: Record<string, FileEntry> = {
      [path.join(home, "sessions")]: { isDir: true },
      [dir]: { isDir: true },
      [path.join(dir, "s1")]: { isDir: true },
      [path.join(dir, "s1", "summary.json")]: {
        isDir: false, content: summary("s1", "2026-01-01T00:00:00Z"), mtimeMs: 200,
      },
      [path.join(dir, "s1", "events.jsonl")]: { isDir: false, content: "", mtimeMs: 200 },
      [path.join(dir, "s1", "updates.jsonl")]: { isDir: false, content: "", mtimeMs: 200 },
    };
    expect(indexSessions({ fs: buildFs(files), grokHome: home, cwd, platform: "linux" })[0].mtimeMs)
      .toBe(200);
    files[path.join(dir, "s1", "updates.jsonl")] = { isDir: false, content: "", mtimeMs: 800 };
    files[path.join(dir, "s1", "events.jsonl")] = { isDir: false, content: "", mtimeMs: 800 };
    expect(indexSessions({ fs: buildFs(files), grokHome: home, cwd, platform: "linux" })[0].mtimeMs)
      .toBe(800);
  });

  it("falls back to summary.json for a conversation with no transcript yet", () => {
    const fs = buildFs({
      [path.join(home, "sessions")]: { isDir: true },
      [dir]: { isDir: true },
      [path.join(dir, "fresh")]: { isDir: true },
      [path.join(dir, "fresh", "summary.json")]: {
        isDir: false, content: summary("fresh", "2026-03-04T05:06:07Z"), mtimeMs: 42,
      },
    });
    expect(indexSessions({ fs, grokHome: home, cwd, platform: "linux" }).map((e) => e.id))
      .toEqual(["fresh"]);
    const [entry] = readSessionEntries({
      fs, grokHome: home, cwd, ids: ["fresh"], overrides: {}, platform: "linux",
    });
    expect(entry.updatedAt).toBe(Date.parse("2026-03-04T05:06:07Z"));
  });
});

describe("the archive fence", () => {
  const A = "/work/a";
  const B = "/work/b";
  const AWT = "/home/u/.grok/worktrees/a/feat";
  const k = (c: string) => normalizeRepoPath(c, "linux");
  const trusted = [
    { cwd: A, repoCwd: A },
    { cwd: AWT, repoCwd: A },
    { cwd: B, repoCwd: B },
  ];
  const choice = (cwd: string, archived: boolean, at = 1000) => ({ cwd, at, archived });

  const blocked = (archives: object, openCwds: string[] = []) =>
    archivedProjectKeys({ archives: archives as never, openCwds, platform: "linux" });
  const fence = (archivedProjects: ReadonlySet<string>) =>
    remoteAuthorizedCwds({ trusted, archivedProjects, platform: "linux" });

  it("fences an archived project and everything belonging to it", () => {
    expect(fence(blocked({ [k(A)]: choice(A, true) }))).toEqual([B]);
  });

  it("fences by OWNING PROJECT, so a worktree learned later cannot slip past", () => {
    // The blocked set names projects, and the trusted set carries each cwd's
    // project with it. Matching exact cwds instead let a worktree the host
    // discovered after the fence was built walk straight through.
    const late = [...trusted, { cwd: "/home/u/.grok/worktrees/a/just-made", repoCwd: A }];
    expect(remoteAuthorizedCwds({
      trusted: late, archivedProjects: blocked({ [k(A)]: choice(A, true) }), platform: "linux",
    })).toEqual([B]);
  });

  it("passes everything through when nothing is archived", () => {
    expect(fence(blocked({}))).toEqual([A, AWT, B]);
    // "not archived" is a real stored answer, not the absence of one.
    expect(fence(blocked({ [k(A)]: choice(A, false) }))).toEqual([A, AWT, B]);
  });

  it("never fences a project the host has OPEN, worktrees included", () => {
    // Opening a project does not clear its flag; fencing it anyway would blind
    // the phone to the conversation the desk is working in.
    expect(fence(blocked({ [k(A)]: choice(A, true) }, [A]))).toEqual([A, AWT, B]);
  });

  it("ignores a stored choice with no cwd rather than fencing everything", () => {
    expect(fence(blocked({ x: { at: 1, archived: true } }))).toEqual([A, AWT, B]);
  });
});

describe("expiredArchiveChoiceKeys", () => {
  const A = "/work/a";
  const k = (c: string) => normalizeRepoPath(c, "linux");
  const call = (over: object = {}) =>
    expiredArchiveChoiceKeys({
      archives: { [k(A)]: { cwd: A, at: 1000, archived: true } },
      newestActivityAt: () => 0,
      platform: "linux",
      ...over,
    });

  it("expires a choice once the project has been worked in since", () => {
    expect(call({ newestActivityAt: () => 2000 })).toEqual([k(A)]);
  });

  it("keeps a choice when the work predates it", () => {
    expect(call({ newestActivityAt: () => 999 })).toEqual([]);
    expect(call({ newestActivityAt: () => 1000 })).toEqual([]);
  });

  it("keeps a choice for a project with no transcript at all", () => {
    // 0 means "nothing ever ran here", which is not evidence of work.
    expect(call({ newestActivityAt: () => 0 })).toEqual([]);
  });

  it("expires an explicit keep-showing-me choice on the same terms", () => {
    expect(call({
      archives: { [k(A)]: { cwd: A, at: 1000, archived: false } },
      newestActivityAt: () => 2000,
    })).toEqual([k(A)]);
  });
});

describe("newestTranscriptMtime (the evidence a remote cannot forge)", () => {
  // Fake fs shaped like the real store: <grokHome>/sessions/<encoded-cwd>/<uuid>/
  const grokHome = "/home/u/.grok";
  const cwd = "/work/a";
  const leaf = encodeSessionCatalogLeaf(cwd);
  const ID1 = "019fd3d2-0000-4000-8000-00000000aaaa";
  const ID2 = "019fd3d2-0000-4000-8000-00000000bbbb";

  function makeFs(files: Record<string, number>) {
    const dirs = new Set<string>([
      `${grokHome}/sessions`,
      `${grokHome}/sessions/${leaf}`,
      `${grokHome}/sessions/${leaf}/${ID1}`,
      `${grokHome}/sessions/${leaf}/${ID2}`,
    ].map((d) => normalizeRepoPath(d, "linux")));
    const norm = (p: string) => normalizeRepoPath(p, "linux");
    const byPath = new Map(Object.entries(files).map(([p, m]) => [norm(p), m]));
    return {
      existsSync: (p: string) => dirs.has(norm(p)) || byPath.has(norm(p)),
      readdirSync: (p: string) =>
        norm(p) === norm(`${grokHome}/sessions`) ? [leaf]
        : norm(p) === norm(`${grokHome}/sessions/${leaf}`) ? [ID1, ID2]
        : [],
      readFileSync: () => "{}",
      statSync: (p: string) => {
        const key = norm(p);
        if (byPath.has(key)) return { isDirectory: () => false, mtimeMs: byPath.get(key)! };
        if (dirs.has(key)) return { isDirectory: () => true, mtimeMs: 0 };
        throw new Error("ENOENT " + p);
      },
    } as unknown as FsLike;
  }

  const run = (files: Record<string, number>) =>
    newestTranscriptMtime({ fs: makeFs(files), grokHome, cwd, platform: "linux" });

  it("takes the newest real-activity file across the project's sessions", () => {
    expect(run({
      [`${grokHome}/sessions/${leaf}/${ID1}/updates.jsonl`]: 500,
      [`${grokHome}/sessions/${leaf}/${ID2}/updates.jsonl`]: 900,
    })).toBe(900);
  });

  it("IGNORES summary.json — the thing a mere reload rewrites", () => {
    // This is the whole point. indexSessions falls back to summary.json so a
    // brand-new conversation still lists, and that fallback is exactly what let
    // a reconnecting phone manufacture "this project was worked in" by getting
    // an empty archived session reloaded.
    const files = {
      [`${grokHome}/sessions/${leaf}/${ID1}/summary.json`]: 9_000_000,
      [`${grokHome}/sessions/${leaf}/${ID2}/summary.json`]: 9_000_000,
    };
    expect(run(files)).toBe(0);
    // ...and the contrast, so this cannot pass because the fixture is wrong:
    // indexSessions DOES see those files, which is why it must not be reused
    // for an authorization decision.
    expect(
      indexSessions({ fs: makeFs(files), grokHome, cwd, platform: "linux" })[0]?.mtimeMs,
    ).toBe(9_000_000);
  });

  it("counts only updates.jsonl when a session has load-stamped siblings", () => {
    expect(run({
      [`${grokHome}/sessions/${leaf}/${ID1}/updates.jsonl`]: 100,
      [`${grokHome}/sessions/${leaf}/${ID1}/events.jsonl`]: 9_000_000,
      [`${grokHome}/sessions/${leaf}/${ID1}/summary.json`]: 9_000_000,
    })).toBe(100);
  });

  it("ignores a load restamp of events.jsonl when there is no updates log", () => {
    // A remote resume writes events.jsonl. That must not count as work.
    expect(run({
      [`${grokHome}/sessions/${leaf}/${ID1}/events.jsonl`]: 9_000_000,
      [`${grokHome}/sessions/${leaf}/${ID1}/summary.json`]: 9_000_000,
    })).toBe(0);
  });

  it("reports nothing for a project that has never been spoken to", () => {
    expect(run({})).toBe(0);
  });
});
