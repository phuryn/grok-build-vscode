import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudHostUpdate, cloudHostIsIdle } from "../src/cloud-host-update";
import { GrokSidebar } from "../src/sidebar";
import { Session, beginTurn, endTurn } from "../src/session";
import type { Routine } from "../src/routines";

const updates: CloudHostUpdate[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000_000); });
afterEach(() => { updates.splice(0).forEach((update) => update.dispose()); vi.useRealTimers(); });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(provider: Routine["provider"] = "grok") {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  const session = new Session();
  const routine: Routine = { id: "routine", title: "Scheduled work", prompt: "Do the work", cwd: "/repo",
    provider, model: "", createdAt: Date.now() - 60_000, cadence: { every: 1, unit: "hours" } };
  const startup = deferred(), sending = deferred(), turn = deferred();
  const client = { sessionId: "routine-session" };
  sidebar.cloudHostWork = 0;
  sidebar.routinesInFlight = new Set();
  sidebar.pool = new Set();
  sidebar.focused = new Session();
  sidebar.loadRoutines = () => [routine];
  sidebar.routineRuns = { claim: vi.fn(() => true), finish: vi.fn(), prune: vi.fn() };
  sidebar.usableProviders = () => [provider];
  sidebar.resolveLocalRepoTarget = () => true;
  sidebar.newLocalSession = () => session;
  sidebar.setSessionCwd = vi.fn(); sidebar.workspaceRoot = () => "/repo";
  sidebar.state = { get: () => ({}), update: vi.fn(async () => {}) };
  sidebar.sessionCache = new Map();
  sidebar.postSessionName = vi.fn(); sidebar.postRepoCatalog = vi.fn();
  sidebar.postSessionsList = vi.fn(); sidebar.postRoutines = vi.fn(); sidebar.emit = vi.fn();
  // Keep the real startSession / exclusive-start / withCloudHostWork chain.
  sidebar.startSessionBody = vi.fn(async () => {
    await startup.promise;
    session.client = client as never;
    return client;
  });
  sidebar.handleAdmittedSend = vi.fn(async (_text, _bare, _session, _origin, _queued, _submission, onStarted) => {
    sending.resolve();
    expect(sidebar.cloudHostWork).toBeGreaterThan(0);
    expect(sidebar.cloudHostUpdate.admitting).toBe(true);
    const token = beginTurn(session);
    onStarted?.();
    await turn.promise;
    endTurn(session, token);
    session.status = "done";
  });
  let busy = true;
  const exit = vi.fn();
  const update = new CloudHostUpdate({
    installed: "4.13.0", random: () => 0.5, saveAttempt: vi.fn(),
    check: async () => ({ latest: "4.13.1", mandatoryBelow: null }),
    idle: () => !busy && cloudHostIsIdle(sidebar.pool, false, false, sidebar.cloudHostWork),
    publish: () => {}, maintenance: async () => {}, removeStamp: async () => {}, exit,
  });
  sidebar.cloudHostUpdate = update; updates.push(update);
  return { sidebar, session, routine, update, exit, startup, sending, turn, idle: () => { busy = false; } };
}

describe("routine admission across cloud updates", () => {
  it.each(["grok", "codex", "claude", "muse"] as const)(
    "holds %s work from before its claim through startup, send and outcome", async (provider) => {
      const h = fixture(provider); await h.update.check(); h.update.request();
      expect(h.update.snapshot.state).toBe("queued");
      h.idle();
      h.sidebar.routineRuns.claim.mockImplementation(() => {
        expect(h.sidebar.cloudHostWork).toBeGreaterThan(0);
        h.update.considerApply();
        expect(h.update.admitting).toBe(true);
        return true;
      });
      const run = h.sidebar.tickRoutines();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.exit).not.toHaveBeenCalled();
      expect(h.sidebar.routineRuns.finish).not.toHaveBeenCalled();
      h.startup.resolve(); await h.sending.promise;
      expect(h.session.turnToken).toBeDefined();
      expect(h.sidebar.routineRuns.finish.mock.calls.some(([run]: [{ outcome: string }]) => run.outcome === "ran")).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.exit).not.toHaveBeenCalled();
      h.turn.resolve(); await run; await vi.advanceTimersByTimeAsync(0);
      expect(h.sidebar.routineRuns.finish).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "ran" }));
      expect(h.sidebar.cloudHostWork).toBe(0);
      expect(h.exit).toHaveBeenCalledOnce();
    });

  it("leaves a due window unclaimed when admission has closed, so a later host can claim it", async () => {
    const h = fixture(); await h.update.check(); h.update.request(); h.idle(); h.update.considerApply();
    expect(h.update.admitting).toBe(false);
    await h.sidebar.tickRoutines();
    await h.sidebar.runRoutine(h.routine, "manual-window", Date.now());
    expect(h.sidebar.routineRuns.claim).not.toHaveBeenCalled();
    expect(h.sidebar.routineRuns.finish).not.toHaveBeenCalled();
    expect(h.sidebar.startSessionBody).not.toHaveBeenCalled();
    // The same unclaimed window is eligible after the replacement host starts.
    h.sidebar.cloudHostUpdate = undefined;
    h.startup.resolve(); h.turn.resolve();
    h.sidebar.handleAdmittedSend = vi.fn(async (_a, _b, _c, _d, _e, _f, started) => { started(); });
    await h.sidebar.tickRoutines();
    expect(h.sidebar.routineRuns.claim).toHaveBeenCalledOnce();
    expect(h.sidebar.routineRuns.finish).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "ran" }));
  });

  it("never reports ran when the send returns before starting a turn", async () => {
    const h = fixture(); h.startup.resolve();
    // Exercise the real handleSend and its real early return for a priming session.
    delete h.sidebar.handleAdmittedSend;
    h.session.priming = true;
    h.sidebar.divertRacingSend = vi.fn();
    await h.sidebar.runRoutine(h.routine, "manual-window", Date.now());
    expect(h.sidebar.routineRuns.finish).toHaveBeenLastCalledWith(expect.objectContaining({
      outcome: "failed", detail: expect.stringContaining("prompt was not sent"),
    }));
    expect(h.sidebar.routineRuns.finish.mock.calls.some(([run]: [{ outcome: string }]) => run.outcome === "ran")).toBe(false);
  });

  it("does not run or write an outcome when another host already owns the window", async () => {
    const h = fixture(); h.sidebar.routineRuns.claim.mockReturnValue(false);
    await h.sidebar.tickRoutines();
    expect(h.sidebar.startSessionBody).not.toHaveBeenCalled();
    expect(h.sidebar.routineRuns.finish).not.toHaveBeenCalled();
  });
});
