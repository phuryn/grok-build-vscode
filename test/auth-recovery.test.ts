import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { beginAuthRecovery, oauthShadowsXaiApiKey } from "../src/auth-recovery";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { promptErrorText } from "../src/acp-dispatch";

describe("session-scoped auth recovery", () => {
  it("reloads the owning pool member instead of the locally focused session", () => {
    const source = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");
    const recovery = source.slice(
      source.indexOf("private async recoverAuthAndResend"),
      source.indexOf("private maybeGenerateTitle"),
    );

    expect(recovery).toContain("this.startSession(resumeId, session)");
    expect(recovery).not.toContain("session !== this.focused");
  });

  it("arms a remote-owned session without requiring it to be locally focused", () => {
    const remote = { activeSessionId: "remote-session", authRecoveryTried: false };

    expect(beginAuthRecovery(remote)).toBe("remote-session");
    expect(remote.authRecoveryTried).toBe(true);
  });

  it("preserves resend-once bookkeeping independently for concurrent sessions", () => {
    const local = { activeSessionId: "local-session", authRecoveryTried: false };
    const remote = { activeSessionId: "remote-session", authRecoveryTried: false };

    expect(beginAuthRecovery(remote)).toBe("remote-session");
    expect(beginAuthRecovery(remote)).toBeUndefined();
    expect(beginAuthRecovery(local)).toBe("local-session");
  });

  it("requires persisted history to reload", () => {
    expect(beginAuthRecovery({ authRecoveryTried: false })).toBeUndefined();
  });
});

function recoverySidebar(error: unknown, provider: "grok" | "claude" | "codex" = "grok") {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  const session = new Session();
  session.provider = provider;
  session.hasHistory = true;
  session.activeSessionId = "own-session";
  const firstPrompt = vi.fn().mockRejectedValue(error);
  const retryPrompt = vi.fn().mockResolvedValue({});
  const client = (prompt: typeof firstPrompt) => ({
    provider, sessionId: session.activeSessionId, availableCommands: [], prompt,
    isCredentialError: (e: unknown) => e === adapterCredential,
  });
  session.client = client(firstPrompt) as any;
  sidebar.focused = session;
  sidebar.pendingAttach = new Set();
  sidebar.host = { appendLine: vi.fn() };
  sidebar.emit = vi.fn();
  sidebar.post = vi.fn();
  sidebar.setStatus = (_session: Session, status: Session["status"]) => { session.status = status; };
  sidebar.startSession = vi.fn(async () => {
    session.gen += 1;
    session.client = client(retryPrompt) as any;
    return session.client;
  });
  for (const name of [
    "waitForSessionStart", "retainUploadedFilesForSession", "refreshImplicitChip",
    "reportRemoteMessage", "noteSessionActivity", "noteLiveTurnEnded", "maybeGenerateTitle",
    "postSessionName", "settleUnavailablePlanTurn", "maybeFlushQueuedSends",
  ]) sidebar[name] = vi.fn();
  sidebar.onboardingForSession = vi.fn(() => ({ provider }));
  return { sidebar, session, firstPrompt, retryPrompt };
}

const adapterCredential = new Error("adapter-specific credential failure");

describe("prompt recovery replay policy (#151)", () => {
  it.each(["grok", "claude", "codex"] as const)("replays a genuine %s credential failure once", async (provider) => {
    const error = provider === "grok" ? { code: -32000, message: "Session expired" } : adapterCredential;
    const { sidebar, session, firstPrompt, retryPrompt } = recoverySidebar(error, provider);
    await sidebar.handleSend("keep going", false, session);
    expect(sidebar.startSession).toHaveBeenCalledWith("own-session", session);
    expect(firstPrompt).toHaveBeenCalledTimes(1);
    expect(retryPrompt).toHaveBeenCalledTimes(1);
    expect(retryPrompt).toHaveBeenCalledWith(firstPrompt.mock.calls[0][0]);
    expect(session.status).toBe("done");
    expect(session.authRecoveryTried).toBe(false);
  });

  it("rebuilds a non-credential 403 without replay and surfaces the original detail", async () => {
    const error = { code: -32603, message: "Internal error", data: "HTTP 403: access denied for this account" };
    const { sidebar, session, firstPrompt, retryPrompt } = recoverySidebar(error);
    await sidebar.handleSend("keep going", false, session);
    expect(sidebar.startSession).toHaveBeenCalledWith("own-session", session);
    expect(firstPrompt).toHaveBeenCalledTimes(1);
    expect(retryPrompt).not.toHaveBeenCalled();
    expect(sidebar.emit).toHaveBeenCalledWith(session, { type: "agentError", text: promptErrorText(error) });
    expect(promptErrorText(error)).toContain(error.data);
    expect(sidebar.post).not.toHaveBeenCalled();
    expect(session.status).toBe("error");
    expect(session.authRecoveryTried).toBe(true);
  });

  it("keeps the original 403 visible even when rebuilding returns no client", async () => {
    const error = new Error("HTTP 403: forbidden");
    const { sidebar, session, retryPrompt } = recoverySidebar(error);
    sidebar.startSession.mockResolvedValue(undefined);
    await sidebar.handleSend("keep going", false, session);
    expect(retryPrompt).not.toHaveBeenCalled();
    expect(sidebar.emit).toHaveBeenCalledWith(session, { type: "agentError", text: promptErrorText(error) });
  });

  it("does not reload a recognized rate limit", async () => {
    const error = { code: -32003, message: "Rate limited" };
    const { sidebar, session, retryPrompt } = recoverySidebar(error);
    await sidebar.handleSend("keep going", false, session);
    expect(sidebar.startSession).not.toHaveBeenCalled();
    expect(retryPrompt).not.toHaveBeenCalled();
    expect(sidebar.emit).toHaveBeenCalledWith(session, { type: "agentError", text: promptErrorText(error) });
  });

  it("does not replay a second credential failure in the same streak", async () => {
    const error = { code: -32000, message: "Session expired" };
    const { sidebar, session, retryPrompt } = recoverySidebar(error);
    retryPrompt.mockRejectedValue(error);
    await sidebar.handleSend("keep going", false, session);
    expect(retryPrompt).toHaveBeenCalledTimes(1);
    expect(sidebar.post).toHaveBeenCalledWith({ type: "onboarding", state: { provider: "grok" } });
    expect(session.authRecoveryTried).toBe(true);
  });
});

describe("OAuth shadow warning condition", () => {
  it("matches cached OAuth plus a configured XAI_API_KEY", () => {
    expect(oauthShadowsXaiApiKey("cached_token", { XAI_API_KEY: "xai-test" })).toBe(true);
  });

  it("does not guess from one side of the condition", () => {
    expect(oauthShadowsXaiApiKey("cached_token", {})).toBe(false);
    expect(oauthShadowsXaiApiKey("api_key", { XAI_API_KEY: "xai-test" })).toBe(false);
    expect(oauthShadowsXaiApiKey(undefined, { XAI_API_KEY: "xai-test" })).toBe(false);
    expect(oauthShadowsXaiApiKey("cached_token", { XAI_API_KEY: "   " })).toBe(false);
  });
});
