import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface, Interface } from "node:readline";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import {
  collectToolImages,
  contextUsedFromUpdateEnvelope,
  extractGeneratedMediaPaths,
  isMediaGenToolCall,
  extractPromptMeta,
  isMethodNotFoundError,
  type PromptResultMeta,
  type PromptUsage,
  type SessionInfoContext,
  makeAckResponse,
  makeExitPlanResponse,
  makeExitPlanUnavailableResponse,
  makePermissionCancelledResponse,
  makePermissionResponse,
  makeQuestionCancelledResponse,
  makeQuestionResponse,
  makeRequest,
  parseAcpLine,
  parseSessionInfoRpcResult,
  resolveModelId,
  routeSessionUpdate,
  isForeignSessionUpdate,
} from "./acp-dispatch";
import {
  PLAN_BLOCKED_CODE,
  PLAN_BLOCKED_TERMINAL_MSG,
  PLAN_BLOCKED_WRITE_MSG,
  isGrokOwnedPlanFile,
  shouldBlockTerminal,
  shouldBlockWrite,
} from "./plan-gate";
import { resolveGrokHome } from "./sessions";
import { resolveCodexHome } from "./codex-cli-locator";
import { inferCodexGeneratedImagePath } from "./media-serve";
import { filterAdvertisedCommands } from "./slash-filter";
import { grokCliNeedsShell } from "./cli-process";
import { compareVersionTuple, parseGrokVersion } from "./cli-locator";
import { resolvedTerminalShellDialect } from "./terminal-manager";
import type { AcpBackend, AcpProvider, BackendSessionListResult } from "./acp-backend";
import { buildGrokAgentArgs, grokBackend } from "./grok-backend";
import {
  parseWorktreeApply,
  parseWorktreeCreate,
  parseWorktreeList,
  parseWorktreeRemove,
  parseWorktreeStatus,
  type WorktreeApplyResult,
  type WorktreeCreateResult,
  type WorktreeRecord,
  type WorktreeRemoveResult,
} from "./worktree";
import {
  parseRewindExecute,
  parseRewindPoints,
  type RewindExecuteResult,
  type RewindMode,
  type RewindPoint,
} from "./rewind";
import {
  promptTimerDelayMs,
  resolveAcpTimeouts,
  type AcpTimeoutInput,
  type AcpTimeouts,
} from "./acp-timeout";
import type { AcpMcpStdioServer } from "./mcp-connectors";
import {
  FEEDBACK_RPC_METHOD,
  buildClientFeedbackParams,
  isFeedbackDisabledError,
  type FeedbackClientType,
  type ThumbsRating,
} from "./feedback";

export type EffortLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type PromptContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

/**
 * Oldest grok whose `_x.ai/interject` honors `content` (text + image blocks).
 * 0.2.x accepts `{sessionId, text}` and ignores unknown fields, so images
 * would drop silently — the host refuses image-bearing Steer instead.
 * Fail closed unless the version is live-verified. Inspected on 1.0.5
 * (`InterjectRequest.content` in `extensions/interject.rs`).
 */
export const GROK_INTERJECT_CONTENT_MIN_VERSION: [number, number, number] = [1, 0, 0];

/** True only for a live-verified grok that will apply interject `content`. */
export function cliHonorsInterjectContent(
  grokVersion?: string | null,
  versionVerified = false,
): boolean {
  if (!versionVerified) return false;
  const parsed = parseGrokVersion(grokVersion ?? "");
  if (!parsed) return false;
  return compareVersionTuple(parsed, GROK_INTERJECT_CONTENT_MIN_VERSION) >= 0;
}

/**
 * `_x.ai/interject` params. `content` is omitted entirely when there are no
 * image blocks so the legacy `{sessionId, text}` wire stays byte-identical
 * (the TUI does the same). The Text block, when present, is the rewritten
 * prompt (`buildPromptWithImages`) and wins over `text` on a capable CLI.
 */
export function buildInterjectParams(
  sessionId: string,
  text: string,
  content?: readonly PromptContentBlock[],
): { sessionId: string; text: string; content?: PromptContentBlock[] } {
  const params: { sessionId: string; text: string; content?: PromptContentBlock[] } = {
    sessionId,
    text,
  };
  if (content && content.some((block) => block.type === "image")) {
    params.content = [...content];
  }
  return params;
}

export interface AcpClientOptions {
  cliPath: string;
  cwd: string;
  effort?: EffortLevel;
  env?: NodeJS.ProcessEnv;
  log: (msg: string) => void;
  backend?: AcpBackend;
  /** Banner or `X.Y.Z` from the grok version probe. Ignored for other providers. */
  grokVersion?: string;
  /**
   * True only after a live parseable `--version`. A cache stand-in or failed
   * probe stays false — `acpClientCapabilities` will not withhold reads from
   * an unverified banner even when the number is at the image-read floor.
   */
  grokVersionVerified?: boolean;
  /**
   * Client-side JSON-RPC timeouts. `session/prompt` uses idle+absolute policy
   * (#117); other methods use `requestTimeoutMs`. Omitted keys take defaults.
   */
  timeouts?: AcpTimeoutInput;
  /**
   * Host-owned MCP servers for `session/new` and `session/load`. A getter is
   * read at request time so a Connect that lands after construct still applies.
   * The getter may be async so a host can re-read its own secrets first.
   * Omitted / empty is the historical `[]` — the field is still sent because
   * grok rejects session/new without it.
   */
  mcpServers?: AcpMcpStdioServer[] | (() => AcpMcpStdioServer[] | Promise<AcpMcpStdioServer[]>);
}

export interface ModelInfo {
  modelId: string;
  name: string;
  description?: string;
  totalContextTokens?: number;
  supportsReasoningEffort?: boolean;
  /** The model's ACTIVE reasoning effort as advertised in `_meta.reasoningEffort`
   *  — the session override (from `SessionHandle.reasoning_effort`), not merely
   *  the catalog default; grok stamps it onto the current model. */
  reasoningEffort?: string;
  /** The effort levels this model OFFERS (`_meta.reasoningEfforts[].value`). Used
   *  to avoid carrying an off-menu override into a model that doesn't offer it
   *  (the CLI gates the flag on this menu but not the `_meta` override, so an
   *  off-menu level could reach the backend and 400). */
  reasoningEfforts?: string[];
}

export interface SlashCommand {
  name: string;
  description?: string;
  input?: { hint?: string };
  /**
   * ACP `_meta`. Skills carry `{scope, path}`; builtins omit those keys
   * (`isAdvertisedSkill` in slash-filter.ts).
   */
  _meta?: { path?: string; scope?: string; [k: string]: unknown };
}

// Re-exported, not redeclared: `extractPromptMeta` (acp-dispatch) is what builds
// these, so a second structurally-identical copy here silently drops any field
// added on one side only — which is exactly what `usage` (#53) would have done.
export type { PromptResultMeta, PromptUsage };
export type { TurnEndStatus } from "./acp-dispatch";

export interface PermissionOption {
  optionId: string;
  kind: string; // "allow_always" | "allow_once" | "reject_once" | ...
  name: string;
}

export interface PermissionRequest {
  id: number | string;
  sessionId: string;
  toolCall: {
    toolCallId: string;
    kind: string; // "edit" | "execute" | "read" | ...
    title: string;
    rawInput?: any;
    content?: unknown;
  };
  options: PermissionOption[];
  _meta?: any;
  /** Present on adapter `switch_mode` reviews (possibly empty). */
  plan?: string;
}

export interface ExitPlanRequest {
  id: number | string;
  sessionId: string;
  plan: string;
}

export interface QuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface QuestionItem {
  question: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export interface QuestionRequest {
  id: number | string;
  sessionId: string;
  questions: QuestionItem[];
}

export interface FsReadHandler {
  (path: string): Promise<string>;
}
export interface FsWriteHandler {
  (path: string, content: string): Promise<void>;
}
export interface TerminalHandler {
  create(params: { command: string; env?: Array<{ name: string; value: string }>; cwd?: string; outputByteLimit?: number }): { terminalId: string };
  output(terminalId: string): { output: string; exitStatus: { exitCode: number } | null; truncated: boolean };
  waitForExit(terminalId: string): Promise<{ exitCode: number }>;
  kill(terminalId: string): void;
  release(terminalId: string): void;
}

type Pending = {
  resolve: (v: any) => void;
  reject: (e: any) => void;
  timer?: ReturnType<typeof setTimeout>;
  onResolve?: (value: any) => void;
  method?: string;
  isPrompt?: boolean;
  startedAt?: number;
  lastActivityAt?: number;
  armTimer?: () => void;
};

export { buildGrokAgentArgs } from "./grok-backend";

export type AcpClientCapabilities = {
  fs: { readTextFile?: true; writeTextFile: true };
  terminal: true;
};

/** Handshake every provider used before grok 1.0 — client-delegated fs. */
export const ACP_DELEGATED_FS_CAPABILITIES: AcpClientCapabilities = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
};

/** Handshake that lets grok >= 1.0.4 run its own image-aware `read_file` (#79). */
export const ACP_IMAGE_READ_FS_CAPABILITIES: AcpClientCapabilities = {
  fs: { writeTextFile: true },
  terminal: true,
};

/**
 * Lowest grok version whose image-aware `read_file` and all-or-nothing client
 * fs were measured (`docs/internal/ACP-feedback.md` §2, 1.0.4). Builds below
 * this keep the delegated handshake — 1.0.0–1.0.3 were never probed, and
 * withholding `readTextFile` also drops write interception.
 *
 * No upper bound. A later major dropping the image branch is a feature
 * removal, which is unlikely and would be caught by
 * `research/image-read-capability-probe.cjs`. Capping would make every future
 * grok release silently lose the #79 fix until someone bumps a constant; run
 * that probe to re-establish the evidence when a new major appears.
 */
export const GROK_IMAGE_READ_MIN_VERSION: [number, number, number] = [1, 0, 4];

/**
 * Advertised `initialize.clientCapabilities`.
 *
 * Withhold `readTextFile` only for a live-verified grok >= 1.0.4, where the
 * image-aware CLI reader exists and the all-or-nothing fs treatment was
 * measured. `versionVerified` must be a live parseable `--version` — a cache
 * stand-in is never treated as verified, even when its number is at the floor.
 *
 * Unknown, unparseable, unverified, or cached grok versions keep the pre-1.0
 * handshake. A missed version probe must not silently drop client fs: on
 * 0.2.117 that can blank plan review (`planContent: null`) and may also stop
 * write delegation. Codex is not this bug and keeps the delegated handshake.
 */
export function acpClientCapabilities(
  provider: AcpProvider,
  grokVersion?: string | null,
  versionVerified = false,
): AcpClientCapabilities {
  if (provider !== "grok") return ACP_DELEGATED_FS_CAPABILITIES;
  if (!versionVerified) return ACP_DELEGATED_FS_CAPABILITIES;
  const parsed = parseGrokVersion(grokVersion ?? "");
  if (!parsed) return ACP_DELEGATED_FS_CAPABILITIES;
  return compareVersionTuple(parsed, GROK_IMAGE_READ_MIN_VERSION) >= 0
    ? ACP_IMAGE_READ_FS_CAPABILITIES
    : ACP_DELEGATED_FS_CAPABILITIES;
}

export class AcpClient extends EventEmitter {
  private proc?: ChildProcessWithoutNullStreams;
  private rl?: Interface;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private readonly backend: AcpBackend;
  private readonly timeouts: AcpTimeouts;

  readonly provider: AcpProvider;
  readonly usesClientPlanGate: boolean;

  sessionId?: string;
  currentModelId?: string;
  currentModeId?: string;
  availableModels: ModelInfo[] = [];
  availableCommands: SlashCommand[] = [];
  lastMeta?: PromptResultMeta;
  private lastContextUsed?: number;
  private lastContextWindow?: number;
  private currentSessionTitle?: string;
  /**
   * The session's effective reasoning effort. Seeded from the spawn flag
   * (`opts.effort`), updated by a live `setReasoningEffort`, and CARRIED through a
   * compatible `setModel` (a model switch that omits it lets the server resolve
   * the new model's default, silently dropping a live override). `""`/undefined =
   * the model default (nothing to carry).
   */
  currentReasoningEffort?: string;

  /**
   * Tool-call ids known to be media generations (`/imagine`, `/imagine-video`).
   * grok's image_gen / image_to_video tools report their output as a JSON-in-text
   * path on the *completed* update, whose title is null — so we remember the id
   * from the initial titled call to recognize the result. See
   * research/image-generation.md.
   */
  private mediaGenCallIds = new Set<string>();

  /**
   * terminalId → the command that terminal is running. The chat shows each
   * finished command's full output as the row's expandable detail (#41); the
   * snapshot is taken at `terminal/release`, when the buffer holds exactly
   * what grok itself received (same byte cap).
   */
  private terminalCommands = new Map<string, string>();

  /**
   * Plan-accepted bit used by permission handling (`effectivePlanActive`).
   * For grok (`usesClientPlanGate`) it is also the fs/terminal safety gate.
   * A successful Plan RPC commits it in the response hook so a later line
   * in the same stdout chunk already sees Plan.
   */
  planActive = false;

  /** Set by the host to satisfy server→client fs requests. */
  fsRead?: FsReadHandler;
  fsWrite?: FsWriteHandler;
  /** Set by the host to satisfy server→client terminal/* requests. */
  terminal?: TerminalHandler;

  constructor(private opts: AcpClientOptions) {
    super();
    this.backend = opts.backend ?? grokBackend;
    this.provider = this.backend.provider;
    this.usesClientPlanGate = this.backend.usesClientPlanGate;
    this.currentReasoningEffort = this.opts.effort || undefined;
    this.timeouts = resolveAcpTimeouts(opts.timeouts);
  }

  async start(): Promise<void> {
    const spawnSpec = this.backend.spawn({
      cliPath: this.opts.cliPath,
      cwd: this.opts.cwd,
      effort: this.opts.effort,
      env: this.opts.env ?? process.env,
    });
    const { args } = spawnSpec;
    const needsShell = this.provider === "grok"
      ? grokCliNeedsShell(this.opts.cliPath)
      : spawnSpec.shell;

    this.opts.log(`spawning ${spawnSpec.command} ${args.join(" ")} (cwd=${this.opts.cwd})`);
    // Node 18+ refuses to spawn .cmd/.bat without `shell: true` on Windows
    // (CVE-2024-27980). Enable shell mode for those so installs that resolve to
    // a .cmd shim (e.g. some package managers, our test fake-CLI) still work.
    this.proc = spawn(spawnSpec.command, args, {
      cwd: this.opts.cwd,
      env: spawnSpec.env,
      shell: needsShell,
    });

    this.rl = createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this.onLine(line));

    // Without an `error` listener, an async write failure on the stdin pipe
    // (EPIPE / ERR_STREAM_DESTROYED after the CLI exits) becomes an uncaught
    // exception that crashes the extension host. Swallow it here; `writeLine`
    // handles the synchronous path.
    this.proc.stdin.on("error", (err) => {
      this.opts.log(`[acp] stdin error: ${(err as Error).message}`);
    });

    this.proc.stderr.on("data", (d) => {
      const text = d.toString();
      this.opts.log(`[stderr] ${text}`);
      this.emit("stderr", text);
    });
    this.proc.on("exit", (code) => {
      this.opts.log(`${this.backend.processName} exited with code ${code}`);
      // Drop the process handle so later writes are skipped rather than hitting
      // a destroyed pipe (`this.proc?` alone stays truthy after exit).
      this.proc = undefined;
    });
    // Wait for `close`, not merely `exit`, before rejecting pending requests and
    // notifying the host. Node may emit `exit` while stdout is still draining;
    // a final successful interject response must be parsed before exit recovery
    // decides whether its user text still needs to be reclaimed.
    this.proc.on("close", (code) => {
      for (const [id, p] of this.pending) {
        this.pending.delete(id);
        if (p.timer) clearTimeout(p.timer);
        p.reject(new Error(`${this.backend.processName} exited (code ${code})`));
      }
      this.emit("exit", code);
    });
    this.proc.on("error", (err) => {
      this.opts.log(`spawn error: ${err.message}`);
      this.emit("error", err);
    });

    const init = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: acpClientCapabilities(
        this.provider,
        this.opts.grokVersion,
        this.opts.grokVersionVerified === true,
      ),
    });
    this.emit("initialized", init);
  }

  private async mcpServersForSession(): Promise<AcpMcpStdioServer[]> {
    const value = this.opts.mcpServers;
    if (typeof value === "function") return await value();
    return Array.isArray(value) ? value : [];
  }

  async newSession(modelId?: string): Promise<{ sessionId: string }> {
    const raw = await this.request("session/new", {
      cwd: this.opts.cwd,
      mcpServers: await this.mcpServersForSession(),
    });
    const res = this.backend.normalizeSessionResponse(raw);
    this.sessionId = res.sessionId;
    this.availableModels = (res.models?.availableModels ?? []).map((m: any) => ({
      modelId: m.modelId,
      name: m.name,
      description: m.description,
      totalContextTokens: m._meta?.totalContextTokens,
      supportsReasoningEffort: m._meta?.supportsReasoningEffort === true,
      reasoningEffort: typeof m._meta?.reasoningEffort === "string" ? m._meta.reasoningEffort : undefined,
      reasoningEfforts: Array.isArray(m._meta?.reasoningEfforts)
        ? m._meta.reasoningEfforts.map((e: any) => e?.value).filter((v: unknown): v is string => typeof v === "string")
        : undefined,
    }));
    this.currentModelId = resolveModelId(res.models?.currentModelId, this.availableModels);
    // The active session effort is authoritative from the advertised current
    // model (grok stamps SessionHandle.reasoning_effort onto it); fall back to
    // the spawn flag only when it's absent.
    this.currentReasoningEffort =
      this.availableModels.find((m) => m.modelId === this.currentModelId)?.reasoningEffort ||
      this.opts.effort ||
      undefined;
    this.emit("session", res);

    if (modelId && modelId !== this.currentModelId) {
      try {
        await this.setModel(modelId);
      } catch (err) {
        this.opts.log(`[acp] Failed to set model to ${modelId}: ${(err as Error).message}. Falling back to default model ${this.currentModelId}.`);
      }
    }
    // Spawn `--reasoning-effort` is grok-only. Adapters take effort as a
    // session config option after session/new — recording `opts.effort`
    // locally without this RPC left the UI showing a level Claude/Codex
    // were not running.
    if (this.opts.effort && this.provider !== "grok") {
      try {
        await this.setReasoningEffort(this.opts.effort);
      } catch (err) {
        this.opts.log(`[acp] Failed to set reasoning effort to ${this.opts.effort}: ${(err as Error).message}.`);
      }
    }
    return { sessionId: res.sessionId };
  }

  async loadSession(sessionId: string, modelId?: string): Promise<{ sessionId: string }> {
    const raw = await this.request("session/load", {
      sessionId,
      cwd: this.opts.cwd,
      mcpServers: await this.mcpServersForSession(),
    });
    const res = this.backend.normalizeSessionResponse(raw);
    this.sessionId = sessionId;
    if (res?.models?.availableModels) {
      this.availableModels = res.models.availableModels.map((m: any) => ({
        modelId: m.modelId,
        name: m.name,
        description: m.description,
        totalContextTokens: m._meta?.totalContextTokens,
        supportsReasoningEffort: m._meta?.supportsReasoningEffort === true,
        reasoningEffort: typeof m._meta?.reasoningEffort === "string" ? m._meta.reasoningEffort : undefined,
      reasoningEfforts: Array.isArray(m._meta?.reasoningEfforts)
        ? m._meta.reasoningEfforts.map((e: any) => e?.value).filter((v: unknown): v is string => typeof v === "string")
        : undefined,
      }));
    }
    this.currentModelId =
      resolveModelId(res?.models?.currentModelId, this.availableModels) ?? this.currentModelId;
    // Restore the session's persisted effort from the advertised current model —
    // NOT the global spawn default — so a later model switch carries the real
    // session override, not a stale global value.
    const loadedEffort = this.availableModels.find((m) => m.modelId === this.currentModelId)?.reasoningEffort;
    if (loadedEffort) this.currentReasoningEffort = loadedEffort;
    this.emit("session", { sessionId, ...(res ?? {}) });
    this.emit("sessionLoaded", { sessionId });
    if (modelId && modelId !== this.currentModelId) {
      try {
        await this.setModel(modelId);
      } catch (err) {
        this.opts.log(`[acp] Failed to set model to ${modelId}: ${(err as Error).message}. Keeping ${this.currentModelId}.`);
      }
    }
    return { sessionId };
  }

  async setModel(modelId: string): Promise<void> {
    if (!this.sessionId) throw new Error("no session");
    // Carry the live effort override through a compatible switch — a bare
    // set_model lets the server resolve the new model's default effort, silently
    // dropping a prior live setReasoningEffort. But ONLY carry a level the TARGET
    // model offers: the CLI gates its flag on the per-model effort menu yet does
    // NOT menu-check a `_meta` override, so carrying an off-menu level could reach
    // the backend and 400. If the target advertises no menu, don't carry (let the
    // server resolve its default) rather than risk an off-menu value.
    const target = this.availableModels.find((m) => m.modelId === modelId);
    const carry =
      this.currentReasoningEffort &&
      Array.isArray(target?.reasoningEfforts) &&
      target!.reasoningEfforts.includes(this.currentReasoningEffort);
    const call = this.backend.setModel(this.sessionId, modelId, carry ? this.currentReasoningEffort : undefined);
    const res = await this.request(call.method, call.params);
    const state = this.backend.configState(res, {
      modelId,
      reasoningEffort: carry ? this.currentReasoningEffort : undefined,
      modeId: this.currentModeId,
    });
    const ok = res?._meta?.model?.Ok;
    if (this.backend.modelSetSucceeded(res)) {
      // grok's set_model echoes a *versioned* id ("grok-build-0.1") that carries no
      // name or context size and isn't in availableModels ("grok-build"). We
      // requested a list id (the picker only ever offers list ids), so anchor to
      // that — it always resolves to a name + context window. Only if the requested
      // id somehow isn't in the list (e.g. a stale grok.defaultModel) do we fall
      // back to normalizing grok's echo.
      const requestedInList = this.availableModels.some((m) => m.modelId === modelId);
      this.currentModelId = this.provider === "grok"
        ? (requestedInList ? modelId : (resolveModelId(ok, this.availableModels) ?? ok))
        : (state.modelId ?? modelId);
      if (this.provider !== "grok") {
        this.currentReasoningEffort = state.reasoningEffort;
        this.currentModeId = state.modeId;
        const current = this.availableModels.find((entry) => entry.modelId === this.currentModelId);
        if (current) current.reasoningEffort = this.currentReasoningEffort;
      }
      this.emit("modelChanged", this.currentModelId);
    }
  }

  /** Whether the current model advertises per-session reasoning effort
   *  (`models[]._meta.supportsReasoningEffort`) — the gate for changing effort
   *  live via `setReasoningEffort` instead of restarting the process. */
  currentModelSupportsEffort(): boolean {
    return !!this.availableModels.find((m) => m.modelId === this.currentModelId)?.supportsReasoningEffort;
  }

  /** Change reasoning effort on the LIVE session — no process restart — via
   *  `session/set_model` with `_meta.reasoningEffort` (the same model id + an
   *  effort override; grok applies and persists it per-session, confirmed on
   *  0.2.101). Only a real, non-empty effort can be set this way — unsetting back
   *  to default still needs a fresh spawn without `--reasoning-effort`. Caller
   *  falls back to a restart on `false`/throw.
   *
   *  Return caveat: the boolean means the CLI *accepted the set_model call*
   *  (`_meta.model.Ok`) — the caller gates on the model advertising
   *  `supportsReasoningEffort`. Whether the effort was actually APPLIED is
   *  reflected authoritatively by the `model_changed` notification (handled in
   *  the session_notification path), which carries the EFFECTIVE effort and
   *  updates `currentReasoningEffort`. We deliberately DON'T set that field
   *  optimistically here: the CLI emits `model_changed` BEFORE the set_model
   *  response, so an optimistic post-response write would clobber the true value
   *  on a build that resolved the effort differently. */
  async setReasoningEffort(level: string): Promise<boolean> {
    if (!this.sessionId) throw new Error("no session");
    if (!level) return false; // "" = unset → cannot be expressed as an override
    const call = this.backend.setReasoningEffort(this.sessionId, this.currentModelId, level);
    if (!call) return false;
    const res = await this.request(call.method, call.params);
    const accepted = this.backend.modelSetSucceeded(res);
    if (accepted && this.provider !== "grok") {
      const state = this.backend.configState(res, {
        modelId: this.currentModelId,
        reasoningEffort: level,
        modeId: this.currentModeId,
      });
      this.currentModelId = state.modelId ?? this.currentModelId;
      this.currentReasoningEffort = state.reasoningEffort;
      this.currentModeId = state.modeId;
      const current = this.availableModels.find((entry) => entry.modelId === this.currentModelId);
      if (current) current.reasoningEffort = this.currentReasoningEffort;
    }
    return accepted;
  }

  async setMode(modeId: string): Promise<void> {
    if (!this.sessionId) throw new Error("no session");
    const call = this.backend.setMode(this.sessionId, modeId);
    const res = await this.request(call.method, call.params, () => {
      // The host still raises session chrome after this await. readline can
      // deliver a later ACP line in this same turn, so the Plan-accepted bit
      // has to land here — after a successful reply, before the next onLine.
      // Grok needs the fs/terminal gate up; Codex/Claude need the same bit so
      // Auto accept cannot grant a same-chunk request_permission (plan review
      // is one). usesClientPlanGate still decides whether writes/terminals
      // are blocked.
      if (modeId === "plan") this.planActive = true;
    });
    const state = this.backend.configState(res, {
      modelId: this.currentModelId,
      reasoningEffort: this.currentReasoningEffort,
      modeId,
    });
    if (this.provider !== "grok" && state.modeId) {
      this.currentModelId = state.modelId ?? this.currentModelId;
      this.currentReasoningEffort = state.reasoningEffort;
      this.currentModeId = state.modeId;
      const current = this.availableModels.find((entry) => entry.modelId === this.currentModelId);
      if (current) current.reasoningEffort = this.currentReasoningEffort;
      this.emit("modeChanged", state.modeId);
    }
  }

  async prompt(textOrBlocks: string | PromptContentBlock[]): Promise<PromptResultMeta> {
    if (!this.sessionId) throw new Error("no session");
    const prompt: PromptContentBlock[] =
      typeof textOrBlocks === "string"
        ? [{ type: "text", text: textOrBlocks }]
        : textOrBlocks;
    const raw = await this.request("session/prompt", {
      sessionId: this.sessionId,
      prompt,
    });
    const result = this.backend.normalizePromptResult(raw);
    const meta = extractPromptMeta(result);
    this.lastMeta = meta;
    this.emit("promptComplete", meta);
    return meta;
  }

  async listSessions(cwd = this.opts.cwd, platform: NodeJS.Platform = process.platform): Promise<BackendSessionListResult> {
    const result = await this.backend.listSessions((method, params) => this.request(method, params), cwd, platform);
    if (this.provider === "grok" || !this.sessionId || result.sessions.some((entry) => entry.sessionId === this.sessionId)) {
      return result;
    }
    return {
      ...result,
      sessions: [{ sessionId: this.sessionId, cwd: this.opts.cwd, title: this.currentSessionTitle }, ...result.sessions],
    };
  }

  /** Read Grok's MCP inventory from the same ACP session as the conversation. */
  async listMcpServers(): Promise<unknown[] | { servers?: unknown[]; result?: unknown } | "unsupported"> {
    if (this.provider !== "grok") return "unsupported";
    if (!this.sessionId) throw new Error("no session");
    try {
      // The method is scoped to the active ACP session; unlike ordinary ACP
      // methods it accepts an empty parameter object rather than sessionId.
      return await this.request("_x.ai/mcp/list", {});
    } catch (error) {
      if (isMethodNotFoundError(error)) {
        this.opts.log("[mcp] CLI does not support _x.ai/mcp/list");
        return "unsupported";
      }
      throw error;
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (this.provider === "grok") throw new Error("This backend does not support ACP session deletion.");
    await this.request("session/delete", { sessionId });
  }

  isCredentialError(error: unknown): boolean {
    return this.backend.isCredentialError(error);
  }

  /**
   * Mid-turn steering (#52) — "Steer". Queues `text` into the session's pending
   * interjection buffer, which the agent drains at its next safe point. It does
   * **not** cancel the turn and loses no in-flight tool work: probed on 0.2.101
   * against a live turn, the model changed course mid-stream and the turn still
   * ended `end_turn` (research/grok-build-oss-findings.md § 3a).
   *
   * `_x.ai/interject` is unadvertised, so a pre-~0.2.96 CLI answers -32601. That
   * returns `"unsupported"` (not a throw) so the caller can fall back to queueing
   * — the user's text must never be lost to a capability gap.
   *
   * `content` is additive: image-capable CLIs take structured text + image
   * blocks (the Text block wins over `text`); older CLIs keep reading `text`.
   * Omit it when there are no images so the legacy wire stays byte-identical.
   * The host must not pass image blocks to a CLI that ignores `content`.
   */
  async interject(
    text: string,
    onQueued?: () => void,
    content?: readonly PromptContentBlock[],
  ): Promise<"ok" | "unsupported"> {
    if (!this.sessionId) throw new Error("no session");
    try {
      await this.request(
        "_x.ai/interject",
        buildInterjectParams(this.sessionId, text, content),
        () => onQueued?.(),
      );
      return "ok";
    } catch (e: any) {
      if (isMethodNotFoundError(e)) {
        this.opts.log("[interject] CLI does not support _x.ai/interject; falling back to queue");
        return "unsupported";
      }
      throw e;
    }
  }

  /** Live-verified grok that will apply interject `content` rather than drop it. */
  honorsInterjectContent(): boolean {
    return this.provider === "grok"
      && cliHonorsInterjectContent(this.opts.grokVersion, this.opts.grokVersionVerified === true);
  }

  /**
   * Spontaneous thumbs rating (#114). Logical method `x.ai/feedback`; wire
   * name `_x.ai/feedback` (ACP `_` extension prefix — a bare `x.ai/feedback`
   * is -32601 at decode). `"unsupported"` on -32601, a disabled-feedback
   * internal_error, or a non-Grok backend so the caller can hide the buttons.
   */
  async submitFeedback(opts: {
    ratingValue: ThumbsRating;
    clientType: FeedbackClientType;
    clientVersion?: string;
  }): Promise<"ok" | "unsupported"> {
    if (this.provider !== "grok") return "unsupported";
    if (!this.sessionId) throw new Error("no session");
    try {
      await this.request(FEEDBACK_RPC_METHOD, buildClientFeedbackParams({
        sessionId: this.sessionId,
        clientType: opts.clientType,
        ratingValue: opts.ratingValue,
        clientVersion: opts.clientVersion,
      }));
      return "ok";
    } catch (e: any) {
      if (isMethodNotFoundError(e) || isFeedbackDisabledError(e)) {
        this.opts.log("[feedback] CLI does not accept x.ai/feedback");
        return "unsupported";
      }
      throw e;
    }
  }

  /**
   * Fork a session (#48) — copies the conversation into a NEW session id, leaving
   * the source untouched (probe-verified: parent history byte-unchanged after
   * forking + using the fork). Params are `ForkSessionRequest`'s three required
   * camelCase fields; `{sessionId}` alone is -32602.
   *
   * This branches the CONVERSATION only — grok never touches the workspace here,
   * so files stay exactly as they are (`/rewind` is the separate feature that
   * restores file snapshots). We deliberately omit `targetPromptIndex`: it works
   * on the wire but truncates `chat_history` without truncating `updates.jsonl`,
   * so a partial fork would replay a conversation the model has forgotten.
   * Returns the new session id, or `"unsupported"` on an older CLI.
   */
  async forkSession(cwd: string): Promise<{ newSessionId: string } | "unsupported"> {
    if (!this.sessionId) throw new Error("no session");
    try {
      const r = await this.request("_x.ai/session/fork", {
        sourceSessionId: this.sessionId,
        sourceCwd: cwd,
        newCwd: cwd,
      });
      const newSessionId = r?.newSessionId;
      if (!newSessionId) throw new Error("fork returned no newSessionId");
      return { newSessionId };
    } catch (e: any) {
      if (isMethodNotFoundError(e)) {
        this.opts.log("[fork] CLI does not support _x.ai/session/fork");
        return "unsupported";
      }
      throw e;
    }
  }

  /**
   * Create an isolated git worktree for this session (P2-8).
   * Required params: `sessionId` (this session) + `sourcePath` (the main
   * checkout). Optional `label` names the worktree dir under
   * `~/.grok/worktrees/<repo>/`. Returns immediately with `status:"creating"`;
   * progress/completion rides `_x.ai/git/worktree/status` (emitted as
   * `worktreeStatus`). `"unsupported"` on older CLIs (-32601).
   */
  async createWorktree(opts: {
    sourcePath: string;
    label?: string;
  }): Promise<WorktreeCreateResult | "unsupported"> {
    if (!this.sessionId) throw new Error("no session");
    try {
      const params: Record<string, string> = {
        sessionId: this.sessionId,
        sourcePath: opts.sourcePath,
      };
      if (opts.label) params.label = opts.label;
      const r = await this.request("_x.ai/git/worktree/create", params);
      const parsed = parseWorktreeCreate(r);
      if (!parsed) throw new Error("worktree/create returned no worktreePath");
      return parsed;
    } catch (e: any) {
      if (isMethodNotFoundError(e)) {
        this.opts.log("[worktree] CLI does not support _x.ai/git/worktree/create");
        return "unsupported";
      }
      throw e;
    }
  }

  /** List tracked worktrees. Empty params = all; optional filters pass through. */
  async listWorktrees(params: Record<string, unknown> = {}): Promise<WorktreeRecord[] | "unsupported"> {
    try {
      const r = await this.request("_x.ai/git/worktree/list", params);
      return parseWorktreeList(r);
    } catch (e: any) {
      if (isMethodNotFoundError(e)) {
        this.opts.log("[worktree] CLI does not support _x.ai/git/worktree/list");
        return "unsupported";
      }
      throw e;
    }
  }

  /**
   * Merge a worktree's file changes back into the main checkout.
   * Required: `sessionId` (any live session works) + `worktreePath`.
   */
  async applyWorktree(worktreePath: string): Promise<WorktreeApplyResult | "unsupported"> {
    if (!this.sessionId) throw new Error("no session");
    try {
      const r = await this.request("_x.ai/git/worktree/apply", {
        sessionId: this.sessionId,
        worktreePath,
      });
      const parsed = parseWorktreeApply(r);
      if (!parsed) throw new Error("worktree/apply returned an empty result");
      return parsed;
    } catch (e: any) {
      if (isMethodNotFoundError(e)) {
        this.opts.log("[worktree] CLI does not support _x.ai/git/worktree/apply");
        return "unsupported";
      }
      throw e;
    }
  }

  /** Remove a worktree by path. Fails if a live process still has it as cwd. */
  async removeWorktree(worktreePath: string): Promise<WorktreeRemoveResult | "unsupported"> {
    try {
      const r = await this.request("_x.ai/git/worktree/remove", { worktreePath });
      const parsed = parseWorktreeRemove(r);
      if (!parsed) throw new Error("worktree/remove returned an empty result");
      return parsed;
    } catch (e: any) {
      if (isMethodNotFoundError(e)) {
        this.opts.log("[worktree] CLI does not support _x.ai/git/worktree/remove");
        return "unsupported";
      }
      throw e;
    }
  }

  /**
   * Structured session context size (`_x.ai/session/info`) — control-plane only.
   * Does **not** send a model turn or inflate the context window (probe-verified
   * 0.2.112). Used to seed/refresh the context donut when turn meta / compact
   * notifications / signals.json are missing or stale. `"unsupported"` on
   * older CLIs (-32601); callers fall back to disk or the hidden `/session-info`
   * prompt scrape.
   */
  async getSessionInfo(): Promise<SessionInfoContext | "unsupported"> {
    if (!this.sessionId) throw new Error("no session");
    if (this.provider !== "grok") return "unsupported";
    try {
      const r = await this.request("_x.ai/session/info", { sessionId: this.sessionId });
      const parsed = parseSessionInfoRpcResult(r);
      if (!parsed) throw new Error("session/info returned no usable context");
      return parsed;
    } catch (e: any) {
      if (isMethodNotFoundError(e)) {
        this.opts.log("[session/info] CLI does not support _x.ai/session/info");
        return "unsupported";
      }
      throw e;
    }
  }

  /**
   * List rewind points for this session (P2-9). One point per user prompt;
   * each carries a prompt preview + whether file snapshots exist.
   * `"unsupported"` on older CLIs (-32601).
   */
  async listRewindPoints(): Promise<RewindPoint[] | "unsupported"> {
    if (!this.sessionId) throw new Error("no session");
    try {
      const r = await this.request("_x.ai/rewind/points", { sessionId: this.sessionId });
      return parseRewindPoints(r);
    } catch (e: any) {
      if (isMethodNotFoundError(e)) {
        this.opts.log("[rewind] CLI does not support _x.ai/rewind/points");
        return "unsupported";
      }
      throw e;
    }
  }

  /**
   * Rewind conversation (+ optional file snapshots) to `targetPromptIndex`.
   * Always passes `force: true` — the extension's confirm dialog is the UX
   * gate (without force the CLI returns success:false with no truncation).
   * Default mode `"all"` matches the TUI `/rewind` (conversation + files).
   * `"unsupported"` on older CLIs.
   */
  async executeRewind(opts: {
    targetPromptIndex: number;
    mode?: RewindMode;
  }): Promise<RewindExecuteResult | "unsupported"> {
    if (!this.sessionId) throw new Error("no session");
    try {
      const r = await this.request("_x.ai/rewind/execute", {
        sessionId: this.sessionId,
        targetPromptIndex: opts.targetPromptIndex,
        mode: opts.mode ?? "all",
        force: true,
      });
      const parsed = parseRewindExecute(r);
      if (!parsed) throw new Error("rewind/execute returned an empty result");
      return parsed;
    } catch (e: any) {
      if (isMethodNotFoundError(e)) {
        this.opts.log("[rewind] CLI does not support _x.ai/rewind/execute");
        return "unsupported";
      }
      throw e;
    }
  }

  async cancel(reason = "unspecified"): Promise<boolean> {
    if (!this.sessionId) return false;
    // Log every outbound cancel with its trigger — the CLI logs the receipt
    // (`shell.cancel.received … trigger:null`) but not who asked, so when a
    // user reports "my turn died and I touched nothing" (#37) this line is
    // what attributes the cancel to a Stop click / plan verdict / nothing-of-ours.
    this.opts.log(`[cancel] sending session/cancel (${reason}) for ${this.sessionId}`);
    // ACP defines session/cancel as a notification (no id) — sending it as a
    // request causes grok-cli to ignore it. Write directly to stdin without an
    // id and don't await a response.
    return this.writeLine({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.sessionId } });
  }

  /** Respond to a pending permission request (from the agent) with the chosen option id. */
  respondPermission(requestId: number | string, optionId: string): boolean {
    return this.writeLine(makePermissionResponse(requestId, optionId));
  }

  /** Decline a permission request when the client has no safe offered option. */
  respondPermissionCancelled(requestId: number | string): boolean {
    return this.writeLine(makePermissionCancelledResponse(requestId));
  }

  /** Respond to a pending exit_plan_mode request with the user's verdict. */
  respondExitPlan(requestId: number | string, type: "approved" | "abandoned" | "rejected"): boolean {
    return this.writeLine(makeExitPlanResponse(requestId, type));
  }

  /** Refuse an exit-plan request when native verdict semantics are unavailable. */
  respondExitPlanUnavailable(requestId: number | string): boolean {
    return this.writeLine(makeExitPlanUnavailableResponse(requestId));
  }

  /** Respond to a pending ask_user_question request with the user's selections. */
  respondQuestion(
    requestId: number | string,
    answers: Record<string, string>,
    annotations: Record<string, { notes?: string; preview?: string }> = {},
  ): boolean {
    return this.writeLine(makeQuestionResponse(requestId, answers, annotations));
  }

  /** Respond to a pending ask_user_question request that the user dismissed. */
  respondQuestionCancelled(requestId: number | string): boolean {
    return this.writeLine(makeQuestionCancelledResponse(requestId));
  }

  /**
   * Tear the process down, resolving only once it has *actually* exited — a
   * caller that must replace the binary (`grok update`) can't race a still-open
   * Windows file lock on `grok.exe`. `kill()` only signals; the OS releases the
   * lock a beat later when the process finishes tearing down. On win32 the grok
   * agent backgrounds subagent / command children that a parent-only kill would
   * orphan (and which keep the executable locked), so kill the whole tree via
   * `taskkill /T /F`. Resolves on the `exit` event, or after `timeoutMs` as a
   * fallback so a wedged process can't hang the caller forever. Fire-and-forget
   * callers can ignore the returned promise — the kill is still initiated now.
   */
  dispose(timeoutMs = 3000): Promise<void> {
    this.rl?.close();
    const proc = this.proc;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
      try { proc?.kill(); } catch { /* already gone */ }
      return Promise.resolve();
    }
    if (this.provider !== "grok") {
      return new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve();
        };
        const abruptKill = () => {
          if (process.platform === "win32" && proc.pid !== undefined) {
            try {
              const tk = spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"]);
              tk.on("error", () => { try { proc.kill(); } catch { /* already gone */ } });
            } catch { try { proc.kill(); } catch { /* already gone */ } }
          } else {
            try { proc.kill(); } catch { /* already gone */ }
          }
        };
        const timer = setTimeout(() => { abruptKill(); finish(); }, timeoutMs);
        proc.once("exit", finish);
        try { proc.stdin.end(); } catch { abruptKill(); }
      });
    }
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      proc.once("exit", finish);
      const fallbackKill = () => { try { proc.kill(); } catch { finish(); } };
      if (process.platform === "win32" && proc.pid !== undefined) {
        // Parent-only kill orphans grok's backgrounded children, which keep
        // grok.exe locked; `/T` kills the tree, `/F` forces it. Fall back to a
        // plain signal if taskkill can't be spawned.
        try {
          const tk = spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"]);
          tk.on("error", fallbackKill);
        } catch {
          fallbackKill();
        }
      } else {
        fallbackKill();
      }
    });
  }

  // ---------- internals ----------

  /**
   * Single gated path for every stdin write. Returns false (and never throws)
   * if the process is gone or the pipe isn't writable — the optional-chaining
   * `this.proc?` check alone is not enough, since a destroyed pipe is still
   * non-null and `write()` on it throws/emits ERR_STREAM_DESTROYED.
   */
  private writeLine(obj: unknown): boolean {
    const proc = this.proc;
    if (!proc || proc.killed || !proc.stdin.writable) return false;
    try {
      proc.stdin.write(JSON.stringify(obj) + "\n");
      return true;
    } catch (err) {
      this.opts.log(`[acp] stdin write failed: ${(err as Error).message}`);
      return false;
    }
  }

  private request(
    method: string,
    params: any,
    onResolve?: (value: any) => void,
  ): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const now = Date.now();
      const entry: Pending = {
        resolve,
        reject,
        onResolve,
        method,
        isPrompt: method === "session/prompt",
        startedAt: now,
        lastActivityAt: now,
      };
      this.pending.set(id, entry);
      if (!this.writeLine(makeRequest(id, method, params))) {
        this.pending.delete(id);
        reject(new Error(`Grok process is not running (${method})`));
        return;
      }
      // Tracked on the pending entry so the response/exit paths can clear it.
      // session/prompt uses idle+absolute policy (#117); other methods keep a
      // fixed cap. A live timer must not outlive the request.
      const arm = () => {
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = undefined;
        let waitMs: number;
        if (entry.isPrompt) {
          waitMs = promptTimerDelayMs({
            startedAt: entry.startedAt ?? now,
            lastActivityAt: entry.lastActivityAt ?? now,
            now: Date.now(),
            idleMs: this.timeouts.promptIdleTimeoutMs,
            absoluteMs: this.timeouts.promptAbsoluteTimeoutMs,
          });
          if (!Number.isFinite(waitMs)) return;
        } else {
          waitMs = this.timeouts.requestTimeoutMs;
        }
        entry.timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            reject(new Error(`ACP request timed out: ${method}`));
          }
        }, waitMs);
      };
      entry.armTimer = arm;
      arm();
    });
  }

  /** Re-arm in-flight `session/prompt` idle timers on live ACP traffic. */
  private touchPendingPromptTimers(): void {
    const now = Date.now();
    for (const [, p] of this.pending) {
      if (!p.isPrompt || typeof p.armTimer !== "function") continue;
      p.lastActivityAt = now;
      p.armTimer();
    }
  }

  private respondOk(id: number | string, result: any = {}): boolean {
    return this.writeLine(makeAckResponse(id, result));
  }

  private respondError(id: number | string, code: number, message: string): boolean {
    return this.writeLine({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private onLine(line: string): void {
    const ev = parseAcpLine(line);
    if (!ev) return;
    if (ev.kind === "non-json") {
      this.opts.log(`[non-json] ${ev.line.slice(0, 200)}`);
      return;
    }
    if (ev.kind === "response") {
      const p = this.pending.get(ev.id as number);
      if (p) {
        this.pending.delete(ev.id as number);
        if (p.timer) clearTimeout(p.timer);
        // A response is ACP traffic too, and the idle policy (#117) is "fire
        // only if nothing has been heard". Concurrent in-turn calls answer
        // during a long prompt — `_x.ai/interject`, `_x.ai/feedback`, `session/set_mode` — and
        // each reply proves the peer is alive. Re-arm AFTER this entry is out
        // of `pending`, so a prompt's own response doesn't arm a timer for a
        // request that just finished.
        this.touchPendingPromptTimers();
        if (ev.error) {
          if (this.provider !== "grok" && this.backend.isCredentialError(ev.error)) {
            this.emit("credentialError", ev.error);
          }
          p.reject(ev.error);
        }
        else {
          try { p.onResolve?.(ev.result); }
          catch (e) { this.opts.log(`[acp] response hook failed: ${(e as Error).message}`); }
          p.resolve(ev.result);
        }
      }
      return;
    }
    if (ev.kind === "session-update") {
      this.touchPendingPromptTimers();
      this.handleSessionUpdate(ev.update, ev.meta, ev.sessionId);
      return;
    }
    this.touchPendingPromptTimers();
    void this.handleServerRequest({ id: ev.id, method: ev.method, params: ev.params });
  }

  private handleSessionUpdate(u: any, meta?: any, sessionId?: string): void {
    const foreign = isForeignSessionUpdate(sessionId, this.sessionId);
    const normalized = this.backend.normalizeUpdate(u, meta);
    if (!foreign) {
      if (normalized.sessionTitle) {
        this.currentSessionTitle = normalized.sessionTitle;
        this.emit("sessionTitle", normalized.sessionTitle);
      }
      if (normalized.contextWindow !== undefined) {
        this.lastContextWindow = normalized.contextWindow;
        // Claude's live id is often an alias (`opus[1m]`) that is not the
        // picker value. Still keep the window — the webview reads it off
        // contextUsage, not the model catalog.
        const model = this.currentModelId
          ? this.availableModels.find((entry) => entry.modelId === this.currentModelId)
          : undefined;
        if (model) model.totalContextTokens = normalized.contextWindow;
      }
    }
    if (normalized.update === undefined && normalized.usageUpdateUsed === undefined && normalized.contextWindow === undefined) {
      return;
    }
    if (normalized.update !== undefined) {
      u = normalized.update;
      meta = normalized.meta;
    }
    if (!foreign) {
      // Ordinary adapter usage_update.used is billed per call (includes
      // output) and is not occupancy by itself. Compact's getContextUsage
      // is the exception — sidebar adopts it only after a compact
      // completed. Other values are per-call observations for
      // occupancyFromAdapterTurn.
      if (normalized.usageUpdateUsed !== undefined) {
        this.emit("adapterUsageUpdate", normalized.usageUpdateUsed, this.lastContextWindow);
      }
      const contextUsed = contextUsedFromUpdateEnvelope(meta);
      const usedChanged = contextUsed !== null && contextUsed !== this.lastContextUsed;
      if (usedChanged) this.lastContextUsed = contextUsed;
      if (usedChanged || normalized.contextWindow !== undefined) {
        this.emit("contextUsage", this.lastContextUsed, this.lastContextWindow);
      }
    }
    const r = routeSessionUpdate(u);
    if (!r) return;
    if (foreign) {
      this.emit("childStream", { childSessionId: sessionId, route: r, meta });
      return;
    }
    if (r.event === "modeChanged") {
      this.currentModeId = r.modeId;
      this.emit("modeChanged", r.modeId);
      return;
    }
    if (r.event === "configOptionUpdate") {
      const state = this.backend.configState({ configOptions: r.configOptions }, {
        modelId: this.currentModelId,
        reasoningEffort: this.currentReasoningEffort,
        modeId: this.currentModeId,
      });
      if (state.modelId) this.currentModelId = state.modelId;
      if (state.reasoningEffort !== undefined) {
        this.currentReasoningEffort = state.reasoningEffort;
        const current = this.availableModels.find((entry) => entry.modelId === this.currentModelId);
        if (current) current.reasoningEffort = this.currentReasoningEffort;
      }
      if (state.modeId && state.modeId !== this.currentModeId) {
        this.currentModeId = state.modeId;
        this.emit("modeChanged", state.modeId);
      }
      return;
    }
    if (r.event === "commandsUpdate") {
      // Hide config-mutating no-op commands (`/always-approve`) from both the
      // autocomplete and the dispatch gate at the single ingestion point (#31).
      this.availableCommands = filterAdvertisedCommands(r.commands);
      this.emit("commandsUpdate", this.availableCommands);
      return;
    }
    if (r.event === "taskBackgrounded") { this.emit("taskBackgrounded", r.payload); return; }
    if (r.event === "taskCompleted") { this.emit("taskCompleted", r.payload); return; }
    if (r.event === "messageChunk") this.emit("messageChunk", r.text, meta);
    else if (r.event === "userMessageChunk") this.emit("userMessageChunk", r.text, meta);
    else if (r.event === "thoughtChunk") this.emit("thoughtChunk", r.text);
    else if (r.event === "mediaContent") this.emit("mediaContent", r.media);
    else if (r.event === "toolCall") {
      this.emit("toolCall", r.payload);
      this.emitToolMedia(r.payload);
    } else if (r.event === "toolCallUpdate") {
      this.emit("toolCallUpdate", r.payload);
      this.emitToolMedia(r.payload);
    } else if (r.event === "plan") this.emit("plan", r.payload);
    else this.emit("update", r.payload);
  }

  /**
   * Emit any media carried by a tool call: ACP-standard image/resource blocks
   * (`collectToolImages`) plus grok's image_gen / image_to_video path-in-JSON
   * result, which only the flagged tool-call ids are allowed to produce.
   */
  private emitToolMedia(payload: any): void {
    const id = payload?.toolCallId;
    if (isMediaGenToolCall(payload, this.provider) && typeof id === "string") this.mediaGenCallIds.add(id);
    const media = collectToolImages(payload);
    if (typeof id === "string" && this.mediaGenCallIds.has(id)) {
      media.push(...extractGeneratedMediaPaths(payload));
      if (this.provider === "codex" && payload?.status === "completed" && !media.length && this.sessionId) {
        const inferred = inferCodexGeneratedImagePath(
          resolveCodexHome(this.opts.env ?? process.env),
          this.sessionId,
          id,
        );
        if (!inferred) {
          this.opts.log("[media] refused Codex generated-image ids or resolved path");
          return;
        }
        media.push({ media: "image", kind: "path", path: inferred, mimeType: "image/png" });
      }
    }
    for (const m of media) this.emit("mediaContent", m);
  }

  private async handleServerRequest(msg: any): Promise<void> {
    const { method, id, params } = msg;
    try {
      if (
        method === "_x.ai/mcp/servers_updated" ||
        method === "_x.ai/mcp/init_progress" ||
        method === "_x.ai/mcp_initialized" ||
        method === "_x.ai/mcp/server_status"
      ) {
        this.emit("mcpNotification", method, params);
        if (id != null) this.respondOk(id, {});
        return;
      }
      if (method === "fs/read_text_file") {
        if (!this.fsRead) throw new Error("fsRead handler not registered");
        const content = await this.fsRead(params.path);
        this.respondOk(id, { content });
        return;
      }
      if (method === "fs/write_text_file") {
        if (!this.fsWrite) throw new Error("fsWrite handler not registered");
        // Snoop grok's own plan.md write as a fallback. Current CLIs send
        // exit_plan_mode with planContent populated; sidebar.ts prefers
        // req.plan over the snooped lastPlanText.
        const grokHome = resolveGrokHome(this.opts.env ?? process.env);
        if (isGrokOwnedPlanFile(params.path, grokHome)) {
          this.emit("planFileContent", params.content ?? "");
        }
        if (this.usesClientPlanGate && shouldBlockWrite(params.path, {
          active: this.planActive,
          workspaceRoot: this.opts.cwd,
          grokHome,
        })) {
          this.emit("mutationBlocked", { kind: "write", target: params.path });
          this.respondError(id, PLAN_BLOCKED_CODE, PLAN_BLOCKED_WRITE_MSG);
          return;
        }
        await this.fsWrite(params.path, params.content);
        this.respondOk(id, {});
        return;
      }
      if (method === "terminal/create") {
        if (!this.terminal) throw new Error("terminal handler not registered");
        if (this.usesClientPlanGate && shouldBlockTerminal(params.command, {
          active: this.planActive,
          workspaceRoot: this.opts.cwd,
          grokHome: resolveGrokHome(this.opts.env ?? process.env),
          shellDialect: resolvedTerminalShellDialect(),
        })) {
          this.emit("mutationBlocked", { kind: "terminal", target: params.command });
          this.respondError(id, PLAN_BLOCKED_CODE, PLAN_BLOCKED_TERMINAL_MSG);
          return;
        }
        // Environment overrides can change the meaning of an otherwise
        // read-only command (PATH resolution, NODE_OPTIONS, language startup
        // hooks, etc.). Plan mode classifies the command against the host's
        // environment, so do not pass agent-supplied overrides to the spawner.
        const createParams = { ...params };
        if (this.usesClientPlanGate && this.planActive) delete createParams.env;
        const created = this.terminal.create(createParams);
        this.terminalCommands.set(created.terminalId, params.command);
        this.respondOk(id, created);
        return;
      }
      if (method === "terminal/output") {
        if (!this.terminal) throw new Error("terminal handler not registered");
        this.respondOk(id, this.terminal.output(params.terminalId));
        return;
      }
      if (method === "terminal/wait_for_exit") {
        if (!this.terminal) throw new Error("terminal handler not registered");
        const r = await this.terminal.waitForExit(params.terminalId);
        this.respondOk(id, r);
        return;
      }
      if (method === "terminal/kill") {
        if (!this.terminal) throw new Error("terminal handler not registered");
        this.terminal.kill(params.terminalId);
        this.respondOk(id, {});
        return;
      }
      if (method === "terminal/release") {
        if (!this.terminal) throw new Error("terminal handler not registered");
        // Snapshot the finished command's output before the buffer is dropped
        // (#41) — release is the last moment it exists.
        const cmd = this.terminalCommands.get(params.terminalId);
        if (cmd !== undefined) {
          this.terminalCommands.delete(params.terminalId);
          try {
            const snap = this.terminal.output(params.terminalId);
            this.emit("commandDone", {
              command: cmd,
              output: snap.output,
              exitCode: snap.exitStatus ? snap.exitStatus.exitCode : null,
              truncated: snap.truncated,
            });
          } catch { /* terminal already gone — nothing to report */ }
        }
        this.terminal.release(params.terminalId);
        this.respondOk(id, {});
        return;
      }
      if (method === "session/request_permission") {
        const normalizedParams = this.backend.normalizePermissionParams(params);
        const req: PermissionRequest = {
          id,
          sessionId: normalizedParams.sessionId,
          toolCall: normalizedParams.toolCall,
          options: normalizedParams.options ?? [],
          ...(this.provider !== "grok" && normalizedParams._meta !== undefined
            ? { _meta: normalizedParams._meta }
            : {}),
        };
        this.emit("permissionRequest", req);
        return; // response is async, host calls respondPermission()
      }
      if (
        method === "x.ai/exit_plan_mode" ||
        method === "_x.ai/exit_plan_mode"
      ) {
        const req: ExitPlanRequest = {
          id,
          sessionId: params?.sessionId ?? this.sessionId ?? "",
          plan: params?.planContent ?? params?.plan ?? params?.input?.plan ?? "",
        };
        this.emit("exitPlanRequest", req);
        return;
      }
      if (
        method === "x.ai/ask_user_question" ||
        method === "_x.ai/ask_user_question"
      ) {
        const req: QuestionRequest = {
          id,
          sessionId: params?.sessionId ?? this.sessionId ?? "",
          questions: Array.isArray(params?.questions) ? params.questions : [],
        };
        this.emit("questionRequest", req);
        return; // response is async — host calls respondQuestion()/respondQuestionCancelled()
      }
      if (
        method === "_x.ai/session_notification" ||
        method === "x.ai/session_notification"
      ) {
        // `model_changed` carries the EFFECTIVE reasoning effort the CLI actually
        // applied (post-resolution) — the authoritative signal that a live
        // set_model override took (or, on a non-conforming build, didn't). Keep
        // `currentReasoningEffort` in sync with reality so a later model switch
        // carries the real value, not an optimistic one.
        const upd = params?.update as { sessionUpdate?: unknown; reasoning_effort?: unknown; model_id?: unknown } | undefined;
        if (upd?.sessionUpdate === "model_changed") {
          this.currentReasoningEffort =
            typeof upd.reasoning_effort === "string" && upd.reasoning_effort ? upd.reasoning_effort : undefined;
          // Keep the model id in sync too — a server-side model change would
          // otherwise leave a later set_model/setReasoningEffort pointing at the
          // stale model, silently switching it back.
          if (typeof upd.model_id === "string" && upd.model_id) {
            this.currentModelId = resolveModelId(upd.model_id, this.availableModels) ?? upd.model_id;
          }
        }
        this.emit("xaiNotification", params?.update);
        if (id != null) this.respondOk(id, {});
        return;
      }
      if (
        method === "_x.ai/session/prompt_complete" ||
        method === "x.ai/session/prompt_complete"
      ) {
        this.emit("xaiPromptComplete", params);
        if (id != null) this.respondOk(id, {});
        return;
      }
      if (
        method === "_x.ai/session/update" ||
        method === "x.ai/session/update"
      ) {
        // Subagent lifecycle stream (subagent_spawned / subagent_finished) —
        // carries the duration_ms + child output that Composer's completed
        // tool_call_update lacks (wire capture:
        // test/fixtures/composer-subagent-session.jsonl), and doubles as a
        // completion backstop for the card.
        this.emit("subagentLifecycle", params?.update, params?._meta);
        if (id != null) this.respondOk(id, {});
        return;
      }
      if (
        method === "_x.ai/git/worktree/status" ||
        method === "x.ai/git/worktree/status"
      ) {
        // Create progress/completion. Parse into a stable shape; emit even when
        // unparseable so the host can log the raw params.
        const status = parseWorktreeStatus(params) ?? { status: "unknown" };
        this.emit("worktreeStatus", status, params);
        if (id != null) this.respondOk(id, {});
        return;
      }

      // unknown server request: emit + ack so the agent doesn't hang
      this.emit("serverRequest", msg);
      if (id != null) this.respondOk(id, {});
    } catch (err) {
      this.opts.log(`server request handler error (${method}): ${(err as Error).message}`);
      if (id != null) {
        this.respondError(id, -32603, (err as Error).message || "Internal error");
      }
    }
  }
}
