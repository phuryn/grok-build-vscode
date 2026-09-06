// Extension <-> relay wire contract (Phase 1, topology B — the extension dials
// OUT to a relay; browsers connect to the same relay; the relay ferries the
// existing HostMsg/WebviewMsg protocol between them).
//
// Pure: types + parse/build helpers only, unit-testable grok-free. The relay
// repo keeps its own mirror of these frame shapes — the contract is these
// little envelopes, deliberately tiny so the mirror can't drift far. Browsers
// speak raw HostMsg/WebviewMsg JSON (the Phase-0 shim unchanged); only the
// extension<->relay leg wraps them in frames so the relay can route per client.

import { WEBVIEW_MESSAGE_TYPES, type HostMsg, type WebviewMsg } from "./protocol";

/** Bump when a frame shape changes incompatibly. The relay refuses a mismatched
 *  hello rather than mis-parsing — clients and extensions update independently. */
export const REMOTE_PROTO_VERSION = 1;

/** Optional richer-device fields on hello / link/start. */
export type RelayClientMeta = {
  clientLabel?: string;
  platform?: "win" | "mac" | "linux" | "cloud";
  osLabel?: string;
};

/** Inputs shared by `buildLinkStartBody` and `helloFrame` for client metadata. */
export type RelayClientSource = {
  platform: string;
  release: string;
  appName: string;
  isDesktop: boolean;
  /** This host IS an AFK Pilot cloud environment. Set from
   *  {@link CLOUD_ENVIRONMENT_ENV}; see {@link relayClientMeta}. */
  isCloud?: boolean;
};

/**
 * Marks a host as a hosted cloud environment rather than someone's machine.
 *
 * The host reports this about ITSELF rather than the relay inferring it, for
 * the same reason every other client field works that way: the relay stores
 * what it is told and never invents a label. When the relay grows a real
 * environments table it will know independently, and this stays true anyway.
 */
export const CLOUD_ENVIRONMENT_ENV = "GROK_CLOUD_ENVIRONMENT";

/** The parenthetical a cloud environment shows in the device picker. */
export const CLOUD_CLIENT_LABEL = "by afkpilot.com";

/** extension -> relay */
export type UplinkFrame =
  | { t: "hello"; proto: number; device?: { name?: string }; client?: RelayClientMeta }
  | { t: "host"; msg: HostMsg }
  | { t: "host-to"; clientIds: string[]; msg: HostMsg }
  | { t: "snapshot"; clientId: string; msgs: HostMsg[] }
  /**
   * "I am mid-turn." No payload, no side effect at the other end — its only job
   * is to ARRIVE. A cloud machine is held awake by traffic on its uplink, and a
   * turn spends most of its life waiting on a tool with nothing to say, so
   * streaming text keeps the machine alive only by accident. This does it on
   * purpose.
   *
   * Additive, so REMOTE_PROTO_VERSION does not move: a relay that predates it
   * does not recognise the frame, drops it, and says nothing. Sending it is
   * therefore safe against every relay this extension can reach.
   */
  | { t: "working" };

/** relay -> extension */
export type RelayFrame =
  | { t: "client-ready"; clientId: string; tabToken?: string }
  | { t: "client-left"; clientId: string }
  | { t: "msg"; clientId: string; msg: WebviewMsg }
  | { t: "clients"; count: number };

export function helloFrame(deviceName?: string, clientSource?: RelayClientSource): UplinkFrame {
  const client = clientSource ? relayClientMeta(clientSource) : undefined;
  const hasClient = !!client && !!(client.clientLabel || client.platform || client.osLabel);
  return {
    t: "hello",
    proto: REMOTE_PROTO_VERSION,
    ...(deviceName ? { device: { name: deviceName } } : {}),
    ...(hasClient ? { client } : {}),
  };
}

export function hostFrame(msg: HostMsg): UplinkFrame {
  return { t: "host", msg };
}

export function hostToFrame(clientIds: string[], msg: HostMsg): UplinkFrame {
  return { t: "host-to", clientIds, msg };
}

export function snapshotFrame(clientId: string, msgs: HostMsg[]): UplinkFrame {
  return { t: "snapshot", clientId, msgs };
}

export function workingFrame(): UplinkFrame {
  return { t: "working" };
}

/** Parse + shape-validate a relay->extension frame. null = drop (never throw). */
export function parseRelayFrame(raw: string): RelayFrame | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const f = obj as Record<string, unknown>;
  switch (f.t) {
    case "client-ready":
      if (typeof f.clientId !== "string") return null;
      if (
        f.tabToken !== undefined &&
        (typeof f.tabToken !== "string" || !REMOTE_TAB_TOKEN_RE.test(f.tabToken))
      ) return null;
      return {
        t: "client-ready",
        clientId: f.clientId,
        ...(f.tabToken !== undefined ? { tabToken: f.tabToken } : {}),
      };
    case "client-left":
      return typeof f.clientId === "string" ? { t: "client-left", clientId: f.clientId } : null;
    case "msg":
      if (typeof f.clientId !== "string") return null;
      {
        const msg = parseRemoteWebviewMsg(f.msg);
        return msg ? { t: "msg", clientId: f.clientId, msg } : null;
      }
    case "clients":
      return typeof f.count === "number" ? { t: "clients", count: f.count } : null;
    default:
      return null;
  }
}

const WEBVIEW_TYPE_SET = new Set<string>(WEBVIEW_MESSAGE_TYPES);
const REMOTE_TAB_TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;
const REMOTE_SUBMISSION_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const REMOTE_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REMOTE_UPLOAD_NAME_RE = /^[^/\\\0-\x1f\x7f]{1,240}$/;
const REMOTE_UPLOAD_EXTENSION_RE = /\.(?:md|txt|pdf|csv|xlsx|docx)$/i;

function pathSegments(value: string): string[] {
  return value.split(/[\\/]/);
}

function hasOnlyConcretePathSegments(value: string): boolean {
  return pathSegments(value).every((part) => part !== "." && part !== "..");
}

function isRemoteCwd(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 32_767 ||
    /[\0-\x1f\x7f]/.test(value) ||
    !hasOnlyConcretePathSegments(value)
  ) return false;
  return value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^\\\\[^\\]+\\[^\\]+/.test(value);
}

function isRemoteSessionId(value: unknown): value is string {
  return typeof value === "string" &&
    REMOTE_SESSION_ID_RE.test(value) &&
    value !== "__proto__" &&
    value !== "prototype" &&
    value !== "constructor";
}

function isRemoteMentionPath(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !/^[A-Za-z]:/.test(value) &&
    !/[\0-\x1f\x7f]/.test(value) &&
    pathSegments(value).every((part) => !!part && part !== "." && part !== "..");
}

function isRemoteUploadName(value: unknown): value is string {
  return typeof value === "string" &&
    REMOTE_UPLOAD_NAME_RE.test(value) &&
    REMOTE_UPLOAD_EXTENSION_RE.test(value);
}

function parseRemoteWebviewMsg(msg: unknown): WebviewMsg | null {
  if (typeof msg !== "object" || msg === null) return null;
  const value = msg as Record<string, unknown>;
  if (typeof value.type !== "string" || !WEBVIEW_TYPE_SET.has(value.type)) return null;
  switch (value.type) {
    case "connectMcpConnector":
      if (typeof value.id !== "string" || (value.key !== undefined && typeof value.key !== "string")
        || (value.readOnly !== undefined && typeof value.readOnly !== "boolean")) return null;
      return { type: "connectMcpConnector", id: value.id,
        ...(value.key !== undefined ? { key: value.key } : {}),
        ...(value.readOnly !== undefined ? { readOnly: value.readOnly } : {}),
      };
    case "disconnectMcpConnector":
      return typeof value.id === "string" ? { type: "disconnectMcpConnector", id: value.id } : null;
    case "ready":
      return value.tabToken === undefined
        ? { type: "ready" }
        : (
        typeof value.tabToken === "string" &&
        REMOTE_TAB_TOKEN_RE.test(value.tabToken)
          ? { type: "ready", tabToken: value.tabToken }
          : null
        );
    case "send": {
      if (typeof value.text !== "string") return null;
      if (value.bare !== undefined && typeof value.bare !== "boolean") return null;
      if (
        value.queuedSendId !== undefined &&
        (typeof value.queuedSendId !== "string" ||
          !REMOTE_SUBMISSION_ID_RE.test(value.queuedSendId))
      ) return null;
      if (
        value.submissionId !== undefined &&
        (typeof value.submissionId !== "string" ||
          !REMOTE_TAB_TOKEN_RE.test(value.submissionId))
      ) return null;
      // Reconstruct this newly-extended payload instead of passing the remote
      // object wholesale. That keeps future send fields outside the host until
      // this boundary explicitly validates and copies them.
      return {
        type: "send",
        text: value.text,
        ...(value.bare !== undefined ? { bare: value.bare } : {}),
        ...(value.queuedSendId !== undefined ? { queuedSendId: value.queuedSendId } : {}),
        ...(value.submissionId !== undefined ? { submissionId: value.submissionId } : {}),
      };
    }
    case "remotePreferences":
      if (
        typeof value.fontScale !== "number" ||
        !Number.isFinite(value.fontScale) ||
        value.fontScale < 80 ||
        value.fontScale > 160 ||
        typeof value.readRepliesAloud !== "boolean" ||
        (value.summarizeRepliesAloud !== undefined && typeof value.summarizeRepliesAloud !== "boolean") ||
        typeof value.usesTouch !== "boolean"
      ) return null;
      return {
        type: "remotePreferences",
        fontScale: value.fontScale,
        readRepliesAloud: value.readRepliesAloud,
        ...(value.summarizeRepliesAloud !== undefined
          ? { summarizeRepliesAloud: value.summarizeRepliesAloud }
          : {}),
        usesTouch: value.usesTouch,
      };
    case "summarizeSpeech":
      return Number.isSafeInteger(value.requestId) && typeof value.text === "string"
        ? { type: "summarizeSpeech", requestId: value.requestId as number, text: value.text }
        : null;
    case "requestImageFull":
      // Shape-check only; the host still has to recognise the handle. This just
      // keeps anything path-like from reaching that lookup in the first place.
      return typeof value.fullId === "string" && REMOTE_TAB_TOKEN_RE.test(value.fullId)
        ? { type: "requestImageFull", fullId: value.fullId }
        : null;
    case "selectRepo":
    case "clearAllSessions":
      return isRemoteCwd(value.cwd) ? msg as WebviewMsg : null;
    case "toggleRepoPin":
      return isRemoteCwd(value.cwd) && typeof value.pinned === "boolean"
        ? msg as WebviewMsg
        : null;
    case "setRepoArchived":
      return isRemoteCwd(value.cwd) && typeof value.archived === "boolean"
        ? msg as WebviewMsg
        : null;
    case "setRepoColor":
      // Shape only: the host still allowlists the colour id and re-checks the
      // cwd against the live catalog. Empty string is a valid "none".
      return isRemoteCwd(value.cwd) && typeof value.color === "string"
        ? msg as WebviewMsg
        : null;
    // Shape-checked here like its repo-level sibling rather than riding the
    // `default` passthrough: the host validates too, but a malformed message
    // that reaches the host has already crossed the boundary this parser exists
    // to hold. `cwd` is optional — the host falls back to its own lookup.
    case "toggleSessionPin":
      return isRemoteSessionId(value.id) &&
        typeof value.pinned === "boolean" &&
        (value.cwd === undefined || isRemoteCwd(value.cwd))
        ? msg as WebviewMsg
        : null;
    case "resumeSession": {
      if (!isRemoteSessionId(value.id)) return null;
      if (value.cwd !== undefined && !isRemoteCwd(value.cwd)) return null;
      if (value.claim !== undefined && typeof value.claim !== "boolean") return null;
      // Reconstruct so a future field cannot ride this newly-extended payload
      // the way `send` used to. `claim: true` is the only value that changes
      // host behaviour; false/absent is today's refusal.
      return {
        type: "resumeSession",
        id: value.id,
        ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
        ...(value.claim === true ? { claim: true } : {}),
      };
    }
    case "renameSession":
    case "deleteSession":
      // cwd is optional and, when present, must look like a repo path. The host
      // still matches it against its OWN catalog before acting, so this only
      // keeps obvious rubbish off the wire.
      return isRemoteSessionId(value.id) &&
        (value.cwd === undefined || isRemoteCwd(value.cwd))
        ? msg as WebviewMsg
        : null;
    case "addMentionFile":
      return isRemoteMentionPath(value.relPath) ? msg as WebviewMsg : null;
    // Project browse/save. cwd must look like a catalog path; relPath must be
    // relative (or empty for the repo root on list). Host still runs
    // resolveRemoteFileRoot + resolveTreePath — this only keeps garbage off the wire.
    case "listProjectDir":
      return isRemoteCwd(value.cwd) &&
        (value.relPath === undefined ||
          value.relPath === "" ||
          isRemoteMentionPath(value.relPath))
        ? msg as WebviewMsg
        : null;
    case "readProjectFile":
      return isRemoteCwd(value.cwd) && isRemoteMentionPath(value.relPath)
        ? msg as WebviewMsg
        : null;
    case "writeProjectFile": {
      // Existing-file save only: stamp + expectedAbsPath are mandatory so the
      // host can refuse a stale tab or a cross-project relPath collision.
      if (!isRemoteCwd(value.cwd) || !isRemoteMentionPath(value.relPath)) return null;
      if (typeof value.text !== "string") return null;
      if (!isRemoteCwd(value.expectedAbsPath)) return null;
      const stamp = value.stamp;
      if (
        !stamp ||
        typeof stamp !== "object" ||
        typeof (stamp as { mtimeMs?: unknown }).mtimeMs !== "number" ||
        !Number.isFinite((stamp as { mtimeMs: number }).mtimeMs) ||
        typeof (stamp as { size?: unknown }).size !== "number" ||
        !Number.isFinite((stamp as { size: number }).size)
      ) {
        return null;
      }
      return msg as WebviewMsg;
    }
    case "uploadFile":
      return isRemoteUploadName(value.name) ? msg as WebviewMsg : null;
    case "pasteImage":
      if (typeof value.mimeType !== "string" || typeof value.data !== "string") return null;
      if (
        value.previewId !== undefined &&
        (typeof value.previewId !== "string" || !REMOTE_TAB_TOKEN_RE.test(value.previewId))
      ) return null;
      return {
        type: "pasteImage",
        mimeType: value.mimeType,
        data: value.data,
        ...(value.previewId !== undefined ? { previewId: value.previewId } : {}),
      };
    case "queueSend": {
      if (typeof value.text !== "string") return null;
      if (value.chips === undefined) return { type: "queueSend", text: value.text };
      if (!Array.isArray(value.chips)) return null;
      const chips: { id: string; path: string; relPath: string; hidden: boolean }[] = [];
      for (const raw of value.chips) {
        if (!raw || typeof raw !== "object") return null;
        const id = (raw as { id?: unknown }).id;
        if (typeof id !== "string" || !id || id.length > 512) return null;
        // Ids only — the host looks the chip up on the session. Never accept a
        // caller-supplied path over this boundary.
        chips.push({ id, path: "", relPath: "", hidden: false });
      }
      return { type: "queueSend", text: value.text, chips };
    }
    case "clearQueuedSends":
      if (value.restore !== undefined && typeof value.restore !== "boolean") return null;
      return value.restore === undefined
        ? { type: "clearQueuedSends" }
        : { type: "clearQueuedSends", restore: value.restore };
    case "steerSend": {
      if (typeof value.text !== "string") return null;
      if (value.fromQueue !== undefined && typeof value.fromQueue !== "boolean") return null;
      const fromQueue = value.fromQueue === true ? { fromQueue: true as const } : {};
      if (value.chips === undefined) {
        return { type: "steerSend", text: value.text, ...fromQueue };
      }
      if (!Array.isArray(value.chips)) return null;
      const chips: { id: string; path: string; relPath: string; hidden: boolean }[] = [];
      for (const raw of value.chips) {
        if (!raw || typeof raw !== "object") return null;
        const id = (raw as { id?: unknown }).id;
        if (typeof id !== "string" || !id || id.length > 512) return null;
        chips.push({ id, path: "", relPath: "", hidden: false });
      }
      return { type: "steerSend", text: value.text, chips, ...fromQueue };
    }
    case "exitPlanAnswer": {
      const validRequestId = typeof value.requestId === "string" || typeof value.requestId === "number";
      if (
        !validRequestId ||
        (value.verdict !== "approved" && value.verdict !== "abandoned" && value.verdict !== "rejected")
      ) return null;
      if (value.comment !== undefined && typeof value.comment !== "string") return null;
      return {
        type: "exitPlanAnswer",
        requestId: value.requestId as number | string,
        verdict: value.verdict,
        ...(value.comment !== undefined ? { comment: value.comment } : {}),
      };
    }
    default:
      return msg as WebviewMsg;
  }
}

/** The production relay. The hostname is written only here.
 *  `scripts/check-production-relay.mjs` refuses to package unless
 *  {@link REMOTE_RELAY_URL} resolves to this value. */
export const PRODUCTION_RELAY_URL = "wss://afkpilot.com";

/** The relay the extension talks to. Fixed in code on purpose — the pairing
 *  flow, the web portal, and the gear "AFK Pilot" section all assume this one
 *  service, so there is no user SETTING. A development build can override it
 *  (see {@link resolveRelayUrl}); a published one never can. A local
 *  `install.ps1` build rewrites this assignment to a staging URL and restores
 *  it afterwards. */
export const REMOTE_RELAY_URL = PRODUCTION_RELAY_URL;

/** Environment variable a DEVELOPMENT build reads instead of the constant. */
export const RELAY_URL_ENV = "GROK_RELAY_URL";

/**
 * Environment variable a DEVELOPMENT build may read as a pre-linked device
 * token. Honour it only when {@link RELAY_URL_ENV} actually moved the relay
 * off this build's default — see {@link resolveInjectedDeviceToken}. A
 * published build never can: {@link resolveRelayUrl} already ignores the
 * URL override in production, and this gate pairs the token to that same
 * condition so the two cannot be split.
 *
 * Lives next to {@link RELAY_URL_ENV} so a third development-only override
 * is not invented somewhere else.
 */
export const RELAY_DEVICE_TOKEN_ENV = "GROK_RELAY_DEVICE_TOKEN";

/**
 * SecretStorage key for the linked-device token. The development overlay
 * and the sidebar uplink must name the same slot.
 */
export const RELAY_DEVICE_TOKEN_SECRET = "grok.remoteControl.deviceToken";

/**
 * The relay this build should actually use.
 *
 * Production ignores the environment entirely: a packaged desktop app
 * (`app.isPackaged`) and a published extension (`ExtensionMode.Production`) are
 * both production, so nobody running a real build can be talked into pointing
 * their client — and their linked device token — at someone else's relay. That
 * is the whole reason there is no user setting, and the gate here is what keeps
 * it true while still letting a build run from source reach staging.
 *
 * The alternative was editing the constant and remembering to change it back,
 * which is how a staging URL reached the public repo once already.
 *
 * Anything malformed falls back to the constant rather than throwing: a typo in
 * a shell variable should cost you a staging session, not a working client.
 */
export function resolveRelayUrl(opts: {
  isProduction: boolean;
  env?: Record<string, string | undefined>;
  /**
   * A build made to run as a cloud environment — see
   * `PACKAGED_CLOUD_BUILD_FIELD`. Such a build is packaged, so `isProduction`
   * is true, but it has no user at a keyboard and is told where to dial by the
   * relay that created it. Requires the machine to ALSO declare itself a cloud
   * environment at runtime, so the artifact alone is not enough.
   */
  cloudBuild?: boolean;
}): string {
  const cloudManaged = !!opts.cloudBuild && isCloudEnvironment(
    (opts.env ?? {}) as NodeJS.ProcessEnv,
  );
  if (opts.isProduction && !cloudManaged) return REMOTE_RELAY_URL;
  const raw = (opts.env ?? {})[RELAY_URL_ENV];
  if (typeof raw !== "string") return REMOTE_RELAY_URL;
  const trimmed = raw.trim();
  // Empty authority, before parsing. ws is a special scheme, so the URL parser
  // resolves `wss:///relay` to host `relay` — it silently promotes the first
  // path segment to a hostname. Falling back is the honest reading of a value
  // that named no host, and it keeps this function's rule ("an authority is
  // required") true rather than nearly true.
  if (/^wss?:\/\/\//i.test(trimmed)) return REMOTE_RELAY_URL;
  // Parsed, not pattern-matched. A prefix test waves through authorities the
  // URL parser rejects (`wss://relay.test:bad`), and that value reaches
  // `new WebSocket()` in remote-uplink and throws synchronously — the opposite
  // of the fallback promised above.
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return REMOTE_RELAY_URL;
  }
  // ws/wss only: any other scheme would send a device token somewhere it
  // cannot go. An authority is required — `wss://` alone names nothing.
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return REMOTE_RELAY_URL;
  if (!parsed.host) return REMOTE_RELAY_URL;
  // Credentials in the URL would be logged wherever the relay URL is logged.
  if (parsed.username || parsed.password) return REMOTE_RELAY_URL;
  // No query or fragment. Callers append `/uplink` and `/api/…` to this value,
  // so `wss://relay.test?x=1` would build `wss://relay.test?x=1/uplink` — a dead
  // endpoint that reads like the relay is down rather than like a bad variable.
  if (parsed.search || parsed.hash) return REMOTE_RELAY_URL;
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/+$/, "");
}

/**
 * A development-only device token, or `undefined`.
 *
 * Fail closed on every path that is not certain:
 *   - production (`isProduction: true`) — packaged desktop / published
 *     extension — never reads the environment, even when both variables
 *     are set;
 *   - the relay URL was not overridden (resolved URL equals this build's
 *     default, including a malformed {@link RELAY_URL_ENV} that fell back);
 *   - the resolved URL is the production hostname, so a source-run cannot
 *     be talked into handing a token to the real relay via env;
 *   - missing / non-string / blank token.
 *
 * Same shape as `acpClientCapabilities`: the safe value (`undefined`)
 * is the default, and only a fully-qualified development override returns
 * the token. The uplink still starts from SecretStorage; this function
 * never opens a socket.
 */
export function resolveInjectedDeviceToken(opts: {
  isProduction: boolean;
  env?: Record<string, string | undefined>;
  /** See {@link resolveRelayUrl}. A cloud build takes its identity from the
   *  environment because nothing else can give it one. */
  cloudBuild?: boolean;
}): string | undefined {
  const env = opts.env ?? {};
  // A cloud environment is the one case where a packaged build may take its
  // identity from the environment: the relay created the machine, wrote the
  // file over TLS, and there is nobody there to link it by hand.
  //
  // It also skips the URL interlock below. That interlock pairs the token to a
  // relay override so the two cannot be split — good on a desk, wrong here,
  // because a production cloud machine dials the PRODUCTION relay and would
  // otherwise be refused for pointing exactly where it should.
  if (opts.cloudBuild && isCloudEnvironment(env as NodeJS.ProcessEnv)) {
    const injected = env[RELAY_DEVICE_TOKEN_ENV];
    if (typeof injected !== "string") return undefined;
    return injected.trim() || undefined;
  }
  if (opts.isProduction) return undefined;
  const resolved = resolveRelayUrl({ isProduction: false, env });
  const baseline = resolveRelayUrl({ isProduction: false, env: {} });
  if (resolved === baseline) return undefined;
  if (resolved === PRODUCTION_RELAY_URL) return undefined;
  const raw = env[RELAY_DEVICE_TOKEN_ENV];
  if (typeof raw !== "string") return undefined;
  const token = raw.trim();
  if (!token) return undefined;
  return token;
}

/**
 * Read {@link resolveInjectedDeviceToken}, then drop the env entry.
 *
 * Desktop `buildEnv` and every `{...process.env}` spawn copy inherit the
 * process environment. Leaving the token there would leak a credential that
 * used to live only in SecretStorage into the agent binary and any command
 * it runs. The in-memory overlay already holds the value.
 */
export function consumeInjectedDeviceToken(opts: {
  isProduction: boolean;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  cloudBuild?: boolean;
}): string | undefined {
  const token = resolveInjectedDeviceToken(opts);
  delete opts.env[RELAY_DEVICE_TOKEN_ENV];
  return token;
}

/**
 * Overlay one SecretStorage key. `undefined` / empty returns `get` unchanged
 * so a production build — whose resolver already returned `undefined` —
 * cannot grow an overlay by accident.
 *
 * The overlay answers the key from memory and never touches the encrypted
 * store, which is what makes a headless Linux runner work: Electron
 * safeStorage is often unavailable there, and a disk write would throw.
 */
export function withInjectedSecret(
  get: (key: string) => PromiseLike<string | undefined>,
  key: string,
  value: string | undefined,
): (key: string) => PromiseLike<string | undefined> {
  if (typeof value !== "string" || !value) return get;
  return (k) => (k === key ? Promise.resolve(value) : get(k));
}

/**
 * A relay URL reduced to what is safe to write into a log: scheme and host.
 *
 * Everything that logs a relay URL goes through this. A base path is accepted
 * by {@link resolveRelayUrl} (a relay can live behind a prefix), so the path may
 * carry something the owner would not want in an output channel or in a pasted
 * terminal dump — and scheme plus host already answers the only question a log
 * line is asked here, which is *which relay is this*.
 */
export function redactRelayUrl(relayUrl: string): string {
  try {
    const u = new URL(String(relayUrl).trim());
    if (u.host) return `${u.protocol}//${u.host}`;
  } catch {
    /* fall through */
  }
  return "(unparseable relay url)";
}

/** ws(s)://relay[/base] + device token -> the uplink endpoint URL. */
export function buildUplinkUrl(relayUrl: string, token: string): string {
  return `${relayUrl.replace(/\/+$/, "")}/uplink?token=${encodeURIComponent(token)}`;
}

/** ws(s)://relay -> http(s)://relay, for the REST link endpoints + browser pages. */
export function httpBaseFromRelayUrl(relayUrl: string): string {
  return relayUrl.replace(/^ws:/i, "http:").replace(/^wss:/i, "https:").replace(/\/+$/, "");
}

/** OS string embedded in the legacy device name ("Windows 11", "macOS", …). */
export function deviceOsLabel(platform: string, release: string): string {
  if (platform === "win32") {
    // Windows 11 reports kernel 10.0.22000+; Windows 10 stays below.
    const build = Number(release.split(".")[2] ?? "0");
    return build >= 22000 ? "Windows 11" : "Windows 10";
  }
  if (platform === "darwin") return "macOS";
  if (platform === "linux") return "Linux";
  return platform;
}

/** "Dell (Windows 11)" — how this machine introduces itself to the relay
 *  (shown on the link-approval page and the portal's device list). Hostname +
 *  a human OS label; the workspace path deliberately stays out of it. */
export function deviceDisplayName(hostname: string, platform: string, release: string): string {
  const os = deviceOsLabel(platform, release);
  return hostname ? `${hostname} (${os})` : os;
}

/** Coarse platform token the relay's richer device rows accept. */
export function devicePlatformCode(platform: string): "win" | "mac" | "linux" | undefined {
  if (platform === "win32") return "win";
  if (platform === "darwin") return "mac";
  if (platform === "linux") return "linux";
  return undefined;
}

/** Client product label for richer device rows. Desktop is never derived
 *  from `appName` — the desktop host's name would otherwise become
 *  "Grok Build Desktop extension". */
export function deviceClientLabel(appName: string, isDesktop: boolean): string {
  if (isDesktop) return "Desktop app";
  if (appName === "Visual Studio Code") return "VS Code extension";
  if (appName === "Cursor") return "Cursor extension";
  if (appName === "Antigravity") return "Antigravity extension";
  const name = String(appName || "").trim();
  return name ? `${name} extension` : "extension";
}

const RELAY_DEVICE_FIELD_MAX = 64;

/** Relay `/api/link/start` optional fields: trim, drop control chars, max 64. */
export function sanitizeRelayDeviceField(value: string): string {
  return String(value).replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, RELAY_DEVICE_FIELD_MAX);
}

export type LinkStartBody = {
  name: string;
  installId: string;
} & RelayClientMeta;

/** Same mapped `clientLabel` / `platform` / `osLabel` as link/start — omit empty. */
export function relayClientMeta(input: RelayClientSource): RelayClientMeta {
  // A cloud environment says what it IS and nothing about the box underneath.
  //
  // It genuinely runs the desktop host on Linux, and reporting either fact is
  // worse than useless to the person reading the picker: they cannot act on the
  // operating system of a machine they do not administer, and "desktop app" is
  // actively wrong — nobody installed anything. What they need to know is who
  // runs it, so the whole parenthetical is "by afkpilot.com" and the OS half is
  // omitted rather than blanked.
  if (input.isCloud) {
    return { clientLabel: CLOUD_CLIENT_LABEL, platform: "cloud" };
  }
  const clientLabel = sanitizeRelayDeviceField(deviceClientLabel(input.appName, input.isDesktop));
  const platform = devicePlatformCode(input.platform);
  const osLabel = sanitizeRelayDeviceField(deviceOsLabel(input.platform, input.release));
  return {
    ...(clientLabel ? { clientLabel } : {}),
    ...(platform ? { platform } : {}),
    ...(osLabel ? { osLabel } : {}),
  };
}

/** POST `/api/link/start` body. `name` stays the legacy "HOST (Windows 11)"
 *  form so older relays keep working; the three extra fields are optional. */
export function buildLinkStartBody(input: {
  hostname: string;
  platform: string;
  release: string;
  installId: string;
  appName: string;
  isDesktop: boolean;
  isCloud?: boolean;
}): LinkStartBody {
  return {
    name: deviceDisplayName(input.hostname, input.platform, input.release),
    installId: input.installId,
    ...relayClientMeta(input),
  };
}

export const INITIAL_BACKOFF_MS = 1000;
export const MAX_BACKOFF_MS = 30_000;

/** Reconnect backoff: double up to the cap. */
export function nextBackoffMs(prev: number): number {
  return Math.min(Math.max(prev, INITIAL_BACKOFF_MS) * 2, MAX_BACKOFF_MS);
}

/**
 * Did this connection last long enough to call it healthy?
 *
 * Backoff used to reset when the socket OPENED, which sounds right and is
 * not: it means the delay can only grow while connections FAIL, and never
 * against one that succeeds and then dies — exactly the case it exists to
 * damp. A host whose socket opened and dropped therefore retried once a
 * second for ever, and every attempt costs the relay a database lookup.
 * Production measured 65,792,061 of them against 23,832 for the
 * per-connection ownership query, and sat at 90-95% CPU for a week.
 *
 * KNOWN COST, accepted deliberately. If the delay has already grown to the
 * cap (about five consecutive failures) and the next connection works but is
 * cut short of the bar by a SECOND interruption, the host waits the full 30s
 * instead of a second, and a phone shows the machine offline meanwhile. An
 * independent round raised it; before this change that case retried at once.
 *
 * Kept anyway. Every alternative is worse: resetting on open is the defect
 * itself, a smaller bar is a knob nobody can pick correctly, and resetting on
 * “did some real work” re-admits the storm, since a socket the relay served
 * for half a second did work too. The cost is a bounded wait that heals
 * itself; the alternative was 65 million queries and a week at 95% CPU.
 *
 * The bar is `MAX_BACKOFF_MS` rather than a new constant, and it says
 * something meaningful: a connection that outlived the longest delay we
 * would ever wait was working. Anything shorter is a flap, and a flap must
 * keep the delay it has earned.
 */
export function connectionWasHealthy(connectedMs: number): boolean {
  return connectedMs >= MAX_BACKOFF_MS;
}

/**
 * Is this host an AFK Pilot cloud environment?
 *
 * One env var, read in one place, so "am I hosted" is never re-derived from
 * something adjacent like the platform or the relay URL. Both of those have
 * other reasons to be true.
 */
export function isCloudEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CLOUD_ENVIRONMENT_ENV] === "1";
}
