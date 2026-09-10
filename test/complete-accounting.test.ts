import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain .mjs, loaded by vitest as a reporter at runtime
import { incompleteRunReport, unaccountedFiles } from "../test-support/complete-accounting.mjs";

/**
 * The guard that decides whether a RUN counted, tested without a run.
 *
 * It exists because `npm test` once reported "216 of 217" and stopped a
 * release: one file had neither passed nor failed, it had never reported at
 * all. The dangerous half is that the shape reads like good news — a large
 * number beside a tick, and the missing file visible only to somebody who
 * already knows the total.
 */
describe("complete suite accounting", () => {
  const file = (name: string, state?: string) =>
    ({ name, result: state ? { state } : undefined });

  it("accepts a run where every file reached a verdict", () => {
    const files = [file("a.test.ts", "pass"), file("b.test.ts", "fail"), file("c.test.ts", "skip")];
    expect(unaccountedFiles(files)).toEqual([]);
    expect(incompleteRunReport(files)).toBeNull();
  });

  it("fails a run where a file never reported, and names it", () => {
    // The literal projects-rail shape: the worker's reporter RPC timed out, so
    // the file carries no result even though nothing in it failed.
    const files = [file("ok.test.ts", "pass"), file("projects-rail.dom.test.ts")];
    expect(unaccountedFiles(files).map((f: { name: string }) => f.name)).toEqual([
      "projects-rail.dom.test.ts",
    ]);
    const report = incompleteRunReport(files)!;
    expect(report).toContain("1 of 2 test files");
    expect(report).toContain("projects-rail.dom.test.ts");
    expect(report).toContain("no result at all");
  });

  it("fails a file whose state is some other word entirely", () => {
    // An allowlist, not a denylist. A state this guard has never heard of is
    // exactly the case it exists for, so it must not be waved through.
    expect(unaccountedFiles([file("x.test.ts", "queued")])).toHaveLength(1);
    expect(unaccountedFiles([file("x.test.ts", "running")])).toHaveLength(1);
  });

  it("says nothing about an empty run", () => {
    // A filter that matched nothing is the caller's problem to report, not a
    // starved pool — and inventing a failure here would break `-t` runs.
    expect(incompleteRunReport([])).toBeNull();
  });
});
