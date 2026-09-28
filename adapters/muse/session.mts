import { MspError, spawnMspConnection, type MspHandshake, type SpawnedMspConnection } from "@muse-code/sdk";
import { RequestError, type AgentContext, type ContentBlock, type PromptResponse } from "@agentclientprotocol/sdk";
import { Projection } from "./projection.mjs";
import { Approvals } from "./approvals.mjs";
// A deep import because the SDK root re-exports nothing from `msp.js`, and
// this is the only route to the effort vocabulary. Type-only, so it costs
// the packaging graph nothing; the disk-read assertion in
// `test/muse-session.test.ts` is what catches the union changing under us.
import type { ApprovalMode, ReasoningEffort } from "@muse-code/sdk/dist/src/msp.js";

// MSP exposes a session-wide vocabulary, with no per-model capability list.
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const satisfies readonly ReasoningEffort[];

// This adapter has its own NodeNext rootDir; the host keeps the wire ids in mode-prefs.ts.
const APPROVAL_MODES = { yolo: "allowAll", agent: "promptUnmatched", onRequest: "onRequest", denyUnmatched: "denyUnmatched" } as const satisfies Record<string, ApprovalMode>;
const MODE_NAMES = { yolo: "Allow all", agent: "Prompt unmatched", onRequest: "On request", denyUnmatched: "Deny unmatched" };
function approvalModeFor(id: string): ApprovalMode | undefined {
  return Object.hasOwn(APPROVAL_MODES, id) ? APPROVAL_MODES[id as keyof typeof APPROVAL_MODES] : undefined;
}

const RESUME_RETRY_DELAY_MS = 300;
const RESUME_RETRY_WINDOW_MS = 10_000;

/** turnCount counts completed turns, not prompts. Keep unfinished work and
 *  forks; creation/resume bookkeeping can advance updatedAt on a blank row. */
function isBlankMuseSession(session: Record<string, any>): boolean {
  const hasText = (value: unknown) => typeof value === "string" && !!value.trim();
  return session.turnCount === 0 && session.activeTurnId === null
    && session.forkedFrom === null && session.status !== "running"
    && !hasText(session.firstUserPrompt) && !hasText(session.title)
    && !hasText(session.lastActivityAt);
}

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
  queued?: boolean;
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
  private approvalMode: ApprovalMode = "promptUnmatched";
  private shellSandbox = true;
  private cloud = false;
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
    const posture = JSON.parse(process.env.GROK_MUSE_POSTURE || "{}");
    this.cloud = posture.cloud === true;
    this.approvalMode = approvalModeFor(posture.mode) ?? "promptUnmatched";
    if (this.approvalMode === "denyUnmatched") this.approvalMode = "promptUnmatched";
    // The process is not attached yet. A saved On request history is checked
    // by session/read before resume; a new cloud session uses the safe default.
    if (this.cloud && this.approvalMode === "onRequest") this.approvalMode = "promptUnmatched";
    this.shellSandbox = !this.cloud && (posture.mode === "onRequest" || (posture.mode !== "yolo" && posture.shellSandbox !== false));
    this.assertSandbox(this.approvalMode);
    const args = ["serve"];
    if (!this.shellSandbox) args.push("--disable-sandbox");
    if (!this.cloud && (posture.sandboxNetwork === "restricted" || posture.sandboxNetwork === "enabled")) {
      args.push("--sandbox-network", posture.sandboxNetwork);
    }
    if (posture.mode === "yolo" || posture.trustWorkspaces === true) args.push("--trust-workspace");
    const handshake = this.handshake = this.spawn({
      command: needsShell ? process.env.COMSPEC || "cmd.exe" : executable,
      args: needsShell ? ["/d", "/c", executable, ...args] : args,
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
      const result = await this.connection().command("session/start", { workspaceRoot, approvalMode: this.approvalMode });
      const session = result.session as { sessionId?: string; modelId?: string; approvalMode?: { mode: ApprovalMode } } | undefined;
      if (!session?.sessionId) throw new Error("Muse session/start returned no sessionId");
      this.sessionId = session.sessionId;
      this.approvalMode = session.approvalMode?.mode ?? this.approvalMode;
      this.assertSandbox(this.approvalMode);
      return { sessionId: session.sessionId, models: await this.models(session.modelId), ...this.modes(session.approvalMode?.mode) };
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
    return { sessions: result.sessions.filter((s: any) => !isBlankMuseSession(s)).map((s: any) => ({ sessionId: s.sessionId, cwd: s.workspaceRoot,
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

  private modes(mode: unknown) {
    const currentModeId = Object.keys(APPROVAL_MODES).find(id => approvalModeFor(id) === mode);
    if (!currentModeId) return {};
    return { modes: { currentModeId, availableModes: Object.entries(MODE_NAMES)
      .filter(([id]) => id !== "denyUnmatched" && (!this.cloud || id !== "onRequest")).map(([id, name]) => ({ id, name })) } };
  }

  private assertSandbox(mode: unknown): void {
    if (mode === "onRequest" && this.cloud) {
      throw new RequestError(-32602, "Muse On request is unavailable on cloud machines. Open this conversation on a desktop to change its mode, or start a new cloud conversation in Prompt unmatched.");
    }
    if (mode === "onRequest" && !this.shellSandbox) {
      throw new Error("Muse On request requires the shell sandbox. Reopen with a sandboxed process before continuing.");
    }
  }

  private publishMode(mode: unknown): Promise<void> {
    const modes = this.modes(mode).modes;
    if (!modes) return this.updates;
    this.approvalMode = mode as ApprovalMode;
    this.updates = this.updates.then(async () => {
      // Repair the durable mode before publishing or admitting a resumed turn.
      // Deny unmatched blocks Muse's own reminder agent (research/muse-modes.md).
      if (mode === "denyUnmatched") await this.setMode(this.sessionId!, "agent");
      else this.approvalMode = mode as ApprovalMode;
      await this.client.notify("session/update", {
        sessionId: this.sessionId!, update: { sessionUpdate: "current_mode_update", currentModeId: mode === "denyUnmatched" ? "agent" : modes.currentModeId },
      });
    });
    void this.updates.catch(error => this.fail(error));
    return this.updates;
  }

  async setMode(sessionId: string, modeId: string) {
    this.assertSession(sessionId);
    if (modeId === "denyUnmatched") throw new Error("Muse Deny unmatched is temporarily unavailable; use Prompt unmatched.");
    const mode = approvalModeFor(modeId);
    if (!mode) throw new Error("Muse does not offer Plan mode or unknown approval modes");
    this.assertSandbox(mode);
    const result = await this.connection().command("session/setApprovalMode", { sessionId, mode });
    const effective = result.effectiveMode as { mode?: string } | undefined;
    if (result.status !== "accepted" || effective?.mode !== mode) throw new Error("Muse approval mode was not accepted");
    this.approvalMode = mode;
    return { _meta: this.modes(effective.mode) };
  }

  async setReasoningEffort(sessionId: string, reasoningEffort: ReasoningEffort) {
    this.assertSession(sessionId);
    const result = await this.connection().command("session/setReasoningEffort", { sessionId, reasoningEffort });
    if (result.status !== "accepted") throw new Error(`Muse reasoning effort "${reasoningEffort}" was rejected`);
    this.reasoningEffort = reasoningEffort;
    return {};
  }

  private async resumeSession(sessionId: string) {
    const deadline = Date.now() + RESUME_RETRY_WINDOW_MS;
    do {
      try {
        // Each command() mints a fresh commandId on the existing connection.
        return await this.connection().command("session/resume", { sessionId, history: "inline" });
      } catch (error) {
        if (!(error instanceof MspError) || (error.kind !== "sessionInUse" && error.code !== -32021)) throw error;
        // Other serves briefly take the writer lease even for sessions they do
        // not own. This is transient despite MSP reporting retryable: false.
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise(resolve => setTimeout(resolve, Math.min(RESUME_RETRY_DELAY_MS, remaining)));
      }
    } while (Date.now() < deadline);
    // An ordinary Error loses its message at the ACP boundary.
    throw new RequestError(-32021, "Muse Code is busy with this conversation in another window. Try again in a moment.");
  }

  async loadSession(sessionId: string, cwd: string, mcpServers: unknown[]) {
    if (this.sessionId || this.creating) throw new Error("Muse adapter already owns a session");
    if (mcpServers.length) throw new Error("Muse adapter does not accept client MCP servers");
    this.creating = true;
    this.sessionId = sessionId;
    this.replayBuffer = [];
    try {
      if (this.cloud) {
        // Read the durable mode without attaching: a refused On request history
        // must not acquire a writer or resume its work in an unsandboxed VM.
        const stored = await this.connection().request("session/read", { sessionId });
        const storedSession = stored.session as { approvalMode?: { mode: ApprovalMode } } | undefined;
        this.assertSandbox(storedSession?.approvalMode?.mode);
      }
      const result = await this.resumeSession(sessionId);
      const resumed = result.session as any;
      if (resumed?.sessionId !== sessionId || resumed.workspaceRoot !== cwd) throw new Error("Muse resume workspace/session mismatch");
      // Native mode must reach the host before Muse reissues pending approvals.
      await this.publishMode(resumed.approvalMode?.mode);
      // Preserve the replayed fact for the host's next start, but never admit
      // tools or pending approvals under On request in this unsandboxed child.
      this.assertSandbox(this.approvalMode);
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
      await this.updates;
      this.assertSandbox(this.approvalMode);
      if (Array.isArray(result.pendingRequests) && result.pendingRequests.length) {
        const pending = await this.connection().request("approval/listPending", { sessionId });
        if (Array.isArray(pending.userInputs) && pending.userInputs.length) throw new Error("Muse resume has an unsupported user-input request");
        for (const approval of (pending.approvals as any[] ?? [])) this.approvals.accept("approval/requested", approval);
      }
      await this.updates;
      return { _meta: { models: await this.models(resumed.modelId) }, ...this.modes(this.approvalMode) };
    } catch (error) {
      this.sessionId = undefined;
      this.projection.clear();
      this.fail(error);
      throw error;
    } finally { this.replayBuffer = undefined; this.creating = false; }
  }

  async prompt(sessionId: string, prompt: ContentBlock[]): Promise<PromptResponse> {
    this.assertSession(sessionId);
    if (this.approvalMode === "denyUnmatched") await this.updates;
    this.assertSandbox(this.approvalMode);
    if (this.pending) throw new Error("Muse session already has an active prompt");
    if (!prompt.length || prompt.some(part => part.type !== "text")) throw new Error("Muse adapter accepts text prompts only");
    let pending!: PendingTurn;
    const completed = new Promise<Record<string, any>>((resolve, reject) => {
      pending = { resolve, reject, early: new Map() };
    });
    // A transport failure can arrive while turn/start is still awaiting admission.
    void completed.catch(() => {});
    this.pending = pending;
    try {
      // Approvals belong to Muse's turns, not to this prompt: one raised by a turn
      // Muse runs on its own must stay answerable while this prompt queues behind it.
      const admitted = await Promise.race([this.connection().command("turn/start", {
        sessionId, ifBusy: "queue", input: prompt.map(part => ({ type: "text", text: (part as { text: string }).text })),
      }), completed.then(() => new Promise<never>(() => {}))]);
      if (admitted.status !== "accepted" || typeof admitted.turnId !== "string" || !admitted.turnId
        || (admitted.disposition !== "started" && admitted.disposition !== "queued")) {
        throw new Error(`Muse did not admit a prompt turn: ${JSON.stringify(admitted)}`);
      }
      pending.turnId = admitted.turnId;
      pending.queued = admitted.disposition === "queued";
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
    }
  }

  async cancel(sessionId: string): Promise<void> {
    this.assertSession(sessionId);
    const pending = this.pending;
    if (!pending) return;
    pending.cancelRequested = true;
    const turnId = pending.turnId;
    if (!turnId) return; // Admission will cancel using its authoritative ID.
    if (pending.queued) {
      try {
        await this.connection().command("turn/unqueue", { sessionId, turnId });
        return; // Settlement is turn/unqueued, not the command acknowledgement.
      } catch (error) {
        if (!(error instanceof MspError) || error.kind !== "commandRejected") throw error;
        // Launch can win the reclaim race. Stop only this same admitted turn.
      }
    }
    await this.connection().command("turn/cancel", { sessionId, turnId });
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
    if (method === "session/approvalModeChanged") {
      void this.publishMode(params.mode).then(() => this.assertSandbox(params.mode)).catch(error => this.fail(error));
      return;
    }
    this.assertSandbox(this.approvalMode);
    this.projection.accept(method, params);
    this.approvals.accept(method, params);
    if (method === "turn/completed" && typeof params.turnId === "string") this.approvals.forgetTurn(params.turnId);
    if (method === "userInput/requested" || method === "view/gap") {
      this.fail(new Error(`Muse ${method} is unsupported in this boundary slice`));
    }
    if (["turn/completed", "turn/unqueued"].includes(method) && this.pending && typeof params.turnId === "string") {
      const terminal = method === "turn/unqueued" ? { ...params, terminal: "cancelled" } : params;
      if (!this.pending.turnId) this.pending.early.set(params.turnId, terminal);
      else if (params.turnId === this.pending.turnId) this.pending.resolve(terminal);
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
