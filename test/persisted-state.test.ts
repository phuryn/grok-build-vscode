import { describe, it, expect } from "vitest";
import { PersistedState, DISK_KEYS, mementoWithout, type StateFs, type MementoLike } from "../src/persisted-state";
import { AUTO_NAME_MAX_CHARS, capAutoName } from "../src/sessions";

const DIR = "/home/.grok/client-state";
const metaFile = `${DIR}/${DISK_KEYS["grok.sessionMeta"]}`;
const installFile = `${DIR}/${DISK_KEYS["grok.installId"]}`;

class FakeFs implements StateFs {
  files = new Map<string, string>();
  dirs = new Set<string>();
  failWrites = false;
  private nextMtime = 1;
  private mtimes = new Map<string, number>();
  /** Every path handed to renameSync, in order — proves write-then-rename. */
  renames: Array<[string, string]> = [];

  setFile(p: string, data: string): void {
    this.files.set(p, data);
    this.mtimes.set(p, this.nextMtime++);
  }

  existsSync(p: string): boolean {
    return this.files.has(p);
  }
  readFileSync(p: string): string {
    const v = this.files.get(p);
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  }
  statSync(p: string): { size: number; mtimeMs: number } {
    const data = this.files.get(p);
    if (data === undefined) throw new Error(`ENOENT: ${p}`);
    return { size: Buffer.byteLength(data), mtimeMs: this.mtimes.get(p) ?? 0 };
  }
  // Mirrors node's real signature — (file, data, options). Reading the flag off
  // a fourth positional argument is what let an inert `wx` pass as atomic.
  writeFileSync(p: string, data: string, opts: { encoding: "utf8"; flag?: string }): void {
    if (this.failWrites) throw new Error("EACCES: read-only file system");
    if (opts?.flag === "wx" && this.files.has(p)) {
      const error = new Error(`EEXIST: ${p}`) as Error & { code: string };
      error.code = "EEXIST";
      throw error;
    }
    this.setFile(p, data);
  }
  renameSync(from: string, to: string): void {
    const v = this.files.get(from);
    if (v === undefined) throw new Error(`ENOENT: ${from}`);
    this.files.delete(from);
    this.mtimes.delete(from);
    this.setFile(to, v);
    this.renames.push([from, to]);
  }
  mkdirSync(p: string): void {
    this.dirs.add(p);
  }
}

class FakeMemento implements MementoLike {
  store = new Map<string, unknown>();
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.store.has(key) ? (this.store.get(key) as T) : defaultValue;
  }
  update(key: string, value: unknown): PromiseLike<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }
}

const make = (seed?: (fs: FakeFs, m: FakeMemento) => void) => {
  const fs = new FakeFs();
  const memento = new FakeMemento();
  seed?.(fs, memento);
  const logs: string[] = [];
  const state = new PersistedState(memento, DIR, fs, (l) => logs.push(l));
  return { fs, memento, state, logs };
};

describe("PersistedState", () => {
  it("delegates keys it does not own straight to globalState", async () => {
    const { state, memento, fs } = make((_f, m) => m.store.set("grok.cliUpdateExtVersion", "3.1.0"));
    expect(state.get<string>("grok.cliUpdateExtVersion")).toBe("3.1.0");
    await state.update("grok.implicitChipHidden", true);
    expect(memento.store.get("grok.implicitChipHidden")).toBe(true);
    // Nothing VS Code-local should ever reach the shared directory.
    expect(fs.files.size).toBe(0);
  });

  it("migrates existing globalState into the state directory on first load", async () => {
    const overrides = { s1: { customName: "Refactor the parser" } };
    const { state, fs } = make((_f, m) => m.store.set("grok.sessionMeta", overrides));
    // Readable immediately — the migration write must not gate the read.
    expect(state.get("grok.sessionMeta", {})).toEqual(overrides);
    await state.flush();
    expect(JSON.parse(fs.files.get(metaFile)!)).toEqual(overrides);
  });

  it("PRESERVES an existing install id rather than minting a new one", async () => {
    // The relay keys device de-duplication on this value: a fresh id reads as a
    // new machine, mints a second device row, and strands a free-tier user
    // against the one-device cap.
    const { state, fs } = make((_f, m) => m.store.set("grok.installId", "abc-123"));
    expect(state.get<string>("grok.installId")).toBe("abc-123");
    await state.flush();
    expect(JSON.parse(fs.files.get(installFile)!)).toBe("abc-123");
  });

  it("reads the welcome-tips file, a map of tip id to day, without calling it malformed (#214)", () => {
    const tipsFile = `${DIR}/${DISK_KEYS["grok.welcomeTipsShown"]}`;
    const { state, logs } = make((f) => f.setFile(tipsFile, JSON.stringify({ providers: "2026-10-16" })));
    expect(state.get("grok.welcomeTipsShown")).toEqual({ providers: "2026-10-16" });
    expect(logs.join("\n")).not.toMatch(/unexpected JSON shape/);
  });

  it("reads and writes the dismissed-tips file, a map of tip id to true, on disk", async () => {
    const dismissedFile = `${DIR}/${DISK_KEYS["grok.welcomeTips"]}`;
    const { state, fs, logs } = make((f) => f.setFile(dismissedFile, JSON.stringify({ providers: true })));
    expect(state.get("grok.welcomeTips")).toEqual({ providers: true });
    await state.update("grok.welcomeTips", { providers: true, remote: true });
    await state.flush();
    expect(JSON.parse(fs.files.get(dismissedFile)!)).toEqual({ providers: true, remote: true });
    expect(logs.join("\n")).not.toMatch(/unexpected JSON shape/);
  });

  it("prefers the file over globalState once it exists", () => {
    const { state } = make((f, m) => {
      f.setFile(metaFile, JSON.stringify({ s1: { customName: "from disk" } }));
      m.store.set("grok.sessionMeta", { s1: { customName: "stale shadow" } });
    });
    expect(state.get<Record<string, { customName: string }>>("grok.sessionMeta", {}).s1.customName).toBe("from disk");
  });

  it("hydrates globalState from a pre-existing disk value", () => {
    const { state, memento } = make((f, m) => {
      f.setFile(metaFile, JSON.stringify({ s1: { customName: "from disk" } }));
      m.store.set("grok.sessionMeta", { s1: { customName: "stale shadow" } });
    });
    expect(memento.store.get("grok.sessionMeta")).toEqual({ s1: { customName: "from disk" } });
    expect(state.get("grok.sessionMeta", {})).toEqual({ s1: { customName: "from disk" } });
  });

  it("refreshes a synchronous read when another client changes the file", () => {
    const { state, fs } = make((f) => f.setFile(metaFile, JSON.stringify({ first: { customName: "one" } })));
    fs.setFile(metaFile, JSON.stringify({
      first: { customName: "one" },
      second: { customName: "two" },
    }));
    expect(state.get<Record<string, { customName: string }>>("grok.sessionMeta", {}).second.customName).toBe("two");
  });

  it("merges a stale record snapshot instead of erasing another client's entry", async () => {
    const fs = new FakeFs();
    const early = new PersistedState(new FakeMemento(), DIR, fs);
    const migratedMemento = new FakeMemento();
    migratedMemento.store.set("grok.sessionMeta", { migrated: { customName: "kept" } });
    const migrated = new PersistedState(migratedMemento, DIR, fs);
    await migrated.flush();

    await early.update("grok.sessionMeta", { local: { customName: "also kept" } });
    expect(JSON.parse(fs.files.get(metaFile)!)).toEqual({
      migrated: { customName: "kept" },
      local: { customName: "also kept" },
    });
  });

  it("still deletes what the writer deleted, rather than resurrecting it from disk", async () => {
    // The failure mode a merge invites: it cannot tell "I deleted this" from
    // "this is missing from my stale cache", so a naive one restores every name
    // a delete (or Clear all) just removed. The write carries the writer's own
    // before-state, so the distinction survives.
    const fs = new FakeFs();
    fs.setFile(metaFile, JSON.stringify({ doomed: { customName: "delete me" }, kept: { customName: "mine" } }));
    const state = new PersistedState(new FakeMemento(), DIR, fs);
    // Read it the way a call site does, so the cache holds the before-state.
    expect(Object.keys(state.get<Record<string, unknown>>("grok.sessionMeta", {}))).toEqual(["doomed", "kept"]);
    // Another client adds an entry while this one is deciding.
    fs.setFile(metaFile, JSON.stringify({
      doomed: { customName: "delete me" },
      kept: { customName: "mine" },
      theirs: { customName: "added elsewhere" },
    }));

    await state.update("grok.sessionMeta", { kept: { customName: "mine" } });

    expect(JSON.parse(fs.files.get(metaFile)!)).toEqual({
      kept: { customName: "mine" },
      theirs: { customName: "added elsewhere" },
    });
  });

  it("atomically creates an install id and adopts the existing winner", () => {
    const fs = new FakeFs();
    const first = new PersistedState(new FakeMemento(), DIR, fs);
    const second = new PersistedState(new FakeMemento(), DIR, fs);
    const firstId = first.getOrCreate("grok.installId", () => "first-id");
    const secondId = second.getOrCreate("grok.installId", () => "second-id");
    expect(firstId).toBe("first-id");
    expect(secondId).toBe("first-id");
    expect(JSON.parse(fs.files.get(installFile)!)).toBe("first-id");
  });

  it("writes through a temp file and shadows into globalState", async () => {
    const { state, fs, memento } = make();
    await state.update("grok.repoPins", { "/repo": { cwd: "/repo", pinnedAt: 7 } });
    expect(fs.renames).toHaveLength(1);
    const [from, to] = fs.renames[0];
    expect(from).toBe(`${to}.tmp`);
    expect(fs.files.has(from)).toBe(false); // temp file is gone after the rename
    expect(memento.store.get("grok.repoPins")).toEqual({ "/repo": { cwd: "/repo", pinnedAt: 7 } });
    expect(fs.dirs.has(DIR)).toBe(true);
  });

  it("serves reads from memory immediately after a write", async () => {
    const { state } = make();
    void state.update("grok.repoArchives", { "/r": { cwd: "/r", at: 1, archived: true } });
    // Synchronous read, no await — this is how the 60+ call sites use it.
    expect(state.get<Record<string, { archived: boolean }>>("grok.repoArchives", {})["/r"].archived).toBe(true);
  });

  it("maps grok.repoColors onto a client-state file like pins/archives", () => {
    expect(DISK_KEYS["grok.repoColors"]).toBe("repo-colors.json");
    expect(DISK_KEYS["grok.mcpConnectors"]).toBe("mcp-connectors.json");
  });

  it("serializes grok.mcpConnectors as ids and endpoints, never a key", async () => {
    const { connectConnector } = await import("../src/mcp-connectors");
    const { state, fs, memento } = make();
    const planted = "ghp_TESTSECRET_do_not_store";
    const store = connectConnector({}, "github", "https://api.githubcopilot.com/mcp/", true);
    expect(JSON.stringify(store)).not.toContain(planted);
    await state.update("grok.mcpConnectors", store);
    const disk = fs.files.get(`${DIR}/${DISK_KEYS["grok.mcpConnectors"]}`)!;
    expect(disk).not.toContain(planted);
    expect(disk).not.toMatch(/"token"|"key"|"authorization"|Bearer /);
    expect(JSON.parse(disk)).toEqual({
      github: { endpoint: "https://api.githubcopilot.com/mcp/", readOnly: true },
    });
    expect(memento.store.get("grok.mcpConnectors")).toEqual({
      github: { endpoint: "https://api.githubcopilot.com/mcp/", readOnly: true },
    });
  });

  it("falls back to globalState when the file is corrupt, without throwing", () => {
    const { state, logs } = make((f, m) => {
      f.files.set(metaFile, "{not json");
      m.store.set("grok.sessionMeta", { s1: { customName: "survived" } });
    });
    expect(state.get<Record<string, { customName: string }>>("grok.sessionMeta", {}).s1.customName).toBe("survived");
    expect(logs.join()).toMatch(/unreadable on disk/);
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["an unrelated object", { notSessionMeta: true }],
  ])("treats %s as unreadable record JSON", async (_label, value) => {
    const { state, fs, logs } = make((f, m) => {
      f.setFile(metaFile, JSON.stringify(value));
      m.store.set("grok.sessionMeta", { s1: { customName: "survived" } });
    });
    const meta = state.get<Record<string, { customName: string }>>("grok.sessionMeta", {});
    // This is the activation path: repoCatalog() immediately calls Object.values(meta).
    expect(Object.values(meta)).toEqual([{ customName: "survived" }]);
    await state.flush();
    expect(JSON.parse(fs.files.get(metaFile)!)).toEqual(value);
    expect(logs.join()).toMatch(/unreadable on disk/);
  });

  it("treats a non-string install id as unreadable", () => {
    const { state, memento, logs } = make((f, m) => {
      f.setFile(installFile, JSON.stringify({ id: "wrong shape" }));
      m.store.set("grok.installId", "shadow-id");
    });
    expect(state.get<string>("grok.installId")).toBe("shadow-id");
    expect(memento.store.get("grok.installId")).toBe("shadow-id");
    expect(logs.join()).toMatch(/unreadable on disk/);
  });

  it("degrades to globalState when the disk cannot be written", async () => {
    const { state, fs, memento, logs } = make();
    fs.failWrites = true;
    await state.update("grok.sessionMeta", { s1: { customName: "typed while read-only" } });
    // The shadow copy is the point: the value is not lost.
    expect(memento.store.get("grok.sessionMeta")).toEqual({ s1: { customName: "typed while read-only" } });
    expect(state.get<Record<string, { customName: string }>>("grok.sessionMeta", {}).s1.customName).toBe(
      "typed while read-only",
    );
    expect(logs.join()).toMatch(/cannot persist/);
  });

  it("returns the default and writes nothing when there is no prior state", async () => {
    const { state, fs } = make();
    expect(state.get("grok.sessionMeta", {})).toEqual({});
    await state.flush();
    expect(fs.files.size).toBe(0);
  });

  it("keeps concurrent writes in order", async () => {
    const { state, fs } = make();
    void state.update("grok.repoPins", { a: { cwd: "/a", pinnedAt: 1 } });
    void state.update("grok.repoPins", { a: { cwd: "/a", pinnedAt: 2 } });
    await state.update("grok.repoPins", { a: { cwd: "/a", pinnedAt: 3 } });
    expect(JSON.parse(fs.files.get(`${DIR}/${DISK_KEYS["grok.repoPins"]}`)!).a.pinnedAt).toBe(3);
  });
});

describe("PersistedState autoName load sweep", () => {
  const fat = "please rewrite this module from first principles ".repeat(40).trim();
  const short = "fix the flaky test";
  const custom = "User title that must survive even when it is quite long ".repeat(4).trim();

  it("caps a fat autoName on load, leaves a short one byte-identical, and writes once", async () => {
    const seeded = {
      fat: { autoName: fat, customName: custom, pinnedAt: 3 },
      short: { autoName: short, unread: true },
    };
    const { state, fs, memento } = make((f) => f.setFile(metaFile, JSON.stringify(seeded)));
    // Readable immediately — the sweep write must not gate the read, and a
    // read must never return empty while that write is in flight.
    const live = state.get<typeof seeded>("grok.sessionMeta", {} as typeof seeded);
    expect(live.fat.autoName).toBe(capAutoName(fat));
    expect(live.fat.autoName.length).toBeLessThanOrEqual(AUTO_NAME_MAX_CHARS);
    expect(live.fat.customName).toBe(custom);
    expect(live.fat.pinnedAt).toBe(3);
    expect(JSON.stringify(live.short)).toBe(JSON.stringify(seeded.short));
    expect(Object.keys(live).sort()).toEqual(["fat", "short"]);

    const writesBeforeFlush = fs.renames.length;
    await state.flush();
    expect(fs.renames.length).toBeGreaterThan(writesBeforeFlush);
    const onDisk = JSON.parse(fs.files.get(metaFile)!);
    expect(onDisk.fat.autoName).toBe(capAutoName(fat));
    expect(onDisk.fat.customName).toBe(custom);
    expect(JSON.stringify(onDisk.short)).toBe(JSON.stringify(seeded.short));
    expect(memento.store.get("grok.sessionMeta")).toEqual(onDisk);
  });

  it("writes only when something changed, and a second load is a no-op", async () => {
    const alreadyCapped = {
      short: { autoName: short },
      capped: { autoName: capAutoName(fat) },
    };
    const first = make((f) => f.setFile(metaFile, JSON.stringify(alreadyCapped)));
    await first.state.flush();
    expect(first.fs.renames).toEqual([]);
    expect(JSON.parse(first.fs.files.get(metaFile)!)).toEqual(alreadyCapped);

    const second = new PersistedState(new FakeMemento(), DIR, first.fs);
    await second.flush();
    expect(first.fs.renames).toEqual([]);
    expect(JSON.parse(first.fs.files.get(metaFile)!)).toEqual(alreadyCapped);
    expect(second.get("grok.sessionMeta")).toEqual(alreadyCapped);
  });

  it("never touches customName, even when it is longer than the autoName cap", async () => {
    const longCustom = "Keep this rename exactly as typed ".repeat(10).trim();
    expect(longCustom.length).toBeGreaterThan(AUTO_NAME_MAX_CHARS);
    const { state, fs } = make((f) => f.setFile(metaFile, JSON.stringify({
      s: { customName: longCustom, autoName: fat },
    })));
    const live = state.get<Record<string, { customName: string; autoName: string }>>("grok.sessionMeta", {});
    expect(live.s.customName).toBe(longCustom);
    expect(live.s.autoName).toBe(capAutoName(fat));
    await state.flush();
    expect(JSON.parse(fs.files.get(metaFile)!).s.customName).toBe(longCustom);
  });

  it("preserves an entry another client added between load and the sweep write", async () => {
    const seeded = {
      fat: { autoName: fat, customName: "mine" },
      short: { autoName: short },
    };
    const { state, fs } = make((f) => f.setFile(metaFile, JSON.stringify(seeded)));
    expect(state.get<typeof seeded>("grok.sessionMeta", {} as typeof seeded).fat.autoName).toBe(capAutoName(fat));

    fs.setFile(metaFile, JSON.stringify({
      fat: { autoName: fat, customName: "mine" },
      short: { autoName: short },
      theirs: { customName: "added elsewhere", autoName: "new session" },
    }));

    await state.flush();
    const onDisk = JSON.parse(fs.files.get(metaFile)!);
    expect(onDisk.theirs).toEqual({ customName: "added elsewhere", autoName: "new session" });
    expect(onDisk.fat.autoName).toBe(capAutoName(fat));
    expect(onDisk.fat.customName).toBe("mine");
    expect(onDisk.short.autoName).toBe(short);
  });
});

describe("PersistedState and routines", () => {
  const routinesFile = `${DIR}/${DISK_KEYS["grok.routines"]}`;
  const routine = (id: string) => ({
    id, title: id, prompt: "p", cwd: "C:/repo",
    provider: "grok", model: "grok-4.6",
    cadence: { every: 6, unit: "hours" }, createdAt: 1,
  });

  // Routines are stored as a RECORD MAP keyed by id, never an array. An array
  // is not a valid value for any disk key, so it is rejected on load and on the
  // globalState shadow read alike: every routine would silently vanish on the
  // next restart, which is the whole feature failing quietly.
  it("survives a restart", async () => {
    const first = make();
    await first.state.update("grok.routines", { r1: routine("r1") });

    const second = new PersistedState(new FakeMemento(), DIR, first.fs);
    const back = second.get<Record<string, unknown>>("grok.routines", {});
    expect(Object.keys(back)).toEqual(["r1"]);
  });

  it("refuses an array, which is why the map shape is load-bearing", () => {
    const { state } = make((fs) => fs.setFile(routinesFile, JSON.stringify([routine("r1")])));
    // Not a crash, a silent empty — exactly what made this worth a test.
    expect(state.get<Record<string, unknown>>("grok.routines", {})).toEqual({});
  });

  // The write path is a three-way merge against the disk snapshot. A map gets
  // that for free; an array would have clobbered, and only for people running
  // two editors at once.
  it("keeps a routine another client added while this one was editing", async () => {
    const { state, fs } = make((f) =>
      f.setFile(routinesFile, JSON.stringify({ mine: routine("mine") })),
    );
    expect(Object.keys(state.get<Record<string, unknown>>("grok.routines", {}))).toEqual(["mine"]);

    // Another editor writes its own routine before this one saves.
    fs.setFile(routinesFile, JSON.stringify({ mine: routine("mine"), theirs: routine("theirs") }));
    await state.update("grok.routines", { mine: routine("mine"), fresh: routine("fresh") });

    const merged = JSON.parse(fs.files.get(routinesFile)!);
    expect(Object.keys(merged).sort()).toEqual(["fresh", "mine", "theirs"]);
  });

  it("still deletes", async () => {
    const { state, fs } = make((f) =>
      f.setFile(routinesFile, JSON.stringify({ a: routine("a"), b: routine("b") })),
    );
    expect(Object.keys(state.get<Record<string, unknown>>("grok.routines", {})).sort()).toEqual(["a", "b"]);
    await state.update("grok.routines", { a: routine("a") });
    expect(Object.keys(JSON.parse(fs.files.get(routinesFile)!))).toEqual(["a"]);
  });
});

describe("a Grok home of its own (grok.homeDirectory)", () => {
  const routinesFile = `${DIR}/${DISK_KEYS["grok.routines"]}`;
  const ownHome = (seed: (m: FakeMemento) => void) => {
    const fs = new FakeFs();
    const shared = new FakeMemento();
    seed(shared);
    const state = new PersistedState(mementoWithout(shared, new Set(["grok.routines"])), DIR, fs);
    return { fs, shared, state };
  };

  it("does not inherit the other home's routines, so they cannot run twice", async () => {
    const { state, fs } = ownHome((m) => m.store.set("grok.routines", { daily: { id: "daily" } }));
    expect(state.get("grok.routines", {})).toEqual({});
    await state.flush();
    expect(fs.files.has(routinesFile)).toBe(false);
  });

  it("keeps its own routines out of the copy every other window reads", async () => {
    const theirs = { daily: { id: "daily" } };
    const { state, shared, fs } = ownHome((m) => m.store.set("grok.routines", theirs));
    await state.update("grok.routines", { mine: { id: "mine" } });
    expect(JSON.parse(fs.files.get(routinesFile)!)).toEqual({ mine: { id: "mine" } });
    expect(shared.store.get("grok.routines")).toEqual(theirs);
  });

  it("still carries the install id and the rest across", async () => {
    const { state } = ownHome((m) => {
      m.store.set("grok.installId", "install-1");
      m.store.set("grok.repoPins", { "/repo": { pinned: true } });
    });
    expect(state.get("grok.installId")).toBe("install-1");
    expect(state.get("grok.repoPins", {})).toEqual({ "/repo": { pinned: true } });
  });
});
