import type { EffortLevel, PromptContentBlock, SlashCommand } from "./acp";
import type { SubscriptionWindow } from "./subscription-usage";

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
  /** Implements a conversation fork. Standard ACP also requires negotiation. */
  fork: boolean;
}> = {
  grok: { deleteHistory: true, compact: true, adapterHistory: false, modeSwitching: true, approvalModeSwitching: false, autoAccept: true, perCallContext: false, clientMcp: true, fork: true },
  codex: { deleteHistory: true, compact: true, adapterHistory: true, modeSwitching: true, approvalModeSwitching: false, autoAccept: true, perCallContext: true, clientMcp: true, fork: true },
  claude: { deleteHistory: true, compact: true, adapterHistory: true, modeSwitching: true, approvalModeSwitching: false, autoAccept: true, perCallContext: true, clientMcp: true, fork: true },
  muse: { deleteHistory: false, compact: true, adapterHistory: true, modeSwitching: false, approvalModeSwitching: true, autoAccept: true, perCallContext: false, clientMcp: false, fork: true },
  agy: { deleteHistory: false, compact: false, adapterHistory: true, modeSwitching: false, approvalModeSwitching: true, autoAccept: true, perCallContext: false, clientMcp: false, fork: false },
  deepseek: { deleteHistory: false, compact: false, adapterHistory: true, modeSwitching: false, approvalModeSwitching: false, autoAccept: true, perCallContext: false, clientMcp: false, fork: false },
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

export function supportsFork(provider: AcpProvider): boolean {
  return actionsFor(provider).fork;
}

export function advertisedFork(initializeResult: any): boolean {
  const fork = initializeResult?.agentCapabilities?.sessionCapabilities?.fork;
  return fork !== null && typeof fork === "object" && !Array.isArray(fork);
}

/** Both standard ACP adapters use this optional reply point on their fork request. */
export function acpForkRequest(sessionId: string, cwd: string, messageId?: string) {
  return {
    method: "session/fork",
    params: {
      sessionId, cwd, mcpServers: [],
      ...(messageId === undefined ? {} : { _meta: { jetbrains: { air: { fork: { version: 1, messageId } } } } }),
    },
  };
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

export interface SessionGoal {
  objective: string;
  status: string;
}

export interface BackendUpdate {
  update?: any;
  meta?: any;
  /** Provider progress projected onto the existing lifecycle presentation rail. */
  workflowUpdate?: any;
  notice?: string;
  sessionTitle?: string;
  sessionGoal?: SessionGoal | null;
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

export function normalizeSessionInfoUpdate(update: any): BackendUpdate {
  const title = [update.title, update.sessionTitle, update.name, update.sessionInfo?.title, update._meta?.title]
    .find((value) => typeof value === "string" && value.trim()) as string | undefined;
  const result: BackendUpdate = { sessionTitle: title?.trim() };
  const goal = update._meta?.goal;
  if (goal === null) result.sessionGoal = null;
  else if (typeof goal?.objective === "string" && goal.objective.trim()
      && typeof goal.status === "string" && goal.status.trim()) {
    result.sessionGoal = { objective: goal.objective.trim(), status: goal.status.trim() };
  }
  return result;
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

export type ChildHistoryReplay = (toolCallId: string) => Iterable<unknown>;
export type DelegatedWorkKind = "workflow" | "subagent";

export interface AcpBackend<Provider extends string = AcpProvider> {
  readonly provider: Provider;
  readonly processName: string;
  readonly usesClientPlanGate: boolean;
  spawn(options: BackendSpawnOptions): BackendSpawnSpec;
  normalizeSessionResponse(response: any): any;
  normalizePromptResult(result: any): any;
  /** Host-discovered instruction shortcuts, optionally merged with native commands. */
  availableCommands?(cwd: string, log: (message: string) => void): Promise<SlashCommand[]>;
  /** Discover on open/reopen without blocking session or prompt admission. */
  readonly backgroundCommands?: boolean;
  rewritePrompt?(text: string, commands: readonly SlashCommand[]): string;
  readonly nativeApprovalModes?: boolean;
  subscriptionCredentialContext?(authMethod: string | undefined): string | undefined;
  readSubscriptionUsage?(authMethod: string | undefined): Promise<SubscriptionWindow[]>;
  normalizeUpdate(update: any, meta: any, foreignSessionId?: string): BackendUpdate;
  stopDelegatedWork?(sessionId: string, kind: DelegatedWorkKind, id: string): { method: string; params: object } | undefined;
  /** Supply child history at the position of its card in the parent replay. */
  prepareChildReplay?(sessionId: string, cwd: string): Promise<ChildHistoryReplay>;
  normalizePermissionParams(params: any): any;
  setModel(sessionId: string, modelId: string, reasoningEffort?: string): { method: string; params: any };
  /** A relay-backed provider can apply effort locally without an ACP call. */
  setReasoningEffort(sessionId: string, modelId: string | undefined, level: string): { method: string; params: any } | { local: true } | null;
  setMode(sessionId: string, modeId: string): { method: string; params: any };
  steeringCapabilities(initializeResult: any, options: BackendSteeringOptions): BackendSteeringCapabilities;
  fork?(sessionId: string, cwd: string, messageId?: string): { method: string; params: object };
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
