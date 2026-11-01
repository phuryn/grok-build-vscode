import { describe, expect, it } from "vitest";
import {
  adapterActivityAt,
  adapterEntriesEligibleForClear,
  adapterListEntry,
  codexListEntry,
  compareHistoryEntries,
  connectedProviderIds,
  usableProviderIds,
  findCachedCodexSession,
  mergeProviderHistoryPage,
  mergeProviderSessionEntries,
  modelsForConnectedProviders,
  parseCodexVersionOutput,
  projectProviderKey,
  providerLoginState,
  versionIsOlder,
  type ProviderHistoryCursor,
} from "../src/provider-ui";
import type { SessionListEntry } from "../src/sessions";
// @ts-expect-error Plain JS renderer helper has no declaration file.
import { formatRelativeTime } from "../media/webview-helpers.js";

describe("provider UI pure policy", () => {
  it("uses stored DeepSeek activity across listings and leaves unknown time blank", () => {
    const raw = { sessionId: "deepseek-session", cwd: "/workspace" };
    const sentAt = Date.UTC(2026, 10, 1, 9);
    const activeAt = sentAt + 1000;
    const metadata = { [raw.sessionId]: { sentAt, activeAt } };
    for (const now of [activeAt + 60_000, activeAt + 3_600_000]) {
      expect(adapterListEntry(raw, metadata, "deepseek", now).updatedAt).toBe(activeAt);
      expect(adapterListEntry(raw, { [raw.sessionId]: { sentAt } }, "deepseek", now).updatedAt).toBe(sentAt);
      expect(adapterListEntry(raw, {}, "deepseek", now)).toMatchObject({ updatedAt: 0, createdAt: 0, displayName: "Untitled" });
      expect(formatRelativeTime(adapterListEntry(raw, {}, "deepseek", now).updatedAt, now)).toBe("");
    }
  });

  it("requires both explicit connection state and a located binary", () => {
    expect(connectedProviderIds(
      { grok: true, codex: true },
      { grok: true, codex: false },
    )).toEqual(["grok"]);
    expect(connectedProviderIds(
      { codex: true },
      { grok: true, codex: true },
    )).toEqual(["codex"]);
  });

  it("excludes a connected provider whose credentials lapsed from the usable set", () => {
    // The exact state the owner hit: Grok and Claude never connected, Codex
    // connected and located but its credential probe failed. It stayed
    // connected[0], so every new empty session was handed to Codex and opened
    // its terminal-login screen. Nothing here can answer a turn.
    const connections = { codex: true } as const;
    const located = { grok: true, codex: true, claude: true } as const;
    expect(connectedProviderIds(connections, located)).toEqual(["codex"]);
    expect(usableProviderIds(connections, located, { codex: true })).toEqual([]);
    // A working Codex is still usable — the filter is the lapsed flag, not the
    // provider.
    expect(usableProviderIds(connections, located, {})).toEqual(["codex"]);
    expect(usableProviderIds(connections, located, { codex: false })).toEqual(["codex"]);
  });

  it("keeps a usable provider when another one has lapsed", () => {
    expect(usableProviderIds(
      { grok: true, codex: true },
      { grok: true, codex: true },
      { codex: true },
    )).toEqual(["grok"]);
  });

  it("prefers Grok, then Codex, then Claude when several can answer", () => {
    // The order a stranded empty session falls back through (owner, 2026-08-17:
    // "Prefer Grok > Codex > Claude Code"). It is PROVIDER_ORDER, so this test
    // exists to stop that list being reordered for an unrelated reason —
    // grouping in the picker reads from the same constant.
    const all = { grok: true, codex: true, claude: true } as const;
    expect(usableProviderIds(all, all, {})).toEqual(["grok", "codex", "claude"]);
    expect(usableProviderIds(all, all, { grok: true })).toEqual(["codex", "claude"]);
    expect(usableProviderIds(all, all, { grok: true, codex: true })).toEqual(["claude"]);
  });

  it("groups Grok first, uses live models, and implies a default for an empty cache", () => {
    const models = modelsForConnectedProviders(
      ["codex", "grok"],
      { codex: { models: [], seenAt: 1 } },
      { provider: "grok", models: [{ modelId: "grok-build", name: "Grok Build" }] },
    );
    expect(models).toEqual([
      expect.objectContaining({ provider: "grok", modelId: "grok-build" }),
      expect.objectContaining({ provider: "codex", modelId: "", defaultImplied: true }),
    ]);
  });

  it("maps Codex list titles to auto-name strength without overriding a rename", () => {
    const entry = codexListEntry(
      { sessionId: "c1", cwd: "C:\\Work", title: "Generated title", updatedAt: 20 },
      { c1: { provider: "codex", customName: "My name" } },
      100,
    );
    expect(entry).toMatchObject({
      id: "c1",
      provider: "codex",
      displayName: "My name",
      rawSummary: "Generated title",
      updatedAt: 20,
    });
  });

  it("merges connected providers into one recency order and filters by name", () => {
    const row = (id: string, updatedAt: number, provider?: "grok" | "codex"): SessionListEntry => ({
      id,
      cwd: "/repo",
      displayName: id,
      rawSummary: id,
      updatedAt,
      createdAt: updatedAt,
      numMessages: 1,
      provider,
    });
    const merged = mergeProviderSessionEntries(
      [row("grok-old", 1), row("grok-new", 4)],
      [row("codex-mid", 3, "codex")],
      ["grok", "codex"],
    );
    expect(merged.map((entry) => entry.id)).toEqual(["grok-new", "codex-mid", "grok-old"]);
    expect(mergeProviderSessionEntries(merged, [], ["grok", "codex"], "codex").map((entry) => entry.id))
      .toEqual(["codex-mid"]);
    expect(mergeProviderSessionEntries(
      [row("grok-plan", 4)],
      [row("codex-other", 5, "codex")],
      ["codex"],
      "plan",
    ).map((entry) => entry.id)).toEqual(["grok-plan"]);
  });

  it("dedupes the final searchable provider merge by globally unique session id", () => {
    const grok = {
      id: "shared-id", cwd: "C:\\Work\\Repo", displayName: "old", rawSummary: "old",
      updatedAt: 1, createdAt: 1, numMessages: 1,
    } satisfies SessionListEntry;
    const codex = {
      ...grok, cwd: "c:\\work\\REPO", displayName: "new", rawSummary: "new",
      updatedAt: 2, provider: "codex" as const,
    };
    expect(mergeProviderSessionEntries([grok], [codex], ["grok", "codex"]))
      .toEqual([codex]);
  });

  it("folds Windows project keys but preserves POSIX case", () => {
    expect(projectProviderKey("C:\\Work\\Repo", "win32")).toBe("c:\\work\\repo");
    expect(projectProviderKey("/Work/Repo", "linux")).toBe("/Work/Repo");
  });

  it("uses the Codex catalog as existence proof without widening repository scope", () => {
    const codex: SessionListEntry = {
      id: "codex-cold",
      cwd: "/repo",
      displayName: "Cold Codex",
      rawSummary: "Cold Codex",
      updatedAt: 2,
      createdAt: 1,
      numMessages: 1,
      provider: "codex",
    };
    const belongs = (cwd: string, allowed: readonly string[]) => allowed.includes(cwd);
    expect(findCachedCodexSession([[codex]], "codex-cold", ["/repo"], belongs)).toBe(codex);
    expect(findCachedCodexSession([[codex]], "codex-cold", ["/other"], belongs)).toBeUndefined();
  });

  it("uses the Codex timestamp/id high-water mark without reinterpreting Grok's cursor", () => {
    const row = (id: string, updatedAt: number, provider?: "grok" | "codex"): SessionListEntry => ({
      id,
      cwd: "/repo",
      displayName: id,
      rawSummary: id,
      updatedAt,
      createdAt: updatedAt,
      numMessages: 1,
      provider,
    });
    const first = mergeProviderHistoryPage(
      { entries: [row("grok-20", 20)], nextOffset: 100, total: 102 },
      [row("codex-a", 20, "codex"), row("codex-b", 20, "codex"), row("codex-old", 10, "codex")],
      { grokOffset: 0 },
    );
    expect(first.entries.map((entry) => entry.id)).toEqual(["codex-a", "codex-b", "grok-20"]);
    expect(first.providerCursor).toEqual({
      grokOffset: 100,
      codexHighWater: { updatedAt: 20, id: "codex-b" },
    });
    expect(first.hasMore).toBe(true);

    const second = mergeProviderHistoryPage(
      { entries: [row("grok-visible", 1)], nextOffset: 102, total: 102 },
      [row("codex-a", 20, "codex"), row("codex-b", 20, "codex"), row("codex-old", 10, "codex")],
      first.providerCursor,
    );
    expect(second.entries.map((entry) => entry.id)).toEqual(["codex-old", "grok-visible"]);
    expect(second.providerCursor).toEqual({
      grokOffset: 102,
      codexHighWater: { updatedAt: 10, id: "codex-old" },
    });
    expect(second.hasMore).toBe(false);
  });

  it("pages the Codex suffix by limit after Grok is exhausted", () => {
    const row = (id: string, updatedAt: number): SessionListEntry => ({
      id, cwd: "/repo", displayName: id, rawSummary: id,
      updatedAt, createdAt: updatedAt, numMessages: 1, provider: "codex",
    });
    const codex = [row("c3", 3), row("c2", 2), row("c1", 1)];
    const first = mergeProviderHistoryPage(undefined, codex, { grokOffset: 100 }, 2);
    expect(first.entries.map((entry) => entry.id)).toEqual(["c3", "c2"]);
    expect(first.hasMore).toBe(true);
    const second = mergeProviderHistoryPage(undefined, codex, first.providerCursor, 2);
    expect(second.entries.map((entry) => entry.id)).toEqual(["c1"]);
    expect(second.hasMore).toBe(false);
  });

  it("every session id appears exactly once with none skipped across randomized combined pagination", () => {
    const row = (id: string, updatedAt: number, provider?: "grok" | "codex"): SessionListEntry => ({
      id,
      cwd: "/repo",
      displayName: id,
      rawSummary: id,
      updatedAt,
      createdAt: updatedAt,
      numMessages: 1,
      provider,
    });
    for (let seed = 1; seed <= 100; seed++) {
      let state = seed;
      const random = (max: number) => {
        state = (state * 1_664_525 + 1_013_904_223) >>> 0;
        return state % max;
      };
      const rawGrok = Array.from({ length: 20 + random(80) }, (_, index) => ({
        mtime: random(30),
        entry: random(5) === 0 ? undefined : row(`g-${seed}-${index}`, random(25)),
      })).sort((a, b) => b.mtime - a.mtime);
      const codex = Array.from({ length: random(50) }, (_, index) =>
        row(`c-${seed}-${index}`, random(25), "codex"));
      const pageSize = 1 + random(12);
      const emitted: SessionListEntry[] = [];
      const emittedPage = new Map<string, number>();
      let cursor: ProviderHistoryCursor = { grokOffset: 0 };
      let page = 0;
      let firstPageReads = 0;
      let hasMore = true;

      while (hasMore) {
        const rawPage = rawGrok.slice(cursor.grokOffset, cursor.grokOffset + pageSize);
        if (page === 0) firstPageReads = rawPage.length;
        const grokPage = {
          entries: rawPage.flatMap((slot) => slot.entry ? [slot.entry] : []).sort(compareHistoryEntries),
          nextOffset: cursor.grokOffset + rawPage.length,
          total: rawGrok.length,
        };
        const merged = mergeProviderHistoryPage(grokPage, codex, cursor);
        for (const entry of merged.entries) {
          emitted.push(entry);
          emittedPage.set(entry.id, page);
        }
        cursor = merged.providerCursor;
        hasMore = merged.hasMore;
        page++;
        expect(page).toBeLessThanOrEqual(Math.ceil(rawGrok.length / pageSize) + 1);
      }

      const oracle = [...rawGrok.flatMap((slot) => slot.entry ? [slot.entry] : []), ...codex]
        .sort(compareHistoryEntries);
      expect(new Set(emitted.map((entry) => entry.id)).size, `seed ${seed}: duplicate id`).toBe(emitted.length);
      expect(emitted.map((entry) => entry.id).sort(), `seed ${seed}: skipped id`)
        .toEqual(oracle.map((entry) => entry.id).sort());
      expect(firstPageReads, `seed ${seed}: first-open reads`).toBe(Math.min(pageSize, rawGrok.length));
      for (let index = 1; index < emitted.length; index++) {
        if (emitted[index - 1].updatedAt >= emitted[index].updatedAt) continue;
        expect(emitted[index].provider, `seed ${seed}: non-Grok ordering inversion`).not.toBe("codex");
        expect(emittedPage.get(emitted[index].id), `seed ${seed}: within-page inversion`)
          .not.toBe(emittedPage.get(emitted[index - 1].id));
      }
    }
  });

  it("selects the provider-specific second-stage login state", () => {
    expect(providerLoginState("grok")).toBe("auth-required");
    expect(providerLoginState("codex")).toBe("codex-login");
    expect(providerLoginState("claude")).toBe("claude-login");
  });

  it("places Claude as a third picker group with its own default row", () => {
    const models = modelsForConnectedProviders(
      ["grok", "codex", "claude"],
      { claude: { models: [], seenAt: 1 } },
    );
    expect(models.map((model) => `${model.provider}:${model.name}`)).toEqual([
      "grok:Grok default",
      "codex:Codex default",
      "claude:Claude default",
    ]);
  });

  it("pins Codex and Claude recency to the host-observed clock", () => {
    expect(adapterActivityAt("codex", 900, 100)).toBe(100);
    expect(adapterActivityAt("claude", 900, 100)).toBe(100);
    expect(adapterActivityAt("claude", 200, 500)).toBe(500);
    expect(adapterActivityAt("claude", 300)).toBe(300);

    const claude = adapterListEntry(
      { sessionId: "c1", cwd: "/repo", title: "External", updatedAt: 900 },
      { c1: { provider: "claude", activeAt: 100 } },
      "claude",
    );
    expect(claude.updatedAt).toBe(100);

    const codex = adapterListEntry(
      { sessionId: "x1", cwd: "/repo", title: "Opened", updatedAt: 900 },
      { x1: { provider: "codex", activeAt: 100 } },
      "codex",
    );
    expect(codex.updatedAt).toBe(100);
  });

  it("does not promote a Claude row whose adapter stamp moved after a known activeAt", () => {
    const raw = { sessionId: "claude-old", cwd: "/repo", title: "Old", updatedAt: 100 };
    const first = adapterListEntry(raw, {}, "claude");
    const opened = adapterListEntry({ ...raw, updatedAt: 900 }, {
      "claude-old": { provider: "claude", activeAt: first.updatedAt },
    }, "claude");
    const other = adapterListEntry({
      sessionId: "claude-new", cwd: "/repo", title: "New", updatedAt: 500,
    }, {}, "claude");

    expect(mergeProviderSessionEntries([], [opened, other], ["claude"]).map((entry) => entry.id))
      .toEqual(["claude-new", "claude-old"]);

    const sent = adapterListEntry(raw, {
      "claude-old": { provider: "claude", activeAt: 1_000 },
    }, "claude");
    expect(mergeProviderSessionEntries([], [sent, other], ["claude"]).map((entry) => entry.id))
      .toEqual(["claude-old", "claude-new"]);
  });

  it("omits adapter history that was not successfully refreshed before clear-all", () => {
    const checked = new Set<"codex" | "claude">(["claude"]);
    expect(adapterEntriesEligibleForClear([
      { provider: "codex", entries: [{ id: "stale-codex" }] },
      { provider: "claude", entries: [{ id: "fresh-claude" }] },
    ], checked)).toEqual([{ id: "fresh-claude" }]);
    expect(adapterEntriesEligibleForClear([
      { provider: "codex", entries: [{ id: "stale-codex" }] },
    ], new Set())).toEqual([]);
  });

  it("keeps Codex ordering stable across an open-only adapter restamp, then moves on send", () => {
    const raw = { sessionId: "codex-old", cwd: "/repo", title: "Old", updatedAt: 100 };
    const first = codexListEntry(raw, {});
    const opened = codexListEntry({ ...raw, updatedAt: 900 }, {
      "codex-old": { provider: "codex", activeAt: first.updatedAt },
    });
    const other = codexListEntry({
      sessionId: "codex-new", cwd: "/repo", title: "New", updatedAt: 500,
    }, {});

    expect(mergeProviderSessionEntries([], [opened, other], ["codex"]).map((entry) => entry.id))
      .toEqual(["codex-new", "codex-old"]);

    const sent = codexListEntry(raw, {
      "codex-old": { provider: "codex", activeAt: 1_000 },
    });
    expect(mergeProviderSessionEntries([], [sent, other], ["codex"]).map((entry) => entry.id))
      .toEqual(["codex-old", "codex-new"]);
  });

  it("parses the binary version rather than using the Codex ACP handshake version", () => {
    expect(parseCodexVersionOutput("codex-cli 0.147.0\n")).toBe("0.147.0");
    expect(parseCodexVersionOutput("codex 0.148.0-beta.1")).toBe("0.148.0-beta.1");
    expect(parseCodexVersionOutput("codex-acp adapter")).toBe("");
    expect(versionIsOlder("0.146.0", "0.147.0")).toBe(true);
    expect(versionIsOlder("0.147.0", "0.147.0")).toBe(false);
    expect(versionIsOlder("0.148.0", "0.147.0")).toBe(false);
  });
});
