import { readFileSync } from "node:fs";
import * as path from "node:path";
import { expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";

// A remembered Auto accept used to start a new Codex chat with the badge on
// Auto accept while Codex ran in its sandbox with no network (decision 1b,
// option A: start it in full access, as the live picker does).
function hostWith(session: Session) {
  const host: any = Object.create(GrokSidebar.prototype);
  host.focused = session;
  host.postMode = vi.fn();
  return host;
}

function codexSession() {
  const session = new Session();
  session.provider = "codex";
  session.autoApprove = true;
  session.priming = true; // startSession sets this before session/new
  return session;
}

it("switches a new Codex chat to full access", async () => {
  const session = codexSession();
  const host = hostWith(session);
  const client = { setMode: vi.fn(async () => {}) };
  await host.startCodexFullAccess(session, client);
  expect(client.setMode.mock.calls).toEqual([["agent-full-access"]]);
  expect(session.autoApprove).toBe(true);
  expect(host.postMode).not.toHaveBeenCalled();
});

it("turns the gate off and shows Agent when Codex refuses", async () => {
  const session = codexSession();
  const host = hostWith(session);
  const client = { setMode: vi.fn(async () => { throw new Error("not allowed"); }) };
  await host.startCodexFullAccess(session, client);
  expect(session.autoApprove).toBe(false);
  expect(host.postMode).toHaveBeenCalledWith(session);
  expect(GrokSidebar.prototype["displayMode" as keyof GrokSidebar].call(host, session)).toBe("agent");
});

it("runs only for a new Codex chat that starts in a remembered Auto accept", () => {
  const src = readFileSync(path.join(__dirname, "..", "src", "sidebar.ts"), "utf8");
  const call = src.indexOf("await this.startCodexFullAccess(session, client)");
  expect(call).toBeGreaterThan(0);
  const line = src.slice(src.lastIndexOf("\n", call), src.indexOf("\n", call));
  expect(line).toContain("rememberedYolo && session.provider === \"codex\" && gen === session.gen");
  // In the new-session branch, before the composer unlocks: right after session/new.
  const newSession = src.lastIndexOf("await client.newSession(defaultModel || undefined);", call);
  expect(newSession).toBeGreaterThan(0);
  expect(src.slice(newSession, call).split("\n")).toHaveLength(3);
});
