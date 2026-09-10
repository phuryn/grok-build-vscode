import { cpus } from "node:os";
import { defineConfig } from "vitest/config";

// Leave the machine some headroom. Vitest defaults to one worker per core, so
// on this box the suite ran 20 workers plus the main thread they all report to,
// and anything else running at the same time (a release gate, a build, an
// editor) pushed it over. What that produced was not slow tests: it was a file
// that never reported at all, and a Chromium launch hook that timed out while
// sixteen of its own assertions passed. Both read as product bugs.
//
// A quarter of the cores back is enough to keep the reporter responsive, and it
// costs a few seconds on a full run. The timeouts below stay as they are; they
// are a different mitigation for a different half of the same contention.
const WORKERS = Math.max(2, Math.floor(cpus().length * 0.75));

export default defineConfig({
  test: {
    maxWorkers: WORKERS,
    minWorkers: 1,
    // Every collected file must end in pass, fail or skip. See the reporter:
    // "216 of 217" is not 216 passed and 1 failed, and a gate that can drop a
    // file silently is not a gate.
    reporters: ["default", "./test-support/complete-accounting.mjs"],
    include: ["test/**/*.test.ts"],
    // Electron e2e lives under test/desktop and needs a real BrowserWindow —
    // run via `npm run test:desktop` only (not npm test / CI unit job).
    exclude: ["**/node_modules/**", "**/dist/**", "test/desktop/**"],
    environment: "node",
    // Vitest's 5s default is a hang detector for pure functions; several files
    // here spawn a real shell or a real Node ACP process, and those starts
    // contend even with the worker cap above. That made
    // `npm test` fail 3-4 tests per run with a different set each time, all
    // passing on re-run, while `--no-file-parallelism` was fully green.
    // Raising the ceiling costs nothing when tests pass and still fails a true
    // hang quickly. Deliberately NOT solved with retries: a retry would also
    // hide a genuine 1-in-5 race, which is exactly the class of bug this
    // codebase keeps finding.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
