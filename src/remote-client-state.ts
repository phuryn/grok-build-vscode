/**
 * Pure AFK Pilot client state. The relay knows only opaque client IDs; cwd
 * selection and the active remote view per browser tab live in the extension.
 */
export function serializesRemoteSessionTransition(type: string): boolean {
  return type === "newSession" || type === "resumeSession" || type === "selectRepo" || type === "setDeepSeekHarness";
}

export class RemoteClientState<T, C = never> {
  private readonly cwdByClient = new Map<string, string>();
  private readonly activeByClient = new Map<string, T>();
  private readonly metadataByClient = new Map<string, C>();
  private readonly tailsByClient = new Map<string, Promise<void>>();
  private readonly tabTokenByClient = new Map<string, string>();
  private readonly clientByTabToken = new Map<string, string>();
  private readonly explicitSessionByClient = new Set<string>();
  private readonly supersededSessionIdByClient = new Map<string, string>();
  private readonly detachedByTabToken = new Map<string, {
    cwd: string;
    active?: T;
    metadata?: C;
    requiresExplicitSession?: boolean;
    supersededSessionId?: string;
  }>();

  constructor(
    private readonly defaultCwd: string | (() => string),
    private readonly normalize: (cwd: string) => string = (cwd) => cwd,
  ) {}

  private currentDefaultCwd(): string {
    return typeof this.defaultCwd === "function" ? this.defaultCwd() : this.defaultCwd;
  }

  ready(clientId: string): string {
    const existing = this.cwdByClient.get(clientId);
    if (existing) return existing;
    const cwd = this.currentDefaultCwd();
    this.cwdByClient.set(clientId, cwd);
    return cwd;
  }

  /**
   * Bind an ephemeral relay connection to a browser-tab identity. A later
   * connection presenting the same unguessable token atomically inherits the
   * tab's cwd and active session; the old socket remains marked stale until its
   * eventual client-left so it cannot race the replacement back into ownership.
   */
  identify(clientId: string, tabToken: string): string | undefined {
    const priorClientId = this.clientByTabToken.get(tabToken);
    const priorToken = this.tabTokenByClient.get(clientId);
    if (priorToken && priorToken !== tabToken && this.clientByTabToken.get(priorToken) === clientId) {
      this.clientByTabToken.delete(priorToken);
    }
    this.tabTokenByClient.set(clientId, tabToken);
    this.clientByTabToken.set(tabToken, clientId);
    if (!priorClientId || priorClientId === clientId) {
      const detached = this.detachedByTabToken.get(tabToken);
      if (detached) {
        this.detachedByTabToken.delete(tabToken);
        this.cwdByClient.set(clientId, detached.cwd);
        // A SEAT CAN BE TAKEN WHILE YOU ARE AWAY.
        //
        // While this tab was disconnected it owned nothing, so an empty
        // conversation it had been given could legitimately be handed to
        // another tab. Restoring the pointer blindly then puts TWO remotes on
        // one conversation: the returning tab's next message lands in the
        // other tab's conversation, and a refresh hits the conflicting-owner
        // refusal and leaves it with nothing. Every other remote path treats
        // one-remote-per-conversation as the rule; coming back from a
        // disconnect is not an exception to it.
        //
        // Dropped rather than contested: the caller then gives this tab a
        // conversation of its own, which is what it would have got had it
        // reconnected a moment later.
        const takenByAnother = detached.active !== undefined
          && [...this.activeByClient].some(([other, value]) => other !== clientId && value === detached.active);
        if (detached.active !== undefined && !takenByAnother) {
          this.activeByClient.set(clientId, detached.active);
        }
        if (detached.metadata !== undefined) this.metadataByClient.set(clientId, detached.metadata);
        this.restoreExplicitSession(clientId, detached.requiresExplicitSession, detached.supersededSessionId);
      }
      return undefined;
    }

    const cwd = this.cwdByClient.get(priorClientId);
    const active = this.activeByClient.get(priorClientId);
    const metadata = this.metadataByClient.get(priorClientId);
    const requiresExplicitSession = this.explicitSessionByClient.has(priorClientId);
    const supersededSessionId = this.supersededSessionIdByClient.get(priorClientId);
    this.cwdByClient.delete(priorClientId);
    this.activeByClient.delete(priorClientId);
    this.metadataByClient.delete(priorClientId);
    this.clearRequiresExplicitSession(priorClientId);
    if (cwd) this.cwdByClient.set(clientId, cwd);
    if (active !== undefined) this.activeByClient.set(clientId, active);
    if (metadata !== undefined) this.metadataByClient.set(clientId, metadata);
    this.restoreExplicitSession(clientId, requiresExplicitSession, supersededSessionId);
    return priorClientId;
  }

  /** False only for a socket superseded by a same-tab reconnect. */
  isCurrent(clientId: string): boolean {
    const token = this.tabTokenByClient.get(clientId);
    return !token || this.clientByTabToken.get(token) === clientId;
  }

  tabToken(clientId: string): string | undefined {
    return this.tabTokenByClient.get(clientId);
  }

  clientForTabToken(tabToken: string): string | undefined {
    return this.clientByTabToken.get(tabToken);
  }

  private sessionTransitionKey(clientId: string): string {
    const tabToken = this.tabTokenByClient.get(clientId);
    return tabToken ? `tab:${tabToken}` : `client:${clientId}`;
  }

  /** Resolve an ephemeral relay id to the connection that currently owns its
   * logical tab. Returns undefined once that tab has genuinely departed. */
  currentClient(clientId: string): string | undefined {
    const tabToken = this.tabTokenByClient.get(clientId);
    const current = tabToken ? this.clientByTabToken.get(tabToken) : clientId;
    return current && this.cwdByClient.has(current) ? current : undefined;
  }

  cwd(clientId: string): string {
    const cwd = this.cwdByClient.get(clientId);
    if (!cwd) throw new Error(`Remote client ${clientId} is not ready`);
    return cwd;
  }

  cwdIfPresent(clientId: string): string | undefined {
    return this.cwdByClient.get(clientId);
  }

  select(clientId: string, cwd: string): string {
    if (!this.cwdByClient.has(clientId)) {
      throw new Error(`Remote client ${clientId} is not ready`);
    }
    const selected = cwd || this.currentDefaultCwd();
    const previous = this.cwdByClient.get(clientId);
    this.cwdByClient.set(clientId, selected);
    if (previous && this.normalize(previous) !== this.normalize(selected)) {
      this.activeByClient.delete(clientId);
    }
    return selected;
  }

  clientsForCwd(cwd: string): string[] {
    const key = this.normalize(cwd);
    return [...this.cwdByClient]
      .filter(([, selected]) => this.normalize(selected) === key)
      .map(([clientId]) => clientId);
  }

  clients(): string[] {
    return [...this.cwdByClient.keys()];
  }

  retainClients(clientIds: Iterable<string>): string[] {
    const keep = new Set(clientIds);
    const removed: string[] = [];
    const known = new Set([...this.cwdByClient.keys(), ...this.tabTokenByClient.keys()]);
    for (const clientId of known) {
      if (keep.has(clientId)) continue;
      this.deleteClient(clientId);
      removed.push(clientId);
    }
    return removed;
  }

  setActive(clientId: string, value: T): void {
    if (!this.cwdByClient.has(clientId)) {
      throw new Error(`Remote client ${clientId} is not ready`);
    }
    this.activeByClient.set(clientId, value);
    this.clearRequiresExplicitSession(clientId);
  }

  /**
   * Mark a tab that lost its conversation to another tab's explicit claim.
   * Survives socket replacement (`identify` / `detachClient`) so a thawing
   * background tab cannot adopt the desk session or mint a blank one.
   */
  markRequiresExplicitSession(clientId: string, sessionId?: string): void {
    if (!this.cwdByClient.has(clientId)) return;
    this.explicitSessionByClient.add(clientId);
    if (sessionId) this.supersededSessionIdByClient.set(clientId, sessionId);
  }

  requiresExplicitSession(clientId: string): boolean {
    return this.explicitSessionByClient.has(clientId);
  }

  supersededSessionId(clientId: string): string | undefined {
    return this.supersededSessionIdByClient.get(clientId);
  }

  clearRequiresExplicitSession(clientId: string): void {
    this.explicitSessionByClient.delete(clientId);
    this.supersededSessionIdByClient.delete(clientId);
  }

  private restoreExplicitSession(
    clientId: string,
    requiresExplicitSession?: boolean,
    supersededSessionId?: string,
  ): void {
    if (!requiresExplicitSession) {
      this.clearRequiresExplicitSession(clientId);
      return;
    }
    this.explicitSessionByClient.add(clientId);
    if (supersededSessionId) this.supersededSessionIdByClient.set(clientId, supersededSessionId);
    else this.supersededSessionIdByClient.delete(clientId);
  }

  active(clientId: string): T | undefined {
    return this.activeByClient.get(clientId);
  }

  setMetadata(clientId: string, value: C): void {
    if (!this.cwdByClient.has(clientId)) {
      throw new Error(`Remote client ${clientId} is not ready`);
    }
    this.metadataByClient.set(clientId, value);
  }

  metadata(clientId: string): C | undefined {
    return this.metadataByClient.get(clientId);
  }

  deleteActive(clientId: string, value?: T): void {
    if (value === undefined || this.activeByClient.get(clientId) === value) {
      this.activeByClient.delete(clientId);
    }
  }

  deleteActiveValue(value: T): void {
    for (const [clientId, active] of this.activeByClient) {
      if (active === value) this.activeByClient.delete(clientId);
    }
  }

  replaceDetachedActiveWhere(
    predicate: (value: T) => boolean,
    replace: (cwd: string, value: T) => T,
  ): T[] {
    const removed: T[] = [];
    for (const detached of this.detachedByTabToken.values()) {
      if (detached.active === undefined || !predicate(detached.active)) continue;
      const previous = detached.active;
      detached.active = replace(detached.cwd, previous);
      removed.push(previous);
    }
    return removed;
  }

  /** Snapshot detached logical-tab values without exposing the backing map. */
  detachedActiveValues(): T[] {
    return [...this.detachedByTabToken.values()]
      .flatMap((detached) => detached.active === undefined ? [] : [detached.active]);
  }

  clientsForActiveValue(value: T): string[] {
    return [...this.activeByClient]
      .filter(([, active]) => active === value)
      .map(([clientId]) => clientId);
  }

  isActiveValueVisible(value: T): boolean {
    return this.clientsForActiveValue(value).length > 0;
  }

  runExclusive<R>(clientId: string, action: () => Promise<R>): Promise<R> {
    const previous = this.tailsByClient.get(clientId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(action);
    const tail = run.then(() => undefined, () => undefined);
    this.tailsByClient.set(clientId, tail);
    return run.finally(() => {
      if (this.tailsByClient.get(clientId) === tail) this.tailsByClient.delete(clientId);
    });
  }

  runSessionOperation<R>(clientId: string, type: string, action: () => Promise<R>): Promise<R> {
    return serializesRemoteSessionTransition(type)
      ? this.runExclusive(clientId, action)
      : action();
  }

  /**
   * Serialize every session transition for one browser tab. Resumes additionally
   * take a session-id lock inside the tab queue, preventing two tabs from
   * concurrently claiming the same persisted Grok session.
   */
  runSessionTransition<R>(
    clientId: string,
    sessionId: string | undefined,
    action: (currentClientId: string) => Promise<R>,
  ): Promise<R | undefined> {
    const tabToken = this.tabTokenByClient.get(clientId);
    const runForCurrentOwner = () => {
      const currentClientId = tabToken
        ? this.clientByTabToken.get(tabToken)
        : this.currentClient(clientId);
      if (!currentClientId || !this.cwdByClient.has(currentClientId)) {
        return Promise.resolve(undefined);
      }
      return action(currentClientId);
    };
    return this.runExclusive(this.sessionTransitionKey(clientId), () =>
      sessionId
        ? this.runExclusive(`session:${sessionId}`, runForCurrentOwner)
        : runForCurrentOwner(),
    );
  }

  /** Wait for an already-running New/Resume without joining its exclusive queue. */
  async runAfterSessionTransition<R>(
    clientId: string,
    action: (currentClientId: string) => Promise<R>,
  ): Promise<R | undefined> {
    const tabToken = this.tabTokenByClient.get(clientId);
    const transition = this.tailsByClient.get(this.sessionTransitionKey(clientId));
    if (transition) await transition;
    const currentClientId = tabToken
      ? this.clientByTabToken.get(tabToken)
      : this.currentClient(clientId);
    if (!currentClientId || !this.cwdByClient.has(currentClientId)) return undefined;
    return action(currentClientId);
  }

  deleteClient(clientId: string): void {
    this.cwdByClient.delete(clientId);
    this.activeByClient.delete(clientId);
    this.metadataByClient.delete(clientId);
    this.clearRequiresExplicitSession(clientId);
    this.tailsByClient.delete(clientId);
    this.tailsByClient.delete(`client:${clientId}`);
    const token = this.tabTokenByClient.get(clientId);
    this.tabTokenByClient.delete(clientId);
    if (token && this.clientByTabToken.get(token) === clientId) {
      this.clientByTabToken.delete(token);
    }
  }

  /** Remove a relay connection while retaining its logical-tab ownership for a
   * same-token replacement that has not connected yet. */
  detachClient(clientId: string): void {
    const token = this.tabTokenByClient.get(clientId);
    const cwd = this.cwdByClient.get(clientId);
    const active = this.activeByClient.get(clientId);
    const metadata = this.metadataByClient.get(clientId);
    if (token && cwd && this.clientByTabToken.get(token) === clientId) {
      this.detachedByTabToken.set(token, {
        cwd,
        active,
        metadata,
        requiresExplicitSession: this.explicitSessionByClient.has(clientId),
        supersededSessionId: this.supersededSessionIdByClient.get(clientId),
      });
    }
    this.deleteClient(clientId);
  }

  clear(): void {
    this.cwdByClient.clear();
    this.activeByClient.clear();
    this.metadataByClient.clear();
    this.tailsByClient.clear();
    this.tabTokenByClient.clear();
    this.clientByTabToken.clear();
    this.explicitSessionByClient.clear();
    this.supersededSessionIdByClient.clear();
    this.detachedByTabToken.clear();
  }
}
