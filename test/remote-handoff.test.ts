import { describe, expect, it, vi } from "vitest";
import { remoteHandoffUrl, remoteHandoffQr } from "../src/remote-handoff";
import { parseRelayFrame } from "../src/remote-frames";
import { INBOUND_DISPOSITION, OUTBOUND_DISPOSITION, OUTBOUND_PROJECT_AUTH, REMOTE_REQUIRES_BOUND_SESSION, transformHostMsgForRemote, allowFromRemote } from "../src/remote-policy";
import { parseWebviewMsg } from "../src/desktop/webview-msg-validate";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { buildRemoteHandoffEvent } from "../src/telemetry";

describe("phone handoff URL and QR", () => {
  const session = { id: "chat-1", repoCwd: "C:/project", cwd: "C:/project", title: "Chat" };
  it("uses the relay HTTP base and keeps session coordinates in the fragment", () => {
    expect(remoteHandoffUrl("wss://relay.test/base/", "device-1", session))
      .toBe("https://relay.test/base/chat?device=device-1#session=chat-1&repo=C%3A%2Fproject");
  });
  it("escapes device, session and worktree coordinates without conflating cwd and repo", () => {
    const target = { ...session, id: "s&+#/é", repoCwd: "C:/Projects/a & b", cwd: "C:/Trees/a # + ü" };
    const url = new URL(remoteHandoffUrl("ws://localhost:8443", "d&?#é", target)!);
    expect(url.origin).toBe("http://localhost:8443");
    expect([...url.searchParams]).toEqual([["device", "d&?#é"]]);
    expect(Object.fromEntries(new URLSearchParams(url.hash.slice(1))))
      .toEqual({ session: target.id, repo: target.repoCwd, cwd: target.cwd });
  });
  it("never invents a device or an empty conversation", () => {
    expect(remoteHandoffUrl("wss://relay.test", undefined, session)).toBeUndefined();
    expect(remoteHandoffUrl("wss://relay.test", "d")).toBeUndefined();
    expect(remoteHandoffUrl("wss://relay.test", "d", { ...session, id: "" })).toBeUndefined();
  });
  it("encodes a real SVG locally without placing the URL or title in markup", () => {
    const url = remoteHandoffUrl("wss://relay.test", "device-1", session)!;
    const svg = remoteHandoffQr(url);
    expect(svg).toMatch(/^<svg\b/);
    expect(svg).toContain("viewBox=");
    expect(svg).toContain("<path");
    expect(svg).not.toContain("relay.test");
    expect(svg).not.toMatch(/<script|<image|href=/);
    expect(remoteHandoffQr(url + "2")).not.toBe(svg);
  });
});

describe("handoff wire boundaries", () => {
  it("accepts additive self frames and rejects malformed identity and counts", () => {
    expect(parseRelayFrame('{"t":"self","deviceId":"desk-123","token":"ignored"}')).toEqual({ t: "self", deviceId: "desk-123" });
    for (const deviceId of [undefined, null, 7, "", " ", "x".repeat(257)]) {
      expect(parseRelayFrame(JSON.stringify({ t: "self", deviceId }))).toBeNull();
    }
    for (const count of [-1, 1.5, "2", null]) {
      expect(parseRelayFrame(JSON.stringify({ t: "clients", count }))).toBeNull();
    }
  });
  it.each(["remoteHandoff", "showRemoteHandoff"] as const)("keeps %s desk-only in both directions", (type) => {
    expect(INBOUND_DISPOSITION[type]).toBe("host-local");
    expect(REMOTE_REQUIRES_BOUND_SESSION[type]).toBe(false);
    expect(OUTBOUND_DISPOSITION[type]).toBe("host-local");
    expect(OUTBOUND_PROJECT_AUTH[type]).toBe("none");
    for (const tier of ["view", "propose", "full"] as const) {
      expect(allowFromRemote(type, tier)).toBe(false);
      expect(allowFromRemote(type, tier, { isCloud: true })).toBe(false);
    }
    // The outbound filter is what keeps a host-local frame off the relay;
    // mayDeliverRemoteHostMsg only scopes frames that are allowed to cross.
    expect(transformHostMsgForRemote({ type } as any, {} as any)).toBeNull();
  });
  it("validates desktop handoff fields and rejects arbitrary source values", () => {
    const msg = { type: "remoteHandoff", requestId: 1, source: "rail", sessionId: "s", repoCwd: "/repo", action: "open" };
    expect(parseWebviewMsg(msg)).toEqual(msg);
    for (const patch of [{ requestId: "1" }, { requestId: 1.2 }, { source: "/secret/path" }, { sessionId: 7 }, { repoCwd: [] }, { action: "upload" }]) {
      expect(parseWebviewMsg({ ...msg, ...patch })).toBeNull();
    }
    expect(parseWebviewMsg({ type: "showRemoteHandoff", source: "settings", explain: true })).not.toBeNull();
    expect(parseWebviewMsg({ type: "showRemoteHandoff", source: "settings", explain: 1 })).toBeNull();
    expect(parseWebviewMsg({ type: "remoteSignIn", source: "secret" })).toBeNull();
    expect(parseWebviewMsg({ type: "openRemotePortal", source: "secret" })).toBeNull();
  });
});

function hostHarness() {
  const h = Object.create(GrokSidebar.prototype) as any;
  h.focused = new Session();
  h.focused.activeSessionId = "focused";
  h.focused.cwd = "/project";
  h.pool = new Set([h.focused]);
  h.sessionCache = new Map([["other", { entry: { id: "other", cwd: "/tree", displayName: "Other chat" } }]]);
  h.allAdapterCatalogs = () => [];
  h.state = { get: (_: string, fallback: unknown) => fallback, update: vi.fn(async () => {}) };
  h.localRepoCatalogEntries = () => [{ cwd: "/project", available: true }, { cwd: "/second", available: true }];
  h.sessionCwdsForRepo = (cwd: string) => cwd === "/project" ? [cwd, "/tree"] : [cwd];
  h.sessionCwd = (s: Session) => s.cwd;
  h.postLocal = vi.fn();
  h.post = vi.fn();
  h.settingsEditor = { webview: { postMessage: vi.fn() } };
  h.host = { openExternal: vi.fn(), revealChatView: vi.fn(async () => {}) };
  h.relayUrl = () => "wss://relay.test";
  h.readDeviceToken = vi.fn(async () => "token");
  h.reportHandoffEvent = vi.fn();
  h.reportRemotePortalOpened = vi.fn();
  h.uplink = { deviceId: "desk", viewerCount: 2 };
  return h;
}

describe("host handoff routing", () => {
  it.each([false, true])("reports link completion only after approval (approved=%s)", async (approved) => {
    const h = hostHarness();
    h.context = { secrets: { store: vi.fn(async () => {}) } };
    h.installId = () => "install";
    h.host.appName = "Visual Studio Code";
    h.host.withProgress = async (_: unknown, run: any) => run({ isCancellationRequested: false });
    h.host.showInformationMessage = vi.fn();
    h.host.showErrorMessage = vi.fn();
    h.pollLinkApproval = vi.fn(async () => approved ? { token: "token" } : undefined);
    h.maybeStartUplink = vi.fn(async () => {});
    h.uplink.dispose = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ code: "ABCD" }) })));
    try {
      await h.linkRemoteDevice("topbar");
      expect(h.reportHandoffEvent.mock.calls).toEqual([
        ["remote_link_started", { source: "topbar" }],
        ...(approved ? [["remote_link_completed", {}]] : []),
      ]);
      expect(h.context.secrets.store).toHaveBeenCalledTimes(approved ? 1 : 0);
      expect(h.host.showErrorMessage).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
  it("draws the code from the link reply's device id before the uplink names itself", async () => {
    const h = hostHarness();
    h.context = { secrets: { store: vi.fn(async () => {}) } };
    h.installId = () => "install";
    h.host.appName = "Visual Studio Code";
    h.host.withProgress = async (_: unknown, run: any) => run({ isCancellationRequested: false });
    h.host.showInformationMessage = vi.fn();
    h.host.showErrorMessage = vi.fn();
    h.pollLinkApproval = vi.fn(async () => ({ token: "token", deviceId: "linked-desk" }));
    h.maybeStartUplink = vi.fn(async () => { h.uplink = { viewerCount: 0 }; }); // connected, no `self` yet
    h.uplink.dispose = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ code: "ABCD" }) })));
    try {
      await h.linkRemoteDevice("topbar");
      expect(h.post).toHaveBeenLastCalledWith(expect.objectContaining({ type: "remoteStatus", linked: true, handoffReady: true }));
      await h.replyRemoteHandoff({ type: "remoteHandoff", source: "topbar", sessionId: "other", repoCwd: "/project", requestId: 9 });
      expect(h.postLocal.mock.calls.at(-1)[0].url).toContain("/chat?device=linked-desk#");
      h.uplink.deviceId = "relay-named";
      await h.replyRemoteHandoff({ type: "remoteHandoff", source: "topbar", sessionId: "other", repoCwd: "/project", requestId: 10 });
      expect(h.postLocal.mock.calls.at(-1)[0].url).toContain("/chat?device=relay-named#");
    } finally { vi.unstubAllGlobals(); }
  });
  it("keeps the device id with the link, and draws no code while another window holds it", async () => {
    const h = hostHarness();
    h.uplink = { viewerCount: 0 }; // reconnecting: no `self` yet
    h.linkedDeviceId = "remembered";
    h.publishRemoteStatus(true);
    expect(h.post).toHaveBeenLastCalledWith({ type: "remoteStatus", linked: true, handoffReady: true, viewerCount: 0 });
    await h.replyRemoteHandoff({ type: "remoteHandoff", source: "topbar", sessionId: "other", repoCwd: "/project", requestId: 1 });
    expect(h.postLocal.mock.calls.at(-1)[0].url).toContain("/chat?device=remembered#");
    // A refusal inside the grace window: maybe our own stale socket, maybe another window. No code yet.
    h.uplink.refused = true;
    h.publishRemoteStatus(true);
    expect(h.post).toHaveBeenLastCalledWith({ type: "remoteStatus", linked: true, handoffReady: false, viewerCount: 0 });
    h.uplink.heldElsewhere = true;
    h.publishRemoteStatus(true);
    expect(h.post).toHaveBeenLastCalledWith({ type: "remoteStatus", linked: true, handoffReady: false, heldElsewhere: true, viewerCount: 0 });
    await h.replyRemoteHandoff({ type: "remoteHandoff", source: "topbar", sessionId: "other", repoCwd: "/project", requestId: 2 });
    expect(h.postLocal.mock.calls.at(-1)[0]).toMatchObject({ url: undefined, qrSvg: undefined });
    h.rememberRemoteDeviceId("relinked");
    expect(h.state.update).toHaveBeenLastCalledWith("grok.remote.deviceId", "relinked");
  });
  it("resolves a nonfocused worktree row without switching the desk conversation", async () => {
    const h = hostHarness();
    await h.replyRemoteHandoff({ type: "remoteHandoff", source: "projects", sessionId: "other", repoCwd: "/project", requestId: 3 });
    const reply = h.postLocal.mock.calls[0][0];
    expect(reply).toMatchObject({ type: "remoteHandoff", requestId: 3, title: "Other chat", url: "https://relay.test/chat?device=desk#session=other&repo=%2Fproject&cwd=%2Ftree" });
    expect(reply.qrSvg).toContain("<svg");
    expect(h.focused.activeSessionId).toBe("focused");
    expect(h.reportHandoffEvent).toHaveBeenCalledWith("remote_handoff_shown", { source: "projects", linked: true });
    await h.replyRemoteHandoff({ type: "remoteHandoff", source: "projects", sessionId: "other", repoCwd: "/project", requestId: 4, action: "open" });
    expect(h.host.openExternal).toHaveBeenCalledWith(reply.url);
    expect(h.reportRemotePortalOpened).toHaveBeenCalledWith(false, "projects");
  });
  it("does not substitute the focused session for a deleted or wrong-project row", () => {
    const h = hostHarness();
    expect(h.handoffSession("gone", "/project")).toBeUndefined();
    expect(h.handoffSession("other", "/second")).toBeUndefined();
    expect(h.handoffSession("other", "/unknown")).toBeUndefined();
    expect(h.handoffSession()).toMatchObject({ id: "focused", cwd: "/project", repoCwd: "/project" });
  });
  it("answers not-ready for an old relay and opens its hinted portal", async () => {
    const h = hostHarness();
    h.uplink.deviceId = undefined;
    const msg = { type: "remoteHandoff", source: "topbar", requestId: 1 };
    await h.replyRemoteHandoff(msg);
    expect(h.postLocal.mock.calls[0][0]).toMatchObject({ type: "remoteHandoff", url: undefined, qrSvg: undefined });
    await h.replyRemoteHandoff({ ...msg, action: "open" });
    expect(h.host.openExternal).toHaveBeenCalledWith("https://relay.test/?remoteHint=1");
    expect(h.reportRemotePortalOpened).toHaveBeenCalledWith(true, "topbar");
  });
  it("updates the open Settings webview on link, presence and unlink", () => {
    const h = hostHarness();
    h.publishRemoteStatus(true);
    expect(h.settingsEditor.webview.postMessage).toHaveBeenLastCalledWith({ type: "remoteStatus", linked: true, handoffReady: true, viewerCount: 2 });
    h.uplink.viewerCount = 0;
    h.publishRemoteStatus(true);
    expect(h.settingsEditor.webview.postMessage).toHaveBeenLastCalledWith({ type: "remoteStatus", linked: true, handoffReady: true, viewerCount: 0 });
    h.publishRemoteStatus(false);
    expect(h.settingsEditor.webview.postMessage).toHaveBeenLastCalledWith({ type: "remoteStatus", linked: false, handoffReady: false, viewerCount: 0 });
  });
  it("does not let an older secret read undo a completed unlink", async () => {
    const h = hostHarness();
    let answer!: (value: string) => void;
    h.readDeviceToken = () => new Promise<string>((resolve) => { answer = resolve; });
    const oldRead = h.postRemoteStatus();
    h.publishRemoteStatus(false);
    answer("old-token");
    await oldRead;
    expect(h.post).toHaveBeenCalledOnce();
    expect(h.post).toHaveBeenLastCalledWith(expect.objectContaining({ type: "remoteStatus", linked: false }));
  });
  it("keeps a usable link if its coordinates exceed QR capacity", async () => {
    const h = hostHarness();
    const longCwd = "/tree/" + "a".repeat(4000);
    h.sessionCache.get("other").entry.cwd = longCwd;
    h.sessionCwdsForRepo = (cwd: string) => [cwd, longCwd];
    await h.replyRemoteHandoff({ type: "remoteHandoff", source: "rail", sessionId: "other", repoCwd: "/project", requestId: 1 });
    const reply = h.postLocal.mock.calls[0][0];
    expect(reply.url).toContain("#session=other&repo=%2Fproject&cwd=");
    expect(reply.qrSvg).toBeUndefined();
  });
  it.each(["settings", "projects", "palette"])("reveals chat for %s and defers until the renderer is ready", async (source) => {
    const h = hostHarness();
    await h.continueOnPhone(source, "other", "/project");
    expect(h.host.revealChatView).toHaveBeenCalledOnce();
    expect(h.postLocal).not.toHaveBeenCalled();
    expect(h.pendingRemoteHandoff).toMatchObject({ type: "showRemoteHandoff", source, sessionId: "other", repoCwd: "/project" });
    h.chatReadyForHandoff = true;
    await h.continueOnPhone(source, "other", "/project");
    expect(h.postLocal).toHaveBeenCalledWith(expect.objectContaining({ type: "showRemoteHandoff", source, sessionId: "other" }));
    expect(h.pendingRemoteHandoff).toBeUndefined();
  });
});

describe("handoff telemetry", () => {
  const sys = { appVersion: "1", osName: "Windows", osVersion: "10", locale: "en", isDebug: false };
  it.each(["remote_handoff_shown", "remote_link_started", "remote_link_completed"] as const)("%s only carries its disclosed fields", (name) => {
    const props = { installId: "install", hostKind: "desktop", source: "rail", linked: true, url: "https://private", sessionId: "secret", repo: "/private", title: "private" } as any;
    const result = buildRemoteHandoffEvent(name, props, sys, "anonymous-envelope", "now");
    expect(result.props).toEqual({ installId: "install", hostKind: "desktop",
      ...(name !== "remote_link_completed" ? { source: "rail" } : {}),
      ...(name === "remote_handoff_shown" ? { linked: true } : {}) });
    expect(buildRemoteHandoffEvent(name, { ...props, source: "private", linked: "secret" }, sys, "envelope", "now").props)
      .toEqual({ installId: "install", hostKind: "desktop" });
  });
});
