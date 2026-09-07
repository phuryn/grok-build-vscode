/**
 * Host-side Steer (#52): attachments ride `_x.ai/interject` `content` built
 * by `buildPromptWithImages`. A CLI that would ignore `content` queues the
 * whole item instead of dropping the pixels.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeExplicitChip, makeImageChip, makeImplicitChip } from "../src/chips";
import type { HostMsg } from "../src/protocol";
import { enqueueQueuedSend } from "../src/queued-send";
import { Session } from "../src/session";
import { GrokSidebar } from "../src/sidebar";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function makeSidebar(): any {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  sidebar.focused = new Session();
  sidebar.focused.provider = "grok";
  sidebar.pool = new Set([sidebar.focused]);
  sidebar.pendingAttach = new Set();
  sidebar.posted = [] as HostMsg[];
  sidebar.emit = (_session: Session, message: HostMsg) => {
    sidebar.posted.push(message);
  };
  sidebar.host = {
    appendLine: vi.fn(),
    showWarningMessage: vi.fn(async () => undefined),
    showErrorMessage: vi.fn(async () => undefined),
  };
  sidebar.refreshImplicitChip = vi.fn();
  sidebar.postChips = vi.fn();
  sidebar.retainUploadedFilesForSession = vi.fn(async () => {});
  sidebar.reportRequester = vi.fn();
  return sidebar;
}

function attachClient(sidebar: any, opts?: { honorContent?: boolean; result?: "ok" | "unsupported" }) {
  const calls: Array<{ text: string; content?: unknown }> = [];
  const session: Session = sidebar.focused;
  session.activeSessionId = "s1";
  session.client = {
    sessionId: "s1",
    availableCommands: [],
    honorsInterjectContent: () => opts?.honorContent !== false,
    async interject(text: string, onQueued?: () => void, content?: unknown) {
      onQueued?.();
      calls.push({ text, content });
      return opts?.result ?? "ok";
    },
  };
  return { session, calls };
}

describe("steerSend carries attachments", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) {
      try { require("node:fs").rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    }
    dirs.length = 0;
  });

  function stagingPng(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "steer-img-"));
    dirs.push(dir);
    const file = path.join(dir, "shot.png");
    writeFileSync(file, PNG);
    return file;
  }

  it("interjects image content blocks from a queued attachment", async () => {
    const sidebar = makeSidebar();
    const { session, calls } = attachClient(sidebar, { honorContent: true });
    const chip = makeImageChip(stagingPng(), 1, "image/png");
    session.queuedSends = enqueueQueuedSend([], "look at this", [chip]);

    await sidebar.steerSend("look at this", session, undefined, [chip], true);

    expect(calls).toHaveLength(1);
    expect(calls[0].text).toBe("look at this");
    expect(calls[0].content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("[Image #1]") }),
      expect.objectContaining({
        type: "image",
        mimeType: "image/png",
        data: PNG.toString("base64"),
      }),
    ]);
    expect(session.queuedSends).toEqual([]);
    expect(sidebar.posted.some((m: HostMsg) => m.type === "userMessage" && (m as any).steer)).toBe(true);
    expect(sidebar.posted.find((m: HostMsg) => m.type === "userMessage")).toMatchObject({
      chips: [expect.objectContaining({ id: chip.id })],
    });
  });

  it("omits content on a text-only steer so the legacy wire stays byte-identical", async () => {
    const sidebar = makeSidebar();
    const { session, calls } = attachClient(sidebar);
    session.queuedSends = enqueueQueuedSend([], "just text", []);

    await sidebar.steerSend("just text", session, undefined, undefined, true);

    expect(calls).toEqual([{ text: "just text", content: undefined }]);
  });

  it.each([false, true])("omits ambient selections but keeps explicit steer attachments (queued=%s)", async (queued) => {
    const sidebar = makeSidebar();
    const { session, calls } = attachClient(sidebar);
    const ambient = makeImplicitChip("/ambient.ts", "ambient.ts", 1, 3000);
    const explicit = makeExplicitChip("/attached.ts", "attached.ts");
    session.chips = [ambient, explicit];
    if (queued) {
      session.queuedSends = enqueueQueuedSend([], "first", [explicit]);
      session.queuedSends = enqueueQueuedSend(session.queuedSends, "second", []);
    }

    await sidebar.steerSend("first", session, undefined, [explicit], queued);

    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("Attached file: attached.ts");
    expect(calls[0].text).not.toContain("ambient.ts");
    expect(calls[0].text).toContain("first");
    if (queued) expect(calls[0].text).toContain("second");
    expect(session.chips).toContainEqual(ambient);
  });

  it("queues the whole item when the CLI would ignore content (0.2.x / unverified)", async () => {
    const sidebar = makeSidebar();
    const { session, calls } = attachClient(sidebar, { honorContent: false });
    const chip = makeImageChip(stagingPng(), 1, "image/png");
    session.queuedSends = enqueueQueuedSend([], "look at this", [chip]);

    await sidebar.steerSend("look at this", session, undefined, [chip], true);

    expect(calls).toEqual([]);
    expect(session.queuedSends).toHaveLength(1);
    expect(session.queuedSends[0].chips.map((c) => c.id)).toEqual([chip.id]);
    expect(sidebar.reportRequester).toHaveBeenCalledWith(
      undefined,
      "warning",
      expect.stringMatching(/cannot steer attachments/),
    );
    expect(sidebar.posted.some((m: HostMsg) => m.type === "userMessage")).toBe(false);
    expect(sidebar.posted.some((m: HostMsg) => m.type === "steerUnavailable")).toBe(false);
  });

  it("re-queues chips on -32601 and does not latch unavailable until that path", async () => {
    const sidebar = makeSidebar();
    const { session, calls } = attachClient(sidebar, { honorContent: true, result: "unsupported" });
    const chip = makeImageChip(stagingPng(), 1, "image/png");
    session.queuedSends = enqueueQueuedSend([], "look at this", [chip]);

    await sidebar.steerSend("look at this", session, undefined, [chip], true);

    expect(calls).toHaveLength(1);
    expect(session.queuedSends[0].chips.map((c) => c.id)).toEqual([chip.id]);
    expect(sidebar.posted.some((m: HostMsg) => m.type === "steerUnavailable")).toBe(true);
  });
});
