import { describe, it, expect } from "vitest";
import {
  normalizeBaselinePathKey,
  parseShellDeletePaths,
  baselineFromContent,
  baselineAbsent,
  selectBaselinesForUndo,
  archiveTurnBaselines,
  resolveTurnBaselineMap,
  MAX_BASELINE_BYTES,
  type FileBaseline,
} from "../src/file-baseline";

describe("normalizeBaselinePathKey", () => {
  it("case-folds and slash-normalizes", () => {
    expect(normalizeBaselinePathKey("d:\\Temp\\F1.txt")).toBe(
      normalizeBaselinePathKey("d:/Temp/f1.txt"),
    );
  });
});

describe("parseShellDeletePaths", () => {
  it("parses Remove-Item and rm", () => {
    expect(parseShellDeletePaths("Remove-Item -Force 'd:\\a\\x.txt'")).toEqual([
      "d:\\a\\x.txt",
    ]);
    expect(parseShellDeletePaths("rm -f /tmp/x.txt")).toEqual(["/tmp/x.txt"]);
    expect(parseShellDeletePaths("Start-Sleep 1")).toEqual([]);
  });
});

describe("baselineFromContent", () => {
  it("stores small text", () => {
    const b = baselineFromContent("/a.txt", "hi", 2);
    expect(b).toEqual({ path: "/a.txt", kind: "content", content: "hi" });
  });

  it("omits oversized and binary", () => {
    expect(baselineFromContent("/a", "x", MAX_BASELINE_BYTES + 1).kind).toBe("omitted");
    expect(baselineFromContent("/a", "a\0b", 3).kind).toBe("omitted");
  });
});

describe("selectBaselinesForUndo", () => {
  const map = new Map<string, FileBaseline>([
    ["a.txt", { path: "A.txt", kind: "content", content: "1" }],
    ["b.txt", { path: "B.txt", kind: "absent" }],
  ]);

  it("returns all when paths omitted", () => {
    expect(selectBaselinesForUndo(map)).toHaveLength(2);
  });

  it("filters by path key", () => {
    const r = selectBaselinesForUndo(map, ["B.txt"]);
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe("absent");
  });
});

describe("archive + resolve turn maps", () => {
  it("archives and prunes old turns", () => {
    const archive = new Map<number, Map<string, FileBaseline>>();
    for (let i = 1; i <= 5; i++) {
      const m = new Map<string, FileBaseline>();
      m.set("f", baselineAbsent(`f${i}`));
      archiveTurnBaselines(archive, i, m, 3);
    }
    expect(archive.size).toBe(3);
    expect(archive.has(1)).toBe(false);
    expect(archive.has(5)).toBe(true);
  });

  it("resolve prefers live current map for active turnId", () => {
    const current = new Map<string, FileBaseline>();
    current.set("k", baselineAbsent("/x"));
    const archive = new Map<number, Map<string, FileBaseline>>();
    expect(resolveTurnBaselineMap(3, 3, current, archive)).toBe(current);
    archive.set(2, new Map([["k", baselineAbsent("/old")]]));
    expect(resolveTurnBaselineMap(2, 3, current, archive)?.get("k")?.path).toBe("/old");
  });
});
