import type { EffortLevel, PromptContentBlock } from "./acp";

export const ACP_PROVIDERS = ["grok", "codex", "claude"] as const;
// The legacy wire vocabulary above stays frozen for older receivers.
export const INTERNAL_PROVIDERS = [...ACP_PROVIDERS, "muse", "agy", "deepseek"] as const;
export type LegacyAcpProvider = (typeof ACP_PROVIDERS)[number];
export type AcpProvider = (typeof INTERNAL_PROVIDERS)[number];

export function isInternalProvider(value: unknown): value is AcpProvider {
  return typeof value === "string" && (INTERNAL_PROVIDERS as readonly string[]).includes(value);
}

// Exhaustive: each new provider must explicitly opt into implemented actions.
// `modeSwitching` includes Plan. Approval-only switching must not enable Plan.
const PROVIDER_ACTIONS: Record<AcpProvider, {
  deleteHistory: boolean;
  compact: boolean;
  adapterHistory: boolean;
  modeSwitching: boolean;
  approvalModeSwitching: boolean;
  autoAccept: boolean;
  perCallContext: boolean;
  clientMcp: boolean;
}> = {
  grok: { deleteHistory: true, compact: true, adapterHistory: false, modeSwitching: true, approvalModeSwitching: false, autoAccept: true, perCallContext: false, clientMcp: true },
  codex: { deleteHistory: true, compact: true, adapterHistory: true, modeSwitching: true, approvalModeSwitching: false, autoAccept: true, perCallContext: true, clientMcp: true },
  claude: { deleteHistory: true, compact: true, adapterHistory: true, modeSwitching: true, approvalModeSwitching: false, autoAccept: true, perCallContext: true, clientMcp: true },
  muse: { deleteHistory: false, compact: false, adapterHistory: true, modeSwitching: false, approvalModeSwitching: true, autoAccept: true, perCallContext: false, clientMcp: false },
  agy: { deleteHistory: false, compact: false, adapterHistory: true, modeSwitching: false, approvalModeSwitching: false, autoAccept: true, perCallContext: false, clientMcp: false },
  deepseek: { deleteHistory: false, compact: false, adapterHistory: true, modeSwitching: false, approvalModeSwitching: false, autoAccept: true, perCallContext: false, clientMcp: false },
};

/**
 * A provider's row, total on purpose.
 *
 * `session.client` is not always a live `AcpClient`. The host parks stubs --
 * `{ dispose() {}, setHumanWaitActive() {} } as AcpClient` -- on sessions a
 * remote tab owns, and a stub carries no `provider` at all. Until 4.10.0 the
 * only capability question was `isAdapterProvider`, written as a comparison,
 * so an absent provider answered `false` and `sessionDisplayName` fell through
 * to its ordinary branch. Indexing this table turned the same call into
 * "Cannot read properties of undefined", and because the name is posted from
 * `postSessionsListNow` and `focusSession`, it took `selectRepo` and
 * `resumeSession` down with it -- a phone could not join a conversation at all.
 *
 * Grok's row is the fallback because it is already what the rest of the wire
 * does with a provider it does not recognise (`isAcpProvider(p) ? p : "grok"`).
 */
function actionsFor(provider: AcpProvider): (typeof PROVIDER_ACTIONS)[AcpProvider] {
  return PROVIDER_ACTIONS[provider] ?? PROVIDER_ACTIONS.grok;
}

export function supportsHistoryDeletion(provider: AcpProvider): boolean {
  return actionsFor(provider).deleteHistory;
}

export function supportsCompaction(provider: AcpProvider): boolean {
  return actionsFor(provider).compact;
}

export function supportsSessionDeletion(provider: AcpProvider): boolean {
  return usesAdapterHistory(provider) && supportsHistoryDeletion(provider);
}

export function supportsModeSwitching(provider: AcpProvider): boolean {
  return actionsFor(provider).modeSwitching;
}

export function supportsAutoAccept(provider: AcpProvider): boolean {
  return actionsFor(provider).autoAccept;
}

export function supportsApprovalModeSwitching(provider: AcpProvider): boolean {
  return actionsFor(provider).approvalModeSwitching === true;
}

export function usesPerCallContextOccupancy(provider: AcpProvider): boolean {
  return actionsFor(provider).perCallContext;
}

export function supportsClientMcpServers(provider: AcpProvider): boolean {
  return actionsFor(provider).clientMcp;
}

export function isAcpProvider(value: unknown): value is LegacyAcpProvider {
  return typeof value === "string" && (ACP_PROVIDERS as readonly string[]).includes(value);
}

/** Providers whose conversations live in an adapter catalog, not ~/.grok. */
export function usesAdapterHistory(provider: AcpProvider): boolean {
  return actionsFor(provider).adapterHistory;
}

export const isAdapterProvider = usesAdapterHistory;

export interface BackendSpawnOptions {
  cliPath: string;
  cwd: string;
  effort?: EffortLevel;
  env: NodeJS.ProcessEnv;
}

export interface BackendSpawnSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  shell: boolean;
}

export interface BackendConfigState {
  modelId?: string;
  reasoningEffort?: string;
  modeId?: string;
}

export interface BackendUpdate {
  update?: any;
  meta?: any;
  /** Provider progress projected onto the existing lifecycle presentation rail. */
  workflowUpdate?: any;
  notice?: string;
  sessionTitle?: string;
  contextWindow?: number;
  /** Direct occupancy reported by a backend, including an empty context. */
  contextUsed?: number;
  /**
   * Ordinary `usage_update.used` is billed per model call (includes output).
   * The compacted size is the exception — the host adopts the first one after
   * a compaction signal. Otherwise these are per-call observations
   * for occupancyFromAdapterTurn, not occupancy by themselves.
   */
  usageUpdateUsed?: number;
  /** The agent reported mid-turn that its credential was refused -- in-band,
   *  as text, with no RPC error for the host to classify. */
  credentialRejected?: true;
  /**
   * This update belongs to a subagent's own stream: it is routed exactly as a
   * child session's updates are (`childStream`), into the card whose
   * `child_session_id` names it. For an agent whose child calls arrive on the
   * parent session.
   */
  childSessionId?: string;
  /** Already-normalized updates to route before this one (a backend closing
   *  cards at a turn boundary it only sees in the stream). */
  precede?: any[];
}

export interface BackendSessionListEntry {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string | number;
  createdAt?: string | number;
  turnCount?: number;
  modelId?: string;
  branch?: string;
  deepseekHarness?: "default" | "minimal";
}

export interface BackendSessionListResult {
  sessions: BackendSessionListEntry[];
  nextCursor?: string | null;
}

export interface BackendSteeringCapabilities {
  supported: boolean;
  acceptsContent: boolean;
}

export interface BackendSteeringOptions {
  grokVersion?: string;
  grokVersionVerified?: boolean;
}

export interface AcpBackend<Provider extends string = AcpProvider> {
  readonly provider: Provider;
  readonly processName: string;
  readonly usesClientPlanGate: boolean;
  spawn(options: BackendSpawnOptions): BackendSpawnSpec;
  normalizeSessionResponse(response: any): any;
  normalizePromptResult(result: any): any;
  normalizeUpdate(update: any, meta: any): BackendUpdate;
  normalizePermissionParams(params: any): any;
  setModel(sessionId: string, modelId: string, reasoningEffort?: string): { method: string; params: any };
  setReasoningEffort(sessionId: string, modelId: string | undefined, level: string): { method: string; params: any } | null;
  setMode(sessionId: string, modeId: string): { method: string; params: any };
  steeringCapabilities(initializeResult: any, options: BackendSteeringOptions): BackendSteeringCapabilities;
  interject(sessionId: string, text: string, content?: readonly PromptContentBlock[]): { method: string; params: any } | null;
  /**
   * Whether a steering RPC that RESOLVED actually delivered the text. Some
   * adapters report a steering failure in-band, as a successful response.
   */
  steerDelivered(result: any): boolean;
  configState(response: any, fallback: BackendConfigState): BackendConfigState;
  modelSetSucceeded(response: any): boolean;
  listSessions(
    request: (method: string, params: any) => Promise<any>,
    cwd: string,
    platform: NodeJS.Platform,
  ): Promise<BackendSessionListResult>;
  /**
   * The whole catalog in one listing, for an agent whose `session/list` is not
   * scoped by folder in the first place (codex returns every folder whatever
   * it is asked). Present only together with {@link catalogSessionsFor}, which
   * must give each folder exactly what `listSessions(cwd)` would have.
   */
  listSessionCatalog?(
    request: (method: string, params: any) => Promise<any>,
    platform: NodeJS.Platform,
  ): Promise<BackendSessionListEntry[]>;
  catalogSessionsFor?(
    catalog: readonly BackendSessionListEntry[],
    cwd: string,
    platform: NodeJS.Platform,
  ): BackendSessionListEntry[];
  isCredentialError(error: unknown): boolean;
  /** Extra `session/new` and `session/load` params beyond cwd and mcpServers. */
  sessionParams?(cwd: string): Record<string, unknown>;
  /**
   * The model a new session moves to when the host remembers none, or
   * undefined to keep the agent's own default.
   */
  defaultModelId?(modelIds: readonly string[]): string | undefined;
  /**
   * A turn (or a `session/load` replay) ended. Returns already-normalized
   * updates to route, e.g. settling subagent cards the agent never closes.
   */
  turnEnded?(outcome: "completed" | "cancelled" | "failed"): any[];
  /**
   * Ask the spawned process to exit cleanly, in place of waiting for it to
   * notice stdin closing. Dispose still kills it if it has not exited in time.
   */
  stopProcess?(pid: number, command: string): Promise<void>;
}
