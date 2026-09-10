import { describe, expect, it } from "vitest";
import { normalizeCodexPermissionParams, normalizeCodexUpdate } from "../src/codex-backend";
// The entry guard makes this import pure: npm test never starts a real CLI.
// @ts-expect-error Standalone release script intentionally has no declaration file.
import { approvalOption, bounded, checkPermission, checkTools, timeoutMs } from "../scripts/acp-smoke.mjs";

describe("ACP smoke evidence checks (no adapter or model)", () => {
  const permission = {
    sessionId: "s",
    toolCall: { toolCallId: "t", kind: "execute", rawInput: { command: "write scratch" } },
    options: [
      { optionId: "policy", name: "Always", kind: "allow_always" },
      { optionId: "once", name: "Once", kind: "allow_once" },
    ],
    _meta: { provider: "retained" },
  };
  const start = { sessionUpdate: "tool_call", toolCallId: "t", title: "Read", kind: "read", rawInput: { path: "read-me.txt" } };
  const end = { sessionUpdate: "tool_call_update", toolCallId: "t", status: "completed", rawOutput: { formatted_output: "arbitrary content" } };

  it("prefers one-time approval and handles missing/malformed options without hanging", () => {
    expect(approvalOption(permission).optionId).toBe("once");
    expect(approvalOption({ options: [permission.options[0]] }).optionId).toBe("policy");
    expect(approvalOption({ options: [null, { kind: "allow_once" }] })).toBeUndefined();
    expect(approvalOption({})).toBeUndefined();
  });

  it("accepts real normalization and rejects loss of selected option, metadata or identity", () => {
    const normalized = normalizeCodexPermissionParams(permission);
    expect(() => checkPermission(permission, normalized, "s", "once")).not.toThrow();
    for (const changed of [
      { ...normalized, options: [] },
      { ...normalized, _meta: undefined },
      { ...normalized, sessionId: "other" },
      { ...normalized, toolCall: { ...normalized.toolCall, toolCallId: undefined } },
    ]) expect(() => checkPermission(permission, changed, "s", "once")).toThrow();
  });

  it("requires connected tool frames for the requested read, independent of output wording", () => {
    expect(checkTools([start, end], normalizeCodexUpdate, "read-me.txt")).toContain("1 completed");
    expect(() => checkTools([start, end], normalizeCodexUpdate, "different.txt")).toThrow(/requested file/);
    expect(() => checkTools([end], normalizeCodexUpdate)).toThrow(/preceding tool_call/);
    expect(() => checkTools([start], normalizeCodexUpdate)).toThrow(/no tool_call_update/);
    expect(() => checkTools([start, { ...end, status: "failed" }], normalizeCodexUpdate)).toThrow(/no completed/);
    expect(() => checkTools([start, end], (update: unknown) => ({ update }))).toThrow(/formatted_output/);
  });

  it("rejects disabled/infinite timers and names a missing response", async () => {
    expect(timeoutMs(undefined, 50)).toBe(50);
    for (const value of ["0", "-1", "NaN", "Infinity", "0.1", "2147483648"]) {
      expect(() => timeoutMs(value, 50)).toThrow(/invalid timeout/);
    }
    await expect(bounded(Promise.resolve("ok"), "initialize", 50)).resolves.toBe("ok");
    await expect(bounded(Promise.reject(new Error("EPIPE")), "stdin", 50)).rejects.toThrow("EPIPE");
    await expect(bounded(new Promise(() => {}), "session/load replay", 5)).rejects.toThrow("session/load replay never arrived within 5ms");
  });
});
