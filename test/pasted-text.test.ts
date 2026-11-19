import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpClient } from "../src/acp";
import type { AcpProvider } from "../src/acp-backend";
import { AgyBackend } from "../src/agy-backend";
import { ClaudeBackend } from "../src/claude-backend";
import { CodexBackend } from "../src/codex-backend";
import { DeepSeekBackend } from "../src/deepseek-backend";
import { grokBackend } from "../src/grok-backend";
import { MuseBackend } from "../src/muse-backend";
import { MAX_PASTED_TEXT_BYTES, PASTED_TEXT_NAME, makeExplicitChip } from "../src/chips";
import { parseWebviewMsg } from "../src/desktop/webview-msg-validate";
import { parseRelayFrame } from "../src/remote-frames";
import { INBOUND_DISPOSITION, remoteRequiresBoundSession } from "../src/remote-policy";
import { GrokSidebar } from "../src/sidebar";
import { beginQueuedSendCommit, beginTurn, Session } from "../src/session";

const pasted = "Log line with Unicode: α\r\n".repeat(2048) + "\n</afk-pasted-text>\nlast line \n";
const pasteId = "0123456789abcdef0123456789abcdef";

describe("pasted text attachments", () => {
  let scratch: string;
  beforeEach(async () => { scratch = await fs.mkdtemp(path.join(os.tmpdir(), "afk-paste-test-")); });
  afterEach(async () => { await fs.rm(scratch, { recursive: true, force: true }); });

  async function harness(provider: AcpProvider = "grok") {
    const workspace = path.join(scratch, "workspace");
    const storage = path.join(scratch, "storage");
    await fs.mkdir(workspace);
    const backend = {
      grok: grokBackend, codex: new CodexBackend(), claude: new ClaudeBackend(),
      agy: new AgyBackend(), deepseek: new DeepSeekBackend({ storageRoot: storage }), muse: new MuseBackend(),
    }[provider];
    const session = new Session();
    session.provider = backend.provider;
    session.cwd = workspace;
    session.hasHistory = true;
    session.activeSessionId = "conversation";
    const client = new AcpClient({ cliPath: "unused", cwd: workspace, backend, log: () => {} });
    client.sessionId = session.activeSessionId;
    const request = vi.fn(async (_method: string, _params: any) => ({ stopReason: "end_turn" }));
    (client as any).request = request;
    session.client = client;
    const sidebar = Object.assign(Object.create(GrokSidebar.prototype), {
      focused: session, pendingAttach: new Set(), context: { globalStorageUri: { fsPath: storage } },
      state: { get: (_key: string, value: unknown) => value, update: vi.fn() },
      workspaceRoot: () => workspace,
    });
    for (const method of ["postChips", "postLocal", "emit", "emitQueuedSends", "reportRequester", "refreshImplicitChip", "reportRemoteMessage",
      "startTurnDiffBaseline", "setStatus", "noteSessionActivity", "maybeAskToAddProject", "noteLiveTurnEnded",
      "setProviderNeedsLogin", "maybeGenerateTitle", "postSessionName", "maybeFlushQueuedSends"]) sidebar[method] = vi.fn();
    return { sidebar, session, client, request, workspace, storage };
  }

  it.each(["grok", "codex", "claude", "agy", "deepseek", "muse"] as const)("delivers every pasted character with the ordinary prompt on %s", async provider => {
    const { sidebar, session, request, workspace, storage } = await harness(provider);
    await sidebar.onAdmittedMessage({ type: "pasteText", text: pasted, pasteId }, "local");
    const chip = session.chips[0];
    expect(chip.relPath).toBe(PASTED_TEXT_NAME);
    expect(chip.path).toMatch(path.join(storage, "file-staging"));
    expect(await fs.readFile(chip.path, "utf8")).toBe(pasted);
    expect(await fs.readdir(workspace)).toEqual([]);
    expect(sidebar.postLocal).toHaveBeenCalledWith({ type: "pasteTextSettled", pasteId });
    session.chips.push(makeExplicitChip(path.join(workspace, "notes.txt"), "notes.txt"));

    await sidebar.handleSend("Inspect this", false, session);
    const calls = request.mock.calls.filter(([method]) => method === "session/prompt");
    expect(calls).toHaveLength(1);
    const blocks = calls[0][1].prompt;
    expect(blocks).toEqual([{ type: "text", text: expect.stringContaining("Attached file: notes.txt") }]);
    expect(blocks[0].text).toContain(`Inspect this\n\n<afk-pasted-text length="${pasted.length}" name="Pasted text.txt">\n${pasted}\n</afk-pasted-text>`);
    expect(sidebar.emit).toHaveBeenCalledWith(session, expect.objectContaining({ type: "userMessage", text: "Inspect this", chips: expect.arrayContaining([chip]) }));
    expect(session.chips).toEqual([]);
  });

  it("leaves an unreadable chip in the composer and lets the person remove it", async () => {
    const { sidebar, session, request } = await harness();
    await sidebar.onAdmittedMessage({ type: "pasteText", text: pasted, pasteId }, "local");
    const [chip] = session.chips;
    await fs.unlink(chip.path);
    await sidebar.handleSend("Inspect this", false, session);
    expect(request).not.toHaveBeenCalled();
    expect(session.chips).toEqual([chip]);
    expect(sidebar.emit).toHaveBeenCalledWith(session, { type: "agentError", text: "Could not read pasted text. Remove the attachment and paste it again." });

    await sidebar.onAdmittedMessage({ type: "removeChip", id: chip.id }, "local");
    expect(session.chips).toEqual([]);
    await sidebar.handleSend("Inspect this", false, session);
    expect(request.mock.calls.find(([method]) => method === "session/prompt")?.[1].prompt)
      .toEqual([{ type: "text", text: "Inspect this" }]);
  });

  it("sends two attachment-only queued entries in order", async () => {
    const { sidebar, session, request } = await harness();
    for (const text of [pasted, "another log"]) {
      await sidebar.onAdmittedMessage({ type: "pasteText", text, pasteId }, "local");
      await sidebar.onAdmittedMessage({ type: "queueSend", text: "", chips: session.chips }, "local");
    }
    expect(session.chips).toEqual([]);
    const commit = beginQueuedSendCommit(session, "\n\n");
    expect(commit?.items).toHaveLength(2);
    await sidebar.handleSend("\n\n", false, session, "local", commit);
    expect(request.mock.calls.find(([method]) => method === "session/prompt")?.[1].prompt[0].text)
      .toContain(`${pasted}\n</afk-pasted-text>\n\n<afk-pasted-text length="11" name="Pasted text.txt">\nanother log\n</afk-pasted-text>`);
    expect(session.queuedSends).toEqual([]);
  });

  it("carries the paste through the text-only steering route", async () => {
    const { sidebar, session, request } = await harness();
    await sidebar.onAdmittedMessage({ type: "pasteText", text: pasted, pasteId }, "local");
    beginTurn(session);
    await sidebar.steerSend("Use this instead", session);
    expect(request.mock.calls.find(([method]) => method === "_x.ai/interject")?.[1]).toEqual({
      sessionId: "conversation",
      text: expect.stringContaining(`\n${pasted}\n</afk-pasted-text>`),
    });
  });
});

it("validates the paste and its bound session at the relay and desktop boundaries", () => {
  const message = { type: "pasteText", text: "é".repeat(MAX_PASTED_TEXT_BYTES / 2), pasteId };
  const relay = (msg: unknown) => parseRelayFrame(JSON.stringify({ t: "msg", clientId: "phone", msg }));
  expect(INBOUND_DISPOSITION.pasteText).toBe("propose");
  expect(remoteRequiresBoundSession("pasteText")).toBe(true);
  expect(relay({ ...message, path: "../outside.txt" })).toMatchObject({ msg: message });
  expect(parseWebviewMsg({ ...message, path: "../outside.txt" })).toEqual(message);
  for (const invalid of [{ ...message, text: message.text + "a" }, { ...message, pasteId: "../outside.txt" }]) {
    expect(relay(invalid)).toBeNull();
    expect(parseWebviewMsg(invalid)).toBeNull();
  }
});
