import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session, sessionUiSnapshot } from "../src/session";
import { parseWebviewMsg } from "../src/desktop/webview-msg-validate";
import { INBOUND_DISPOSITION, REMOTE_REQUIRES_BOUND_SESSION, OUTBOUND_PROJECT_AUTH } from "../src/remote-policy";

const selection = { sessionId: "s", modelId: "m", generation: 1, sizes: [256000, 500000], available: true, changing: false };
function harness() {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  const session = new Session();
  session.provider = "grok";
  session.client = { provider: "grok", currentModelId: "m", contextWindowSelection: selection, setContextWindow: vi.fn(async () => {}) } as any;
  session.chips = [{ id: "keep", path: "/keep.ts", relPath: "keep.ts", hidden: false, kind: "file" }];
  sidebar.focused = session;
  sidebar.workspaceRoot = () => "/repo";
  sidebar.emit = vi.fn();
  sidebar.handleSend = vi.fn();
  sidebar.switchModel = vi.fn(async () => {});
  sidebar.providerForRequestedModel = () => session.provider;
  sidebar.trackPickerChange = (op: Promise<unknown>) => op;
  return { sidebar, session, send: (msg: unknown) => sidebar.onAdmittedMessage(msg, "local") };
}

describe("context selection host routing", () => {
  it("handles both numeric forms without sending a model prompt or consuming chips", async () => {
    const h = harness();
    await h.send({ type: "send", text: "/context-window 500k" });
    await h.send({ type: "send", text: " /context-window 256000 " });
    expect(h.session.client!.setContextWindow).toHaveBeenNthCalledWith(1, 500000, selection);
    expect(h.session.client!.setContextWindow).toHaveBeenNthCalledWith(2, 256000, selection);
    expect(h.sidebar.handleSend).not.toHaveBeenCalled();
    expect(h.session.chips).toHaveLength(1);
  });
  it("opens the bare command and reports malformed sizes", async () => {
    const h = harness();
    await h.send({ type: "send", text: "/context-window" });
    expect(h.sidebar.emit).toHaveBeenCalledWith(h.session, { type: "contextWindowSelection", selection, openPicker: true });
    await h.send({ type: "send", text: "/context-window 1.5k" });
    expect(h.sidebar.emit.mock.calls.at(-1)[1].type).toBe("error");
    expect(h.session.client!.setContextWindow).not.toHaveBeenCalled();
  });
  it.each(["turn", "startup", "picker"])("refuses a context change during %s", async (busy) => {
    const h = harness();
    if (busy === "turn") h.session.turnToken = {};
    if (busy === "startup") h.session.priming = true;
    if (busy === "picker") h.sidebar.pickerChange = Promise.resolve();
    await h.send({ type: "setContextWindow", ...selection, size: 500000 });
    expect(h.session.client!.setContextWindow).not.toHaveBeenCalled();
    expect(h.sidebar.emit.mock.calls.at(-1)[1].type).toBe("error");
  });
  it("passes the UI identity to the client and reports a native rejection", async () => {
    const h = harness();
    vi.mocked(h.session.client!.setContextWindow).mockRejectedValueOnce(new Error("older session"));
    const msg = { type: "setContextWindow", sessionId: "old", modelId: "m", generation: 0, size: 500000 };
    await h.send(msg);
    expect(h.session.client!.setContextWindow).toHaveBeenCalledWith(500000, msg);
    expect(h.sidebar.emit.mock.calls.at(-1)[1].text).toContain("older session");
  });
  it.each(["codex", "claude", "muse"] as const)("keeps %s model switching during a turn unchanged", async (provider) => {
    const h = harness();
    h.session.provider = provider;
    h.session.turnToken = {};
    await h.send({ type: "setModel", modelId: "other", provider });
    expect(h.sidebar.switchModel).toHaveBeenCalledWith("other", h.session, undefined, provider);
  });
  it("restores confirmed selection in reconnect snapshots", () => {
    const h = harness();
    expect(sessionUiSnapshot(h.session, "agent")).toContainEqual({ type: "contextWindowSelection", selection });
  });
});

describe("context selection transport", () => {
  const msg = { type: "setContextWindow", sessionId: "s", modelId: "m", generation: 2, size: 500000 };
  it("accepts a complete native choice and requires an authorized bound session", () => {
    expect(parseWebviewMsg(msg)).toEqual(msg);
    expect(INBOUND_DISPOSITION.setContextWindow).toBe("propose");
    expect(REMOTE_REQUIRES_BOUND_SESSION.setContextWindow).toBe(true);
    expect(OUTBOUND_PROJECT_AUTH.contextWindowSelection).toBe("scope");
  });
  it.each([{ size: -1 }, { size: 1.5 }, { size: Infinity }, { generation: -1 }, { generation: 0.5 }, { sessionId: "" }, { modelId: undefined }])("rejects malformed IPC %j", (bad) => {
    expect(parseWebviewMsg({ ...msg, ...bad })).toBeNull();
  });
});
