import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sidebar = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");
const session = readFileSync(new URL("../src/session.ts", import.meta.url), "utf8");
const primer = readFileSync(new URL("../src/grok-primer.ts", import.meta.url), "utf8");
const acp = readFileSync(new URL("../src/acp.ts", import.meta.url), "utf8");

const start = sidebar.indexOf("  private handleExitPlan(");
const end = sidebar.indexOf("  private recoverUnavailablePlanMode(", start);
const handleExitPlan = sidebar.slice(start, end);
const abandonStart = handleExitPlan.indexOf('    if (verdict === "abandoned") {');
const abandonEnd = handleExitPlan.indexOf("    // Calling the async method", abandonStart);
const abandonVerdict = handleExitPlan.slice(abandonStart, abandonEnd);
const nativeVerdicts = handleExitPlan.slice(abandonEnd);
const postStart = sidebar.indexOf("  private async postExitPlanRequest(");
const postEnd = sidebar.indexOf("  private async withPlanReviewPaths", postStart);
const postExitPlanRequest = sidebar.slice(postStart, postEnd);
const sessionStart = sidebar.indexOf("  private async startSession(");
const sessionStartEnd = sidebar.indexOf("    // Worktree sessions pin cwd", sessionStart);
const startSessionSetup = sidebar.slice(sessionStart, sessionStartEnd);
const recoveryStart = sidebar.indexOf("  private recoverUnavailablePlanMode(");
const recoveryEnd = sidebar.indexOf("  /** Persist this plan", recoveryStart);
const recoverUnavailablePlanMode = sidebar.slice(recoveryStart, recoveryEnd);
const handleSendStart = sidebar.indexOf("  private async handleSend(");
const handleSendEnd = sidebar.indexOf("  /**\n   * Recover from an expired-token", handleSendStart);
const handleSend = sidebar.slice(handleSendStart, handleSendEnd);
const exitPlanListenerStart = sidebar.indexOf('    client.on("exitPlanRequest"');
const exitPlanListenerEnd = sidebar.indexOf('    client.on("questionRequest"', exitPlanListenerStart);
const exitPlanListener = sidebar.slice(exitPlanListenerStart, exitPlanListenerEnd);
const modeChangedStart = sidebar.indexOf('    client.on("modeChanged"');
const modeChangedEnd = sidebar.indexOf('    client.on("commandsUpdate"', modeChangedStart);
const modeChangedListener = sidebar.slice(modeChangedStart, modeChangedEnd);
const restoreStart = sidebar.indexOf("        const decision = decideRestoreState(saved)");
const restoreEnd = sidebar.indexOf("        // Seed the context donut", restoreStart);
const restorePlanState = sidebar.slice(restoreStart, restoreEnd);
const exitHandlerStart = sidebar.indexOf('    client.on("exit", (code) => {');
const exitHandlerEnd = sidebar.indexOf('    client.on("stderr"', exitHandlerStart);
const exitHandler = sidebar.slice(exitHandlerStart, exitHandlerEnd);

describe("native plan verdict orchestration", () => {
  it("accepts each verdict only for a host-owned pending request in that Session", () => {
    const lookup = handleExitPlan.indexOf("session.pendingExitPlans.get(requestId)");
    const rejectStale = handleExitPlan.indexOf("if (!client || !pending) return", lookup);
    const respond = handleExitPlan.indexOf("client.respondExitPlan", rejectStale);
    const consume = handleExitPlan.indexOf("session.pendingExitPlans.delete(requestId)", rejectStale);
    const persist = handleExitPlan.indexOf("sidebar.persistPlanVerdict", consume);

    expect(session).toContain("pendingExitPlans = new Map<number | string, PendingExitPlan>()");
    expect(lookup).toBeGreaterThan(-1);
    expect(rejectStale).toBeGreaterThan(lookup);
    expect(respond).toBeGreaterThan(rejectStale);
    expect(consume).toBeGreaterThan(respond);
    expect(persist).toBeGreaterThan(consume);
    expect(postExitPlanRequest).toContain("session.pendingExitPlans.set(req.id, { planText: plan })");
    expect(startSessionSetup).toContain("this.clearPendingHumanRequests(session)");
    expect(sidebar.slice(sidebar.indexOf("  private clearPendingHumanRequests"), sidebar.indexOf("  noteAnswered")))
      .toContain("session.pendingExitPlans.clear()");
  });

  it("settles approval state and interjects feedback before releasing native exit_plan_mode outcomes", () => {
    // Approval restores remembered Auto-accept via the injected Host config surface
    // (was `vscode.workspace.getConfiguration` before the host extraction).
    const restoreYolo = handleExitPlan.indexOf("session.autoApprove = this.defaultModeForProvider");
    const dropGate = handleExitPlan.indexOf("this.setPlanActive(session, false)", restoreYolo);
    const interject = nativeVerdicts.indexOf("client.interject(feedback");
    const respond = nativeVerdicts.indexOf("client.respondExitPlan(requestId, verdict)");
    const commit = nativeVerdicts.indexOf("commitVerdict()", respond);

    expect(restoreYolo).toBeGreaterThan(-1);
    expect(dropGate).toBeGreaterThan(restoreYolo);
    expect(interject).toBeGreaterThan(-1);
    expect(respond).toBeGreaterThan(interject);
    expect(commit).toBeGreaterThan(respond);
    expect(nativeVerdicts).not.toContain("client.cancel");
  });

  it("keeps the plan actionable when the verdict cannot be written", () => {
    const respond = nativeVerdicts.indexOf("client.respondExitPlan(requestId, verdict)");
    const failed = nativeVerdicts.indexOf("if (!verdictWritten)", respond);
    const commit = nativeVerdicts.indexOf("commitVerdict()", failed);
    const failedBranch = nativeVerdicts.slice(failed, commit);

    expect(failed).toBeGreaterThan(respond);
    expect(commit).toBeGreaterThan(failed);
    expect(failedBranch).not.toContain("commitVerdict()");
    expect(failedBranch).not.toContain("resolveCard()");
    expect(handleExitPlan).not.toMatch(/planVerdictPending|planVerdictFailed/);
    expect(handleExitPlan).toContain('this.setStatus(session, "needs-you")');
  });

  it("keeps reject in Plan and makes abandon land in Agent, not remembered YOLO", () => {
    expect(handleExitPlan).toMatch(/else if \(verdict === "rejected"\) \{\s+session\.autoApprove = false;\s+this\.setPlanActive\(session, true\);/);
    expect(handleExitPlan).toContain("explicit Cancel lands in Agent");
    expect(handleExitPlan).toMatch(/session\.autoApprove = false;\s+this\.setPlanActive\(session, false\);/);
  });

  it("lets native abandon settle and queues its comment exactly once without interjecting", () => {
    const respond = abandonVerdict.indexOf("client.respondExitPlan(requestId, verdict)");
    const queue = abandonVerdict.indexOf("this.divertRacingSend(session, feedback, false)");

    expect(respond).toBeGreaterThan(-1);
    expect(queue).toBeGreaterThan(respond);
    expect(abandonVerdict.match(/divertRacingSend\(session, feedback, false\)/g)).toHaveLength(1);
    expect(abandonVerdict).not.toContain("client.interject");
    expect(abandonVerdict).not.toMatch(/client\.cancel|agentReset|suppressAbandoned/);
  });

  it("keeps the queued abandon comment out of the planning turn", () => {
    const commit = handleExitPlan.indexOf("commitVerdict()", abandonStart);
    const queue = handleExitPlan.indexOf("this.divertRacingSend(session, feedback, false)", abandonStart);

    expect(commit).toBeGreaterThan(-1);
    expect(queue).toBeGreaterThan(commit);
    // Resumed via noteAnswered, which sets `working` only when nothing else is
    // outstanding — a plan verdict does not answer a permission card that is
    // also waiting — but re-arms the activity clock either way.
    expect(handleExitPlan).toContain("sidebar.noteAnswered(session)");
    expect(abandonVerdict).not.toContain("client.interject");
  });

  it("queues unchanged approve/reject comments only when interject is unsupported or fails", () => {
    expect(nativeVerdicts.match(/this\.divertRacingSend\(session, feedback, false\)/g)).toHaveLength(2);
    expect(nativeVerdicts).toContain('result === "ok"');
    expect(nativeVerdicts).toContain('text: feedback, chips: [], steer: true');
  });

  it("owns pending feedback in memory until acceptance or a controlled restart", () => {
    const own = handleExitPlan.indexOf("session.inFlightPlanComments.set(requestId, inFlightComment)");
    const interject = handleExitPlan.indexOf("client.interject(feedback", own);
    const retire = handleExitPlan.indexOf("session.inFlightPlanComments.delete(requestId)", interject);

    expect(session).toContain("inFlightPlanComments = new Map<number | string, InFlightPlanComment>()");
    expect(own).toBeGreaterThan(-1);
    expect(interject).toBeGreaterThan(own);
    expect(retire).toBeGreaterThan(interject);
    expect(exitHandler).not.toContain("queueInFlightPlanCommentsOnExit");
    expect(exitHandler).not.toContain("restoreComposer");
    expect(exitHandler).toContain("session.queuedSends = []");
    expect(handleExitPlan).toContain("resolveCard()");
    expect(handleExitPlan).toContain("session.interjectionCount += 1");
    expect(session).not.toMatch(/pendingPlanComments|queuedPlanCommentRecoveries/);
    expect(sidebar).not.toMatch(/pending-plan-comments|recoverComposer|stagePlanCommentRecovery/);
    expect(startSessionSetup).toContain("session.inFlightPlanComments.clear()");
  });

  it("recovers pending feedback before a controlled restart invalidates its generation", () => {
    const recover = startSessionSetup.indexOf(
      "this.queueInFlightPlanCommentsOnExit(session, replacedClient, session.gen)",
    );
    const bump = startSessionSetup.indexOf("const gen = ++session.gen");
    const clear = startSessionSetup.indexOf("session.inFlightPlanComments.clear()", bump);

    expect(recover).toBeGreaterThan(-1);
    expect(bump).toBeGreaterThan(recover);
    expect(clear).toBeGreaterThan(bump);
  });

  it("drains stdout responses before process-exit recovery decides ownership", () => {
    const exit = acp.indexOf('this.proc.on("exit", (code) => {');
    const close = acp.indexOf('this.proc.on("close", (code) => {', exit);
    const rejectPending = acp.indexOf("p.reject(new Error", close);
    const notifyHost = acp.indexOf('this.emit("exit", code)', rejectPending);

    expect(exit).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(exit);
    expect(rejectPending).toBeGreaterThan(close);
    expect(notifyHost).toBeGreaterThan(rejectPending);
  });

  it("persists an in-turn interjection coordinate alongside the prompt coordinate", () => {
    const persistStart = sidebar.indexOf("  private persistPlanVerdict(");
    const persistEnd = sidebar.indexOf("  /** Persist an answered permission", persistStart);
    const persist = sidebar.slice(persistStart, persistEnd);
    expect(persist).toContain("afterUserMessage: session.userMessageCount");
    expect(persist).toContain("afterInterjection: session.interjectionCount");
  });

  it("advances the coordinate synchronously when the interject response is dispatched", () => {
    const responseStart = acp.indexOf('if (ev.kind === "response")');
    const responseEnd = acp.indexOf('if (ev.kind === "session-update")', responseStart);
    const response = acp.slice(responseStart, responseEnd);
    expect(response.indexOf("p.onResolve?.(ev.result)")).toBeGreaterThan(-1);
    expect(response.indexOf("p.resolve(ev.result)")).toBeGreaterThan(
      response.indexOf("p.onResolve?.(ev.result)"),
    );
    expect(handleExitPlan).toContain("client.interject(feedback, () =>");
  });

  it("uses the shipped Steer bubble shape without inventing a rewindable user turn", () => {
    expect(nativeVerdicts).toContain('type: "userMessage", text: feedback, chips: [], steer: true');
    expect(nativeVerdicts).not.toContain("userMessageCount += 1");
  });

  it("acknowledges only after an abandon comment is queued", () => {
    const queue = abandonVerdict.indexOf("this.divertRacingSend(session, feedback, false)");
    const resolve = abandonVerdict.indexOf("resolveCard()", queue);
    expect(queue).toBeGreaterThan(-1);
    expect(resolve).toBeGreaterThan(queue);
  });

  it("persists the shared history-event coordinate for plans, permissions, and usage", () => {
    expect(sidebar.match(/afterHistoryEvent: session\.historyEventCount/g)?.length).toBeGreaterThanOrEqual(3);
    expect(session).toContain("historyEventCount = 0");
  });

  it("has no primer markers, cancellation, synthetic prompt, or deferred turn", () => {
    expect(handleExitPlan).not.toMatch(/client\.cancel|client\.prompt|client\.setMode/);
    expect(handleExitPlan).not.toMatch(/\[Plan (approved|rejected|cancelled)\]/);
    expect(handleExitPlan).not.toMatch(/afterTurn|planProcessing|agentStart|agentEnd|suppressPlanReject|suppressAbandoned/);
  });
});

describe("primer sender retirement", () => {
  it("keeps only legacy primer readers in production", () => {
    expect(primer).toContain("isPrimerText");
    expect(primer).toContain("isPrimerSummary");
    expect(primer).not.toMatch(/GROK_PRIMER|PRIMER_MARKER|PRIMER_VERSION/);
    expect(sidebar).not.toMatch(/ensurePrimed|primingPromise|\.primed\b/);
    expect(session).not.toMatch(/primingPromise|\bprimed\b/);
  });
});

describe("unavailable Plan recovery", () => {
  it("follows a writable adapter mode without lowering grok's client gate", () => {
    expect(modeChangedListener).toContain("!client.usesClientPlanGate");
    expect(modeChangedListener).toContain("applyAgentModeToHostPlan(id, false)");
    expect(modeChangedListener).toContain("this.setPlanActive(session, next.planActive)");
    const grokDescriptive = modeChangedListener.slice(modeChangedListener.indexOf("} else if (session === this.focused)"));
    expect(grokDescriptive).toContain("this.postMode()");
    expect(grokDescriptive).not.toContain("this.setPlanActive(session, false)");
  });

  it("raises the gate but defers recovery while session/load is replaying", () => {
    const raise = modeChangedListener.indexOf("this.setPlanActive(session, true)");
    const unavailable = modeChangedListener.indexOf("if (!session.planModeAvailable)", raise);
    const defer = modeChangedListener.indexOf("if (session.replaying) return", unavailable);
    const recover = modeChangedListener.indexOf("this.recoverUnavailablePlanMode", defer);

    expect(raise).toBeGreaterThan(-1);
    expect(unavailable).toBeGreaterThan(raise);
    expect(defer).toBeGreaterThan(unavailable);
    expect(recover).toBeGreaterThan(defer);
    expect(restorePlanState).toContain("this.recoverUnavailablePlanMode(session, client, gen)");
  });

  it("cancels a live untrusted planning turn and requires both settlement and Agent mode", () => {
    const raise = recoverUnavailablePlanMode.indexOf("this.setPlanActive(session, true)");
    const cancel = recoverUnavailablePlanMode.indexOf('client.cancel("unavailable Plan recovery")');
    const setMode = recoverUnavailablePlanMode.indexOf("client.setMode(ACT_MODE_ID)");
    const modeConfirmed = recoverUnavailablePlanMode.indexOf("recovery.modeConfirmed = true", setMode);
    const requireMode = recoverUnavailablePlanMode.indexOf("!recovery.modeConfirmed");
    const requireSettlement = recoverUnavailablePlanMode.indexOf("!recovery.turnSettled", requireMode);
    const lower = recoverUnavailablePlanMode.indexOf("this.setPlanActive(session, false)", requireSettlement);
    expect(raise).toBeGreaterThan(-1);
    expect(cancel).toBeGreaterThan(raise);
    expect(setMode).toBeGreaterThan(raise);
    expect(modeConfirmed).toBeGreaterThan(setMode);
    expect(requireMode).toBeGreaterThan(modeConfirmed);
    expect(requireSettlement).toBeGreaterThan(requireMode);
    expect(lower).toBeGreaterThan(requireSettlement);
    expect(recoverUnavailablePlanMode).toContain("planModeRecoveryAttempt");
    expect(handleSend).toContain("this.settleUnavailablePlanTurn(session, client, gen)");
  });

  it("tells the user the gate stays raised when returning to Agent fails", () => {
    expect(recoverUnavailablePlanMode).toContain("write and terminal actions remain blocked until the planning turn stops and Agent mode is confirmed");
    expect(recoverUnavailablePlanMode).toContain("Write and terminal actions remain blocked for safety");
    expect(recoverUnavailablePlanMode).toContain("Update Grok Build or start a new session");
    expect(recoverUnavailablePlanMode).toContain("Could not finish leaving unavailable Plan mode promptly");
  });

  it("rejects unavailable exit-plan requests without exposing the native verdict card", () => {
    const availability = exitPlanListener.indexOf("if (!session.planModeAvailable)");
    const reject = exitPlanListener.indexOf("this.recoverUnavailablePlanMode(session, client, gen, req.id)");
    const post = exitPlanListener.indexOf("this.postExitPlanRequest(req, session, gen)");
    expect(availability).toBeGreaterThan(-1);
    expect(reject).toBeGreaterThan(availability);
    expect(post).toBeGreaterThan(reject);
    expect(recoverUnavailablePlanMode).toContain("client.respondExitPlanUnavailable(exitPlanRequestId)");
  });

  it("does not lower a restored unavailable Plan session before Agent is confirmed", () => {
    expect(restorePlanState).toContain("const unavailablePlan = !session.planModeAvailable");
    expect(restorePlanState).toContain('client.currentModeId === "plan"');
    expect(restorePlanState).toContain("this.recoverUnavailablePlanMode(session, client, gen)");
  });
});
