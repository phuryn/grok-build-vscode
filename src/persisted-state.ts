// Durable client state — our own layer over grok's session store.
//
// Session names, pins, archives and the install id used to live in VS Code's
// `globalState`, which nothing outside a VS Code window can read. They move to
// `~/.grok/client-state/` so that a second client of the same machine (the
// planned desktop app) shows the same names, pins and archives — and so the
// install id, which the relay keys device de-duplication on, identifies the
// MACHINE rather than one editor profile.
//
// Three shape constraints, in order of how much they cost to get wrong:
//
//   1. **Reads stay synchronous.** Sixty-odd call sites read this state inline
//      inside expressions; making reads async would turn a data move into a
//      rewrite of the file we least want to rewrite. So the disk copy is loaded
//      in the constructor, then a cheap size/mtime check keeps synchronous reads
//      coherent across clients.
//   2. **There is no window where a read returns empty.** Loading in the
//      constructor (not in an async init) matters because the dangerous failure
//      is not a stale read — it is an empty read followed by a write, which
//      would persist the emptiness and destroy the user's names and pins.
//   3. **Every migrated key is also written to `globalState`.** The shadow copy
//      costs one extra write and means an unwritable `~/.grok` is not data
//      loss, and that downgrading to an older build still finds its data. Disk
//      wins on read — unless its last write failed, in which case that key
//      falls back to the shadow for the rest of the session.
//
// Writes rebase record updates on the current disk snapshot, so a client that
// started with an empty or stale cache preserves entries another client added.
// The small read-then-write window within one tick remains the same as it was
// with globalState and is outside this layer's scope.
//
// `grok.sessionMeta.autoName` is capped on ingest (`capAutoName`) so a pasted
// prompt cannot bloat the file. The load-time sweep writes once if anything
// changed; capping an already-capped string is a no-op, so it converges after
// one load. `customName` is never touched.

import { capSessionMetaAutoNames, capSessionMetaUsageLogs } from "./sessions";

/** The `fs` surface this needs, injected so tests never touch a real disk. */
export interface StateFs {
  existsSync(p: string): boolean;
  readFileSync(p: string, encoding: "utf8"): string;
  statSync(p: string): { size: number; mtimeMs: number };
  // Options object, not a positional encoding: node's `writeFileSync` takes
  // (file, data, options) and SILENTLY IGNORES a fourth argument, so passing the
  // exclusive flag positionally made the atomic create a plain overwrite against
  // the real fs while a test double that read arg 4 still went green.
  writeFileSync(p: string, data: string, opts: { encoding: "utf8"; flag?: string }): void;
  renameSync(from: string, to: string): void;
  mkdirSync(p: string, opts: { recursive: true }): void;
}

/** Structurally `vscode.Memento`, declared here so this module stays free of
 *  the `vscode` import — it is one of the pieces a non-VS-Code host reuses. */
export interface MementoLike {
  keys?(): readonly string[];
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

/** globalState key -> file under the state directory. Everything absent from
 *  this map (update nags, one-shot UI dismissals) is VS Code-local by nature
 *  and keeps living in `globalState`. */
export const DISK_KEYS: Readonly<Record<string, string>> = {
  "grok.defaultModeCohort": "default-mode-cohort.json",
  "grok.sessionMeta": "session-meta.json",
  "grok.repoPins": "repo-pins.json",
  "grok.repoArchives": "repo-archives.json",
  "grok.repoColors": "repo-colors.json",
  "grok.installId": "install-id.json",
  // Global progressive-disclosure preference ("knowledge" | "coding"). String
  // scalar like installId — not a record map. See src/app-purpose.ts.
  "grok.appPurpose": "app-purpose.json",
  // Connected Tier-1 MCP apps (ids + endpoints + optional readOnly — never
  // tokens or PATs; those live in HostSecrets). Shared with the desktop host
  // because `~/.mcp-auth` is already machine-wide.
  "grok.mcpConnectors": "mcp-connectors.json",
  // Routine DEFINITIONS only. Their runs are one file each under
  // `routine-runs/`, deliberately outside this class: a run record is a claim,
  // and a claim's whole value is being an uncached atomic create — which is the
  // opposite of what the cache, the globalState shadow and the rebase-on-write
  // in here are for. See src/routine-store.ts.
  "grok.routines": "routines.json",
  // Empty-state tips the user is finished with — a record map of id -> true,
  // never an array (validValue accepts a string scalar or a record map, and an
  // array is silently rejected; the routines list learned that the hard way).
  // Machine-wide on purpose: the desk and a linked phone show subsets of the
  // same pool to the same person.
  "grok.welcomeTips": "welcome-tips.json",
  // Companion to the above: id -> the local day that tip last appeared, so the
  // same line does not come round twice in one day. Pruned to today on write.
  "grok.welcomeTipsShown": "welcome-tips-shown.json",
};

export class PersistedState {
  private readonly cache = new Map<string, unknown>();
  private readonly diskStamps = new Map<string, DiskStamp>();
  /** Keys whose last disk write threw — read from the shadow copy instead, so
   *  a broken disk degrades to the old behaviour rather than to stale reads. */
  private readonly degraded = new Set<string>();
  /** Writes serialise through one chain. Volume is a handful per interaction,
   *  so per-key queues would be complexity without a payoff. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly memento: MementoLike,
    private readonly dir: string,
    private readonly fs: StateFs,
    private readonly log: (line: string) => void = () => {},
  ) {
    this.loadSync();
  }

  private filePath(key: string): string {
    // Plain concatenation rather than path.join: `dir` is built by the caller
    // from resolveGrokHome(), and the file names are literals in DISK_KEYS.
    return `${this.dir}/${DISK_KEYS[key]}`;
  }

  /** Cap `autoName` and `usageLog` on session-meta maps. Other keys pass
   *  through. Sync and idempotent — a second ingest of already-capped data is a
   *  no-op, which is what lets `loadSync` skip the write when nothing changed. */
  private ingest(key: string, value: unknown): { value: unknown; changed: boolean } {
    if (key !== "grok.sessionMeta" || !isRecordMap(value)) {
      return { value, changed: false };
    }
    const names = capSessionMetaAutoNames(value);
    const logs = capSessionMetaUsageLogs(names.value);
    return { value: logs.value, changed: names.changed || logs.changed };
  }

  private validValue(key: string, value: unknown): boolean {
    if (key === "grok.defaultModeCohort") return value === "new" || value === "existing";
    // Scalar string keys (install id + app purpose). Everything else is a
    // record-of-records map (session meta, pins, archives).
    if (key === "grok.installId" || key === "grok.appPurpose") {
      return typeof value === "string";
    }
    // The two tip stores are flat maps, not records of records (welcome-tips.ts):
    // dismissed tip id -> true, and shown tip id -> the day it was shown.
    // Rejecting them logged "unexpected JSON shape" on every start (#214) and
    // kept both off disk, so a tip dismissed on the desk came back on a phone.
    if (key === "grok.welcomeTips" || key === "grok.welcomeTipsShown") {
      const want = key === "grok.welcomeTips" ? "boolean" : "string";
      return !!value && typeof value === "object" && !Array.isArray(value)
        && Object.values(value).every((v) => typeof v === want);
    }
    return isRecordMap(value);
  }

  private shadowValue(key: string): unknown {
    const value = this.memento.get(key);
    return this.validValue(key, value) ? value : undefined;
  }

  private diskStamp(key: string): DiskStamp {
    const p = this.filePath(key);
    try {
      if (!this.fs.existsSync(p)) return null;
      const stat = this.fs.statSync(p);
      return { size: stat.size, mtimeMs: stat.mtimeMs };
    } catch {
      return null;
    }
  }

  private readDisk(key: string): { value: unknown; stamp: DiskStamp } | undefined {
    const p = this.filePath(key);
    if (!this.fs.existsSync(p)) return undefined;
    const stamp = this.diskStamp(key);
    try {
      const value = JSON.parse(this.fs.readFileSync(p, "utf8")) as unknown;
      if (!this.validValue(key, value)) throw new Error("unexpected JSON shape");
      return { value, stamp };
    } catch (e) {
      this.log(`[state] ${key}: unreadable on disk (${String(e)}), using globalState`);
      return { value: undefined, stamp };
    }
  }

  private refreshSync(key: string): void {
    if (this.degraded.has(key)) return;
    const currentStamp = this.diskStamp(key);
    const knownStamp = this.diskStamps.get(key);
    if (sameStamp(currentStamp, knownStamp)) return;

    const disk = this.readDisk(key);
    this.diskStamps.set(key, disk?.stamp ?? currentStamp);
    if (disk?.value !== undefined) {
      const ingested = this.ingest(key, disk.value);
      this.cache.set(key, ingested.value);
      void this.memento.update(key, ingested.value);
      if (ingested.changed) this.enqueueWrite(key, ingested.value, disk.value);
      return;
    }
    const shadow = this.shadowValue(key);
    if (shadow !== undefined) this.cache.set(key, shadow);
    else this.cache.delete(key);
  }

  /** Read every migrated key into the cache, migrating from `globalState` the
   *  first time each file is absent. Never throws: state that cannot be read is
   *  state we fall back to the shadow copy for. */
  private loadSync(): void {
    for (const key of Object.keys(DISK_KEYS)) {
      const disk = this.readDisk(key);
      this.diskStamps.set(key, disk?.stamp ?? this.diskStamp(key));
      const shadow = this.shadowValue(key);
      if (disk?.value !== undefined) {
        const ingested = this.ingest(key, disk.value);
        this.cache.set(key, ingested.value);
        // Keep the downgrade/failure shadow current even when this instance did
        // not create the disk file. Cap first so a fat `autoName` never lands
        // in either copy, then write once if anything actually changed.
        void this.memento.update(key, ingested.value);
        if (ingested.changed) this.enqueueWrite(key, ingested.value, disk.value);
      } else if (shadow !== undefined) {
        // First run after the upgrade: seed the file from what VS Code already
        // holds. Critically this PRESERVES the existing install id — minting a
        // fresh one would read as a new machine at the relay, mint a second
        // device row, and strand a free-tier user against the 1-device cap.
        const ingested = this.ingest(key, shadow);
        this.cache.set(key, ingested.value);
        // A malformed existing file is evidence to preserve, not a migration
        // target. An absent file is safe to seed from the shadow.
        if (!disk) this.enqueueWrite(key, ingested.value);
      }
    }
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    if (!(key in DISK_KEYS) || this.degraded.has(key)) {
      return defaultValue === undefined
        ? this.memento.get<T>(key)
        : this.memento.get<T>(key, defaultValue);
    }
    this.refreshSync(key);
    return this.cache.has(key) ? (this.cache.get(key) as T) : defaultValue;
  }

  /** Synchronously claim a value whose first creation must be unique. */
  getOrCreate<T>(key: string, create: () => T): T {
    if (!(key in DISK_KEYS)) {
      const existing = this.memento.get<T>(key);
      if (existing !== undefined) return existing;
      const value = create();
      void this.memento.update(key, value);
      return value;
    }
    this.refreshSync(key);
    const existing = this.cache.get(key);
    if (this.validValue(key, existing)) return existing as T;

    const value = create();
    try {
      this.fs.mkdirSync(this.dir, { recursive: true });
      this.fs.writeFileSync(this.filePath(key), JSON.stringify(value), { encoding: "utf8", flag: "wx" });
      this.cache.set(key, value);
      this.diskStamps.set(key, this.diskStamp(key));
      void this.memento.update(key, value);
      return value;
    } catch (e) {
      if (errorCode(e) === "EEXIST") {
        const winner = this.readDisk(key);
        if (winner?.value !== undefined) {
          this.cache.set(key, winner.value);
          this.diskStamps.set(key, winner.stamp);
          void this.memento.update(key, winner.value);
          return winner.value as T;
        }
      }
      this.log(`[state] ${key}: cannot create ${this.filePath(key)} (${String(e)}); using globalState`);
      this.degraded.add(key);
      void this.memento.update(key, value);
      return value;
    }
  }

  update(key: string, value: unknown): PromiseLike<void> {
    if (!(key in DISK_KEYS)) return this.memento.update(key, value);
    const ingested = this.ingest(key, value);
    const previous = this.cache.get(key);
    this.cache.set(key, ingested.value);
    // Shadow first and unawaited: it is the fallback, so it must not be gated
    // on the disk write it exists to survive.
    void this.memento.update(key, ingested.value);
    return this.enqueueWrite(key, ingested.value, previous);
  }

  private enqueueWrite(key: string, value: unknown, previous?: unknown): Promise<void> {
    this.queue = this.queue.then(() => {
      try {
        this.fs.mkdirSync(this.dir, { recursive: true });
        if (key === "grok.installId") {
          this.writeInstallId(key, value);
          return;
        }
        const disk = this.readDisk(key);
        let next = mergeRecord(previous, value, disk?.value);
        // Rebase can revive a fat `autoName` or an unfolded `usageLog` from
        // disk; cap the merged result so a concurrent client's new entries
        // survive and their prompts don't.
        if (key === "grok.sessionMeta" && isRecordMap(next)) {
          next = capSessionMetaUsageLogs(capSessionMetaAutoNames(next).value).value;
        }
        // Write-then-rename: a crash mid-write leaves the previous file intact
        // rather than a truncated one. Node's rename replaces an existing
        // destination on Windows too (MoveFileEx with REPLACE_EXISTING).
        const tmp = `${this.filePath(key)}.tmp`;
        this.fs.writeFileSync(tmp, JSON.stringify(next), { encoding: "utf8" });
        this.fs.renameSync(tmp, this.filePath(key));
        this.cache.set(key, next);
        this.diskStamps.set(key, this.diskStamp(key));
        void this.memento.update(key, next);
        this.degraded.delete(key);
      } catch (e) {
        if (!this.degraded.has(key)) {
          this.log(`[state] ${key}: cannot persist to ${this.dir} (${String(e)}); using globalState`);
        }
        this.degraded.add(key);
      }
    });
    return this.queue;
  }

  private writeInstallId(key: string, value: unknown): void {
    const p = this.filePath(key);
    try {
      this.fs.writeFileSync(p, JSON.stringify(value), { encoding: "utf8", flag: "wx" });
      this.cache.set(key, value);
      this.diskStamps.set(key, this.diskStamp(key));
      return;
    } catch (e) {
      if (errorCode(e) !== "EEXIST") throw e;
      const winner = this.readDisk(key);
      if (winner?.value === undefined) throw new Error("install id file exists but is unreadable");
      this.cache.set(key, winner.value);
      this.diskStamps.set(key, winner.stamp);
      void this.memento.update(key, winner.value);
    }
  }

  /** Settle every queued write — for tests and for a clean shutdown. */
  flush(): Promise<void> {
    return this.queue;
  }
}

type DiskStamp = { size: number; mtimeMs: number } | null;

function sameStamp(a: DiskStamp | undefined, b: DiskStamp | undefined): boolean {
  return a === b || (!!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordMap(value: unknown): value is Record<string, Record<string, unknown>> {
  return isRecord(value) && Object.values(value).every(isRecord);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function mergeRecord(previous: unknown, value: unknown, disk: unknown): unknown {
  if (!isRecord(value) || !isRecord(disk)) return value;
  const base = isRecord(previous) ? previous : {};
  const next = { ...disk };
  for (const key of new Set([...Object.keys(base), ...Object.keys(value)])) {
    const was = Object.prototype.hasOwnProperty.call(base, key);
    const now = Object.prototype.hasOwnProperty.call(value, key);
    if (!now && was) delete next[key];
    else if (now && (!was || !sameJson(base[key], value[key]))) {
      next[key] = was ? mergeChangedValue(base[key], value[key], disk[key]) : value[key];
    }
  }
  return next;
}

function mergeChangedValue(previous: unknown, value: unknown, disk: unknown): unknown {
  if (!isRecord(previous) || !isRecord(value) || !isRecord(disk)) return value;
  return mergeRecord(previous, value, disk);
}
