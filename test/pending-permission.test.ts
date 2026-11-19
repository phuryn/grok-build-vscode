import { describe, expect, it } from "vitest";
import {
  Session,
  createPendingPermission,
  pendingPermissionOptions,
  pickAutoAcceptOption,
  preferredPermissionAllowOption,
  sessionUiSnapshot,
  type PendingPermission,
} from "../src/session";

describe("Auto accept on Claude answers once", () => {
  // The option sets claude-agent-acp builds (dist/permissions/options): its
  // allow_always ids add a "don't ask again" rule to .claude/settings.local.json.
  const webFetch = [
    { optionId: "allow-once", name: "Yes", kind: "allow_once" },
    { optionId: "allow-with-updates", name: "Yes, and don't ask again for example.com", kind: "allow_always" },
    { optionId: "reject", name: "No", kind: "reject_once" },
  ];
  const skill = [
    { optionId: "allow-once", name: "Yes", kind: "allow_once" },
    { optionId: "allow-skill-exact", name: "Yes, and don't ask again for review pr", kind: "allow_always" },
    { optionId: "allow-skill-prefix", name: "Yes, and don't ask again for review:* commands", kind: "allow_always" },
    { optionId: "reject", name: "No", kind: "reject_once" },
  ];

  it("never sends a Claude option that saves a rule", () => {
    expect(pickAutoAcceptOption(webFetch, "claude")?.optionId).toBe("allow-once");
    expect(pickAutoAcceptOption(skill, "claude")?.optionId).toBe("allow-once");
    const pending = createPendingPermission({ title: "Fetch", toolKind: "fetch", options: webFetch });
    expect(preferredPermissionAllowOption(pending, false, "claude")?.kind).toBe("allow_once");
  });

  it("leaves a Claude request with no one-time allow to the person", () => {
    const alwaysOnly = webFetch.filter((option) => option.kind !== "allow_once");
    expect(pickAutoAcceptOption(alwaysOnly, "claude")).toBeUndefined();
  });

  it("keeps each other agent's choice", () => {
    expect(pickAutoAcceptOption(webFetch, "grok")?.kind).toBe("allow_always");
    expect(pickAutoAcceptOption(webFetch, "codex")?.kind).toBe("allow_always");
    expect(pickAutoAcceptOption(webFetch, "agy")?.kind).toBe("allow_once");
    expect(pickAutoAcceptOption(webFetch, "deepseek")?.kind).toBe("allow_once");
    expect(pickAutoAcceptOption(webFetch, "muse")).toBeUndefined();
  });
});

describe("pending permission options", () => {
  const pending: PendingPermission = {
    title: "Run a read-only command",
    toolKind: "execute",
    options: [
      { optionId: "always", kind: "allow_always", name: "Allow always" },
      { optionId: "reject", kind: "reject_once", name: "Reject" },
    ],
    planOptions: [
      { optionId: "reject", kind: "reject_once", name: "Reject" },
    ],
  };

  it("keeps persistent grants unavailable while Plan mode is active", () => {
    expect(pendingPermissionOptions(pending, true)).toEqual([
      { optionId: "reject", kind: "reject_once", name: "Reject" },
    ]);
    expect(preferredPermissionAllowOption(pending, true)).toBeUndefined();
  });

  it("restores the original grant after the user leaves Plan mode", () => {
    expect(pendingPermissionOptions(pending, false)).toEqual(pending.options);
    expect(preferredPermissionAllowOption(pending, false)).toEqual({
      optionId: "always",
      kind: "allow_always",
      name: "Allow always",
    });
  });

  it("snapshots the option set matching the session's current mode", () => {
    const session = new Session();
    session.pendingPermissions.set(7, pending);

    session.planActive = true;
    expect(sessionUiSnapshot(session, "plan")).toContainEqual({
      type: "permissionOptions",
      requestId: 7,
      options: pending.planOptions,
    });

    session.planActive = false;
    expect(sessionUiSnapshot(session, "agent")).toContainEqual({
      type: "permissionOptions",
      requestId: 7,
      options: pending.options,
    });
  });

  it("caches Plan-safe options when the request arrives in Agent mode", () => {
    const session = new Session();
    session.planActive = false;
    const arrivedInAgentMode = createPendingPermission({
      title: "Run a read-only command",
      toolKind: "execute",
      options: [
        { optionId: "always", kind: "allow_always", name: "Allow always" },
        { optionId: "once", kind: "allow_once", name: "Allow once" },
        { optionId: "reject", kind: "reject_once", name: "Reject" },
      ],
    });
    session.pendingPermissions.set(8, arrivedInAgentMode);

    expect(pendingPermissionOptions(arrivedInAgentMode, false).map((option) => option.optionId))
      .toEqual(["always", "once", "reject"]);

    session.planActive = true;
    expect(sessionUiSnapshot(session, "plan")).toContainEqual({
      type: "permissionOptions",
      requestId: 8,
      options: [
        { optionId: "once", kind: "allow_once", name: "Allow once" },
        { optionId: "reject", kind: "reject_once", name: "Reject" },
      ],
    });
  });
});
