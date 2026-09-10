/**
 * Fail the run when a test file produced no verdict.
 *
 * The failure that made this necessary: `projects-rail.dom.test.ts` came back
 * as `[vitest-worker]: Timeout calling "onTaskUpdate"` with five unhandled
 * rejections, and the summary read "216 of 217". Not 216 passed and 1 failed —
 * 216 accounted for and one file that simply never reported. Zero assertions
 * had failed in it.
 *
 * A gate that can silently drop a file is not a gate. Worse, this shape reads
 * like good news: the number next to the tick is large, and the missing file is
 * visible only to somebody who knows what the total should be.
 *
 * So every collected file must end in pass, fail or skip. Anything else is a
 * starved worker or a reporter RPC that timed out, and the run fails saying so
 * by name. Deliberately NOT a retry: a retry would also hide a genuine
 * one-in-five race, which is the class of bug this codebase keeps finding.
 */

/** The whole decision, as a pure function, so it can be tested without a run. */
export function unaccountedFiles(files = []) {
  return files.filter((file) => {
    const state = file?.result?.state;
    return state !== "pass" && state !== "fail" && state !== "skip";
  });
}

export function incompleteRunReport(files = []) {
  const unaccounted = unaccountedFiles(files);
  if (!unaccounted.length) return null;
  const names = unaccounted
    .map((file) => `  ${file?.name ?? "<unnamed file>"} — ${file?.result?.state ?? "no result at all"}`)
    .join("\n");
  return (
    `\nINCOMPLETE RUN: ${unaccounted.length} of ${files.length} test files ` +
    `never reported a verdict.\n${names}\n` +
    "Nothing in them necessarily failed. They were not run to a conclusion, " +
    "which usually means the worker pool was starved — so the run is not " +
    "evidence of anything, and is failed here rather than counted as a pass.\n"
  );
}

export default class CompleteAccountingReporter {
  onFinished(files = []) {
    const report = incompleteRunReport(files);
    if (!report) return;
    console.error(report);
    // The pool can already be tearing down by the time this runs, so set the
    // exit code directly rather than relying on a thrown error to propagate.
    process.exitCode = 1;
  }
}
