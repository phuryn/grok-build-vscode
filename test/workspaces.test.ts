import { describe, it, expect } from "vitest";
import * as path from "node:path";
import type { FsLike } from "../src/sessions";
import {
  addWorkspacePath,
  buildWorkspaceList,
  canonicalizeWorkspacePath,
  discoverWorkspaces,
  dotColorId,
  dotTooltip,
  formatAgo,
  isInternalWorkspacePath,
  mergeSessionIndexes,
  removeWorkspacePath,
} from "../src/workspaces";

// In-memory FsLike over grok's store layout: dirs["sessions/<encoded>"] lists the
// session ids inside; mtimes keys the workspace dir path to its recency.
function makeFs(grokHome: string, workspaces: Record<string, { sessions: string[]; mtimeMs: number }>): FsLike {
  const root = path.join(grokHome, "sessions");
  const dirs = new Map<string, { children: string[]; mtimeMs: number }>();
  dirs.set(root, { children: Object.keys(workspaces).map((cwd) => encodeURIComponent(cwd)), mtimeMs: 0 });
  for (const [cwd, w] of Object.entries(workspaces)) {
    dirs.set(path.join(root, encodeURIComponent(cwd)), { children: w.sessions, mtimeMs: w.mtimeMs });
  }
  return {
    existsSync: (p) => dirs.has(p),
    readdirSync: (p) => {
      const d = dirs.get(p);
      if (!d) throw new Error("ENOENT: " + p);
      return d.children;
    },
    readFileSync: () => { throw new Error("ENOENT"); },
    statSync: (p) => {
      const d = dirs.get(p);
      if (!d) throw new Error("ENOENT: " + p);
      return { isDirectory: () => true, mtimeMs: d.mtimeMs };
    },
    rmdirSync: () => {},
  };
}

describe("canonicalizeWorkspacePath", () => {
  it("folds case, slashes, and trailing separators on win32", () => {
    expect(canonicalizeWorkspacePath("C:\\GitHub\\Proj", "win32")).toBe("c:\\github\\proj");
    expect(canonicalizeWorkspacePath("c:/GitHub/Proj/", "win32")).toBe("c:\\github\\proj");
    expect(canonicalizeWorkspacePath("C:\\GitHub\\Proj\\\\", "win32")).toBe("c:\\github\\proj");
  });

  it("keeps a bare drive root addressable on win32", () => {
    expect(canonicalizeWorkspacePath("C:\\", "win32")).toBe("c:\\");
    expect(canonicalizeWorkspacePath("C:", "win32")).toBe("c:\\");
  });

  it("preserves case on POSIX (only trailing slashes are noise there)", () => {
    expect(canonicalizeWorkspacePath("/home/User/Proj/", "linux")).toBe("/home/User/Proj");
    expect(canonicalizeWorkspacePath("/home/User/Proj", "linux")).toBe("/home/User/Proj");
    expect(canonicalizeWorkspacePath("/", "linux")).toBe("/");
  });

  it("empty/whitespace input canonicalizes to empty (callers treat that as invalid)", () => {
    expect(canonicalizeWorkspacePath("", "win32")).toBe("");
    expect(canonicalizeWorkspacePath("   ", "linux")).toBe("");
  });
});

describe("discoverWorkspaces", () => {
  const HOME = path.join("/", "home", "u", ".grok");

  it("decodes store dir names into workspaces, newest-first, with session counts", () => {
    const fs = makeFs(HOME, {
      "/work/alpha": { sessions: ["s1", "s2"], mtimeMs: 200 },
      "/work/beta": { sessions: ["s3"], mtimeMs: 500 },
    });
    const out = discoverWorkspaces({ fs, grokHome: HOME, platform: "linux" });
    expect(out.map((w) => w.displayPath)).toEqual(["/work/beta", "/work/alpha"]);
    expect(out[1]).toMatchObject({ sessionCount: 2, storageCwds: ["/work/alpha"] });
  });

  it("merges two spellings of one workspace by canonical key (the Windows drive-letter split)", () => {
    // VS Code spawns grok with a lowercase drive letter; a terminal usually doesn't.
    const fs = makeFs(HOME, {
      "c:\\proj": { sessions: ["s1"], mtimeMs: 900 },
      "C:\\proj": { sessions: ["s2", "s3"], mtimeMs: 100 },
    });
    const out = discoverWorkspaces({ fs, grokHome: HOME, platform: "win32" });
    expect(out).toHaveLength(1);
    expect(out[0].canonicalKey).toBe("c:\\proj");
    expect(out[0].storageCwds).toEqual(["c:\\proj", "C:\\proj"]); // newest spelling first
    expect(out[0].displayPath).toBe("c:\\proj");
    expect(out[0].sessionCount).toBe(3);
  });

  it("returns [] with no store on disk, and skips undecodable dir names", () => {
    expect(discoverWorkspaces({ fs: makeFs(HOME, {}), grokHome: path.join("/", "nowhere") })).toEqual([]);
    const fs = makeFs(HOME, { "/work/ok": { sessions: [], mtimeMs: 1 } });
    // Inject a dir name that isn't valid percent-encoding.
    const origReaddir = fs.readdirSync;
    fs.readdirSync = (p) => (p === path.join(HOME, "sessions") ? ["%E0%A4%A", encodeURIComponent("/work/ok")] : origReaddir(p));
    const origStat = fs.statSync;
    fs.statSync = (p) => (p.endsWith("%E0%A4%A") ? { isDirectory: () => true, mtimeMs: 1 } : origStat(p));
    const out = discoverWorkspaces({ fs, grokHome: HOME, platform: "linux" });
    expect(out.map((w) => w.displayPath)).toEqual(["/work/ok"]);
  });
});

describe("buildWorkspaceList", () => {
  const discovered = [
    { canonicalKey: "c:\\proj", storageCwds: ["c:\\proj", "C:\\proj"], displayPath: "c:\\proj", sessionCount: 3, lastActivityMs: 10 },
    { canonicalKey: "c:\\other", storageCwds: ["C:\\Other"], displayPath: "C:\\Other", sessionCount: 1, lastActivityMs: 5 },
  ];

  it("puts active folders first and matches them to on-disk spellings", () => {
    const out = buildWorkspaceList({
      workspaceFolders: ["C:\\Proj"],
      added: ["C:\\Other"],
      discovered,
      platform: "win32",
    });
    expect(out.map((w) => w.source)).toEqual(["active", "added"]);
    // The active folder aggregates BOTH discovered spellings plus its own literal one.
    expect(out[0].storageCwds).toEqual(["c:\\proj", "C:\\proj", "C:\\Proj"]);
    expect(out[0].displayPath).toBe("C:\\Proj");
  });

  it("drops an added path that IS the active folder (dedupe by canonical key)", () => {
    const out = buildWorkspaceList({
      workspaceFolders: ["C:\\Proj"],
      added: ["c:/proj/", "C:\\Other"],
      discovered,
      platform: "win32",
    });
    expect(out).toHaveLength(2);
    expect(out.map((w) => w.canonicalKey)).toEqual(["c:\\proj", "c:\\other"]);
  });

  it("keeps a never-used added folder listable (its own spelling as the only storage candidate)", () => {
    const out = buildWorkspaceList({
      workspaceFolders: [],
      added: ["/work/fresh"],
      discovered: [],
      platform: "linux",
    });
    expect(out).toEqual([
      { canonicalKey: "/work/fresh", storageCwds: ["/work/fresh"], displayPath: "/work/fresh", source: "added" },
    ]);
  });

  it("lists every folder of a multi-root workspace as active", () => {
    const out = buildWorkspaceList({
      workspaceFolders: ["/w/a", "/w/b"],
      added: [],
      discovered: [],
      platform: "linux",
    });
    expect(out.map((w) => [w.displayPath, w.source])).toEqual([["/w/a", "active"], ["/w/b", "active"]]);
  });
});

describe("add/removeWorkspacePath (persisted registry policy)", () => {
  it("adds a new folder, refuses duplicates and active folders", () => {
    const activeKeys = [canonicalizeWorkspacePath("C:\\Proj", "win32")];
    let added = addWorkspacePath([], "C:\\Other", activeKeys, "win32");
    expect(added).toEqual(["C:\\Other"]);
    expect(addWorkspacePath(added, "c:/other/", activeKeys, "win32")).toEqual(added); // dup by key
    expect(addWorkspacePath(added, "c:\\proj", activeKeys, "win32")).toEqual(added); // active
    expect(addWorkspacePath(added, "", activeKeys, "win32")).toEqual(added); // invalid
  });

  it("removes by canonical key regardless of the stored spelling", () => {
    const added = ["C:\\Other", "C:\\Third"];
    expect(removeWorkspacePath(added, "c:\\other", "win32")).toEqual(["C:\\Third"]);
    expect(removeWorkspacePath(added, "c:\\missing", "win32")).toEqual(added);
  });
});

describe("mergeSessionIndexes", () => {
  it("merges newest-first across spellings and tags each entry with its storage cwd", () => {
    const out = mergeSessionIndexes([
      { cwd: "c:\\proj", entries: [{ id: "a", mtimeMs: 300 }, { id: "b", mtimeMs: 100 }] },
      { cwd: "C:\\proj", entries: [{ id: "c", mtimeMs: 200 }] },
    ]);
    expect(out.map((e) => [e.id, e.storageCwd])).toEqual([
      ["a", "c:\\proj"],
      ["c", "C:\\proj"],
      ["b", "c:\\proj"],
    ]);
  });

  it("dedupes by session id — two spellings of one dir on a case-insensitive fs list the same sessions", () => {
    const entries = [{ id: "a", mtimeMs: 300 }, { id: "b", mtimeMs: 100 }];
    const out = mergeSessionIndexes([
      { cwd: "c:\\proj", entries },
      { cwd: "C:\\Proj", entries },
    ]);
    expect(out.map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("isInternalWorkspacePath (Add-workspace suggestion filter)", () => {
  it("flags temp-dir workspaces (live-test grok-live-* scratch cwds) on win32", () => {
    const env = { platform: "win32" as const, tmpdir: "C:\\Users\\U\\AppData\\Local\\Temp" };
    expect(isInternalWorkspacePath("C:\\Users\\U\\AppData\\Local\\Temp\\grok-live-wsA-x1y2", env)).toBe(true);
    expect(isInternalWorkspacePath("c:\\users\\u\\appdata\\local\\temp", env)).toBe(true);
  });

  it("flags anything under AppData and under grok's own home on win32", () => {
    const env = { platform: "win32" as const, grokHome: "C:\\Users\\U\\.grok" };
    expect(isInternalWorkspacePath("C:\\Users\\U\\AppData\\Roaming\\Code\\scratch", env)).toBe(true);
    expect(isInternalWorkspacePath("C:\\Users\\U\\.grok\\sessions", env)).toBe(true);
  });

  it("keeps real project folders", () => {
    const env = { platform: "win32" as const, tmpdir: "C:\\Users\\U\\AppData\\Local\\Temp", grokHome: "C:\\Users\\U\\.grok" };
    expect(isInternalWorkspacePath("C:\\GitHub\\grok-build-vscode", env)).toBe(false);
    expect(isInternalWorkspacePath("D:\\Work\\client-app", env)).toBe(false);
  });

  it("flags POSIX temp locations, keeps real ones", () => {
    const env = { platform: "linux" as const, tmpdir: "/tmp" };
    expect(isInternalWorkspacePath("/tmp/grok-live-pool-abc", env)).toBe(true);
    expect(isInternalWorkspacePath("/var/folders/ab/T/grok-live-x", { platform: "darwin" as NodeJS.Platform })).toBe(true);
    expect(isInternalWorkspacePath("/home/u/projects/app", env)).toBe(false);
  });

  it("a prefix-sibling of tmpdir is NOT flagged (boundary is the separator)", () => {
    const env = { platform: "linux" as const, tmpdir: "/tmp" };
    expect(isInternalWorkspacePath("/tmpfiles/app", env)).toBe(false);
  });
});

describe("tree presentation helpers", () => {
  it("maps dots to the popover's palette", () => {
    expect(dotColorId("working")).toBe("charts.blue");
    expect(dotColorId("needs-you")).toBe("charts.yellow");
    expect(dotColorId("unread")).toBe("charts.green");
    expect(dotColorId("error")).toBe("errorForeground");
    expect(dotColorId("none")).toBe("descriptionForeground");
    expect(dotTooltip("needs-you")).toBe("Needs you");
    expect(dotTooltip("none")).toBe("");
  });

  it("formats relative times compactly", () => {
    const now = 1_000_000_000;
    expect(formatAgo(now - 30_000, now)).toBe("just now");
    expect(formatAgo(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatAgo(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatAgo(now - 49 * 3_600_000, now)).toBe("2d ago");
    expect(formatAgo(now + 999, now)).toBe("just now"); // clock skew never yields negatives
  });
});
