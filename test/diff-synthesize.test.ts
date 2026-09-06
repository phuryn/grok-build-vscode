import { describe, expect, it } from "vitest";
import {
  contentHasDiff,
  mergeDiffIntoContent,
  synthesizeEditDiff,
} from "../src/diff-synthesize";

describe("synthesizeEditDiff", () => {
  it("builds a single-site diff with line metadata", () => {
    const diff = synthesizeEditDiff({
      path: "/repo/a.ts",
      oldText: "old",
      newText: "new",
      oldLine: 5,
    });
    expect(diff).toEqual({
      type: "diff",
      path: "/repo/a.ts",
      oldText: "old",
      newText: "new",
      _meta: { old_line: 5 },
    });
  });

  it("carries multi-site details[] without collapsing them", () => {
    const diff = synthesizeEditDiff({
      path: "/repo/a.ts",
      oldText: "first-old",
      newText: "first-new",
      details: [
        { old_string: "first-old", new_string: "first-new", old_line: 1 },
        { old_string: "second-old", new_string: "second-new", old_line: 9 },
      ],
    });
    expect(diff?._meta?.details).toHaveLength(2);
    expect(diff?.oldText).toBe("first-old");
    expect(diff?.newText).toBe("first-new");
  });

  it("returns undefined for an empty path", () => {
    expect(synthesizeEditDiff({ path: "", oldText: "a", newText: "b" })).toBeUndefined();
    expect(synthesizeEditDiff({ path: "   ", oldText: "a", newText: "b" })).toBeUndefined();
  });

  it("defaults missing oldText/newText to empty strings", () => {
    const diff = synthesizeEditDiff({ path: "/repo/new.ts", oldText: undefined as any, newText: "content" });
    expect(diff?.oldText).toBe("");
    expect(diff?.newText).toBe("content");
  });
});

describe("mergeDiffIntoContent", () => {
  it("appends to existing content instead of replacing it", () => {
    const diff = synthesizeEditDiff({ path: "/a.ts", oldText: "x", newText: "y" })!;
    const result = mergeDiffIntoContent([{ type: "text", text: "hi" }], diff);
    expect(result).toEqual([{ type: "text", text: "hi" }, diff]);
  });

  it("wraps non-array content instead of dropping it", () => {
    const diff = synthesizeEditDiff({ path: "/a.ts", oldText: "x", newText: "y" })!;
    const result = mergeDiffIntoContent({ type: "text", text: "solo" }, diff);
    expect(result).toEqual([{ type: "text", text: "solo" }, diff]);
  });

  it("is idempotent: a native diff for the same path wins, no second block", () => {
    const nativeDiff = { type: "diff", path: "/a.ts", oldText: "native-old", newText: "native-new" };
    const synthesized = synthesizeEditDiff({ path: "/a.ts", oldText: "x", newText: "y" })!;
    const result = mergeDiffIntoContent([nativeDiff], synthesized);
    expect(result).toEqual([nativeDiff]);
  });

  it("does not merge a diff for a different path away", () => {
    const otherDiff = { type: "diff", path: "/other.ts", oldText: "o", newText: "n" };
    const synthesized = synthesizeEditDiff({ path: "/a.ts", oldText: "x", newText: "y" })!;
    const result = mergeDiffIntoContent([otherDiff], synthesized);
    expect(result).toEqual([otherDiff, synthesized]);
  });

  it("passes through unchanged content when there is no diff to merge", () => {
    const content = [{ type: "text", text: "hi" }];
    expect(mergeDiffIntoContent(content, undefined)).toBe(content);
  });

  it("treats undefined/null content as empty", () => {
    const diff = synthesizeEditDiff({ path: "/a.ts", oldText: "x", newText: "y" })!;
    expect(mergeDiffIntoContent(undefined, diff)).toEqual([diff]);
    expect(mergeDiffIntoContent(null, diff)).toEqual([diff]);
  });

  it("replaces a degenerate existing diff in place, rather than appending a second block", () => {
    // The exact bug this guards: Claude's own tool_call_update sometimes ships
    // a content diff whose oldText === newText (documented as unreliable) —
    // deferring to it silently rendered a "+0 −0" card even though rawInput
    // carried a real change. It must be REPLACED, not left alongside a synthesized one.
    const degenerate = { type: "diff", path: "/a.ts", oldText: "same-text", newText: "same-text" };
    const synthesized = synthesizeEditDiff({ path: "/a.ts", oldText: "old", newText: "new" })!;
    const result = mergeDiffIntoContent([{ type: "text", text: "hi" }, degenerate], synthesized);
    expect(result).toEqual([{ type: "text", text: "hi" }, synthesized]);
  });
});

describe("contentHasDiff", () => {
  it("finds a useful diff block by path", () => {
    const content = [{ type: "diff", path: "/a.ts", oldText: "old", newText: "new" }];
    expect(contentHasDiff(content, "/a.ts")).toBe(true);
    expect(contentHasDiff(content, "/b.ts")).toBe(false);
  });

  it("finds any useful diff block when no path is given", () => {
    expect(contentHasDiff([{ type: "diff", path: "/a.ts", oldText: "old", newText: "new" }])).toBe(true);
    expect(contentHasDiff([{ type: "text", text: "hi" }])).toBe(false);
  });

  it("does not count a degenerate diff (oldText === newText) as already having one", () => {
    // Claude's own diff blocks are documented as unreliable — a block that
    // shows no change at all must not block synthesizing a better one.
    const content = [{ type: "diff", path: "/a.ts", oldText: "", newText: "" }];
    expect(contentHasDiff(content, "/a.ts")).toBe(false);
    const same = [{ type: "diff", path: "/a.ts", oldText: "same", newText: "same" }];
    expect(contentHasDiff(same, "/a.ts")).toBe(false);
  });

  it("counts a degenerate block-level diff as useful when its details[] still shows a real change", () => {
    const content = [{
      type: "diff",
      path: "/a.ts",
      oldText: "TOKEN",
      newText: "TOKEN",
      _meta: { details: [{ old_string: "old-site", new_string: "new-site" }] },
    }];
    expect(contentHasDiff(content, "/a.ts")).toBe(true);
  });

  it("is false for non-array content", () => {
    expect(contentHasDiff(undefined)).toBe(false);
    expect(contentHasDiff({ type: "diff" })).toBe(false);
  });
});
