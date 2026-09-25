import { spawnMspConnection, type MspHandshake, type SpawnedMspConnection } from "@muse-code/sdk";
import type { AgentContext, ContentBlock, PromptResponse } from "@agentclientprotocol/sdk";
import { Projection } from "./projection.mjs";
import { Approvals } from "./approvals.mjs";
// A deep import because the SDK root re-exports nothing from `msp.js`, and
// this is the only route to the effort vocabulary. Type-only, so it costs
// the packaging graph nothing; the disk-read assertion in
// `test/muse-session.test.ts` is what catches the union changing under us.
import type { ReasoningEffort } from "@muse-code/sdk/dist/src/msp.js";

// MSP exposes a session-wide vocabulary, with no per-model capability list.
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const satisfies readonly ReasoningEffort[];

/**
 * How long a closing adapter waits for `muse serve` to actually exit. The host
 * gives every adapter three seconds before it kills the tree, so this stays
 * comfortably inside that: a child that will not go must not be the reason the
 * user's app-quit appears to hang, and it does not need to be, because the host
 * reaps the whole tree the moment we are gone.
 */
const CHILD_EXIT_BUDGET_MS = 2000;

/**
 * Windows command shims are scripts, not binaries: Node has refused to spawn
 * a `.cmd`/`.bat` directly since CVE-2024-27980. `src/cli-process.ts` carries
 * the same rule for the host, but the adapter compiles under its own tsconfig
 * whose rootDir is `adapters/muse`, so it cannot import that file.
 */
function museCliNeedsShell(cliPath: string, platform = process.platform): boolean {
  return platform === "win32" && /\.(cmd|bat)$/i.test(cliPath);
}

function childExitTimeout(): Promise<undefined> {
  return new Promise<undefined>(resolve => {
    const timer = setTimeout(() => resolve(undefined), CHILD_EXIT_BUDGET_MS);
    timer.unref?.();
  });
}

interface PendingTurn {
  turnId?: string;
  cancelRequested?: boolean;
  early: Map<string, Record<string, any>>;
  resolve: (result: Record<string, any>) => void;
  reject: (error: unknown) => void;
}

/** Owns exactly one MSP child and one conversation or a shared read-only catalog connection. */
export class MuseSession {
  private handshake?: MspHandshake;
  private msp?: SpawnedMspConnection;
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private sessionId?: string;
  private reasoningEffort?: ReasoningEffort;
  private activeTurnId?: string;
  private creating = false;
  private replayBuffer?: { method: string; params: Record<string, any> }[];
  private pending?: PendingTurn;
  private updates = Promise.resolve();
  private readonly projection: Projection;
  private readonly approvals: Approvals;

  constructor(
    private readonly client: Pick<AgentContext, "notify" | "request">,
    private readonly log: (message: string) => void,
    private readonly fatal: (error: unknown) => void,
    private readonly spawn = spawnMspConnection,
  ) {
    this.projection = new Projection(update => {
      this.updates = this.updates.then(() => this.client.notify("session/update", {
        sessionId: this.sessionId!, update,
      }));
      void this.updates.catch(error => this.fail(error));
    }, log);
    this.approvals = new Approvals(
      params => this.client.request("session/request_permission", params),
      params => this.connection().command("approval/decide", params),
      () => this.cancel(this.sessionId!),
      error => this.fail(error),
    );
  }

  initialize(): Promise<void> {
    if (this.closing) return Promise.reject(new Error("Muse adapter is closing"));
    return this.starting ??= this.start();
  }

  private async start(): Promise<void> {
    const executable = process.env.MUSE_CODE_EXECUTABLE;
    if (!executable) throw new Error("MUSE_CODE_EXECUTABLE must name the installed Muse CLI");
    // The SDK spawns the command itself and exposes neither `shell` nor
    // `windowsVerbatimArguments`, so the shim is wrapped here instead. The
    // executable and `serve` stay separate argv entries. Omit /s: it strips
    // Node's quotes around a spaced executable path before cmd resolves it.
    const needsShell = museCliNeedsShell(executable);
    const handshake = this.handshake = this.spawn({
      command: needsShell ? process.env.COMSPEC || "cmd.exe" : executable,
      args: needsShell ? ["/d", "/c", executable, "serve"] : ["serve"],
      cwd: process.cwd(), env: process.env,
      onStderr: chunk => process.stderr.write(chunk) });
    handshake.onNotification(notification => {
      try { this.notification(notification.method, notification.params ?? {}); }
      catch (error) { this.fail(error); }
    });
    handshake.onProtocolError(error => this.fail(error));
    handshake.onServerRequest(async request => {
      if (request.method === "approval/request" && this.sessionId && request.params && request.params.sessionId === this.sessionId) {
        this.notification("approval/requested", request.params);
        // The server request is only a presentation receipt. The decision is
        // sent separately using the offered choice and requirement ids.
        return {};
      }
      const error = new Error(`Unsupported Muse server request: ${request.method}`);
      this.fail(error);
      throw error;
    });
    void handshake.exited.then(exit => {
      if (!this.closing) this.fail(new Error(`Muse exited unexpectedly: ${JSON.stringify(exit)}`));
    }, error => this.fail(error));
    const timeout = setTimeout(() => this.fail(new Error("Muse initialize timed out")), 20_000);
    try {
      this.msp = await handshake.initialize({ clientInfo: { name: "grok_build_muse_adapter", version: "1" },
        capabilities: { requestedCapabilities: [], experimentalApi: false, userInputDialogs: false } });
      this.log(`Muse initialized: ${JSON.stringify(this.msp.initializeResult.serverInfo)}`);
      if (this.msp.fingerprintWarning) this.log(`Muse schema warning: ${JSON.stringify(this.msp.fingerprintWarning)}`);
      void this.msp.connection.closed.then(() => {
        if (!this.closing) this.fail(new Error("Muse transport closed"));
      });
    } finally { clearTimeout(timeout); }
  }

  private connection() {
    if (!this.msp || this.closing) throw new Error("Muse connection is not available");
    return this.msp.connection;
  }

  async newSession(workspaceRoot: string, mcpServers: unknown[]) {
    if (this.sessionId || this.creating) throw new Error("Muse adapter already owns a session");
    if (mcpServers.length) throw new Error("Muse adapter does not accept client MCP servers");
    this.creating = true;
    try {
      const result = await this.connection().command("session/start", { workspaceRoot });
      const session = result.session as { sessionId?: string; modelId?: string } | undefined;
      if (!session?.sessionId) throw new Error("Muse session/start returned no sessionId");
      this.sessionId = session.sessionId;
      return { sessionId: session.sessionId, models: await this.models(session.modelId) };
    } finally { this.creating = false; }
  }


  async models(currentModelId?: string) {
    const catalog = await this.connection().request("model/list", {});
    if (!Array.isArray(catalog.models)) throw new Error("Muse model/list returned no models");
    const activeModelId = currentModelId ?? catalog.models.find((m: any) => m.isDefault)?.modelId;
    return { currentModelId: activeModelId,
      availableModels: catalog.models.map((model: any) => ({ modelId: model.modelId,
        name: model.displayLabel || model.modelId, description: model.description ?? undefined,
        _meta: { totalContextTokens: model.contextLimit,
          supportsReasoningEffort: true,
          reasoningEfforts: REASONING_EFFORTS.map(value => ({ value })),
          ...(model.modelId === activeModelId && this.reasoningEffort !== undefined
            ? { reasoningEffort: this.reasoningEffort } : {}),
        } })) };
  }

  async listSessions(cwd?: string, cursor?: string | null) {
    const result = await this.connection().request("session/list", {
      ...(cwd ? { workspaceRoot: cwd } : {}), ...(cursor ? { cursor } : {}), limit: 200,
    });
    if (!Array.isArray(result.sessions)) throw new Error("Muse session/list returned no sessions");
    return { sessions: result.sessions.map((s: any) => ({ sessionId: s.sessionId, cwd: s.workspaceRoot,
      title: s.title || s.firstUserPrompt, updatedAt: s.updatedAt,
      _meta: { createdAt: s.createdAt, turnCount: s.turnCount, modelId: s.modelId, branch: s.branch } })),
      nextCursor: result.nextCursor as string | null };
  }

  async setModel(sessionId: string, modelId: string) {
    this.assertSession(sessionId);
    const result = await this.connection().command("session/setModel", { sessionId, model: { modelId } });
    if (result.status !== "accepted") throw new Error("Muse model selection was rejected");
    return {};
  }

  async setReasoningEffort(sessionId: string, reasoningEffort: ReasoningEffort) {
    this.assertSession(sessionId);
    const result = await this.connection().command("session/setReasoningEffort", { sessionId, reasoningEffort });
    if (result.status !== "accepted") throw new Error(`Muse reasoning effort "${reasoningEffort}" was rejected`);
    this.reasoningEffort = reasoningEffort;
    return {};
  }

  async loadSession(sessionId: string, cwd: string, mcpServers: unknown[]) {
    if (this.sessionId || this.creating) throw new Error("Muse adapter already owns a session");
    if (mcpServers.length) throw new Error("Muse adapter does not accept client MCP servers");
    this.creating = true;
    this.sessionId = sessionId;
    this.replayBuffer = [];
    try {
      const result = await this.connection().command("session/resume", { sessionId, history: "inline" });
      const resumed = result.session as any;
      if (resumed?.sessionId !== sessionId || resumed.workspaceRoot !== cwd) throw new Error("Muse resume workspace/session mismatch");
      this.activeTurnId = resumed.activeTurnId ?? undefined;
      const history = result.history as any;
      this.reasoningEffort = history?.snapshot?.state?.reasoningEffort?.reasoningEffort;
      const seen = new Set<string>();
      let items: any[];
      if (history?.mode === "inline" && Array.isArray(history.items)) items = history.items;
      else if (history?.mode === "snapshot" && Array.isArray(history.snapshot?.state?.items)) items = history.snapshot.state.items;
      else {
        // Fold complete durable revisions before projecting: replay deltas are not history.
        const folded = new Map<string, any>();
        let cursor: string | undefined;
        const cursors = new Set<string>();
        let reachedHead = false;
        do {
          const page = await this.connection().request("view/page", { sessionId, direction: "forward", limit: 1000,
            ...(cursor ? { cursor } : {}) });
          if (!Array.isArray(page.events)) throw new Error("Muse history page returned no events");
          for (const event of page.events as any[]) {
            const params = event.params ?? {};
            if (typeof params.viewCursor === "string") seen.add(params.viewCursor);
            const item = params.item;
            if (item && (!folded.has(item.itemId) || folded.get(item.itemId).revision < item.revision)) folded.set(item.itemId, item);
            if (params.viewCursor === result.viewCursor) { reachedHead = true; break; }
          }
          if (reachedHead || !page.nextCursor) break;
          cursor = String(page.nextCursor);
          if (cursors.has(cursor)) throw new Error("Muse history page cursor repeated");
          cursors.add(cursor);
        } while (true);
        items = [...folded.values()];
      }
      for (const item of items) this.projection.acceptHistory(item);
      if (history?.snapshot?.state?.contextUsage) {
        this.projection.accept("session/contextUsage", history.snapshot.state.contextUsage);
      }
      const buffered = this.replayBuffer;
      this.replayBuffer = undefined;
      for (const event of buffered) if (!seen.has(event.params.viewCursor)) this.notification(event.method, event.params);
      if (Array.isArray(result.pendingRequests) && result.pendingRequests.length) {
        const pending = await this.connection().request("approval/listPending", { sessionId });
        if (Array.isArray(pending.userInputs) && pending.userInputs.length) throw new Error("Muse resume has an unsupported user-input request");
        for (const approval of (pending.approvals as any[] ?? [])) this.approvals.accept("approval/requested", approval);
      }
      await this.updates;
      return { _meta: { models: await this.models(resumed.modelId) } };
    } catch (error) {
      this.sessionId = undefined;
      this.projection.clear();
      this.fail(error);
      throw error;
    } finally { this.replayBuffer = undefined; this.creating = false; }
  }

  async prompt(sessionId: string, prompt: ContentBlock[]): Promise<PromptResponse> {
    this.assertSession(sessionId);
    if (this.pending || this.activeTurnId) throw new Error("Muse session already has an active prompt");
    if (!prompt.length || prompt.some(part => part.type !== "text")) throw new Error("Muse adapter accepts text prompts only");
    this.approvals.clear();
    let pending!: PendingTurn;
    const completed = new Promise<Record<string, any>>((resolve, reject) => {
      pending = { resolve, reject, early: new Map() };
    });
    // A transport failure can arrive while turn/start is still awaiting admission.
    void completed.catch(() => {});
    this.pending = pending;
    try {
      const admitted = await Promise.race([this.connection().command("turn/start", {
        sessionId, input: prompt.map(part => ({ type: "text", text: (part as { text: string }).text })),
      }), completed.then(() => new Promise<never>(() => {}))]);
      if (admitted.status !== "accepted" || typeof admitted.turnId !== "string" || admitted.startedNewTurn !== true) {
        throw new Error(`Muse did not start a new turn: ${JSON.stringify(admitted)}`);
      }
      pending.turnId = admitted.turnId;
      this.log(`Muse turn admitted: ${admitted.turnId}`);
      const early = pending.early.get(admitted.turnId);
      if (early) pending.resolve(early);
      else if (pending.cancelRequested) await this.cancel(sessionId);
      pending.early.clear();
      const terminal = await completed;
      await this.updates;
      await this.readSubscriptionUsage();
      this.log(`Muse turn completed: ${JSON.stringify({ turnId: terminal.turnId, terminal: terminal.terminal })}`);
      if (terminal.terminal === "completed") return { stopReason: "end_turn" };
      if (terminal.terminal === "cancelled") return { stopReason: "cancelled" };
      throw new Error(`Muse turn failed: ${JSON.stringify(terminal.error ?? terminal.terminal)}`);
    } finally {
      this.pending = undefined;
      this.approvals.clear();
    }
  }

  async cancel(sessionId: string): Promise<void> {
    this.assertSession(sessionId);
    if (this.pending) this.pending.cancelRequested = true;
    const turnId = this.pending?.turnId ?? this.activeTurnId;
    if (turnId) await this.connection().command("turn/cancel", { sessionId, turnId });
  }

  private assertSession(id: string): void {
    if (!this.sessionId || id !== this.sessionId) throw new Error("Unknown Muse session");
  }

  /** MSP `usage/read` after a turn, and `usage/changed` (no session id). The
   *  host maps the raw payload. A failed read is logged and never fatal. */
  private async readSubscriptionUsage(): Promise<void> {
    if (!this.sessionId) return;
    try {
      const result = await this.connection().request("usage/read", {});
      const usage = result?.usage;
      if (usage && typeof usage === "object") await this.publishSubscriptionUsage(usage as Record<string, any>);
    } catch (error) {
      this.log(`Muse usage/read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private publishSubscriptionUsage(usage: Record<string, any>): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId) return Promise.resolve();
    try {
      return Promise.resolve(this.client.notify("_muse/subscription_usage", { sessionId, usage })).catch(error => {
        this.log(`Muse subscription usage was not delivered: ${error instanceof Error ? error.message : String(error)}`);
      });
    } catch (error) {
      this.log(`Muse subscription usage was not delivered: ${error instanceof Error ? error.message : String(error)}`);
      return Promise.resolve();
    }
  }

  private notification(method: string, params: Record<string, any>): void {
    // `usage/changed` carries no session id, so the check below would drop it.
    if (method === "usage/changed") {
      if (this.sessionId) void this.publishSubscriptionUsage(params);
      return;
    }
    if (params.sessionId !== this.sessionId) return;
    if (this.replayBuffer) { this.replayBuffer.push({ method, params }); return; }
    if (method === "turn/started") this.activeTurnId = params.turnId;
    if (method === "turn/completed" && params.turnId === this.activeTurnId) this.activeTurnId = undefined;
    this.projection.accept(method, params);
    this.approvals.accept(method, params);
    if (method === "userInput/requested" || method === "view/gap") {
      this.fail(new Error(`Muse ${method} is unsupported in this boundary slice`));
    }
    if (method === "turn/completed" && this.pending && typeof params.turnId === "string") {
      if (!this.pending.turnId) this.pending.early.set(params.turnId, params);
      else if (params.turnId === this.pending.turnId) this.pending.resolve(params);
    }
  }

  private fail(error: unknown): void {
    this.pending?.reject(error);
    if (!this.closing) this.fatal(error);
  }

  close(): Promise<void> {
    return this.closing ??= Promise.resolve().then(async () => {
      this.pending?.reject(new Error("Muse adapter is closing"));
      this.approvals.clear();
      const handshake = this.handshake;
      if (!handshake) return;
      try { await handshake.close(); }
      finally {
        // The evidence is written only AFTER the SDK observes the child's close
        // — but the wait is bounded (above), so a wedged child costs a logged
        // timeout rather than a frozen quit. No exit observed is not evidence of
        // an unclean one, so it is recorded and not raised.
        const exit = await Promise.race([handshake.exited, childExitTimeout()]);
        this.log(`MUSE_CHILD_EXIT ${JSON.stringify(exit ?? { timedOutMs: CHILD_EXIT_BUDGET_MS })}`);
        if (exit && (exit.code !== 0 || exit.signal !== null)) throw new Error("Muse child did not exit cleanly");
      }
    });
  }
}
