import { describe, expect, it } from "vitest";
import { Session, beginTurn, endTurn, setTurnWaiting, turnIsInFlight, turnWasStopped } from "../src/session";

// `status` used to stand in for "is a turn running", and could not do the job:
// it is set to "working" beside the prompt and only leaves it when that promise
// settles. A cancel the CLI never answered therefore pinned the session at
// "working" forever — and the send path diverts every send into the queue while
// a turn is in flight, so that session could never send again until the window
// was reloaded. Nothing on disk showed it, which is what made it so hard to see.
describe("turn token", () => {
  it("reports no turn on a fresh session", () => {
    expect(turnIsInFlight(new Session())).toBe(false);
  });

  it("is in flight from the prompt until it settles", () => {
    const session = new Session();
    const turn = beginTurn(session);
    expect(turnIsInFlight(session)).toBe(true);
    expect(endTurn(session, turn)).toBe(true);
    expect(turnIsInFlight(session)).toBe(false);
  });

  it("lets only the first settlement end a turn", () => {
    const session = new Session();
    const turn = beginTurn(session);
    // The cancel recovery gets there first...
    expect(endTurn(session, turn)).toBe(true);
    // ...so the real promise, landing later, must not emit a second agentEnd.
    expect(endTurn(session, turn)).toBe(false);
  });

  it("never lets a stale turn end a newer one", () => {
    const session = new Session();
    const stale = beginTurn(session);
    const current = beginTurn(session);
    // The auth resend starts a turn of its own while the outer one is unwinding;
    // the outer's `finally` must not settle the resend.
    expect(endTurn(session, stale)).toBe(false);
    expect(turnIsInFlight(session)).toBe(true);
    expect(endTurn(session, current)).toBe(true);
    expect(turnIsInFlight(session)).toBe(false);
  });

  // The whole point of the token is the prompt that never settles — and a prompt
  // that never settles never runs its `finally`, so the token outlives the client
  // that owned it. Restarting the session has always been the cure for a wedged
  // one, and it stays the cure only if the restart clears this too: resetting
  // `status` alone (which used to be enough) would leave the fresh session
  // reporting a turn in flight and diverting every send into the queue.
  // The host does this in startSession; asserted here on the state it owns.
  it("is cleared by a restart, even when the old prompt never settled", () => {
    const session = new Session();
    beginTurn(session);
    expect(turnIsInFlight(session)).toBe(true);

    // What startSession resets for the replacement client.
    session.status = "idle";
    session.turnToken = undefined;

    expect(turnIsInFlight(session)).toBe(false);
  });

  // Same reasoning for a process that dies mid-turn: its `prompt()` may never
  // settle, and the send path checks for a turn in flight BEFORE it respawns the
  // CLI — so a crash would divert the next send into a queue the exit handler
  // has just emptied. The turn dies with the process.
  it("is cleared when the process exits mid-turn", () => {
    const session = new Session();
    beginTurn(session);

    // What the exit handler resets.
    session.gen++;
    session.turnToken = undefined;

    expect(turnIsInFlight(session)).toBe(false);
  });

  // The invariant behind both of the above, stated once: whoever disposes a
  // client ends its turn. Every disposal site in the host keeps it — the ACP
  // exit handler, startSession, and worktree removal — because a live token
  // outliving its client is what lets a recovery act on a session that no longer
  // exists, or a fresh session inherit a turn it never ran.
  it("treats client disposal as the end of the turn, wherever it happens", () => {
    const session = new Session();
    const turn = beginTurn(session);

    // The shape every disposal site shares.
    session.gen++;
    session.turnToken = undefined;

    expect(turnIsInFlight(session)).toBe(false);
    // And the turn cannot be ended a second time by whatever was holding it.
    expect(endTurn(session, turn)).toBe(false);
  });

  it("does not treat a stale status as a running turn", () => {
    const session = new Session();
    // Exactly the wedge: the dot still says working because nothing settled the
    // turn, but no prompt is running and sends must go through.
    session.status = "working";
    expect(turnIsInFlight(session)).toBe(false);
  });

  it("freezes the elapsed work on the settled token, through the next turn", () => {
    const session = new Session();
    const turn = beginTurn(session, 0);
    setTurnWaiting(session, true, 2_000);
    setTurnWaiting(session, false, 7_000);
    setTurnWaiting(session, true, 10_000);
    setTurnWaiting(session, false, 30_000);
    expect(endTurn(session, turn, 32_400)).toBe(true);
    expect(turn.durationMs).toBe(7_400);

    const next = beginTurn(session, 50_000);
    expect(endTurn(session, turn, 51_000)).toBe(false);
    expect(endTurn(session, next, 54_000)).toBe(true);
    expect(next.durationMs).toBe(4_000);
    expect(turn.durationMs).toBe(7_400);
  });

  it("counts overlapping waits once and resumes only when the last closes", () => {
    const session = new Session();
    const turn = beginTurn(session, 0);
    setTurnWaiting(session, true, 2_000);
    setTurnWaiting(session, true, 4_000);
    setTurnWaiting(session, true, 7_000);
    setTurnWaiting(session, false, 12_000);
    setTurnWaiting(session, false, 14_000);
    expect(endTurn(session, turn, 15_000)).toBe(true);
    expect(turn.durationMs).toBe(5_000);
  });

  it("excludes a wait still open when the turn settles", () => {
    const session = new Session();
    const turn = beginTurn(session, 0);
    setTurnWaiting(session, true, 4_000);
    expect(endTurn(session, turn, 50_000)).toBe(true);
    expect(turn.durationMs).toBe(4_000);
  });

  it("is stopped by the person's Stop or by the agent's own word for it", () => {
    const turn = beginTurn(new Session(), 0);
    expect(turnWasStopped(turn, { lastPromptStopReason: "end_turn" })).toBe(false);
    expect(turnWasStopped(turn, { lastPromptStopReason: "cancelled" })).toBe(true);
    turn.stopRequested = true;
    expect(turnWasStopped(turn, { lastPromptStopReason: "end_turn" })).toBe(true);
  });
});
