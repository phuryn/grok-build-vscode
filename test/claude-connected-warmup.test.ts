/**
 * A warm-up failure that is not about credentials must not leave Claude
 * marked needs-login (#146).
 *
 * Codex learned this on 2026-08-17 — "leaving a stale needs-login standing made
 * Codex permanently unusable: it never cleared, so it stayed out of the model
 * picker and out of the connected confirmation, no matter how many times the
 * user signed in". Claude's catch had no equivalent branch, so the flag it set
 * once was the flag it kept.
 *
 * The failures that reach here in practice are precisely the non-credential
 * kind: an EPERM removing a scratch directory, or `session/new` answering
 * "Internal error".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { warmClaudeModelCache } from "../src/claude-model-cache";

const probe = vi.hoisted(() => ({ error: undefined as Error | undefined }));

vi.mock("../src/claude-model-cache", () => ({
  warmClaudeModelCache: vi.fn(async (options: { onModels: (m: unknown[], c?: string) => void }) => {
    if (probe.error) throw probe.error;
    await options.onModels([{ modelId: "claude-opus-5", name: "Opus" }], "claude-opus-5");
  }),
}));

function makeSidebar(): any {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  sidebar.providerNeedsLogin = {};
  sidebar.locateProvider = vi.fn(() => "C:\\Users\\someone\\.local\\bin\\claude.exe");
  sidebar.cacheProviderModels = vi.fn();
  sidebar.adapterHistory = vi.fn(() => ({ at: { clear: vi.fn() } }));
  sidebar.postProviderState = vi.fn();
  sidebar.workspaceRoot = vi.fn(() => "C:\\repo");
  sidebar.host = { appendLine: vi.fn(), workspaceRoot: () => "C:\\repo" };
  return sidebar;
}

beforeEach(() => {
  probe.error = undefined;
  vi.clearAllMocks();
});

describe("claude warm-up and the needs-login flag (#146)", () => {
  it("clears a stale flag when the failure says nothing about credentials", async () => {
    const sidebar = makeSidebar();
    sidebar.providerNeedsLogin = { claude: true };
    probe.error = Object.assign(new Error("EPERM, Permission denied"), { code: "EPERM" });

    await expect(sidebar.warmConnectedClaudeModels()).resolves.toBe(false);

    // The flag must not survive. Left standing, Claude stays out of the model
    // picker and out of the connected confirmation however often you sign in.
    expect(sidebar.providerNeedsLogin.claude).toBe(false);
  });

  it("keeps saying needs-login when the failure IS about credentials", async () => {
    const sidebar = makeSidebar();
    probe.error = new Error("Sign in required");

    await expect(sidebar.warmConnectedClaudeModels()).resolves.toBe(false);
    expect(sidebar.providerNeedsLogin.claude).toBe(true);
  });

  it("caches the models and clears the flag on success", async () => {
    const sidebar = makeSidebar();
    sidebar.providerNeedsLogin = { claude: true };

    await expect(sidebar.warmConnectedClaudeModels()).resolves.toBe(true);
    expect(sidebar.cacheProviderModels).toHaveBeenCalledWith(
      "claude",
      [{ modelId: "claude-opus-5", name: "Opus" }],
      "claude-opus-5",
    );
    expect(sidebar.providerNeedsLogin.claude).toBe(false);
  });

  it("offers the workspace as somewhere to retry", async () => {
    // Without this the scratch-dir refusal has nowhere to fall back to, which
    // is the half of #146 that `Internal error` cycles hit.
    const sidebar = makeSidebar();
    await sidebar.warmConnectedClaudeModels();
    expect(vi.mocked(warmClaudeModelCache).mock.calls[0][0]).toMatchObject({
      fallbackCwd: "C:\\repo",
    });
  });
});
