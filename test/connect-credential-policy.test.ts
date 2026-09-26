import { beforeEach, describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { probeClaudeAuthStatus } from "../src/device-login-run";
import { warmCodexModelCache } from "../src/codex-model-cache";
import { warmClaudeModelCache } from "../src/claude-model-cache";

vi.mock("../src/device-login-run", async original => ({
  ...await original<typeof import("../src/device-login-run")>(), probeClaudeAuthStatus: vi.fn(),
}));
vi.mock("../src/codex-model-cache", () => ({ warmCodexModelCache: vi.fn() }));
vi.mock("../src/claude-model-cache", () => ({ warmClaudeModelCache: vi.fn() }));

function sidebar(provider: string, consent = true): any {
  const s = Object.create(GrokSidebar.prototype) as any;
  s.providerConnectionState = { [provider]: consent };
  s.providerNeedsLogin = { [provider]: true };
  s.locateProvider = vi.fn(() => "/fake/cli");
  s.reprobeProviderCredentials = vi.fn(async () => true);
  s.providerCredentialFilePresent = vi.fn(() => true);
  return s;
}
beforeEach(() => vi.resetAllMocks());

describe("the CLI owns Connect credentials", () => {
  it.each(["grok", "codex", "claude", "muse"])("does not check %s without consent", async provider => {
    const s = sidebar(provider, false);
    expect(await s.deviceLoginCredentialReady(provider, true)).toBe(false);
    expect(s.reprobeProviderCredentials).not.toHaveBeenCalled();
    expect(s.providerCredentialFilePresent).not.toHaveBeenCalled();
    expect(probeClaudeAuthStatus).not.toHaveBeenCalled();
  });

  it.each(["grok", "codex"])("uses %s ACP proof", async provider => {
    const s = sidebar(provider);
    expect(await s.deviceLoginCredentialReady(provider, true)).toBe(true);
    expect(s.reprobeProviderCredentials).toHaveBeenCalledWith(provider, true);
  });

  it.each([true, false, undefined])("uses Claude auth status=%s, falling back only if unknown", async status => {
    const s = sidebar("claude");
    vi.mocked(probeClaudeAuthStatus).mockResolvedValue(status);
    expect(await s.deviceLoginCredentialReady("claude", true)).toBe(status !== false);
    expect(probeClaudeAuthStatus).toHaveBeenCalledWith("/fake/cli", undefined, undefined, s.providerRunSignal("claude"));
    if (status === undefined) expect(s.reprobeProviderCredentials).toHaveBeenCalledWith("claude", true);
    else expect(s.reprobeProviderCredentials).not.toHaveBeenCalled();
  });

  it("does not fall back to ACP after Claude consent was withdrawn", async () => {
    const s = sidebar("claude");
    vi.mocked(probeClaudeAuthStatus).mockImplementation(async () => {
      s.providerRuns.get("claude").abort();
      return undefined;
    });
    expect(await s.deviceLoginCredentialReady("claude", true)).toBe(false);
    expect(s.reprobeProviderCredentials).not.toHaveBeenCalled();
  });

  it.each([true, false])("uses Muse credential file presence=%s without ACP", async present => {
    const s = sidebar("muse");
    s.providerCredentialFilePresent.mockReturnValue(present);
    expect(await s.deviceLoginCredentialReady("muse", true)).toBe(present);
    expect(s.reprobeProviderCredentials).not.toHaveBeenCalled();
  });

  it.each(["codex", "claude"])("does not report healthy %s after an inconclusive Connect probe", async provider => {
    const s = sidebar(provider);
    delete s.reprobeProviderCredentials;
    s.workspaceRoot = () => "/repo";
    s.host = { appendLine: vi.fn() };
    s.setProviderNeedsLogin = vi.fn();
    const warm = provider === "codex" ? warmCodexModelCache : warmClaudeModelCache;
    vi.mocked(warm).mockRejectedValue(new Error("Internal error"));
    expect(await s.reprobeProviderCredentials(provider, true)).toBe(false);
    expect(s.setProviderNeedsLogin).not.toHaveBeenCalledWith(provider, false);
    expect(warm).toHaveBeenCalledWith(expect.objectContaining({ signal: s.providerRunSignal(provider) }));
    // Existing Re-check/remote semantics are retained.
    expect(await s.reprobeProviderCredentials(provider)).toBe(false);
    expect(s.setProviderNeedsLogin).toHaveBeenCalledWith(provider, false);
  });
});
