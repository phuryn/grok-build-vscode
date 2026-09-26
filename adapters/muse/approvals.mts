import type { PermissionOption, RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { parseToolInput } from "./tool-input.mjs";

interface Choice { choiceId: string; decision: string; scope: string; label: string }
interface Approval {
  sessionId: string;
  approvalId: string;
  currentRequirementId: { approvalId: string; sourceIndex: number };
  availableChoices: Choice[];
  toolCallId?: string;
  toolName?: string;
  rawArgs?: string;
}

export function permissionOptions(choices: Choice[]): PermissionOption[] {
  return choices.flatMap(choice => {
    const allow = ["approved", "approvedForSession", "approvedPolicyAmendment"].includes(choice.decision);
    const deny = ["denied", "deniedPolicyAmendment", "abort", "timedOut"].includes(choice.decision);
    if ((!allow && !deny) || !["once", "session", "localPersistent"].includes(choice.scope)) return [];
    // ACP has no session-scoped kind. Keep the scope in the label and in
    // `_meta.scope`, and preserve Muse's exact choice id. Never advertise a
    // session grant as allow_always — Auto accept reads the scope, not the kind.
    return [{ optionId: choice.choiceId, name: `${choice.label} (${choice.scope})`,
      kind: choice.scope === "localPersistent"
        ? (allow ? "allow_always" : "reject_always")
        : (allow ? "allow_once" : "reject_once"),
      _meta: { scope: choice.scope } }];
  });
}

export class Approvals {
  private readonly current = new Map<string, Approval>();
  private readonly offered = new Set<string>();
  constructor(
    private readonly ask: (params: RequestPermissionRequest) => Promise<RequestPermissionResponse>,
    private readonly decide: (params: Record<string, unknown>) => Promise<unknown>,
    private readonly cancel: () => Promise<void>,
    private readonly fail: (error: unknown) => void,
  ) {}

  clear(): void { this.current.clear(); this.offered.clear(); }

  accept(method: string, params: Record<string, any>): void {
    if (method === "approval/resolved") { this.current.delete(params.approvalId); return; }
    if (method !== "approval/requested" && method !== "approval/updated") return;
    const previous = this.current.get(params.approvalId);
    const request = { ...previous, ...params } as Approval;
    if (!request.currentRequirementId || !Array.isArray(request.availableChoices)) {
      this.fail(new Error("Malformed Muse approval"));
      return;
    }
    const key = JSON.stringify([request.approvalId, request.currentRequirementId, request.availableChoices]);
    if (this.offered.has(key)) return;
    this.current.set(request.approvalId, request);
    this.offered.add(key);
    void this.answer(request).catch(error => {
      if (this.current.get(request.approvalId) === request) this.fail(error);
    });
  }

  private async answer(request: Approval): Promise<void> {
    if (this.current.get(request.approvalId) !== request) return;
    const options = permissionOptions(request.availableChoices);
    if (!options.length) throw new Error("Muse offered no supported permission choices");
    const rawInput = parseToolInput(request.rawArgs);
    const command = [rawInput?.command, rawInput?.cmd].find(value => typeof value === "string" && value.trim());
    // Existing permission renderers display the title, including older clients.
    const title = request.toolName === "bash" && typeof command === "string"
      ? command : request.toolName || "Muse permission";
    const response = await this.ask({ sessionId: request.sessionId, options,
      toolCall: { toolCallId: request.toolCallId || request.approvalId,
        title, kind: request.toolName === "bash" ? "execute" : "other", status: "pending",
        rawInput } });
    if (this.current.get(request.approvalId) !== request) return;
    const outcome = response.outcome;
    const id = outcome.outcome === "selected" ? outcome.optionId
      : request.availableChoices.find(c => c.scope === "once" && ["denied", "abort"].includes(c.decision))?.choiceId;
    if (!id && outcome.outcome === "cancelled") { await this.cancel(); return; }
    if (!options.some(option => option.optionId === id)) throw new Error("ACP selected an unoffered Muse choice");
    await this.decide({ sessionId: request.sessionId, approvalId: request.approvalId,
      requirementId: request.currentRequirementId, choiceId: id });
  }
}
