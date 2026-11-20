/**
 * The 30-day history horizon: a conversation whose last activity is older is
 * listed nowhere -- not in Recent, a project's list or history search -- and is
 * skipped before anything is read for it. It stays on disk, untouched, and a
 * pinned one still opens.
 */
import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { HISTORY_HORIZON_MS, sessionsDirFor, withinHistoryHorizon, type SessionListEntry } from "../src/sessions";
import { listAgySessions } from "../src/agy-backend";

const DAY = 24 * 60 * 60 * 1000;

describe("withinHistoryHorizon", () => {
  it("keeps the last 30 days and anything with no time to judge", () => {
    const now = Date.UTC(2026, 9, 15);
    expect(HISTORY_HORIZON_MS).toBe(30 * DAY);
    expect(withinHistoryHorizon(now - 29 * DAY, now)).toBe(true);
    expect(withinHistoryHorizon(now - 30 * DAY, now)).toBe(true);
    expect(withinHistoryHorizon(now - 31 * DAY, now)).toBe(false);
    expect(withinHistoryHorizon(0, now)).toBe(true);
    expect(withinHistoryHorizon(undefined, now)).toBe(true);
  });
});

function grokListing(sessions: Array<[id: string, ageDays: number]>) {
  const grokHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-horizon-"));
  const cwd = path.join(grokHome, "repo");
  const catalog = sessionsDirFor(grokHome, cwd);
  const now = Date.now();
  for (const [id, ageDays] of sessions) {
    const dir = path.join(catalog, id);
    fs.mkdirSync(dir, { recursive: true });
    const summary = path.join(dir, "summary.json");
    fs.writeFileSync(summary, "{}");
    const at = (now - ageDays * DAY) / 1000;
    fs.utimesSync(summary, at, at);
  }
  const instance = Object.create(GrokSidebar.prototype) as any;
  instance.authorizedSessionCwds = vi.fn(() => [cwd]);
  instance.sessionCwdsForRepo = vi.fn(() => [cwd]);
  instance.refreshWorktreeCache = vi.fn(async () => {});
  instance.state = { get: vi.fn((_key: string, fallback: unknown) => fallback ?? {}) };
  instance.host = { appendLine: vi.fn() };
  instance.pool = new Set<Session>();
  instance.annotateWorktreeLabels = vi.fn();
  instance.dotForId = vi.fn(() => "none");
  instance.readEntriesCachedMulti = vi.fn((ids: string[]) => ids.map((id): SessionListEntry => ({
    id, cwd, displayName: `chat ${id}`, rawSummary: "", updatedAt: now, createdAt: 1, numMessages: 1,
  })));
  return { instance, cwd, grokHome };
}

describe("the Grok listing", () => {
  it("drops old conversations on their stat mtime, before reading any of them, in pages and in search", () => {
    const previousHome = process.env.GROK_HOME;
    const { instance, cwd, grokHome } = grokListing([["fresh", 1], ["month", 29], ["old", 45], ["ancient", 400]]);
    try {
      process.env.GROK_HOME = grokHome;
      const page = instance.buildGrokSessionsList(cwd, { offset: 0, limit: 10 }, null);
      expect(page.entries.map((e: SessionListEntry) => e.id).sort()).toEqual(["fresh", "month"]);
      expect(page.total).toBe(2);
      expect(page.hasMore).toBe(false);
      const search = instance.buildGrokSessionsList(cwd, { offset: 0, limit: 10, query: "chat" }, null);
      expect(search.entries.map((e: SessionListEntry) => e.id).sort()).toEqual(["fresh", "month"]);
      // Never read, in either pass: the horizon is applied to the index.
      const read = instance.readEntriesCachedMulti.mock.calls.flatMap((call: any[]) => call[0]);
      expect(read).not.toContain("old");
      expect(read).not.toContain("ancient");
      // ...and nothing on disk was touched.
      expect(fs.readdirSync(sessionsDirFor(grokHome, cwd)).sort()).toEqual(["ancient", "fresh", "month", "old"]);
    } finally {
      if (previousHome === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = previousHome;
      fs.rmSync(grokHome, { recursive: true, force: true });
    }
  });
});

describe("adapter rows", () => {
  it("lists only the last 30 days of what the adapter reports, and keeps the cache whole for pins", () => {
    const now = Date.now();
    const row = (id: string, ageDays: number): SessionListEntry => ({
      id, cwd: "/repo", provider: "codex", displayName: id, rawSummary: "", updatedAt: now - ageDays * DAY, createdAt: 1, numMessages: 1,
    });
    const cache = new Map([["/repo", [row("codex-new", 2), row("codex-old", 60)]]]);
    const instance = Object.create(GrokSidebar.prototype) as any;
    instance.authorizedSessionCwds = vi.fn(() => ["/repo"]);
    instance.connectedProviders = vi.fn(() => ["codex"]);
    instance.scheduleAdapterHistoryRefresh = vi.fn();
    instance.buildGrokSessionsList = vi.fn(() => ({ type: "sessions", entries: [], activeId: null, dots: {}, offset: 0, total: 0, hasMore: false, nextOffset: 0, query: "" }));
    instance.state = { get: vi.fn((_key: string, fallback: unknown) => fallback ?? {}) };
    instance.codexSessionCache = { get: () => cache.get("/repo") };
    instance.claudeSessionCache = { get: () => undefined };
    instance.pool = new Set<Session>();
    instance.dotForId = vi.fn(() => "none");
    instance.focused = new Session();
    const list = instance.buildSessionsList("/repo", { offset: 0, limit: 10 }, null);
    expect(list.entries.map((e: SessionListEntry) => e.id)).toEqual(["codex-new"]);
    expect(list.total).toBe(1);
    expect(cache.get("/repo")!.map((e) => e.id)).toEqual(["codex-new", "codex-old"]);
  });
});

describe("Antigravity's disk listing", () => {
  it("skips an old conversation on its transcript mtime without reading its metadata, unless it is pinned", () => {
    const dir = path.join("/home/me", ".gemini", "antigravity-acp", "conversations");
    const now = Date.now();
    const reads: string[] = [];
    const meta = (cwd: string) => JSON.stringify({ cwd });
    const files: Record<string, string> = {
      [path.join(dir, "new.meta")]: meta("/repo"),
      [path.join(dir, "old.meta")]: meta("/repo"),
      [path.join(dir, "pinned.meta")]: meta("/repo"),
    };
    const fakeFs = {
      readDir: () => ["new.db", "new.meta", "old.db", "old.meta", "pinned.db", "pinned.meta"],
      readFile: (file: string) => { reads.push(path.basename(file)); return files[file]; },
      modifiedAt: (file: string) => file.endsWith("new.db") ? now - DAY : now - 90 * DAY,
    };
    const listed = listAgySessions("/repo", "linux", {
      env: {}, home: "/home/me", fs: fakeFs, since: now - HISTORY_HORIZON_MS, keepIds: new Set(["pinned"]),
    });
    expect(listed.map((e) => e.sessionId)).toEqual(["new", "pinned"]);
    // One read of the usage meter's remembered id, then only the kept conversations' sidecars.
    expect(reads).toEqual(["session.json", "new.meta", "pinned.meta"]);
  });
});
