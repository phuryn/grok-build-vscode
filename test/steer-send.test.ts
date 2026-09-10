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
import { AcpClient } from "../src/acp";
import type { AcpBackend } from "../src/acp-backend";
import { grokBackend } from "../src/grok-backend";
import { CodexBackend } from "../src/codex-backend";
import { ClaudeBackend } from "../src/claude-backend";

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
  // Steer only exists mid-turn, and the host reads that off the token.
  session.turnToken = {};
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

  function attachBackend(sidebar: any, backend: AcpBackend, supported = true, verified = true) {
    const options = { grokVersion: "1.0.5", grokVersionVerified: verified };
    const client = new AcpClient({ cliPath: "x", cwd: "/", log: () => {}, backend, ...options });
    client.sessionId = "s1";
    (client as any).steering = backend.steeringCapabilities({ _meta: { steering: { supported } } }, options);
    const request = vi.fn(async (_method: string, _params: any, onQueued?: () => void) => { onQueued?.(); return {}; });
    (client as any).request = request;
    const session: Session = sidebar.focused;
    session.client = client;
    session.provider = backend.provider;
    session.activeSessionId = "s1";
    session.turnToken = {};
    return { session, request, client };
  }

  it.each([grokBackend, new CodexBackend()])("carries actual backend image support through the host (%s)", async (backend) => {
    const sidebar = makeSidebar();
    const { session, request } = attachBackend(sidebar, backend);
    const chip = makeImageChip(stagingPng(), 1, "image/png");
    session.chips = [chip];
    await sidebar.steerSend("look at this", session, undefined, [chip]);
    expect(request).toHaveBeenCalledTimes(1);
    const [method, params] = request.mock.calls[0];
    expect(method).toBe(backend.provider === "grok" ? "_x.ai/interject" : "_session/steering");
    const blocks = backend.provider === "grok" ? params.content : params.prompt;
    expect(blocks).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("[Image #1]") }),
      { type: "image", mimeType: "image/png", data: PNG.toString("base64") },
    ]);
    expect(session.queuedSends).toEqual([]);
    expect(session.interjectionCount).toBe(1);
    expect(sidebar.posted.filter((m: HostMsg) => m.type === "userMessage")).toEqual([
      expect.objectContaining({ text: "look at this", steer: true }),
    ]);
    expect(sidebar.posted.some((m: HostMsg) => m.type === "agentStart")).toBe(false);
  });

  it.each([grokBackend, new CodexBackend(), new ClaudeBackend()])(
    "queues images intact without dispatching to an incapable backend (%s)", async (backend) => {
      const sidebar = makeSidebar();
      const { session, request } = attachBackend(sidebar, backend, false, false);
      const chip = makeImageChip(stagingPng(), 1, "image/png");
      session.queuedSends = enqueueQueuedSend([], "keep text and pixels", [chip]);
      await sidebar.steerSend("keep text and pixels", session, undefined, [chip], true);
      expect(request).not.toHaveBeenCalled();
      expect(session.queuedSends).toEqual([{ text: "keep text and pixels", chips: [expect.objectContaining({ id: chip.id })] }]);
      expect(session.interjectionCount).toBe(0);
    },
  );

  it.each([new CodexBackend(), new ClaudeBackend()])("queues text on an advertised capability gap (%s)", async (backend) => {
    const sidebar = makeSidebar();
    const { session, request } = attachBackend(sidebar, backend, false);
    await sidebar.steerSend("keep my correction", session);
    expect(request).not.toHaveBeenCalled();
    expect(session.queuedSends).toEqual([{ text: "keep my correction", chips: [] }]);
    expect(session.interjectionCount).toBe(0);
    expect(sidebar.posted.some((m: HostMsg) => m.type === "steerUnavailable")).toBe(true);
  });

  it.each([grokBackend, new CodexBackend()])("queues text and images on method-not-found (%s)", async (backend) => {
    const sidebar = makeSidebar();
    const { session, request } = attachBackend(sidebar, backend);
    request.mockRejectedValueOnce({ code: -32601, message: "Method not found" });
    const chip = makeImageChip(stagingPng(), 1, "image/png");
    session.queuedSends = enqueueQueuedSend([], "keep both", [chip]);
    await sidebar.steerSend("keep both", session, undefined, [chip], true);
    expect(session.queuedSends).toEqual([{ text: "keep both", chips: [expect.objectContaining({ id: chip.id })] }]);
    expect(session.interjectionCount).toBe(0);
    expect(sidebar.posted.some((m: HostMsg) => m.type === "steerUnavailable")).toBe(true);
    // Grok’s method is unadvertised, so -32601 means an old CLI and the warning
    // owes the user the thing that fixes it. Codex advertises its capability, so
    // a gap there is the adapter’s and no update of ours changes it.
    expect(sidebar.reportRequester).toHaveBeenCalledWith(
      undefined,
      "warning",
      backend.provider === "grok"
        ? expect.stringContaining("Update via Settings")
        : expect.not.stringContaining("Update via Settings"),
    );
  });

  it.each([grokBackend, new CodexBackend()])(
    "queues an idle steer instead of starting a turn nobody is watching (%s)", async (backend) => {
      const sidebar = makeSidebar();
      const { session, request } = attachBackend(sidebar, backend);
      // The turn finished while the tap was crossing the relay.
      session.turnToken = undefined;
      const flushed: string[] = [];
      sidebar.maybeFlushQueuedSends = vi.fn(async (s: Session) => {
        flushed.push(...s.queuedSends.map((q) => q.text));
      });
      await sidebar.steerSend("say less", session);
      expect(request).not.toHaveBeenCalled();
      expect(session.queuedSends).toEqual([{ text: "say less", chips: [] }]);
      expect(flushed).toEqual(["say less"]);
      // The capability is fine; latching the button off would be a lie.
      expect(sidebar.posted.some((m: HostMsg) => m.type === "steerUnavailable")).toBe(false);
      // No bubble either: nothing was steered, and the flush paints the send.
      expect(sidebar.posted.some((m: HostMsg) => m.type === "userMessage")).toBe(false);
    },
  );

  it.each([grokBackend, new CodexBackend()])(
    "does not re-meter a queued steer the relay already charged (%s)", async (backend) => {
      const sidebar = makeSidebar();
      const { session, request } = attachBackend(sidebar, backend);
      session.turnToken = undefined;
      session.queuedSends = enqueueQueuedSend([], "one correction", []);
      // `queueSend` set this when the phone queued the block. The relay then
      // metered the `steerSend` that followed, so the text is paid for once.
      session.queuedSendRequiresRelay = true;
      sidebar.maybeFlushQueuedSends = vi.fn(async () => {});
      await sidebar.steerSend("one correction", session, undefined, undefined, true);
      expect(request).not.toHaveBeenCalled();
      expect(session.queuedSends).toEqual([{ text: "one correction", chips: [] }]);
      // The flag is the whole defect: a flush with it standing goes back out as
      // `submitQueuedSend`, which the phone re-sends and the relay bills again.
      expect(session.queuedSendRequiresRelay).toBe(false);
      expect(sidebar.maybeFlushQueuedSends).toHaveBeenCalledTimes(1);
    },
  );

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
