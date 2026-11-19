import { expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { INTERNAL_PROVIDERS, supportsFork } from "../src/acp-backend";

// Pages from before 4.15.10 offer "Continue in a new chat" on every agent and
// post forkSession. Only Grok's CLI forks, so the host refuses the others in a
// plain sentence instead of failing into "update Grok".
function hostWith(session: Session) {
  const host: any = Object.create(GrokSidebar.prototype);
  host.pool = new Set([session]);
  host.focused = session;
  host.reportRequester = vi.fn();
  host.sessionCwd = () => "/work/repo";
  host.sessionDisplayName = () => "Parent";
  host.host = { appendLine: vi.fn() };
  return host;
}

function startedSession(provider: Session["provider"]) {
  const session = new Session();
  session.provider = provider;
  session.activeSessionId = `${provider}-1`;
  session.hasHistory = true;
  session.client = { forkSession: vi.fn(async () => "unsupported" as const) } as any;
  return session;
}

it("forks on Grok only", () => {
  expect(INTERNAL_PROVIDERS.filter((provider) => supportsFork(provider))).toEqual(["grok"]);
});

it.each(INTERNAL_PROVIDERS.filter((provider) => provider !== "grok"))(
  "refuses a fork on %s without asking the agent",
  async (provider) => {
    const session = startedSession(provider);
    const host = hostWith(session);
    const requester = { clientId: "phone" };
    await host.forkFocusedSession(session, requester);
    expect((session.client as any).forkSession).not.toHaveBeenCalled();
    expect(host.reportRequester).toHaveBeenCalledWith(
      requester,
      "info",
      expect.stringMatching(/^(Codex|Claude|Muse Code|Antigravity|DeepSeek) can't continue a conversation in a new chat yet\.$/),
    );
  },
);

it("still asks Grok's CLI, and names a Grok update only there", async () => {
  const session = startedSession("grok");
  const host = hostWith(session);
  await host.forkFocusedSession(session, undefined);
  expect((session.client as any).forkSession).toHaveBeenCalledWith("/work/repo");
  expect(host.reportRequester).toHaveBeenCalledWith(undefined, "warning", expect.stringContaining("newer Grok Build CLI"));
});
