// Remote uplink — the OUTBOUND leg of remote control. Dials the relay over
// ws(s) with a device token, ferries the host<->webview protocol in the frames
// defined in remote-frames.ts, and reconnects with backoff. No inbound port on
// the dev box; the relay pairs this connection with browser clients.
//
// **Authorization boundary.** Every HostMsg that can reach a remote client
// passes through {@link mayDeliverRemoteHostMsg} here, at the socket write —
// including catch-up snapshots. Callers may pre-filter (sidebar `deliverRemote`
// still does, for transform + postTap), but a forgotten pre-filter cannot
// bypass this gate.

import WebSocket from "ws";
import type { HostMsg, WebviewMsg } from "./protocol";
import {
  buildUplinkUrl,
  helloFrame,
  hostFrame,
  hostToFrame,
  snapshotFrame,
  workingFrame,
  parseRelayFrame,
  nextBackoffMs,
  refusalRetryMs,
  CLOSE_BAD_TOKEN,
  CLOSE_DEVICE_BUSY,
  INITIAL_BACKOFF_MS,
  connectionWasHealthy,
  redactRelayUrl,
  type RelayClientSource,
} from "./remote-frames";
import {
  isSelfScopedOutbound,
  mayDeliverRemoteHostMsg,
  repoSessionsMessageForRemote,
} from "./remote-policy";

/**
 * Live project-scope inputs for the outbound write gate. Re-read on every
 * send so a just-closed folder cannot leak through a stale snapshot of the set.
 */
/**
 * How often to say "still working" while a turn is in flight.
 *
 * The relay lets a cloud machine go back to sleep after 90 seconds of silence,
 * so 30 leaves room for two lost beats before a working machine is dropped.
 * Anything faster buys nothing: the hypervisor's own suspend timer is about a
 * minute, and this only has to beat that.
 */
export const WORKING_HEARTBEAT_MS = 30_000;

export interface RemoteUplinkAuth {
  /** Currently authorized session/repo cwds (open folders + worktrees). */
  authorizedCwds: () => readonly string[];
  /**
   * Session/repo cwd that owns conversation payload for this client. Used when
   * the write call does not pass an explicit `scopeCwd` (snapshots, etc.).
   */
  scopeCwdForClient: (clientId: string) => string | undefined;
  /**
   * True when this client may receive a delivery whose payload is scoped to
   * `scopeCwd`. Defaults to sameCwd(scopeCwdForClient(id), scopeCwd) when
   * omitted. Sidebar supplies a richer check (selected repo cwd OR active
   * session cwd) so repo-scoped fan-out still reaches worktree sessions.
   */
  clientOwnsScope?: (clientId: string, scopeCwd: string) => boolean;
  sameCwd: (a: string, b: string) => boolean;
}

/**
 * Recipients that own `scopeCwd`. Pure — unit-tested independently of the socket.
 * When `clientOwnsScope` is absent, ownership is `sameCwd(scopeCwdForClient, scope)`.
 */
export function filterRecipientsOwningScope(
  clientIds: readonly string[],
  scopeCwd: string,
  auth: Pick<RemoteUplinkAuth, "scopeCwdForClient" | "clientOwnsScope" | "sameCwd">,
): string[] {
  const out: string[] = [];
  for (const id of clientIds) {
    if (auth.clientOwnsScope) {
      if (auth.clientOwnsScope(id, scopeCwd)) out.push(id);
      continue;
    }
    const owned = auth.scopeCwdForClient(id);
    if (owned !== undefined && auth.sameCwd(owned, scopeCwd)) out.push(id);
  }
  return out;
}

/**
 * Typed delivery target for a host→client write. Callers still name recipients
 * and (when project-scoped) the originating scope; the uplink derives nothing
 * from a free-form cwd alone — it re-filters recipients to owners of that scope
 * and re-checks {@link mayDeliverRemoteHostMsg}.
 *
 * What remains caller-supplied: the client id list and the scope string. A later
 * pass could replace both with session/repo handles only.
 */
export interface RemoteDeliveryTarget {
  clientIds: readonly string[];
  /** Project scope that owns the payload; omit for device-global messages. */
  scopeCwd?: string;
}

export interface RemoteUplinkOptions {
  /** ws(s)://relay-host[:port] — the relay's base URL. */
  relayUrl: string;
  /** Long-lived device token from the link flow. */
  token: string;
  deviceName?: string;
  /** Same source `relayClientMeta` / `buildLinkStartBody` map into hello. */
  client?: RelayClientSource;
  /** Ordered catch-up (already remote-transformed) for a newly-ready browser client. */
  snapshot: (clientId: string) => HostMsg[];
  /**
   * Project authorization for every outbound HostMsg. Required — without it
   * the uplink refuses to send (fail closed).
   */
  auth: RemoteUplinkAuth;
  /** A browser connection is ready to receive its client-specific snapshot. */
  onClientReady?: (clientId: string, tabToken?: string) => void;
  /** A specific browser connection has left the relay. */
  onClientLeft?: (clientId: string) => void;
  /** Authoritative surviving-client roster replayed after each uplink connect. */
  onClientRoster?: (clientIds: string[]) => void;
  /** The relay authoritatively rejected this device credential (close 4001). */
  onCredentialRevoked?: () => void;
  /** A browser client's webview->host message (already relayed + parsed). */
  onClientMessage: (clientId: string, msg: WebviewMsg) => void;
  log: (line: string) => void;
}

/**
 * Filter HostMsgs through the project-scope gate. Pure helper — also the unit-
 * test surface for "snapshot carrying closed-project data is scrubbed".
 */
export function filterAuthorizedOutbound(
  msgs: readonly HostMsg[],
  authorizedCwds: readonly string[],
  scopeCwd: string | undefined,
  sameCwd: (a: string, b: string) => boolean,
): HostMsg[] {
  return msgs.flatMap((message) => {
    const msg = message.type === "repoSessions"
      ? repoSessionsMessageForRemote(message, authorizedCwds, sameCwd)
      : message;
    return mayDeliverRemoteHostMsg(msg, authorizedCwds, scopeCwd, sameCwd) ? [msg] : [];
  });
}

export class RemoteUplink {
  private ws?: WebSocket;
  private backoff = INITIAL_BACKOFF_MS;
  /** When the current run of 4002 refusals began; 0 when there is none. */
  private refusedSince = 0;
  /** When the live socket opened, so a close can tell healthy from flapping. */
  private openedAt = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private disposed = false;
  private awaitingRosterCount = false;
  private workingTimer?: NodeJS.Timeout;
  private reconnectRoster?: { expected: number; clientIds: Set<string> };

  constructor(private readonly opts: RemoteUplinkOptions) {}

  start(): void {
    this.connect();
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Tell the relay whether a turn is in flight.
   *
   * Only a cloud machine acts on this, and it is the difference between a long
   * turn finishing and a long turn being frozen mid-tool: the hypervisor
   * suspends a machine roughly a minute after its last interaction, and it
   * decides that from traffic, not from what the machine believes it is doing.
   * A turn that is compiling, installing, or waiting on a test run says nothing
   * for minutes at a time, so the frames a streaming answer produces are not
   * something to rely on.
   *
   * On a laptop this is a few bytes a minute to a socket that is already open.
   * Idempotent — the callers re-assert state rather than tracking transitions.
   */
  setWorking(working: boolean): void {
    if (!working) {
      if (this.workingTimer) clearInterval(this.workingTimer);
      this.workingTimer = undefined;
      return;
    }
    if (this.workingTimer) return;
    this.sendWorking();
    this.workingTimer = setInterval(() => this.sendWorking(), WORKING_HEARTBEAT_MS);
    this.workingTimer.unref?.();
  }

  /** Best-effort: a heartbeat is worth nothing if losing one can throw. */
  private sendWorking(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(workingFrame()));
    } catch {
      /* the reconnect path re-establishes the socket; the next beat rides it */
    }
  }

  /** Fan a host->webview message out to the relay (which broadcasts to this
   *  device's browser clients). Silently dropped while disconnected — a
   *  reconnecting client re-syncs via its own `ready` -> snapshot. */
  broadcast(msg: HostMsg, scopeCwd?: string): void {
    if (!this.authorizeWrite(msg, scopeCwd)) return;
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(hostFrame(msg)));
      } catch {
        /* teardown race; reconnect handles it */
      }
    }
  }

  /**
   * Send one host message only to the named browser clients.
   * Prefer {@link deliver} with a {@link RemoteDeliveryTarget}; this overload
   * keeps existing call sites.
   */
  broadcastTo(clientIds: string[], msg: HostMsg, scopeCwd?: string): void {
    this.deliver({ clientIds, scopeCwd }, msg);
  }

  /**
   * Socket write with a typed delivery target. When `scopeCwd` is set, every
   * recipient must own that scope ({@link filterRecipientsOwningScope}); the
   * message is then gated with {@link mayDeliverRemoteHostMsg} for that scope.
   * Callers cannot widen delivery to tabs that merely share an authorized cwd
   * set — ownership is per-client.
   */
  deliver(target: RemoteDeliveryTarget, msg: HostMsg): void {
    const unique = [...new Set(target.clientIds)];
    if (!unique.length) return;
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.opts.log(`[remote] could not send ${msg.type} (uplink is not connected)`);
      return;
    }
    const authorized = this.opts.auth.authorizedCwds();
    const outbound = msg.type === "repoSessions"
      ? repoSessionsMessageForRemote(msg, authorized, this.opts.auth.sameCwd)
      : msg;
    if (msg.type === "repoSessions" && outbound.type === "repoSessions"
      && outbound.entries.length !== msg.entries.length) {
      const removed = msg.entries.length - outbound.entries.length;
      this.opts.log(`[remote] filtered ${removed} unauthorized repoSessions ${removed === 1 ? "entry" : "entries"}`);
    }
    // A frame that names its own project (`repoSessions`, `sessionName`) is
    // ABOUT that project, not payload from the recipient's conversation, so the
    // ownership filter below must not see it: the rail asks about a sibling
    // project by design and every answer was being dropped as "does not own
    // scope". authorizeWrite still checks the frame's own cwd against the live
    // authorized set, so this widens delivery, never authorization.
    const scopeCwd = isSelfScopedOutbound(outbound.type) ? undefined : target.scopeCwd;

    if (scopeCwd !== undefined) {
      const owners = filterRecipientsOwningScope(unique, scopeCwd, this.opts.auth);
      for (const id of unique) {
        if (!owners.includes(id)) {
          this.opts.log(
            `[remote] dropped ${outbound.type} for client ${id} (does not own scope: ${scopeCwd})`,
          );
        }
      }
      if (!owners.length) return;
      if (!this.authorizeWrite(outbound, scopeCwd)) return;
      try {
        this.ws.send(JSON.stringify(hostToFrame(owners, outbound)));
      } catch {
        this.opts.log(`[remote] could not send ${outbound.type} (uplink write failed)`);
      }
      return;
    }

    // No explicit scope: authorize each client against its own scope so a
    // multi-tab send cannot borrow another tab's open project.
    if (unique.length === 1) {
      const scope = this.opts.auth.scopeCwdForClient(unique[0]);
      if (!this.authorizeWrite(outbound, scope)) return;
      try {
        this.ws.send(JSON.stringify(hostToFrame(unique, outbound)));
      } catch {
        this.opts.log(`[remote] could not send ${outbound.type} (uplink write failed)`);
      }
      return;
    }
    const allowed: string[] = [];
    for (const id of unique) {
      const scope = this.opts.auth.scopeCwdForClient(id);
      if (this.authorizeWrite(outbound, scope, /* silent */ true)) allowed.push(id);
      else {
        this.opts.log(
          `[remote] dropped ${outbound.type} for client ${id} (project scope not authorized: ${scope ?? "<none>"})`,
        );
      }
    }
    if (!allowed.length) return;
    try {
      this.ws.send(JSON.stringify(hostToFrame(allowed, outbound)));
    } catch {
      this.opts.log(`[remote] could not send ${outbound.type} (uplink write failed)`);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (this.workingTimer) clearInterval(this.workingTimer);
    this.workingTimer = undefined;
    try {
      this.ws?.close();
    } catch {
      /* best effort */
    }
    this.ws = undefined;
  }

  /**
   * Sole authorization check before any HostMsg is serialized onto the socket.
   * Returns false when the message must not leave.
   */
  private authorizeWrite(
    msg: HostMsg,
    scopeCwd: string | undefined,
    silent = false,
  ): boolean {
    const authorized = this.opts.auth.authorizedCwds();
    if (mayDeliverRemoteHostMsg(msg, authorized, scopeCwd, this.opts.auth.sameCwd)) {
      return true;
    }
    if (!silent) {
      this.opts.log(
        `[remote] dropped ${msg.type} (project scope not authorized: ${scopeCwd ?? "<none>"})`,
      );
    }
    return false;
  }

  private authorizedSnapshot(clientId: string, msgs: readonly HostMsg[]): HostMsg[] {
    const scope = this.opts.auth.scopeCwdForClient(clientId);
    const authorized = this.opts.auth.authorizedCwds();
    const kept = filterAuthorizedOutbound(
      msgs,
      authorized,
      scope,
      this.opts.auth.sameCwd,
    );
    if (kept.length < msgs.length) {
      const dropped = msgs.length - kept.length;
      this.opts.log(
        `[remote] scrubbed ${dropped} snapshot message(s) for ${clientId} (project scope not authorized: ${scope ?? "<none>"})`,
      );
    }
    return kept;
  }

  private connect(): void {
    if (this.disposed) return;
    const url = buildUplinkUrl(this.opts.relayUrl, this.opts.token);
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on("open", () => {
      // NOT a backoff reset. Opening proves nothing — see connectionWasHealthy.
      this.openedAt = Date.now();
      this.awaitingRosterCount = true;
      this.reconnectRoster = undefined;
      // Redacted: a relay may live behind a base path, and that path is not
      // ours to print into an output channel the user may paste anywhere.
      this.opts.log(`[remote] uplink connected to ${redactRelayUrl(this.opts.relayUrl)}`);
      ws.send(JSON.stringify(helloFrame(this.opts.deviceName, this.opts.client)));
    });
    ws.on("message", (raw) => {
      const frame = parseRelayFrame(raw.toString());
      if (!frame) return;
      switch (frame.t) {
        case "client-ready":
          // The relay-side twin of the LAN bridge's ready->snapshot: catch this
          // one browser client up, routed back through the relay by clientId.
          // Authorization runs HERE on the snapshot payload — the only path that
          // does not go through broadcast/broadcastTo.
          try {
            this.opts.onClientReady?.(frame.clientId, frame.tabToken);
            const rawSnap = this.opts.snapshot(frame.clientId);
            const msgs = this.authorizedSnapshot(frame.clientId, rawSnap);
            ws.send(JSON.stringify(snapshotFrame(frame.clientId, msgs)));
          } catch {
            /* teardown race */
          }
          if (this.reconnectRoster) {
            this.reconnectRoster.clientIds.add(frame.clientId);
            this.finishRosterIfComplete();
          }
          return;
        case "msg":
          try {
            this.opts.onClientMessage(frame.clientId, frame.msg);
          } catch (e) {
            this.opts.log(`[remote] dropped malformed client message: ${(e as Error)?.message ?? String(e)}`);
          }
          return;
        case "client-left":
          this.opts.onClientLeft?.(frame.clientId);
          this.reconnectRoster?.clientIds.delete(frame.clientId);
          return;
        case "clients":
          this.opts.log(`[remote] relay clients: ${frame.count}`);
          if (this.awaitingRosterCount) {
            this.awaitingRosterCount = false;
            this.reconnectRoster = { expected: frame.count, clientIds: new Set() };
          } else if (this.reconnectRoster) {
            this.reconnectRoster.expected = frame.count;
          }
          this.finishRosterIfComplete();
          return;
      }
    });
    ws.on("close", (code) => {
      if (this.disposed) return;
      // 4001 = relay rejected the token — retrying with the same token is
      // pointless; the user must re-link. Stop, loudly.
      if (code === CLOSE_BAD_TOKEN) {
        this.opts.log(`[remote] uplink rejected (revoked device token) — run "AFK Pilot: Link this device" again`);
        try {
          this.opts.onCredentialRevoked?.();
        } catch (e) {
          this.opts.log(`[remote] failed to handle revoked credential: ${(e as Error)?.message ?? String(e)}`);
        }
        return;
      }
      // A connection that lasted is evidence the relay is reachable, so the
      // next attempt starts from the floor. One that did not keeps the delay
      // it earned, which is what stops a flapping socket hammering the relay.
      const connectedMs = this.openedAt ? Date.now() - this.openedAt : 0;
      this.openedAt = 0;
      // 4002 = another socket is holding this device, and it is nearly always
      // this host's own frozen one. The relay challenges that incumbent as
      // soon as we knock, so the obstacle clears in seconds — wait those out
      // briefly rather than earning a thirty-second delay for it. Bounded:
      // past the window the refusal is a real rival, and ordinary backoff
      // takes over with the delay it already had. See `refusalRetryMs`.
      if (code === CLOSE_DEVICE_BUSY) {
        if (!this.refusedSince) this.refusedSince = Date.now();
        const soon = refusalRetryMs(Date.now() - this.refusedSince);
        if (soon !== undefined) {
          this.opts.log(`[remote] uplink refused (device still held); retrying in ${(soon / 1000).toFixed(1)}s`);
          this.reconnectTimer = setTimeout(() => this.connect(), soon);
          return;
        }
      } else {
        this.refusedSince = 0;
      }
      if (connectionWasHealthy(connectedMs)) this.backoff = INITIAL_BACKOFF_MS;
      this.opts.log(`[remote] uplink disconnected (code ${code}); retrying in ${Math.round(this.backoff / 1000)}s`);
      this.reconnectTimer = setTimeout(() => this.connect(), this.backoff);
      this.backoff = nextBackoffMs(this.backoff);
    });
    ws.on("error", (e) => {
      this.opts.log(`[remote] uplink error: ${(e as Error).message}`);
      try {
        ws.close();
      } catch {
        /* triggers the close handler's retry */
      }
    });
  }

  private finishRosterIfComplete(): void {
    const roster = this.reconnectRoster;
    if (!roster || roster.clientIds.size < roster.expected) return;
    this.reconnectRoster = undefined;
    this.opts.onClientRoster?.([...roster.clientIds]);
  }
}
