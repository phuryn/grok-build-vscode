import { describe, it, expect } from "vitest";
import {
  REMOTE_PROTO_VERSION,
  helloFrame,
  hostFrame,
  hostToFrame,
  snapshotFrame,
  parseRelayFrame,
  buildUplinkUrl,
  httpBaseFromRelayUrl,
  deviceDisplayName,
  deviceOsLabel,
  devicePlatformCode,
  deviceClientLabel,
  sanitizeRelayDeviceField,
  buildLinkStartBody,
  connectionWasHealthy,
  nextBackoffMs,
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
} from "../src/remote-frames";

describe("uplink frame builders", () => {
  it("rejects the unreleased paste RPC and validates remote connector payloads", () => {
    const wrap = (msg: unknown) => JSON.stringify({ t: "msg", clientId: "phone", msg });
    expect(parseRelayFrame(wrap({ type: "completeMcpConnectorOAuth", id: "notion", attemptId: "old", redirectUrl: "pasted" }))).toBeNull();
    expect(parseRelayFrame(wrap({ type: "connectMcpConnector", id: "github", key: 12 }))).toBeNull();
    expect(parseRelayFrame(wrap({ type: "disconnectMcpConnector", id: 12 }))).toBeNull();
  });
  it("hello carries the protocol version and optional device name", () => {
    expect(helloFrame("dev-box")).toEqual({ t: "hello", proto: REMOTE_PROTO_VERSION, device: { name: "dev-box" } });
    expect(helloFrame()).toEqual({ t: "hello", proto: REMOTE_PROTO_VERSION });
  });

  it("hello carries the client object with the same mapped values as link/start", () => {
    const src = {
      hostname: "Dell",
      platform: "win32",
      release: "10.0.26200",
      installId: "abc",
      appName: "Visual Studio Code",
      isDesktop: false,
    };
    const body = buildLinkStartBody(src);
    expect(helloFrame("Dell (Windows 11)", src)).toEqual({
      t: "hello",
      proto: REMOTE_PROTO_VERSION,
      device: { name: "Dell (Windows 11)" },
      client: {
        clientLabel: body.clientLabel,
        platform: body.platform,
        osLabel: body.osLabel,
      },
    });
    expect(helloFrame("Dell (Windows 11)", src).client).toEqual({
      clientLabel: "VS Code extension",
      platform: "win",
      osLabel: "Windows 11",
    });
  });

  it("host/snapshot wrap protocol messages verbatim", () => {
    const msg = { type: "messageChunk", text: "hi" } as const;
    expect(hostFrame(msg)).toEqual({ t: "host", msg });
    expect(snapshotFrame("c1", [msg])).toEqual({ t: "snapshot", clientId: "c1", msgs: [msg] });
    expect(hostToFrame(["c1", "c2"], msg)).toEqual({ t: "host-to", clientIds: ["c1", "c2"], msg });
  });
});

describe("parseRelayFrame", () => {
  it("round-trips the relay frames", () => {
    expect(parseRelayFrame(JSON.stringify({ t: "client-ready", clientId: "c1" }))).toEqual({ t: "client-ready", clientId: "c1" });
    expect(parseRelayFrame(JSON.stringify({
      t: "client-ready",
      clientId: "c2",
      tabToken: "0123456789abcdef01234567",
    }))).toEqual({
      t: "client-ready",
      clientId: "c2",
      tabToken: "0123456789abcdef01234567",
    });
    expect(parseRelayFrame(JSON.stringify({ t: "client-left", clientId: "c1" }))).toEqual({ t: "client-left", clientId: "c1" });
    expect(parseRelayFrame(JSON.stringify({ t: "msg", clientId: "c1", msg: { type: "send", text: "x" } }))).toEqual({
      t: "msg",
      clientId: "c1",
      msg: { type: "send", text: "x" },
    });
    expect(parseRelayFrame(JSON.stringify({ t: "clients", count: 2 }))).toEqual({ t: "clients", count: 2 });
  });

  it("accepts an absent legacy token but drops malformed client-ready tokens", () => {
    expect(parseRelayFrame(JSON.stringify({
      t: "client-ready",
      clientId: "c1",
    }))).toEqual({ t: "client-ready", clientId: "c1" });
    for (const tabToken of [null, 42, {}, [], "short", "x".repeat(129), "not/url/safe".repeat(2)]) {
      expect(parseRelayFrame(JSON.stringify({
        t: "client-ready",
        clientId: "c1",
        tabToken,
      }))).toBeNull();
    }
  });

  it("drops malformed input instead of throwing", () => {
    expect(parseRelayFrame("not json")).toBeNull();
    expect(parseRelayFrame("42")).toBeNull();
    expect(parseRelayFrame(JSON.stringify({ t: "nope" }))).toBeNull();
    expect(parseRelayFrame(JSON.stringify({ t: "client-ready" }))).toBeNull(); // no clientId
    expect(parseRelayFrame(JSON.stringify({ t: "client-left" }))).toBeNull(); // no clientId
    expect(parseRelayFrame(JSON.stringify({ t: "msg", clientId: "c1" }))).toBeNull(); // no msg
    expect(parseRelayFrame(JSON.stringify({ t: "msg", clientId: "c1", msg: { text: "x" } }))).toBeNull(); // msg w/o type
    expect(parseRelayFrame(JSON.stringify({ t: "clients", count: "2" }))).toBeNull();
  });

  const traversalMessages = [
    ["selectRepo cwd", { type: "selectRepo", cwd: "../.." }],
    ["toggleRepoPin cwd", { type: "toggleRepoPin", cwd: "..\\..", pinned: true }],
    ["setRepoColor cwd", { type: "setRepoColor", cwd: "..\\..", color: "blue" }],
    ["resumeSession id", { type: "resumeSession", id: "../.." }],
    ["resumeSession cwd", { type: "resumeSession", id: "safe-session", cwd: "/work/../escape" }],
    ["renameSession id", { type: "renameSession", id: "..\\..", name: "renamed" }],
    ["deleteSession id", { type: "deleteSession", id: "../.." }],
    ["clearAllSessions cwd", { type: "clearAllSessions", cwd: "../.." }],
    ["addMentionFile relPath", { type: "addMentionFile", relPath: "../../secret.txt" }],
    ["uploadFile name", { type: "uploadFile", name: "../../secret.md", data: "YQ==" }],
    ["writeProjectFile relPath", {
      type: "writeProjectFile",
      cwd: "/work/a",
      relPath: "../../secret.txt",
      text: "x",
      stamp: { mtimeMs: 1, size: 1 },
      expectedAbsPath: "/work/a/secret.txt",
    }],
    ["writeProjectFile expectedAbsPath", {
      type: "writeProjectFile",
      cwd: "/work/a",
      relPath: "a.ts",
      text: "x",
      stamp: { mtimeMs: 1, size: 1 },
      expectedAbsPath: "/work/../escape",
    }],
  ] as const;

  it.each(traversalMessages)(
    "drops traversal in remote-reachable %s at the wire boundary",
    (_name, msg) => {
      const wrap = (value: unknown) => JSON.stringify({ t: "msg", clientId: "c1", msg: value });
      expect(parseRelayFrame(wrap(msg))).toBeNull();
    },
  );

  it("drops unknown message types", () => {
    const wrap = (msg: unknown) => JSON.stringify({ t: "msg", clientId: "c1", msg });
    expect(parseRelayFrame(wrap({ type: "notAWebviewMessage" }))).toBeNull();
  });

  it("validates queued-send identity on remote send frames", () => {
    const wrap = (msg: unknown) => JSON.stringify({ t: "msg", clientId: "c1", msg });
    expect(parseRelayFrame(wrap({
      type: "send",
      text: "queued",
      queuedSendId: "01234567-89ab-cdef-0123-456789abcdef",
    }))).not.toBeNull();
    for (const queuedSendId of [null, 42, "short", "not/a/submission/id"]) {
      expect(parseRelayFrame(wrap({ type: "send", text: "queued", queuedSendId }))).toBeNull();
    }
  });

  it("validates and reconstructs ordinary remote send frames", () => {
    const wrap = (msg: unknown) => JSON.stringify({ t: "msg", clientId: "c1", msg });
    const submissionId = "0123456789abcdef".repeat(3);
    expect(parseRelayFrame(wrap({
      type: "send",
      text: "from the phone",
      bare: false,
      submissionId,
      chips: [{ id: "unchecked-legacy-render-copy" }],
      futureUncheckedField: { large: "payload" },
    }))).toEqual({
      t: "msg",
      clientId: "c1",
      msg: {
        type: "send",
        text: "from the phone",
        bare: false,
        submissionId,
      },
    });

    for (const malformed of [
      { type: "send", text: 42 },
      { type: "send", text: "x", bare: "false" },
      { type: "send", text: "x", submissionId: null },
      { type: "send", text: "x", submissionId: {} },
      { type: "send", text: "x", submissionId: "short" },
      { type: "send", text: "x", submissionId: "x".repeat(129) },
      { type: "send", text: "x", submissionId: "not/a/submission/token" },
    ]) {
      expect(parseRelayFrame(wrap(malformed)), JSON.stringify(malformed)).toBeNull();
    }
  });

  it("reconstructs queueSend chips as ids only — never a caller-supplied path", () => {
    const wrap = (msg: unknown) => JSON.stringify({ t: "msg", clientId: "c1", msg });
    expect(parseRelayFrame(wrap({
      type: "queueSend",
      text: "follow-up",
      chips: [{ id: "image:/s/a.png:1:1", path: "/etc/passwd", relPath: "secret", hidden: false }],
    }))).toEqual({
      t: "msg",
      clientId: "c1",
      msg: {
        type: "queueSend",
        text: "follow-up",
        chips: [{ id: "image:/s/a.png:1:1", path: "", relPath: "", hidden: false }],
      },
    });
    expect(parseRelayFrame(wrap({ type: "queueSend", text: "" }))).toEqual({
      t: "msg",
      clientId: "c1",
      msg: { type: "queueSend", text: "" },
    });
    expect(parseRelayFrame(wrap({ type: "clearQueuedSends", restore: true }))).toEqual({
      t: "msg",
      clientId: "c1",
      msg: { type: "clearQueuedSends", restore: true },
    });
    expect(parseRelayFrame(wrap({ type: "queueSend", chips: [] }))).toBeNull();
    expect(parseRelayFrame(wrap({ type: "queueSend", text: "x", chips: "nope" }))).toBeNull();
  });

  it("reconstructs steerSend chips as ids only — never a caller-supplied path", () => {
    const wrap = (msg: unknown) => JSON.stringify({ t: "msg", clientId: "c1", msg });
    expect(parseRelayFrame(wrap({
      type: "steerSend",
      text: "look",
      fromQueue: true,
      chips: [{ id: "image:/s/a.png:1:1", path: "/etc/passwd", relPath: "secret", hidden: false }],
    }))).toEqual({
      t: "msg",
      clientId: "c1",
      msg: {
        type: "steerSend",
        text: "look",
        fromQueue: true,
        chips: [{ id: "image:/s/a.png:1:1", path: "", relPath: "", hidden: false }],
      },
    });
    expect(parseRelayFrame(wrap({ type: "steerSend", text: "x" }))).toEqual({
      t: "msg",
      clientId: "c1",
      msg: { type: "steerSend", text: "x" },
    });
    expect(parseRelayFrame(wrap({ type: "steerSend", text: "x", chips: "nope" }))).toBeNull();
    expect(parseRelayFrame(wrap({ type: "steerSend", text: "x", fromQueue: "yes" }))).toBeNull();
  });

  it("validates and reconstructs browser-owned speech preferences", () => {
    const wrap = (msg: unknown) => JSON.stringify({ t: "msg", clientId: "c1", msg });
    expect(parseRelayFrame(wrap({
      type: "remotePreferences",
      fontScale: 120,
      readRepliesAloud: true,
      summarizeRepliesAloud: true,
      usesTouch: true,
      unchecked: "drop me",
    }))).toEqual({
      t: "msg",
      clientId: "c1",
      msg: {
        type: "remotePreferences",
        fontScale: 120,
        readRepliesAloud: true,
        summarizeRepliesAloud: true,
        usesTouch: true,
      },
    });
    expect(parseRelayFrame(wrap({
      type: "remotePreferences",
      fontScale: 100,
      readRepliesAloud: false,
      usesTouch: false,
    }))).not.toBeNull();

    for (const malformed of [
      { type: "remotePreferences", fontScale: 79, readRepliesAloud: false, usesTouch: false },
      { type: "remotePreferences", fontScale: 161, readRepliesAloud: false, usesTouch: false },
      { type: "remotePreferences", fontScale: "100", readRepliesAloud: false, usesTouch: false },
      { type: "remotePreferences", fontScale: 100, readRepliesAloud: "yes", usesTouch: false },
      { type: "remotePreferences", fontScale: 100, readRepliesAloud: true, summarizeRepliesAloud: 1, usesTouch: false },
      { type: "remotePreferences", fontScale: 100, readRepliesAloud: false, usesTouch: "yes" },
    ]) {
      expect(parseRelayFrame(wrap(malformed)), JSON.stringify(malformed)).toBeNull();
    }
  });

  it("validates and reconstructs remote speech-summary requests", () => {
    const wrap = (msg: unknown) => JSON.stringify({ t: "msg", clientId: "c1", msg });
    expect(parseRelayFrame(wrap({
      type: "summarizeSpeech",
      requestId: 9,
      text: "Full spoken reply.",
      unchecked: true,
    }))).toEqual({
      t: "msg",
      clientId: "c1",
      msg: { type: "summarizeSpeech", requestId: 9, text: "Full spoken reply." },
    });
    for (const malformed of [
      { type: "summarizeSpeech", requestId: "9", text: "x" },
      { type: "summarizeSpeech", requestId: 1.5, text: "x" },
      { type: "summarizeSpeech", requestId: 9, text: null },
    ]) {
      expect(parseRelayFrame(wrap(malformed)), JSON.stringify(malformed)).toBeNull();
    }
  });

  it("validates the opaque preview id without adding preview bytes", () => {
    const wrap = (msg: unknown) => JSON.stringify({ t: "msg", clientId: "c1", msg });
    const previewId = "0123456789abcdef".repeat(3);
    expect(parseRelayFrame(wrap({
      type: "pasteImage",
      mimeType: "image/png",
      data: "iVBORw==",
      previewId,
      previewSrc: "data:image/png;base64,should-not-pass",
    }))).toEqual({
      t: "msg",
      clientId: "c1",
      msg: { type: "pasteImage", mimeType: "image/png", data: "iVBORw==", previewId },
    });
    expect(parseRelayFrame(wrap({
      type: "pasteImage", mimeType: "image/png", data: "iVBORw==", previewId: "short",
    }))).toBeNull();
  });

  it("validates and reconstructs remote plan verdicts before host state can change", () => {
    const wrap = (msg: unknown) => JSON.stringify({ t: "msg", clientId: "c1", msg });
    expect(parseRelayFrame(wrap({
      type: "exitPlanAnswer",
      requestId: "plan-7",
      verdict: "approved",
      comment: "Please keep the tests focused.",
      unchecked: true,
    }))).toEqual({
      t: "msg",
      clientId: "c1",
      msg: {
        type: "exitPlanAnswer",
        requestId: "plan-7",
        verdict: "approved",
        comment: "Please keep the tests focused.",
      },
    });

    for (const malformed of [
      { type: "exitPlanAnswer", verdict: "approved" },
      { type: "exitPlanAnswer", requestId: null, verdict: "approved" },
      { type: "exitPlanAnswer", requestId: 7, verdict: "approve" },
      { type: "exitPlanAnswer", requestId: 7, verdict: "approved", comment: 42 },
    ]) {
      expect(parseRelayFrame(wrap(malformed)), JSON.stringify(malformed)).toBeNull();
    }
  });

  it("accepts canonical filesystem-bearing remote payloads", () => {
    const wrap = (msg: unknown) => JSON.stringify({ t: "msg", clientId: "c1", msg });
    for (const msg of [
      { type: "selectRepo", cwd: "/work/repo" },
      { type: "toggleRepoPin", cwd: "C:\\work\\repo", pinned: true },
      { type: "setRepoColor", cwd: "/work/repo", color: "coral" },
      { type: "setRepoColor", cwd: "/work/repo", color: "" },
      { type: "resumeSession", id: "019f-session_1", cwd: "\\\\server\\share\\repo" },
      { type: "renameSession", id: "019f-session_1", name: "renamed" },
      { type: "deleteSession", id: "019f-session_1" },
      { type: "clearAllSessions", cwd: "/work/repo" },
      { type: "addMentionFile", relPath: "src/file.ts" },
      { type: "uploadFile", name: "Quarterly Notes.pdf", data: "YQ==" },
      {
        type: "writeProjectFile",
        cwd: "/work/repo",
        relPath: "src/file.ts",
        text: "hello\n",
        stamp: { mtimeMs: 1_700_000_000_000, size: 6 },
        expectedAbsPath: "/work/repo/src/file.ts",
      },
    ]) {
      expect(parseRelayFrame(wrap(msg)), JSON.stringify(msg)).not.toBeNull();
    }
    // Missing stamp / non-finite numbers must not pass the wire gate.
    expect(parseRelayFrame(wrap({
      type: "writeProjectFile",
      cwd: "/work/repo",
      relPath: "a.ts",
      text: "x",
      expectedAbsPath: "/work/repo/a.ts",
    }))).toBeNull();
    expect(parseRelayFrame(wrap({
      type: "writeProjectFile",
      cwd: "/work/repo",
      relPath: "a.ts",
      text: "x",
      stamp: { mtimeMs: NaN, size: 1 },
      expectedAbsPath: "/work/repo/a.ts",
    }))).toBeNull();
  });

  it("drops malformed filesystem selectors and accepts a valid ready token", () => {
    const wrap = (msg: unknown) => JSON.stringify({ t: "msg", clientId: "c1", msg });
    expect(parseRelayFrame(wrap({ type: "selectRepo", cwd: {} }))).toBeNull();
    expect(parseRelayFrame(wrap({ type: "toggleRepoPin", cwd: "/a", pinned: "yes" }))).toBeNull();
    expect(parseRelayFrame(wrap({ type: "setRepoColor", cwd: "/a", color: 7 }))).toBeNull();
    expect(parseRelayFrame(wrap({ type: "setRepoColor", cwd: "..\\..", color: "blue" }))).toBeNull();
    expect(parseRelayFrame(wrap({ type: "resumeSession", id: "s", cwd: [] }))).toBeNull();
    expect(parseRelayFrame(wrap({ type: "clearAllSessions", cwd: 42 }))).toBeNull();
    expect(parseRelayFrame(wrap({ type: "ready", tabToken: "short" }))).toBeNull();
    expect(parseRelayFrame(wrap({ type: "ready", tabToken: "0123456789abcdef01234567" }))).not.toBeNull();
  });

  it("accepts resumeSession.claim only as a boolean and keeps only true", () => {
    const wrap = (msg: unknown) => JSON.stringify({ t: "msg", clientId: "c1", msg });
    const claimed = parseRelayFrame(wrap({
      type: "resumeSession", id: "019f-session_1", cwd: "/work/repo", claim: true,
    }));
    expect(claimed?.t).toBe("msg");
    if (claimed?.t === "msg") {
      expect(claimed.msg).toEqual({
        type: "resumeSession", id: "019f-session_1", cwd: "/work/repo", claim: true,
      });
    }
    const omitted = parseRelayFrame(wrap({
      type: "resumeSession", id: "019f-session_1", cwd: "/work/repo", claim: false,
    }));
    expect(omitted?.t).toBe("msg");
    if (omitted?.t === "msg") {
      expect(omitted.msg).toEqual({
        type: "resumeSession", id: "019f-session_1", cwd: "/work/repo",
      });
    }
    expect(parseRelayFrame(wrap({
      type: "resumeSession", id: "019f-session_1", claim: "yes",
    }))).toBeNull();
  });
});

describe("url helpers", () => {
  it("buildUplinkUrl appends /uplink with the encoded token", () => {
    expect(buildUplinkUrl("ws://localhost:8787", "a+b/c")).toBe("ws://localhost:8787/uplink?token=a%2Bb%2Fc");
    expect(buildUplinkUrl("wss://relay.example/", "t")).toBe("wss://relay.example/uplink?token=t");
  });

  it("httpBaseFromRelayUrl swaps ws->http / wss->https and trims the trailing slash", () => {
    expect(httpBaseFromRelayUrl("ws://localhost:8787")).toBe("http://localhost:8787");
    expect(httpBaseFromRelayUrl("wss://relay.example/")).toBe("https://relay.example");
    expect(httpBaseFromRelayUrl("WSS://relay.example")).toBe("https://relay.example");
  });
});

describe("deviceDisplayName", () => {
  it("labels Windows 11 by kernel build >= 22000", () => {
    expect(deviceDisplayName("Dell", "win32", "10.0.26200")).toBe("Dell (Windows 11)");
  });

  it("labels older Windows as Windows 10", () => {
    expect(deviceDisplayName("PC", "win32", "10.0.19045")).toBe("PC (Windows 10)");
  });

  it("maps darwin to macOS and linux to Linux", () => {
    expect(deviceDisplayName("Mac", "darwin", "23.5.0")).toBe("Mac (macOS)");
    expect(deviceDisplayName("box", "linux", "6.1.0")).toBe("box (Linux)");
  });

  it("passes an unknown platform through as-is", () => {
    expect(deviceDisplayName("host", "freebsd", "14.0")).toBe("host (freebsd)");
  });

  it("falls back to just the OS label when the hostname is empty", () => {
    expect(deviceDisplayName("", "win32", "10.0.26200")).toBe("Windows 11");
  });
});

describe("richer device-row link/start fields", () => {
  it("reuses the same OS string the legacy name already embeds", () => {
    expect(deviceOsLabel("win32", "10.0.26200")).toBe("Windows 11");
    expect(deviceOsLabel("win32", "10.0.19045")).toBe("Windows 10");
    expect(deviceOsLabel("darwin", "23.5.0")).toBe("macOS");
    expect(deviceOsLabel("linux", "6.1.0")).toBe("Linux");
    expect(deviceDisplayName("Dell", "win32", "10.0.26200")).toBe("Dell (Windows 11)");
  });

  it("maps process.platform to win|mac|linux", () => {
    expect(devicePlatformCode("win32")).toBe("win");
    expect(devicePlatformCode("darwin")).toBe("mac");
    expect(devicePlatformCode("linux")).toBe("linux");
    expect(devicePlatformCode("freebsd")).toBeUndefined();
  });

  it("labels desktop as Desktop app and maps editor appName", () => {
    expect(deviceClientLabel("Grok Build Desktop", true)).toBe("Desktop app");
    expect(deviceClientLabel("Visual Studio Code", false)).toBe("VS Code extension");
    expect(deviceClientLabel("Cursor", false)).toBe("Cursor extension");
    expect(deviceClientLabel("Antigravity", false)).toBe("Antigravity extension");
    expect(deviceClientLabel("VSCodium", false)).toBe("VSCodium extension");
  });

  it("keeps the legacy name and adds optional clientLabel/platform/osLabel", () => {
    expect(buildLinkStartBody({
      hostname: "Dell",
      platform: "win32",
      release: "10.0.26200",
      installId: "abc",
      appName: "Visual Studio Code",
      isDesktop: false,
    })).toEqual({
      name: "Dell (Windows 11)",
      installId: "abc",
      clientLabel: "VS Code extension",
      platform: "win",
      osLabel: "Windows 11",
    });
    expect(buildLinkStartBody({
      hostname: "Mac",
      platform: "darwin",
      release: "23.5.0",
      installId: "abc:desktop",
      appName: "Grok Build Desktop",
      isDesktop: true,
    })).toEqual({
      name: "Mac (macOS)",
      installId: "abc:desktop",
      clientLabel: "Desktop app",
      platform: "mac",
      osLabel: "macOS",
    });
  });

  it("sanitizes optional fields to trim / max-64 / no control chars", () => {
    expect(sanitizeRelayDeviceField("  VS Code extension\u0000  ")).toBe("VS Code extension");
    expect(sanitizeRelayDeviceField("x".repeat(80))).toHaveLength(64);
    const body = buildLinkStartBody({
      hostname: "box",
      platform: "linux",
      release: "6.1.0",
      installId: "id",
      appName: `  ${"N".repeat(80)}\n`,
      isDesktop: false,
    });
    expect(body.clientLabel!.length).toBeLessThanOrEqual(64);
    expect(body.clientLabel).not.toMatch(/[\u0000-\u001F]/);
  });
});

describe("connectionWasHealthy", () => {
  // The reset used to happen on OPEN, which means the delay could only grow
  // while connections FAILED and never against one that succeeded and then
  // died — the exact case it exists to damp. A host whose socket opened and
  // dropped retried once a second for ever, and each attempt cost the relay a
  // database lookup: 65.8M of them in production, against 23.8k for the
  // per-connection ownership query.
  it("a connection that outlived the longest delay was working", () => {
    expect(connectionWasHealthy(MAX_BACKOFF_MS)).toBe(true);
    expect(connectionWasHealthy(MAX_BACKOFF_MS + 1)).toBe(true);
    // The observed real case: a cloud machine suspends about a minute after
    // going idle and its socket dies with it. That is healthy, not flapping —
    // the next attempt should be immediate.
    expect(connectionWasHealthy(60_000)).toBe(true);
  });

  it("a flap keeps the delay it earned", () => {
    expect(connectionWasHealthy(0)).toBe(false);
    expect(connectionWasHealthy(1)).toBe(false);
    expect(connectionWasHealthy(MAX_BACKOFF_MS - 1)).toBe(false);
  });

  it("never resets from a socket that merely opened", () => {
    // The whole defect in one assertion: opening is not evidence.
    expect(connectionWasHealthy(0)).toBe(false);
  });
});

describe("nextBackoffMs", () => {
  it("doubles from the initial value and caps", () => {
    expect(nextBackoffMs(INITIAL_BACKOFF_MS)).toBe(INITIAL_BACKOFF_MS * 2);
    expect(nextBackoffMs(MAX_BACKOFF_MS)).toBe(MAX_BACKOFF_MS);
    expect(nextBackoffMs(0)).toBe(INITIAL_BACKOFF_MS * 2); // floor below initial
  });
});
