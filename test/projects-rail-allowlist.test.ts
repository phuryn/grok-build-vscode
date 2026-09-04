/**
 * The VS Code projects rail renders the SAME clone form as the chat, so every
 * message that form can send has to be on the rail's allowlist.
 *
 * `onProjectsRailMessage` drops anything not listed, with only a log line — so
 * an omission is silent by construction. Two were missing: pasting a GitHub
 * token cleared the field and left GitHub disconnected with no error, and
 * Cancel left the device login running for its full 15-minute timeout.
 *
 * This asserts the allowlist by driving the real handler, because the set
 * itself is private and a test that restated it would just be the same list
 * written twice.
 */
import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";

function makeSidebar() {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  const delivered: unknown[] = [];
  sidebar.host = { appendLine: vi.fn() };
  sidebar.onMessage = vi.fn(async (msg: unknown) => { delivered.push(msg); });
  sidebar.focused = { activeSessionId: "" };
  return { sidebar, delivered };
}

const reaches = async (msg: Record<string, unknown>) => {
  const { sidebar, delivered } = makeSidebar();
  await sidebar.onProjectsRailMessage(msg);
  return delivered.length === 1;
};

describe("projects rail allowlist", () => {
  it("passes a pasted GitHub token through to the host", async () => {
    expect(await reaches({ type: "githubLoginWithToken", token: "github_pat_x" })).toBe(true);
  });

  it("passes a device-login cancel through to the host", async () => {
    expect(await reaches({ type: "cancelDeviceLogin", provider: "github" })).toBe(true);
  });

  it("still passes the rest of the clone form", async () => {
    expect(await reaches({ type: "setupGithubCli", action: "auth" })).toBe(true);
    expect(await reaches({ type: "listGithubRepos" })).toBe(true);
    expect(await reaches({ type: "cloneProject", url: "https://github.com/o/r" })).toBe(true);
  });

  it("still drops what the rail has no business sending", async () => {
    // The allowlist is the point: it is not an oversight that this is refused,
    // so widening it for the clone form must not have widened it generally.
    const { sidebar, delivered } = makeSidebar();
    await sidebar.onProjectsRailMessage({ type: "send", text: "hello" } as never);
    expect(delivered).toEqual([]);
    expect(sidebar.host.appendLine).toHaveBeenCalledWith(expect.stringContaining("ignored send"));
  });
});
