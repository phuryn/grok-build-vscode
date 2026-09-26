import { describe, expect, it, vi } from "vitest";
import { Approvals, permissionOptions } from "../adapters/muse/approvals.mts";

const once = { choiceId: "minted_17", label: "Allow", scope: "once", decision: "approved" };
const session = { choiceId: "minted_29", label: "Allow this session", scope: "session", decision: "approvedForSession" };
const persistent = { choiceId: "minted_31", label: "Save rule", scope: "localPersistent", decision: "approvedPolicyAmendment" };
const deny = { choiceId: "minted_44", label: "Deny", scope: "once", decision: "denied" };
const request = { sessionId: "session", approvalId: "approval", toolCallId: "call", toolName: "bash",
  currentRequirementId: { approvalId: "approval", sourceIndex: 0 }, availableChoices: [once, session, persistent, deny] };

describe("Muse permission correlation", () => {
  it.each([
    ['{"command":"echo example"}', { command: "echo example" }, "echo example"],
    ['{"cmd":"echo alias"}', { cmd: "echo alias" }, "echo alias"],
    ['{"path":"example.txt"}', { path: "example.txt" }, "bash"],
    ['{"command":42}', { command: 42 }, "bash"],
    ['{"command":""}', { command: "" }, "bash"],
    [undefined, undefined, "bash"], ["{invalid", undefined, "bash"], ["null", undefined, "bash"],
    ["[]", undefined, "bash"], ['"not an object"', undefined, "bash"],
  ])("shows the parsed approval arguments without inventing a command for %s", (rawArgs, rawInput, title) => {
    const ask = vi.fn((_params: any) => new Promise<any>(() => {}));
    new Approvals(ask, vi.fn(), vi.fn(), vi.fn()).accept("approval/requested", { ...request, rawArgs });
    expect(ask.mock.calls[0][0].toolCall).toEqual({ toolCallId: "call", title, kind: "execute", status: "pending", rawInput });
  });

  it("preserves offered ids and does not advertise a session grant as persistent", () => {
    expect(permissionOptions(request.availableChoices)).toEqual([
      { optionId: once.choiceId, name: "Allow (once)", kind: "allow_once", _meta: { scope: "once" } },
      { optionId: session.choiceId, name: "Allow this session (session)", kind: "allow_once", _meta: { scope: "session" } },
      { optionId: persistent.choiceId, name: "Save rule (localPersistent)", kind: "allow_always", _meta: { scope: "localPersistent" } },
      { optionId: deny.choiceId, name: "Deny (once)", kind: "reject_once", _meta: { scope: "once" } },
    ]);
  });

  it("decides each requirement once, including a requirement delivered through approval/updated", async () => {
    const ask = vi.fn().mockResolvedValue({ outcome: { outcome: "selected", optionId: session.choiceId } });
    const decide = vi.fn().mockResolvedValue({});
    const fail = vi.fn();
    const approvals = new Approvals(ask, decide, vi.fn(), fail);
    approvals.accept("approval/requested", request);
    approvals.accept("approval/requested", request);
    await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    expect(decide).toHaveBeenLastCalledWith({ sessionId: "session", approvalId: "approval",
      requirementId: request.currentRequirementId, choiceId: session.choiceId });
    approvals.accept("approval/updated", { ...request, currentRequirementId: { approvalId: "approval", sourceIndex: 1 } });
    await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(2));
    expect(fail).not.toHaveBeenCalled();
  });

  it("rejects fabricated choices and uses an offered denial on ACP cancellation", async () => {
    const decide = vi.fn(), fail = vi.fn();
    const invalid = new Approvals(async () => ({ outcome: { outcome: "selected", optionId: "allow_once" } }), decide, vi.fn(), fail);
    invalid.accept("approval/requested", request);
    await vi.waitFor(() => expect(fail).toHaveBeenCalled());
    expect(decide).not.toHaveBeenCalled();
    const cancelled = new Approvals(async () => ({ outcome: { outcome: "cancelled" } }), decide, vi.fn(), fail);
    cancelled.accept("approval/requested", request);
    await vi.waitFor(() => expect(decide).toHaveBeenCalledWith(expect.objectContaining({ choiceId: deny.choiceId })));
  });

  it("discards a late client answer after Muse resolves the approval", async () => {
    let answer!: (value: any) => void;
    const ask = vi.fn(() => new Promise<any>(resolve => { answer = resolve; }));
    const decide = vi.fn();
    const approvals = new Approvals(ask, decide, vi.fn(), vi.fn());
    approvals.accept("approval/requested", request);
    await vi.waitFor(() => expect(ask).toHaveBeenCalled());
    approvals.accept("approval/resolved", request);
    answer({ outcome: { outcome: "selected", optionId: once.choiceId } });
    await new Promise(resolve => setImmediate(resolve));
    expect(decide).not.toHaveBeenCalled();
  });
});


it("echoes an explicit rejection and surfaces a server refusal", async () => {
  const decide = vi.fn(async () => { throw new Error("approvalRequirementStale"); });
  const fail = vi.fn();
  const approvals = new Approvals(async () => ({ outcome: { outcome: "selected", optionId: deny.choiceId } }), decide, vi.fn(), fail);
  approvals.accept("approval/requested", request);
  await vi.waitFor(() => expect(fail).toHaveBeenCalled());
  expect(decide).toHaveBeenCalledWith(expect.objectContaining({ choiceId: deny.choiceId }));
});
