import { describe, expect, it, vi } from "vitest";
import { Session } from "../src/session";
import { GrokSidebar } from "../src/sidebar";

vi.mock("vscode", () => ({ window: {}, commands: { getCommands: () => Promise.resolve([]) } }));

// Hiding a project on desktop closes its side chats, and their Files panels
// with them. Unsaved file edits there are asked about first, as closing the
// chat with × does; nothing is closed when the person keeps them.
function hiding(answer: boolean, opts: { sideChat?: boolean; origin?: "local" | "remote" } = {}) {
  const session = new Session();
  const panel = { visible: true };
  const host = {
    canSwitchWorkspaceFolder: true,
    workspaceRoot: () => "/work/beta",
    showWarningMessage: vi.fn(async () => undefined),
    removeWorkspaceFolder: vi.fn(() => false),
    confirmEditorChatFilesDiscard: vi.fn(async () => answer),
  };
  const sidebar = {
    host,
    sessionsBoundToFolder: () => [session],
    editorChatFor: (s: Session) => opts.sideChat !== false && s === session ? { panel } : undefined,
  };
  const run = () => (GrokSidebar.prototype as unknown as {
    removeProjectFolder(this: unknown, cwd: string, origin: string): Promise<void>;
  }).removeProjectFolder.call(sidebar, "/work/beta", opts.origin ?? "local");
  return { host, panel, run };
}

describe("hiding a project with a side chat open", () => {
  it("keeps the project when the unsaved Files edits are kept", async () => {
    const h = hiding(false);
    await h.run();
    expect(h.host.confirmEditorChatFilesDiscard).toHaveBeenCalledWith([h.panel]);
    expect(h.host.removeWorkspaceFolder).not.toHaveBeenCalled();
  });

  it("hides it once the edits are discarded", async () => {
    const h = hiding(true);
    await h.run();
    expect(h.host.removeWorkspaceFolder).toHaveBeenCalledWith("/work/beta");
  });

  it("does not ask when none of the project's chats is a side chat", async () => {
    const h = hiding(false, { sideChat: false });
    await h.run();
    expect(h.host.confirmEditorChatFilesDiscard).not.toHaveBeenCalled();
    expect(h.host.removeWorkspaceFolder).toHaveBeenCalled();
  });
});
