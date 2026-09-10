import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostMsg } from "../src/protocol";
import { pathsEqual } from "../src/worktree";
import { REMOTE_PROTO_VERSION } from "../src/remote-frames";

const wsMock = vi.hoisted(() => {
  const sockets: any[] = [];
  class FakeWebSocket {
    static OPEN = 1;
    readyState = FakeWebSocket.OPEN;
    sent: string[] = [];
    handlers = new Map<string, Array<(...args: any[]) => void>>();
    constructor(public readonly url: string) { sockets.push(this); }
    on(event: string, fn: (...args: any[]) => void) {
      const list = this.handlers.get(event) ?? [];
      list.push(fn);
      this.handlers.set(event, list);
    }
    emit(event: string, ...args: any[]) {
      for (const fn of this.handlers.get(event) ?? []) fn(...args);
    }
    send(raw: string) { this.sent.push(raw); }
    close() {}
  }
  return { FakeWebSocket, sockets };
});

vi.mock("ws", () => ({ default: wsMock.FakeWebSocket }));

import {
  filterAuthorizedOutbound,
  filterRecipientsOwningScope,
  RemoteUplink,
  WORKING_HEARTBEAT_MS,
  type RemoteUplinkAuth,
} from "../src/remote-uplink";

function openAuth(open: string[] = ["/work/open"]): RemoteUplinkAuth {
  return {
    authorizedCwds: () => open,
    scopeCwdForClient: () => open[0],
    sameCwd: pathsEqual,
  };
}

function makeUplink(overrides: Partial<ConstructorParameters<typeof RemoteUplink>[0]> = {}) {
  return new RemoteUplink({
    relayUrl: "ws://relay",
    token: "token",
    snapshot: () => [],
    auth: openAuth(),
    onClientMessage: () => {},
    log: () => {},
    ...overrides,
  });
}

describe("RemoteUplink client identity and targeted sends", () => {
  beforeEach(() => { wsMock.sockets.length = 0; });

  it("logs an outbound frame refused while the uplink is disconnected", () => {
    const logs: string[] = [];
    const uplink = makeUplink({ log: (line) => logs.push(line) });
    uplink.broadcastTo(["tab-a"], {
      type: "repoSessions", cwd: "/work/open", entries: [], dots: {}, total: 0,
    });
    expect(logs).toContain("[remote] could not send repoSessions (uplink is not connected)");
  });

  it("hello is legacy-shaped without client metadata and includes mapped client when supplied", () => {
    const uplink = makeUplink({ deviceName: "Dell (Windows 11)" });
    uplink.start();
    const socket = wsMock.sockets[0];
    socket.emit("open");
    expect(JSON.parse(socket.sent[0])).toEqual({
      t: "hello",
      proto: REMOTE_PROTO_VERSION,
      device: { name: "Dell (Windows 11)" },
    });
    uplink.dispose();

    const withClient = makeUplink({
      deviceName: "Dell (Windows 11)",
      client: {
        platform: "win32",
        release: "10.0.26200",
        appName: "Visual Studio Code",
        isDesktop: false,
      },
    });
    withClient.start();
    const socket2 = wsMock.sockets[1];
    socket2.emit("open");
    expect(JSON.parse(socket2.sent[0])).toEqual({
      t: "hello",
      proto: REMOTE_PROTO_VERSION,
      device: { name: "Dell (Windows 11)" },
      client: {
        clientLabel: "VS Code extension",
        platform: "win",
        osLabel: "Windows 11",
      },
    });
    withClient.dispose();
  });

  it("threads clientId inbound and emits host-to for a cwd group", () => {
    const received: unknown[] = [];
    const ready: Array<{ clientId: string; tabToken?: string }> = [];
    const left: string[] = [];
    const rosters: string[][] = [];
    const uplink = makeUplink({
      snapshot: (clientId) => [{ type: "error", text: `snapshot:${clientId}` }],
      onClientReady: (clientId, tabToken) => ready.push({ clientId, tabToken }),
      onClientLeft: (clientId) => left.push(clientId),
      onClientRoster: (clientIds) => rosters.push(clientIds),
      onClientMessage: (clientId, msg) => received.push({ clientId, msg }),
    });
    uplink.start();
    const socket = wsMock.sockets[0];
    socket.emit("open");

    uplink.broadcastTo(["tab-a", "tab-b"], { type: "error", text: "shared" });
    socket.emit("message", Buffer.from(JSON.stringify({
      t: "msg", clientId: "tab-b", msg: { type: "send", text: "hello" },
    })));
    socket.emit("message", Buffer.from(JSON.stringify({ t: "clients", count: 1 })));
    socket.emit("message", Buffer.from(JSON.stringify({
      t: "client-ready",
      clientId: "tab-a",
      tabToken: "0123456789abcdef01234567",
    })));
    socket.emit("message", Buffer.from(JSON.stringify({ t: "client-left", clientId: "tab-b" })));

    expect(socket.sent.map(JSON.parse)).toContainEqual({
      t: "host-to",
      clientIds: ["tab-a", "tab-b"],
      msg: { type: "error", text: "shared" },
    });
    expect(received).toEqual([{ clientId: "tab-b", msg: { type: "send", text: "hello" } }]);
    expect(ready).toEqual([{ clientId: "tab-a", tabToken: "0123456789abcdef01234567" }]);
    expect(left).toEqual(["tab-b"]);
    expect(rosters).toEqual([["tab-a"]]);
    expect(socket.sent.map(JSON.parse)).toContainEqual({
      t: "snapshot",
      clientId: "tab-a",
      msgs: [{ type: "error", text: "snapshot:tab-a" }],
    });
    uplink.dispose();
  });

  it("rebuilds an authoritative roster after reconnect so outage ghosts can be removed", async () => {
    vi.useFakeTimers();
    const rosters: string[][] = [];
    const uplink = makeUplink({
      onClientRoster: (clientIds) => rosters.push(clientIds),
    });
    uplink.start();
    const first = wsMock.sockets[0];
    first.emit("open");
    first.emit("message", Buffer.from(JSON.stringify({ t: "clients", count: 2 })));
    first.emit("message", Buffer.from(JSON.stringify({ t: "client-ready", clientId: "survivor" })));
    first.emit("message", Buffer.from(JSON.stringify({ t: "client-ready", clientId: "ghost" })));

    first.emit("close", 1006);
    await vi.advanceTimersByTimeAsync(1000);
    const second = wsMock.sockets[1];
    second.emit("open");
    second.emit("message", Buffer.from(JSON.stringify({ t: "clients", count: 1 })));
    second.emit("message", Buffer.from(JSON.stringify({ t: "client-ready", clientId: "survivor" })));

    expect(rosters).toEqual([["survivor", "ghost"], ["survivor"]]);
    uplink.dispose();
    vi.useRealTimers();
  });

  it("surfaces an authoritative 4001 revocation and does not retry it", async () => {
    vi.useFakeTimers();
    const revoked = vi.fn();
    const logs: string[] = [];
    const uplink = makeUplink({
      token: "revoked-token",
      onCredentialRevoked: revoked,
      log: (line) => logs.push(line),
    });
    uplink.start();

    wsMock.sockets[0].emit("close", 4001);
    expect(revoked).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).toContain("AFK Pilot: Link this device");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wsMock.sockets).toHaveLength(1);

    uplink.dispose();
    vi.useRealTimers();
  });

  it("keeps retrying transient 1011 closes", async () => {
    vi.useFakeTimers();
    const revoked = vi.fn();
    const uplink = makeUplink({
      onCredentialRevoked: revoked,
    });
    uplink.start();

    wsMock.sockets[0].emit("close", 1011);
    expect(revoked).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(wsMock.sockets).toHaveLength(2);

    uplink.dispose();
    vi.useRealTimers();
  });

  // A 4002 says the relay is healthy and this device is momentarily held —
  // nearly always by this host's OWN socket, frozen at the relay because the
  // machine suspended without ever sending a FIN. The relay now challenges that
  // incumbent the instant we knock, so the obstacle clears in seconds; waiting
  // a thirty-second backoff for it is what made a returning laptop look dead
  // for a minute. See refusalRetryMs.
  it("waits out a 4002 in seconds rather than earning a thirty-second delay", async () => {
    vi.useFakeTimers();
    const logs: string[] = [];
    const uplink = makeUplink({ log: (line) => logs.push(line) });
    uplink.start();

    wsMock.sockets[0].emit("close", 4002);
    expect(logs.at(-1)).toContain("refused (device still held)");
    await vi.advanceTimersByTimeAsync(2000);
    expect(wsMock.sockets).toHaveLength(2);

    uplink.dispose();
    vi.useRealTimers();
  });

  it("hands a long run of refusals back to ordinary backoff, at the delay it already had", async () => {
    vi.useFakeTimers();
    const logs: string[] = [];
    const uplink = makeUplink({ log: (line) => logs.push(line) });
    uplink.start();

    // Refusals at t = 0, 2s, 4s, 6s, 8s are inside the 10s window; the one at
    // 10s is a rival rather than a corpse — two windows on one desk share an
    // installId, so one of them has to lose slowly.
    for (let i = 0; i < 6; i += 1) {
      wsMock.sockets.at(-1)!.emit("close", 4002);
      await vi.advanceTimersByTimeAsync(2000);
    }

    expect(logs.filter((l) => l.includes("refused (device still held)"))).toHaveLength(5);
    // The short retries must not have grown the backoff on the way past —
    // resetting or inflating it here is the flapping bug connectionWasHealthy
    // was written to prevent.
    expect(logs.at(-1)).toContain("uplink disconnected (code 4002); retrying in 1s");

    uplink.dispose();
    vi.useRealTimers();
  });

  it("starts a fresh window when an ordinary close breaks the run", async () => {
    vi.useFakeTimers();
    const logs: string[] = [];
    const uplink = makeUplink({ log: (line) => logs.push(line) });
    uplink.start();

    wsMock.sockets.at(-1)!.emit("close", 4002);
    await vi.advanceTimersByTimeAsync(2000);
    // Long enough that a window measured from the FIRST refusal would be spent.
    await vi.advanceTimersByTimeAsync(20_000);

    wsMock.sockets.at(-1)!.emit("close", 1011);
    await vi.advanceTimersByTimeAsync(1000);
    wsMock.sockets.at(-1)!.emit("close", 4002);

    expect(logs.filter((l) => l.includes("refused (device still held)"))).toHaveLength(2);

    uplink.dispose();
    vi.useRealTimers();
  });

  it("does not treat a dispose-driven 4001 close as revocation", () => {
    const revoked = vi.fn();
    const uplink = makeUplink({
      onCredentialRevoked: revoked,
    });
    uplink.start();
    const socket = wsMock.sockets[0];

    uplink.dispose();
    socket.emit("close", 4001);

    expect(revoked).not.toHaveBeenCalled();
  });

  it("finishes roster reconciliation when a client leaves during reconnect replay", () => {
    const rosters: string[][] = [];
    const uplink = makeUplink({
      onClientRoster: (clientIds) => rosters.push(clientIds),
    });
    uplink.start();
    const socket = wsMock.sockets[0];
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ t: "clients", count: 2 })));
    socket.emit("message", Buffer.from(JSON.stringify({ t: "client-ready", clientId: "survivor" })));
    socket.emit("message", Buffer.from(JSON.stringify({ t: "client-left", clientId: "departed" })));
    socket.emit("message", Buffer.from(JSON.stringify({ t: "clients", count: 1 })));

    expect(rosters).toEqual([["survivor"]]);
    uplink.dispose();
  });

  it("contains a synchronous client callback failure inside the websocket listener", () => {
    const logs: string[] = [];
    const uplink = makeUplink({
      onClientMessage: () => { throw new Error("bad frame"); },
      log: (line) => logs.push(line),
    });
    uplink.start();
    const socket = wsMock.sockets[0];
    expect(() => socket.emit("message", Buffer.from(JSON.stringify({
      t: "msg", clientId: "tab", msg: { type: "send", text: "hello" },
    })))).not.toThrow();
    expect(logs).toContain("[remote] dropped malformed client message: bad frame");
    uplink.dispose();
  });
});

describe("RemoteUplink socket-level project authorization", () => {
  beforeEach(() => { wsMock.sockets.length = 0; });

  const caps = {
    uploadFile: true,
    remoteVoice: true,
    deleteActiveSession: true,
  };
  const closedChunk: HostMsg = { type: "messageChunk", text: "secret from closed" };
  const deviceOk: HostMsg = { type: "error", text: "ok" };
  const closedRepos: HostMsg = {
    type: "repos",
    entries: [{
      cwd: "/work/closed",
      label: "Closed",
      available: true,
      pinned: false,
      updatedAt: 1,
    }],
    selectedCwd: "/work/closed",
    activeCwd: "/work/closed",
  };
  const openRepos: HostMsg = {
    type: "repos",
    entries: [{
      cwd: "/work/open",
      label: "Open",
      available: true,
      pinned: false,
      updatedAt: 1,
    }],
    selectedCwd: "/work/open",
    activeCwd: "/work/open",
  };
  const closedInitial: HostMsg = {
    type: "initialState",
    effort: "",
    cwd: "/work/closed",
    useCtrlEnter: false,
    extVersion: "0",
    showThinking: false,
    expandCommandOutputs: false,
    steerByDefault: false,
    soundNotifications: false,
    processingSound: false,
    readRepliesAloud: false,
    capabilities: caps,
  };
  const unboundInitial: HostMsg = {
    type: "initialState",
    effort: "",
    cwd: "",
    useCtrlEnter: false,
    extVersion: "0",
    showThinking: false,
    expandCommandOutputs: false,
    steerByDefault: false,
    soundNotifications: false,
    processingSound: false,
    readRepliesAloud: false,
    capabilities: caps,
  };

  it("filterAuthorizedOutbound scrubs closed-project conversation and catalog frames", () => {
    const open = ["/work/open"];
    const voiceCfg: HostMsg = {
      type: "voiceConfigured",
      value: true,
      sendPhrase: "from-closed-project",
    };
    const kept = filterAuthorizedOutbound(
      [
        deviceOk,
        closedChunk,
        closedRepos,
        openRepos,
        closedInitial,
        voiceCfg,
        { type: "clearMessages" },
      ],
      open,
      "/work/closed", // stale session scope
      pathsEqual,
    );
    // voiceConfigured is project-scoped: closed scope must drop it too.
    expect(kept.map((m) => m.type)).toEqual(["error", "repos", "clearMessages"]);
    expect(kept.find((m) => m.type === "repos")).toEqual(openRepos);
    expect(kept.some((m) => m.type === "voiceConfigured")).toBe(false);
  });

  it("mutation: without the filter a closed-project snapshot would leave intact", () => {
    const leaky = [closedChunk, closedRepos, closedInitial];
    // Old path: snapshotFrame(clientId, rawMsgs) with no gate.
    expect(leaky).toHaveLength(3);
    const scrubbed = filterAuthorizedOutbound(leaky, ["/work/open"], "/work/closed", pathsEqual);
    expect(scrubbed).toEqual([]);
  });

  it("refuses broadcastTo of conversation payload under a closed scope", () => {
    const logs: string[] = [];
    const uplink = makeUplink({
      auth: openAuth(["/work/open"]),
      log: (l) => logs.push(l),
    });
    uplink.start();
    const socket = wsMock.sockets[0];
    socket.emit("open");

    uplink.broadcastTo(["tab"], closedChunk, "/work/closed");
    expect(socket.sent.map(JSON.parse).filter((f: { t: string }) => f.t === "host-to")).toEqual([]);
    expect(logs.some((l) => l.includes("dropped messageChunk"))).toBe(true);

    uplink.broadcastTo(["tab"], closedChunk, "/work/open");
    expect(socket.sent.map(JSON.parse)).toContainEqual({
      t: "host-to",
      clientIds: ["tab"],
      msg: closedChunk,
    });
    uplink.dispose();
  });

  it("refuses broadcastTo when a recipient does not own the scope", () => {
    const logs: string[] = [];
    const scopes: Record<string, string> = {
      "tab-a": "/work/a",
      "tab-b": "/work/b",
    };
    const uplink = makeUplink({
      auth: {
        authorizedCwds: () => ["/work/a", "/work/b"],
        scopeCwdForClient: (id) => scopes[id],
        sameCwd: pathsEqual,
      },
      log: (l) => logs.push(l),
    });
    uplink.start();
    const socket = wsMock.sockets[0];
    socket.emit("open");

    // Caller incorrectly includes tab-b under /work/a — ownership filter drops it.
    uplink.broadcastTo(["tab-a", "tab-b"], closedChunk, "/work/a");
    const hostTo = socket.sent.map(JSON.parse).filter((f: { t: string }) => f.t === "host-to");
    expect(hostTo).toEqual([
      {
        t: "host-to",
        clientIds: ["tab-a"],
        msg: closedChunk,
      },
    ]);
    expect(logs.some((l) => l.includes("does not own scope") && l.includes("tab-b"))).toBe(true);

    // No owners at all → no write.
    socket.sent.length = 0;
    uplink.broadcastTo(["tab-b"], closedChunk, "/work/a");
    expect(socket.sent.map(JSON.parse).filter((f: { t: string }) => f.t === "host-to")).toEqual([]);
    uplink.dispose();
  });

  it("delivers a sibling project's rail preview to a tab that does not own it", () => {
    // The regression that put "Update Grok Build to preview" on the phone
    // against a fully current desktop: the rail asks for a preview of a project
    // the tab is NOT working in, the host answered, and the ownership filter
    // ate every answer because the frame's own cwd was passed as the delivery
    // scope. Frames that carry their own cwd are ABOUT a project, not payload
    // FROM the recipient's conversation.
    const logs: string[] = [];
    const preview: HostMsg = {
      type: "repoSessions",
      cwd: "/work/sibling",
      entries: [{ id: "s1", title: "In the other project", cwd: "/work/sibling" } as any],
      dots: {},
      total: 1,
    };
    const uplink = makeUplink({
      auth: {
        // Both projects are open; the tab is working in /work/a.
        authorizedCwds: () => ["/work/a", "/work/sibling"],
        scopeCwdForClient: () => "/work/a",
        sameCwd: pathsEqual,
      },
      log: (l) => logs.push(l),
    });
    uplink.start();
    const socket = wsMock.sockets[0];
    socket.emit("open");

    uplink.broadcastTo(["tab-a"], preview, "/work/sibling");
    expect(socket.sent.map(JSON.parse).filter((f: { t: string }) => f.t === "host-to")).toEqual([
      { t: "host-to", clientIds: ["tab-a"], msg: preview },
    ]);
    expect(logs.some((l) => l.includes("does not own scope"))).toBe(false);

    // Authorization is untouched: a project that is not open is still refused,
    // and the frame's OWN cwd is what decides — not the scope argument.
    socket.sent.length = 0;
    const closedPreview = { ...preview, cwd: "/work/closed", entries: [] } as HostMsg;
    uplink.broadcastTo(["tab-a"], closedPreview, "/work/closed");
    expect(socket.sent.map(JSON.parse).filter((f: { t: string }) => f.t === "host-to")).toEqual([]);
    uplink.dispose();
  });

  it("writes the authorized rows from a mixed repoSessions frame", () => {
    const logs: string[] = [];
    const uplink = makeUplink({
      auth: {
        authorizedCwds: () => ["/work/project"],
        scopeCwdForClient: () => "/work/other",
        sameCwd: pathsEqual,
      },
      log: (line) => logs.push(line),
    });
    uplink.start();
    const socket = wsMock.sockets[0];
    socket.emit("open");

    uplink.broadcastTo(["tab-a"], {
      type: "repoSessions",
      cwd: "/work/project",
      entries: [
        { id: "kept", title: "Kept", cwd: "/work/project" } as any,
        { id: "worktree", title: "Worktree", cwd: "/tmp/worktree" } as any,
      ],
      dots: { kept: "working", worktree: "needs-you" },
      total: 2,
    }, "/work/project");

    const [frame] = socket.sent.map(JSON.parse).filter((item: { t: string }) => item.t === "host-to");
    expect(frame.msg.entries.map((entry: { id: string }) => entry.id)).toEqual(["kept"]);
    expect(frame.msg.dots).toEqual({ kept: "working" });
    expect(frame.msg.total).toBe(1);
    expect(logs.some((line) => line.includes("filtered 1 unauthorized repoSessions entry"))).toBe(true);
    uplink.dispose();
  });

  it("filterRecipientsOwningScope is pure and mutation-checked", () => {
    const auth: RemoteUplinkAuth = {
      authorizedCwds: () => ["/a", "/b"],
      scopeCwdForClient: (id) => (id === "x" ? "/a" : "/b"),
      sameCwd: pathsEqual,
    };
    expect(filterRecipientsOwningScope(["x", "y"], "/a", auth)).toEqual(["x"]);
    expect(filterRecipientsOwningScope(["y"], "/a", auth)).toEqual([]);
    // Richer ownership (repo select vs session cwd).
    const rich: RemoteUplinkAuth = {
      ...auth,
      clientOwnsScope: (id, scope) => id === "y" && scope === "/a",
    };
    expect(filterRecipientsOwningScope(["x", "y"], "/a", rich)).toEqual(["y"]);

    // Mutation: without the filter, both ids would ship under a forged multi-client list.
    const withoutFilter = ["x", "y"];
    expect(withoutFilter).toContain("y");
    expect(filterRecipientsOwningScope(withoutFilter, "/a", auth)).not.toContain("y");
  });

  it("source gate: deliver/broadcastTo ownership filter is on the write path", () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "remote-uplink.ts"),
      "utf8",
    );
    expect(src).toContain("filterRecipientsOwningScope");
    expect(src).toMatch(/deliver\([\s\S]*filterRecipientsOwningScope/);
    expect(src).toContain("does not own scope");
    // Sidebar wires clientOwnsScope for repo + session ownership.
    const sidebar = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sidebar.ts"),
      "utf8",
    );
    expect(sidebar).toContain("clientOwnsScope:");
  });

  it("scrubs closed-project data out of the catch-up snapshot frame", () => {
    const logs: string[] = [];
    const uplink = makeUplink({
      auth: {
        authorizedCwds: () => ["/work/open"],
        // Tab still bound to closed session cwd (revoke race / stale mapping).
        scopeCwdForClient: () => "/work/closed",
        sameCwd: pathsEqual,
      },
      snapshot: () => [
        deviceOk,
        closedChunk,
        closedRepos,
        openRepos,
        { type: "clearMessages" },
        unboundInitial,
      ],
      log: (l) => logs.push(l),
    });
    uplink.start();
    const socket = wsMock.sockets[0];
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ t: "client-ready", clientId: "tab-a" })));

    const snap = socket.sent.map(JSON.parse).find((f: { t: string }) => f.t === "snapshot");
    expect(snap).toBeDefined();
    expect(snap.msgs.map((m: HostMsg) => m.type)).toEqual([
      "error",
      "repos",
      "clearMessages",
      "initialState",
    ]);
    expect(snap.msgs.find((m: HostMsg) => m.type === "repos")).toEqual(openRepos);
    expect(logs.some((l) => l.includes("scrubbed"))).toBe(true);
    uplink.dispose();
  });

  it("mutation: snapshot path without uplink gate would deliver closed transcript", () => {
    // Documents the hole deliverRemote never covered: client-ready → snapshotFrame
    // used opts.snapshot() bytes directly. With the gate, closed chunks are gone.
    const raw = [closedChunk, deviceOk];
    const scopeClosed = "/work/closed";
    const withoutGate = raw; // old
    expect(withoutGate.some((m) => m.type === "messageChunk")).toBe(true);
    const withGate = filterAuthorizedOutbound(raw, ["/work/open"], scopeClosed, pathsEqual);
    expect(withGate.some((m) => m.type === "messageChunk")).toBe(false);
    expect(withGate).toEqual([deviceOk]);
  });
});

describe("saying \"still working\" while a turn is in flight", () => {
  // A cloud machine is suspended by its hypervisor about a minute after its
  // last interaction, and the hypervisor judges that from traffic, not from
  // what the machine thinks it is doing. A turn that spends four minutes
  // running a test suite sends nothing, so without this the machine freezes
  // mid-tool — the exact failure remote control exists to prevent.
  beforeEach(() => { wsMock.sockets.length = 0; });

  const openUplink = () => {
    const uplink = makeUplink();
    uplink.start();
    const ws = wsMock.sockets[wsMock.sockets.length - 1];
    ws.emit("open");
    ws.sent.length = 0; // drop the hello
    return { uplink, ws };
  };

  it("beats immediately, then on the interval", () => {
    vi.useFakeTimers();
    try {
      const { uplink, ws } = openUplink();
      uplink.setWorking(true);
      // The first beat is not deferred: a turn can be over inside 30 seconds
      // and still have to survive its own tool call.
      expect(ws.sent.map((s: string) => JSON.parse(s).t)).toEqual(["working"]);
      vi.advanceTimersByTime(WORKING_HEARTBEAT_MS * 3);
      expect(ws.sent).toHaveLength(4);
      expect(ws.sent.every((s: string) => JSON.parse(s).t === "working")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops when the turn ends", () => {
    vi.useFakeTimers();
    try {
      const { uplink, ws } = openUplink();
      uplink.setWorking(true);
      uplink.setWorking(false);
      const after = ws.sent.length;
      vi.advanceTimersByTime(WORKING_HEARTBEAT_MS * 5);
      expect(ws.sent).toHaveLength(after);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not stack timers when re-asserted", () => {
    // Callers re-assert state rather than tracking transitions, so setWorking
    // runs on every session status change — a timer per call would be a beat
    // per status change forever.
    vi.useFakeTimers();
    try {
      const { uplink, ws } = openUplink();
      for (let i = 0; i < 10; i += 1) uplink.setWorking(true);
      expect(ws.sent).toHaveLength(1);
      vi.advanceTimersByTime(WORKING_HEARTBEAT_MS);
      expect(ws.sent).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips beats while the socket is down and resumes when it is back", () => {
    vi.useFakeTimers();
    try {
      const { uplink, ws } = openUplink();
      uplink.setWorking(true);
      ws.readyState = 3; // CLOSED
      vi.advanceTimersByTime(WORKING_HEARTBEAT_MS * 2);
      expect(ws.sent).toHaveLength(1);
      ws.readyState = 1;
      vi.advanceTimersByTime(WORKING_HEARTBEAT_MS);
      expect(ws.sent).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops beating when the uplink is disposed", () => {
    // Unlinking must not leave a timer writing to a dead socket for the rest of
    // the session.
    vi.useFakeTimers();
    try {
      const { uplink, ws } = openUplink();
      uplink.setWorking(true);
      uplink.dispose();
      const after = ws.sent.length;
      vi.advanceTimersByTime(WORKING_HEARTBEAT_MS * 5);
      expect(ws.sent).toHaveLength(after);
    } finally {
      vi.useRealTimers();
    }
  });

  it("survives a send that throws", () => {
    const { uplink, ws } = openUplink();
    ws.send = () => { throw new Error("socket gone"); };
    expect(() => uplink.setWorking(true)).not.toThrow();
  });
});
