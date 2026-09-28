import { describe, expect, it, vi } from "vitest";
import { AcpClient } from "../src/acp";
import { grokSetupDetail } from "../src/grok-backend";

const phases = {
  auth: "signing in", resolve_workspace: "reading the project", folder_trust: "reading the project",
  git_discovery: "reading the project", plugin_registry: "loading tools and connectors",
  mcp_merge: "loading tools and connectors", tool_overrides: "loading tools and connectors",
  persistence_init: undefined, spawn_session_actor: undefined, model_switch: undefined,
  finalize_response: undefined, response_ready: undefined,
};
describe("Grok startup and title wire", () => {
  it.each(Object.entries(phases))("maps %s to the approved detail", (phase, expected) => {
    expect(grokSetupDetail(phase)).toBe(expected);
  });
  it.each([undefined, null, {}, "future_phase"])("ignores unknown detail %s", (phase) => {
    expect(grokSetupDetail(phase)).toBeUndefined();
  });
  it("reads the measured setup envelope before an id exists and scopes it after binding", async () => {
    const client = new AcpClient({ cliPath: "unused", cwd: process.cwd(), log: () => {} });
    const setup = vi.fn(); client.on("sessionSetup", setup);
    const params = { method: "session/new", phase: "auth", sessionId: null };
    await (client as any).handleServerRequest({ method: "_x.ai/session/setup", params });
    expect(setup).toHaveBeenLastCalledWith(params);
    client.sessionId = "parent";
    await (client as any).handleServerRequest({ method: "_x.ai/session/setup", params: { ...params, sessionId: "child" } });
    expect(setup).toHaveBeenCalledTimes(1);
    await (client as any).handleServerRequest({ method: "_x.ai/session/setup", params: { ...params, method: "session/load", sessionId: "parent" } });
    expect(setup).toHaveBeenCalledTimes(2);
  });
  it("routes the captured session_info_update title and rejects foreign/empty titles", () => {
    const client = new AcpClient({ cliPath: "unused", cwd: process.cwd(), log: () => {} });
    client.sessionId = "01a0e88e-71c5-7dd1-8e7e-48f92654cf8e";
    const title = vi.fn(); client.on("sessionTitle", title);
    const update = { sessionUpdate: "session_info_update", title: "Two-step sequential agent workflow plumbing test" };
    (client as any).handleSessionUpdate(update, undefined, client.sessionId);
    expect(title).toHaveBeenCalledWith(update.title);
    (client as any).handleSessionUpdate({ ...update, title: "Other" }, undefined, "child");
    for (const value of [undefined, null, {}, " "]) (client as any).handleSessionUpdate({ ...update, title: value }, undefined, client.sessionId);
    expect(title).toHaveBeenCalledTimes(1);
  });
});
