// Live ACP smoke against the REAL Codex, Claude and Muse adapters and user CLIs.
//
// DELIBERATELY NOT in `npm test`: this needs real credentials and the network,
// can fail for reasons unrelated to the product, and spends model credits.
// This is a release plumbing gate, separate from the offline build. A person
// must also judge the per-provider render reports before shipping.
// No fixture fallback — a green run against a fake would be worse than no run.
//
// Run: npm run smoke:acp [-- --provider=codex|claude|muse]
// Optional: CODEX_CLI_PATH / CLAUDE_CLI_PATH / MUSE_CLI_PATH (existing user CLI),
// ACP_SMOKE_<PROVIDER>_MODEL (must be advertised),
// ACP_SMOKE_RPC_TIMEOUT_MS (90000), ACP_SMOKE_TURN_TIMEOUT_MS (180000),
// ACP_SMOKE_WORKFLOW_TIMEOUT_MS (300000), ACP_SMOKE_DELIVERY_TIMEOUT_MS (60000).
// Evidence: .verification/acp-smoke/<unique run>/ (never overwritten).
// Agent workspaces are separate OS-temp directories, removed even on failure.
// Real provider homes are preserved: relocating them would hide credentials
// and invalidate the resume check. The CLI's own session history remains.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { smokeOutcome, hasClaudeAgentReceipt } from "./smoke-render-report.mjs";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const capabilities = ["initialize", "session/new", "streaming", "tool call", "permission", "cancellation", "resume"];
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const errorText = (error) => String(error?.message ?? error);

export function permissionSmokeNotApplicable(provider) {
  return provider === "muse" ? "Muse Agent mode leaves approval policy to Muse; scratch writes may be pre-approved, and this smoke does not force an ask policy. Permission prompting is not exercised." : undefined;
}

export const SUBAGENT_PROMPT = "This is a delegation plumbing test. You MUST actually invoke your subagent/Agent tool exactly once, even though the task is trivial; answering yourself does not test it. Its only job: reply with the single word ok. Wait for the child to finish, then tell me what it said. Keep it minimal and do nothing else. Use the cheapest available model and lowest supported reasoning effort for the subagent.";
export const WORKFLOW_PROMPT = "This is a workflow plumbing test. You MUST actually invoke your workflow tool, even though the task is trivial; answering yourself or launching ordinary subagents does not test it. Run exactly 2 steps, one agent per step. Step one: reply with the single word one. Step two: reply with the single word two. Declare both steps in the script's metadata before starting, wait for completion and report the result. Keep it minimal and do nothing else. Use the cheapest available model and lowest supported reasoning effort for both agents.";

export function inconclusive(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Catalogs currently expose names/tiers, not comparable prices. Never invent an ID. */
export function selectSmokeModel(response, override) {
  const models = response?.models?.availableModels?.filter(m => nonempty(m?.modelId)) ?? [];
  assert(models.length, "session advertised no models");
  const rank = (m) => {
    const label = `${m.modelId} ${m.name ?? ""}`;
    const description = m.description ?? "";
    if (/cheapest|lowest.cost|most affordable/i.test(description)) return 0;
    if (/cheap|economical|cost.efficient|affordable/i.test(description)) return 1;
    if (/\bnano\b/i.test(label)) return 2;
    if (/\b(haiku|mini|luna|flash|small)\b/i.test(label)) return 3;
    if (/\bfast\b/i.test(label)) return 4;
    return Infinity;
  };
  const candidates = models.filter(m => !/^(default|auto)$/i.test(m.modelId));
  const ordered = [...candidates].sort((a, b) => rank(a) - rank(b));
  // Captured Muse catalog: only versions/privacy variants of Spark, no cost
  // signals. Preserve the account's selected variant (including consent) rather
  // than inventing a price order or opting it into contributor data use.
  const sameSparkFamily = candidates.length > 0 && candidates.every(m => /^muse-spark-\d+(?:\.\d+)*(?:-contributor)?$/.test(m.modelId));
  const currentSpark = sameSparkFamily && candidates.find(m => m.modelId === response.models.currentModelId);
  const model = override ? models.find(m => m.modelId === override) : currentSpark || ordered[0];
  assert(model, `model override is not in the advertised catalog: ${override}`);
  assert(override || currentSpark || candidates.length === 1 || Number.isFinite(rank(model)),
    "catalog has no recognizable economy tier or prices; set ACP_SMOKE_<PROVIDER>_MODEL to the cheapest advertised ID (see wire evidence)");
  assert(override || currentSpark || ordered.filter(m => rank(m) === rank(model)).length === 1,
    "catalog has tied economy tiers without prices; set ACP_SMOKE_<PROVIDER>_MODEL to the cheapest advertised ID (see wire evidence)");
  const effort = lowestSmokeEffort(model);
  return { modelId: model.modelId, effort, basis: override ? "env override" : currentSpark
    ? "account-selected Spark variant; catalog supplies no prices or economy tiers, cheapest is unproven"
    : candidates.length === 1
    ? "only advertised concrete model" : "economy tier from advertised names/descriptions; catalog supplies no prices" };
}

/** Composer is an agent family, not necessarily part of a model ID. */
export function selectGrokLaneModel(session, override, composerOnly = false) {
  const available = session?.models?.availableModels ?? [];
  if (!composerOnly) return selectSmokeModel(session, override);
  const models = available.filter(m => /composer/i.test(`${m.modelId} ${m.name ?? ""} ${m._meta?.agentType ?? ""}`));
  if (!models.length) throw Object.assign(new Error(`subagent-composer unavailable: this session advertises no Composer agent/model; advertised: ${available.map(m => `${m.modelId} (agentType=${m._meta?.agentType ?? "unspecified"})`).join(", ") || "none"}. The ordinary subagent lane covers Grok Build; Composer-specific wire assertions cannot be exercised.`), { code: "GROK_COMPOSER_UNAVAILABLE" });
  return selectSmokeModel({ ...session, models: { ...session.models, availableModels: models } }, override);
}

/** Use the POST-switch menu: Claude removes effort entirely when Haiku is selected. */
export function selectSmokeEffort(response, model) {
  if (!Array.isArray(response?.configOptions)) return { effort: lowestSmokeEffort(model) };
  const options = response.configOptions.filter(o => o.category === "thought_level" || ["effort", "reasoning_effort"].includes(o.id));
  assert(options.length <= 1, "ambiguous reasoning config options");
  if (!options.length) return { effort: undefined };
  const option = options[0];
  assert(nonempty(option.id), "reasoning config option lacks id");
  const values = (option.options ?? []).flatMap(o => o.options ?? [o]).filter(o => o.value !== "default");
  if (!values.length) return { effort: undefined };
  return { effort: lowestSmokeEffort({ _meta: { reasoningEfforts: values } }), configId: option.id };
}

export function desktopSmokeCatalog(status) {
  return { models: { currentModelId: status.modelId, availableModels: status.models.map(m => ({ ...m, _meta: {
    supportsReasoningEffort: m.supportsReasoningEffort,
    reasoningEfforts: m.reasoningEfforts?.map(value => ({ value })),
  } })) } };
}

export function smokeScenario(argv, allowed) {
  const flags = argv.filter(a => a.startsWith("--scenario="));
  assert(flags.length <= 1, "provide only one --scenario");
  const scenario = flags[0]?.slice(11).replaceAll("-", " ");
  assert(!scenario || allowed.includes(scenario), `unknown scenario: ${scenario}; choose ${allowed.join(", ")}`);
  assert(!flags.length || scenario, "--scenario must name a scenario");
  return scenario;
}

export function lowestSmokeEffort(model) {
  const offered = (model?._meta?.reasoningEfforts ?? []).map(e => typeof e === "string" ? e : e?.value).filter(nonempty);
  if (!offered.length) {
    assert(!model?._meta?.supportsReasoningEffort, "model supports effort but advertises no effort menu");
    return undefined;
  }
  const effort = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].find(e => offered.includes(e));
  assert(effort, `unrecognized effort menu: ${offered.join(", ")}`);
  return effort;
}

export function delegationAttempted(frames, kind) {
  return frames.some(({ raw }) => kind === "workflow"
    ? raw?._meta?.claudeCode?.toolName === "Workflow" || raw?._meta?.["muse/workflow"]
      || raw?.sessionUpdate === "workflow_updated" || raw?.taskType === "workflow"
      || /^workflow$/i.test(raw?.title ?? "") || raw?._meta?.["x.ai/tool"]?.name === "workflow"
    : raw?.sessionUpdate?.startsWith("subagent_") || raw?._meta?.claudeCode?.subagent === true
      || raw?._meta?.claudeCode?.toolName === "Agent" || raw?._meta?.codex?.subagent
      || (["tool_call", "tool_call_update"].includes(raw?.sessionUpdate)
        && (raw.kind === "subagent" || /^(Agent|spawn_subagent|Start subagent\b.*)$/i.test(raw.title ?? ""))));
}

/** Consume normalized parent cards and only the child stream belonging to that card. */
export function checkSubagents(frames, sessionId, isSubagentToolCall) {
  assert(!frames.some(f => hasClaudeAgentReceipt(f.update)), "Claude launch receipt is not a subagent result or reply");
  const calls = new Map();
  for (const frame of frames.filter(f => f.sessionId === sessionId)) {
    const u = frame.update;
    if (!["tool_call", "tool_call_update"].includes(u?.sessionUpdate)) continue;
    if (u.sessionUpdate === "tool_call" && isSubagentToolCall(u)) {
      assert(nonempty(u.toolCallId), "normalized subagent card lacks toolCallId");
      calls.set(u.toolCallId, { ...u });
    } else if (calls.has(u.toolCallId)) {
      Object.assign(calls.get(u.toolCallId), Object.fromEntries(Object.entries(u).filter(([, v]) => v !== undefined)));
    }
  }
  if (!calls.size) {
    assert(!delegationAttempted(frames, "subagent"), "delegation wire evidence produced no normalized subagent card");
    throw inconclusive("MODEL_DID_NOT_DELEGATE", "model did not delegate; no subagent launch observed (no retry)");
  }
  let backgroundCount = 0;
  for (const call of calls.values()) {
    const output = typeof call.rawOutput === "string" ? call.rawOutput : call.rawOutput?.output;
    // A launch receipt proves only that the task started. It cannot satisfy
    // the result check if a later completion edge has no summary.
    const background = frames.some(f => f.sessionId === sessionId && f.raw?.toolCallId === call.toolCallId
      && (f.raw?._meta?.claudeCode?.toolResponse?.isAsync === true || hasClaudeAgentReceipt(f.raw)));
    if (background && call.status === "background") {
      assert(!nonempty(output) && !(call.content ?? []).some(b => nonempty(b.content?.text)), "background subagent has an unexpected result");
      backgroundCount++;
      continue;
    }
    assert.equal(call.status, "completed", `subagent ${call.toolCallId} did not complete successfully`);
    const content = !background && (call.content ?? []).some(b => nonempty(b.content?.text));
    const child = call.child_session_id;
    const childOutput = nonempty(child) && frames.some(f => f.sessionId === child
      && f.update?.sessionUpdate === "agent_message_chunk" && nonempty(f.update.content?.text));
    assert(nonempty(output) || content || childOutput, `subagent ${call.toolCallId} has no non-empty normalized result/child output`);
  }
  return `${calls.size} normalized subagent card(s): ${backgroundCount} in background (completion not reported), ${calls.size - backgroundCount} completed with non-empty result`;
}

/** All snapshots are parsed by the shipped parseRunProgressUpdate before this check. */
export function checkWorkflow(frames, provider) {
  const progress = frames.map(f => f.workflow).filter(p => p?.kind === "workflow");
  if (!progress.length) {
    assert(!delegationAttempted(frames, "workflow"), "workflow launch observed but no parsed workflowUpdate arrived");
    throw inconclusive("MODEL_DID_NOT_DELEGATE", "model did not delegate; no workflow launch observed (no retry)");
  }
  const id = progress[0].id;
  assert(progress.every(p => p.id === id), "expected one workflow, received unrelated run IDs");
  const last = progress.at(-1);
  assert(last.done && !last.failed && !last.cancelled, `workflow ${id} did not finish successfully (${last.phase})`);
  const roster = provider === "muse" ? "agents" : "phases";
  assert(progress.some(p => p[roster]?.length >= 2), `workflow ${id} never showed >=2 ${roster}`);
  if (provider === "claude") {
    // seedWorkflow comes from a second real normalizer fed ONLY Workflow tool
    // frames: AIR progress cannot manufacture the up-front script declaration.
    const seedFrame = frames.find(f => f.seedWorkflow?.id === id);
    const seed = seedFrame?.seedWorkflow;
    assert(seed?.phases?.length >= 2, "Workflow script metadata did not seed >=2 steps up front");
    const titles = seed.phases.map(p => p.title);
    assert(progress[0].phases?.length === titles.length, "first workflow update omitted declared steps");
    assert(progress.every(p => p.phases?.length === titles.length
      && p.phases.every((phase, i) => phase.title === titles[i])), "workflow steps were discovered late or changed order");
    const taskIds = new Set(frames.filter(f => f.raw?.toolCallId === seedFrame.raw.toolCallId)
      .flatMap(f => [f.raw.asyncTaskId, f.raw._meta?.claudeCode?.toolResponse?.taskId]).filter(nonempty));
    const tasks = frames.map(f => f.raw).filter(u => taskIds.has(u?.asyncTaskId));
    assert(tasks.some(u => u.sessionUpdate === "async_task_spawned" && u.taskType === "workflow")
      && tasks.some(u => u.sessionUpdate === "async_task_progress")
      && tasks.some(u => u.sessionUpdate === "async_task_state_update" && u.state === "completed"),
    "Workflow lacks correlated AIR spawn/progress/completion events");
  }
  return `workflow ${id}: >=2 ${roster}, parsed done=true (${progress.length} snapshots)${provider === "claude" ? "; all steps seeded from script metadata" : ""}`;
}

export function isMuseDeliveryChunk(message, sessionId, launchSettled, workflowDone) {
  return launchSettled && workflowDone && message.method === "session/update"
    && message.params?.sessionId === sessionId && message.params.update?.sessionUpdate === "agent_message_chunk"
    && message.params.update.content?.type === "text" && nonempty(message.params.update.content.text);
}

export function timeoutMs(value, fallback) {
  const ms = value === undefined ? fallback : Number(value);
  assert(Number.isSafeInteger(ms) && ms > 0 && ms <= 2_147_483_647, `invalid timeout: ${value}`);
  return ms;
}

export function bounded(promise, what, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${what} never arrived within ${ms}ms`), { code: "ACP_SMOKE_TIMEOUT" })), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** An approval is chosen from the WIRE before inspecting normalization. */
export function approvalOption(params) {
  const options = Array.isArray(params?.options) ? params.options : [];
  return options.find((o) => o?.kind === "allow_once" && nonempty(o.optionId))
    ?? options.find((o) => o?.kind === "allow_always" && nonempty(o.optionId));
}

export function checkPermission(raw, normalized, sessionId, selectedId) {
  assert.equal(raw.sessionId, sessionId, "permission sessionId does not match the prompt");
  assert.equal(normalized.sessionId, sessionId, "normalization lost permission sessionId");
  assert(nonempty(raw.toolCall?.toolCallId), "permission lacks toolCall.toolCallId");
  assert.equal(normalized.toolCall?.toolCallId, raw.toolCall.toolCallId, "normalization lost toolCallId");
  assert(nonempty(normalized.toolCall.title), "normalized permission lacks a usable title");
  assert(Array.isArray(raw.options) && raw.options.length > 0, "permission lacks options");
  for (const option of raw.options) {
    assert(nonempty(option.optionId) && nonempty(option.name), "malformed permission option");
    assert(["allow_once", "allow_always", "reject_once", "reject_always"].includes(option.kind), "unknown permission kind");
  }
  assert(normalized.options?.some((o) => o.optionId === selectedId), "normalization lost the selected approval option");
  assert.deepEqual(normalized._meta, raw._meta, "normalization lost permission metadata");
  assert.deepEqual(normalized.toolCall.rawInput, raw.toolCall.rawInput, "normalization lost tool input");
}

export function checkTools(updates, normalize, expectedFile) {
  const starts = new Map();
  // The two adapters disagree about WHERE a tool's arguments arrive, and the
  // host does not care. codex-acp names the file in the opening `tool_call`;
  // claude-agent-acp opens with a placeholder ("Read File", empty rawInput, no
  // locations) and fills the path in on a following `tool_call_update`.
  // `refreshToolRowFromUpdate` in media/chat.js merges those frames by id for
  // exactly this reason -- "arguments accumulate across updates (`{}` ->
  // `{file_path}` -> `{file_path, limit}`), so merge rather than replace or a
  // later, sparser update would drop the path". Reading only the opening frame
  // would pin Codex's framing as if it were the protocol and fail a provider
  // the product renders correctly.
  const merged = new Map();
  const completed = new Set();
  let patches = 0;
  for (const raw of updates) {
    if (!["tool_call", "tool_call_update"].includes(raw?.sessionUpdate)) continue;
    assert(nonempty(raw.toolCallId), "tool update lacks toolCallId");
    const value = normalize(raw).update;
    assert.equal(value?.sessionUpdate, raw.sessionUpdate, "normalization lost tool frame type");
    assert.equal(value?.toolCallId, raw.toolCallId, "normalization lost toolCallId");
    if (raw.sessionUpdate === "tool_call") {
      assert(nonempty(value.title) && nonempty(value.kind), "tool_call lacks title/kind after normalization");
      starts.set(raw.toolCallId, value);
    } else {
      patches++;
      assert(starts.has(raw.toolCallId), `tool_call_update ${raw.toolCallId} has no preceding tool_call`);
    }
    if (value.status !== undefined) {
      assert(["pending", "in_progress", "completed", "failed"].includes(value.status), `invalid tool status: ${value.status}`);
    }
    if (value.content !== undefined) assert(Array.isArray(value.content), "tool content is not an array");
    if (raw.rawOutput && typeof raw.rawOutput.formatted_output === "string") {
      assert.equal(value.rawOutput.output, raw.rawOutput.formatted_output, "formatted_output was not normalized");
    }
    for (const block of value.content ?? []) {
      assert(nonempty(block.type), "tool content block lacks type");
      if (block.type === "diff") {
        assert(nonempty(block.path) && typeof block.newText === "string", "malformed tool diff");
        assert(typeof block.oldText === "string", "diff oldText was not normalized");
      }
    }
    const accumulated = merged.get(raw.toolCallId) ?? { rawInput: {}, input: {}, locations: [] };
    for (const key of ["rawInput", "input"]) {
      if (value[key] && typeof value[key] === "object") {
        accumulated[key] = { ...accumulated[key], ...value[key] };
      }
    }
    if (Array.isArray(value.locations) && value.locations.length) accumulated.locations = value.locations;
    merged.set(raw.toolCallId, accumulated);
    if (value.status === "completed") completed.add(raw.toolCallId);
  }
  assert(starts.size > 0, "file-read prompt produced no tool_call");
  assert(patches > 0, "file-read prompt produced no tool_call_update");
  assert(completed.size > 0, "file-read prompt produced no completed tool call");
  if (expectedFile) {
    assert([...completed].some((id) => {
      const call = merged.get(id);
      // Match tool inputs/locations, never the assistant's prose or output.
      return JSON.stringify([call.rawInput, call.input, call.locations]).includes(expectedFile);
    }), `no completed tool references the requested file ${expectedFile} in its input/locations`);
  }
  return `${starts.size} tool_call, ${patches} tool_call_update, ${completed.size} completed`;
}

function inside(base, target) {
  const relative = path.relative(base, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

// Check both lexical and real paths so a client-delegated write cannot follow
// an agent-created symlink out of this run's scratch directory.
function scratchPath(base, target, writing = false) {
  assert(nonempty(target), "client filesystem request lacks path");
  const resolved = path.resolve(base, target);
  assert(inside(base, resolved), `client filesystem request outside scratch: ${resolved}`);
  const existing = writing && !fs.existsSync(resolved) ? path.dirname(resolved) : resolved;
  assert(inside(fs.realpathSync(base), fs.realpathSync(existing)), `client filesystem symlink outside scratch: ${resolved}`);
  return resolved;
}

export class Peer {
  constructor(spec, cwd, evidence, rpcMs, turnMs, TerminalManager, backend, seedBackend, parseProgress) {
    this.cwd = cwd;
    this.rpcMs = rpcMs;
    this.turnMs = turnMs;
    this.nextId = 0;
    this.pending = new Map();
    this.events = [];
    this.normalized = [];
    this.listeners = new Set();
    this.terminals = new TerminalManager();
    this.terminalIds = new Set();
    this.record = (direction, message) => {
      const event = { at: new Date().toISOString(), direction, message };
      fs.appendFileSync(evidence, `${JSON.stringify(event)}\n`);
      this.events.push(event);
      return event;
    };
    // This is the product's command/args/env/shell, including CODEX_PATH or
    // CLAUDE_CODE_EXECUTABLE and ELECTRON_RUN_AS_NODE, without extra CLI flags.
    this.proc = spawn(spec.command, spec.args, {
      cwd, env: spec.env, shell: spec.shell, windowsHide: true,
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
    });
    this.closed = new Promise((resolve) => this.proc.once("close", resolve));
    this.proc.once("error", (e) => this.fail(new Error(`adapter spawn: ${e.message}`)));
    this.proc.once("exit", (code, signal) => this.fail(new Error(`adapter exited (code=${code}, signal=${signal})`)));
    for (const [name, stream] of [["stdin", this.proc.stdin], ["stdout", this.proc.stdout], ["stderr", this.proc.stderr]]) {
      stream.on("error", (e) => this.fail(new Error(`adapter ${name}: ${e.message}`)));
    }
    this.proc.stderr.on("data", (data) => this.record("stderr", data.toString()));
    this.rl = createInterface({ input: this.proc.stdout });
    this.rl.on("error", (e) => this.fail(e));
    this.rl.on("line", (line) => {
      try {
        const message = JSON.parse(line);
        assert.equal(message.jsonrpc, "2.0", "adapter emitted non-JSON-RPC stdout");
        this.record("receive", message);
        if (["session/update", "_x.ai/session_notification", "x.ai/session_notification", "_x.ai/session/update", "x.ai/session/update"].includes(message.method)) {
          const { update: raw, sessionId, _meta } = message.params;
          const normalized = backend.normalizeUpdate(raw, _meta);
          const seed = raw?._meta?.claudeCode?.toolName === "Workflow"
            ? seedBackend.normalizeUpdate(raw, _meta).workflowUpdate : undefined;
          // Normalizers own mutable workflow buffers. Retain each instant, not
          // references that a later completed snapshot could retroactively fill.
          const frame = structuredClone({ sessionId, raw, update: normalized.update,
            workflow: parseProgress(normalized.workflowUpdate ?? normalized.update), seedWorkflow: parseProgress(seed),
            ignored: !Object.entries(normalized).some(([key, value]) => key !== "meta" && value !== undefined) });
          this.normalized.push(frame);
          this.record("normalized", frame);
        }
        if (message.method && message.id !== undefined) {
          // Handle concurrently: an outstanding permission or terminal request
          // must never stop reception of the response to another RPC.
          void bounded(this.handleRequest(message), `client handler ${message.method}`, turnMs)
            .then((result) => this.send({ jsonrpc: "2.0", id: message.id, result }))
            .catch((e) => {
              this.record("client-error", errorText(e));
              this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: errorText(e) } });
            });
        } else if (message.id !== undefined) {
          const pending = this.pending.get(message.id);
          if (pending) {
            this.pending.delete(message.id);
            if (message.error) pending.reject(new Error(`${pending.method}: ${JSON.stringify(message.error)}`));
            else if (Object.hasOwn(message, "result")) pending.resolve(message.result);
            else pending.reject(new Error(`${pending.method}: response lacks result/error`));
          }
        }
        for (const listener of this.listeners) listener(message);
      } catch (e) {
        this.record("wire-error", { line, error: errorText(e) });
        this.fail(e);
      }
    });
  }

  fail(error) {
    this.failure ??= error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  send(message) {
    if (this.failure) return;
    try {
      this.record("send", message);
      this.proc.stdin.write(`${JSON.stringify(message)}\n`, (e) => { if (e) this.fail(e); });
    } catch (e) { this.fail(e); }
  }

  request(method, params, ms = this.rpcMs) {
    if (this.failure) return Promise.reject(new Error(`not exercised: connection unavailable after ${errorText(this.failure)}`));
    const id = ++this.nextId;
    const response = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
    return bounded(response, `${method} response`, ms).catch((e) => {
      // A timed-out RPC may still be running. A failed prompt may instead be
      // an auth/network outage. Do not queue turns behind either and multiply
      // the failure. Shape assertions still run independently; resume gets a
      // fresh process, so remains independently exercisable.
      if (e.code === "ACP_SMOKE_TIMEOUT" || method === "session/prompt") this.fail(e);
      throw e;
    }).finally(() => this.pending.delete(id));
  }

  notify(method, params) { this.send({ jsonrpc: "2.0", method, params }); }

  async waitUntil(predicate, what, ms) {
    const deadline = Date.now() + ms;
    while (!predicate()) {
      if (this.failure) throw this.failure;
      if (Date.now() >= deadline) throw Object.assign(new Error(`${what} never arrived within ${ms}ms`), { code: "ACP_SMOKE_TIMEOUT" });
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  async handleRequest({ method, params }) {
    if (["_x.ai/session_notification", "x.ai/session_notification", "_x.ai/session/update", "x.ai/session/update"].includes(method)) return {};
    if (method === "session/request_permission") {
      const option = approvalOption(params);
      // Even malformed permission requests receive an immediate response.
      return option ? { outcome: { outcome: "selected", optionId: option.optionId } }
        : { outcome: { outcome: "cancelled" } };
    }
    if (method === "fs/read_text_file") {
      const content = fs.readFileSync(scratchPath(this.cwd, params.path), "utf8");
      const lines = content.split("\n");
      return { content: params.line !== undefined || params.limit !== undefined
        ? lines.slice((params.line ?? 1) - 1, params.limit === undefined ? undefined : (params.line ?? 1) - 1 + params.limit).join("\n")
        : content };
    }
    if (method === "fs/write_text_file") {
      assert.equal(typeof params.content, "string", "write content is not text");
      fs.writeFileSync(scratchPath(this.cwd, params.path, true), params.content);
      return {};
    }
    if (method === "terminal/create") {
      const cwd = scratchPath(this.cwd, params.cwd || this.cwd);
      const result = this.terminals.create({ ...params, cwd });
      this.terminalIds.add(result.terminalId);
      return result;
    }
    assert(this.terminalIds.has(params?.terminalId), `unsupported client request ${method}`);
    if (method === "terminal/output") return this.terminals.output(params.terminalId);
    if (method === "terminal/wait_for_exit") {
      try { return await bounded(this.terminals.waitForExit(params.terminalId), `${method} ${params.terminalId}`, this.turnMs); }
      catch (e) { this.terminals.kill(params.terminalId); throw e; }
    }
    if (method === "terminal/kill") { this.terminals.kill(params.terminalId); return {}; }
    if (method === "terminal/release") { this.terminals.release(params.terminalId); return {}; }
    throw new Error(`unsupported client request ${method}`);
  }

  prompt(sessionId, text) {
    const turn = { from: this.events.length, sessionId, settled: false };
    turn.promise = this.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, this.turnMs)
      .finally(() => { turn.settled = true; });
    turn.id = this.nextId;
    // Observation may fail before we await the prompt. Keep its rejection handled.
    void turn.promise.catch(() => {});
    return turn;
  }

  received(from, method, sessionId) {
    return this.events.slice(from).filter((e) => e.direction === "receive" && e.message.method === method
      && e.message.params?.sessionId === sessionId).map((e) => e.message.params);
  }

  async onLiveChunk(turn, action) {
    let listener;
    const activity = new Promise((resolve, reject) => {
      listener = (m) => {
        if (m.method !== "session/update" || m.params?.sessionId !== turn.sessionId) return;
        const update = m.params.update;
        if (update?.sessionUpdate !== "agent_message_chunk" || update.content?.type !== "text" || !nonempty(update.content.text)) return;
        this.listeners.delete(listener);
        if (turn.settled) { reject(new Error("turn ended before live action")); return; }
        // Send in this notification callback, not after a sleep or an idle RPC.
        try { resolve(action()); } catch (e) { reject(e); }
      };
      this.listeners.add(listener);
    });
    const ended = turn.promise.then(() => { throw new Error("prompt ended before a live agent_message_chunk arrived"); });
    try { return await bounded(Promise.race([activity, ended]), "live agent_message_chunk and action response", this.turnMs); }
    finally { this.listeners.delete(listener); }
  }

  async stop() {
    this.terminals.disposeAll();
    try {
      // EOF lets the adapter dispose its own CLI, flush history and release the
      // scratch cwd. It also works on hosts that prohibit process-tree kills.
      this.proc.stdin.end();
      try { await bounded(this.closed, "adapter shutdown after stdin EOF", 10_000); }
      catch {
        // Kill only this smoke's process tree, including adapter-owned tools.
        if (this.proc.pid && this.proc.exitCode === null && this.proc.signalCode === null) {
          if (process.platform === "win32") {
            try {
              execFileSync("taskkill", ["/PID", String(this.proc.pid), "/T", "/F"], { windowsHide: true, timeout: 10_000, stdio: "pipe" });
            } catch (e) {
              // The process can exit between the liveness check and taskkill.
              try { await bounded(this.closed, "adapter exit after taskkill failure", 5_000); }
              catch { throw e; }
            }
          } else {
            try { process.kill(-this.proc.pid, "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") throw e; }
          }
        }
        await bounded(this.closed, "adapter process-tree shutdown", 15_000);
      }
    } finally {
      this.fail(new Error("adapter connection closed for cleanup"));
      this.rl.close();
      // A denied kill is reported as cleanup FAIL, but must not keep the smoke
      // itself alive forever through inherited pipe/process handles.
      this.proc.stdin.destroy();
      this.proc.stdout.destroy();
      this.proc.stderr.destroy();
      this.proc.unref();
    }
  }
}

/** Locate only existing user CLIs; explicitly refuse the product's test hooks. */
function resolveCli(provider, locate) {
  for (const name of ["GROK_TEST_CODEX_ACP_ADAPTER_PATH", "GROK_TEST_CLAUDE_ACP_ADAPTER_PATH"]) {
    assert(!process.env[name], `refusing fixture override ${name}; this smoke only runs real adapters`);
  }
  // npm run prepends dependency .bin directories. In this repository that
  // silently selects codex-acp's transitive Codex, not the user's own CLI.
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
  env[pathKey] = (env[pathKey] || "").split(path.delimiter)
    .filter((entry) => !/[\\/]node_modules[\\/]\.bin[\\/]?$/i.test(entry)).join(path.delimiter);
  const cli = locate({ env, configuredPath: process.env[`${provider.toUpperCase()}_CLI_PATH`] });
  if (!cli) throw new Error([
    `No real ${provider} CLI found.`,
    "This check exists to exercise the REAL agent, so it will not fall back to",
    "the test fixture — a green run against a fake would be worse than no run.",
    `Put ${provider} on PATH, or set ${provider.toUpperCase()}_CLI_PATH to it, and make sure its credentials already exist.`,
  ].join("\n"));
  assert(!/fake-|[\\/]fixtures[\\/]/i.test(cli), `refusing fixture CLI: ${cli}`);
  return cli;
}

function probeCli(cli, args, cwd) {
  const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(cli);
  // Only a discovered executable and these fixed probe arguments reach a shell.
  const command = shell ? `"${cli}"` : cli;
  assert(!shell || !/["%\r\n]/.test(cli), "CLI shim path cannot be safely quoted for cmd.exe");
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 30_000, windowsHide: true, shell, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) {
    throw new Error(`${args.join(" ")} probe failed (${result.error?.code ?? result.status}): ${String(result.stderr || result.stdout || result.error?.message).trim()}`);
  }
  // Codex login status uses stderr. Preserve that verdict instead of printing
  // an empty status or inspecting the credential file ourselves.
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

async function main() {
  const selected = process.argv.slice(2);
  const scenario = smokeScenario(selected, ["plain reply", "subagent", "workflow"]);
  assert(selected.every(a => /^--provider=(codex|claude|muse)$/.test(a) || a.startsWith("--scenario="))
    && selected.filter(a => a.startsWith("--provider=")).length <= 1, "usage: npm run smoke:acp -- --provider=codex|claude|muse [--scenario=plain-reply|subagent|workflow]");
  const chosenProvider = selected.find(a => a.startsWith("--provider="))?.slice(11);
  const requested = capability => !scenario || ["initialize", "session/new", "model", "render", "boundary audit"].includes(capability)
    || capability === (scenario === "plain reply" ? "streaming" : scenario) || (scenario === "workflow" && capability === "delivery prompt");
  const rpcMs = timeoutMs(process.env.ACP_SMOKE_RPC_TIMEOUT_MS, 90_000);
  const turnMs = timeoutMs(process.env.ACP_SMOKE_TURN_TIMEOUT_MS, 180_000);
  const workflowMs = timeoutMs(process.env.ACP_SMOKE_WORKFLOW_TIMEOUT_MS, 300_000);
  const deliveryMs = timeoutMs(process.env.ACP_SMOKE_DELIVERY_TIMEOUT_MS, 60_000);
  // `smoke:acp` compiles src first, exactly like smoke:live. No stale bundles,
  // TS loader, copied spawn implementation, or adapter-path override.
  const { CodexBackend, normalizeCodexUpdate, normalizeCodexPermissionParams } = require("../out/codex-backend.js");
  const { ClaudeBackend } = require("../out/claude-backend.js");
  const { MuseBackend } = require("../out/muse-backend.js");
  const { locateMuseCli } = require("../out/muse-cli-locator.js");
  const { parseRunProgressUpdate } = require("../out/run-progress.js");
  const { isSubagentToolCall } = require("../media/webview-helpers.js");
  const { locateCodexCli } = require("../out/codex-cli-locator.js");
  const { locateClaudeCli } = require("../out/claude-cli-locator.js");
  const { acpClientCapabilities } = require("../out/acp.js");
  const { TerminalManager } = require("../out/terminal-manager.js");
  const outputParent = path.join(root, ".verification", "acp-smoke");
  fs.mkdirSync(outputParent, { recursive: true });
  const output = fs.mkdtempSync(path.join(outputParent, `${new Date().toISOString().replace(/[:.]/g, "-")}-`));
  const rows = [];
  const notes = [];
  const unhandled = [];
  const say = (text) => { console.log(`[acp-smoke] ${text}`); notes.push(text); };
  const report = () => {
    const lines = ["provider | capability   | result | evidence", "---------|--------------|--------|---------",
      ...rows.map((r) => `${r.provider.padEnd(8)} | ${r.capability.padEnd(12)} | ${r.result.padEnd(6)} | ${r.detail.replace(/\r?\n/g, " ")}`)];
    const headline = unhandled.length ? `UNHANDLED\n${unhandled.map(r => `${r.provider} ${r.status} ${r.boundary}: ${r.kind} (${r.count})${r.reason ? ` — ${r.reason}` : ""}`).join("\n")}\n\n` : "";
    fs.writeFileSync(path.join(output, "report.txt"), `${headline}${notes.join("\n")}\n\n${lines.join("\n")}\n`);
    const outcome = smokeOutcome(rows, interrupted || unhandled.length > 0);
    fs.writeFileSync(path.join(output, "report.json"), JSON.stringify({ ...outcome, unhandled, rpcMs, turnMs, workflowMs, deliveryMs, rows, notes }, null, 2));
    return headline + lines.join("\n");
  };
  say(`Evidence: ${output}`);
  let interrupted = false;
  let active;
  const interrupt = () => { interrupted = true; active?.fail(new Error("smoke interrupted")); };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);

  for (const [provider, Backend, locate] of [["codex", CodexBackend, locateCodexCli], ["claude", ClaudeBackend, locateClaudeCli], ["muse", MuseBackend, locateMuseCli]]) {
    if (chosenProvider && chosenProvider !== provider) continue;
    const required = [...capabilities, "model", "steering", "subagent", "workflow", "render", ...(provider === "muse" ? ["delivery prompt"] : [])];
    let scratch;
    let peer;
    let sessionId;
    let fatal;
    let cli;
    const record = (capability, result, detail) => {
      rows.push({ provider, capability, result, detail: detail.replace(/\r?\n/g, " ") });
      say(`${provider} ${capability}: ${result} — ${detail}`);
      report();
    };
    if (provider !== "codex") record("steering", "N/A", `${provider} does not support mid-turn steering`);
    if (provider === "codex") record("workflow", "N/A", "Codex has no workflow feature");
    if (provider === "muse") record("subagent", "N/A", "Muse delegation is a workflow; no plain subagent feature");
    if (permissionSmokeNotApplicable(provider)) record("permission", "N/A", permissionSmokeNotApplicable(provider));
    const check = async (capability, fn, ms = Math.min(2_147_483_647, turnMs * 2 + rpcMs)) => {
      if (!requested(capability)) { record(capability, "NOT RUN", "excluded by --scenario; not release validation"); return false; }
      say(`${provider}: checking ${capability}`);
      try {
        assert(!interrupted, "smoke interrupted");
        const detail = await bounded(Promise.resolve().then(fn), `${provider} ${capability} check`, ms);
        rows.push({ provider, capability, result: "PASS", detail });
        say(`${provider} ${capability}: PASS — ${detail}`);
        report();
        return true;
      } catch (e) {
        record(capability, ["MODEL_DID_NOT_DELEGATE", "NOT_OBSERVED"].includes(e.code) ? "INCONCLUSIVE" : "FAIL", errorText(e));
        return false;
      }
    };
    try {
      scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `grok-acp-smoke-${provider}-`)));
      assert(!inside(root, scratch), "OS temp directory must be outside the repository");
      fs.writeFileSync(path.join(scratch, "read-me.txt"), "A scratch file owned by the ACP release smoke.\n".repeat(20));
      // Claude's adapter EMBEDS the agent, so the agent reads the operator's own
      // `~/.claude/settings.json` -- and a box with a bare "Write" in
      // `permissions.allow` pre-approves every edit, so no permission request is
      // ever made and the check measures the machine instead of the adapter.
      // Project settings in this run's own cwd put the prompt back: ask rules
      // outrank allow rules, and nothing outside the scratch directory is
      // touched. Codex needs no equivalent -- its prompt asks for an escalation.
      fs.mkdirSync(path.join(scratch, ".claude"), { recursive: true });
      fs.writeFileSync(
        path.join(scratch, ".claude", "settings.json"),
        JSON.stringify({ permissions: { ask: ["Write", "Edit", "MultiEdit"] } }, null, 2),
      );
      say(`${provider} scratch: ${scratch}`);
      cli = resolveCli(provider, locate);
      const version = probeCli(cli, ["--version"], scratch);
      assert(new RegExp(provider, "i").test(version), `version probe did not identify ${provider}: ${version}`);
      say(`${provider} CLI: ${cli} (${version})`);
      if (provider === "codex") {
        const status = probeCli(cli, ["login", "status"], scratch);
        // Codex prints login status to stderr on some releases; exit zero is
        // the CLI's authenticated verdict. Never require OPENAI_API_KEY.
        say(`codex auth: login status exited 0${status ? `; ${status}` : " (existing CLI credentials)"}`);
      } else if (provider === "claude") {
        const status = JSON.parse(probeCli(cli, ["auth", "status", "--json"], scratch));
        assert.equal(status.loggedIn, true, "Claude credentials missing: auth status reports loggedIn=false");
        say(`claude auth: loggedIn=true; method=${status.authMethod}`);
      } else say("muse auth: real prompt checks will validate existing credentials (the SDK catalog alone does not prove login)");
      const backend = new Backend();
      const spec = backend.spawn({ cliPath: cli, cwd: scratch, env: { ...process.env } });
      const packageName = provider === "muse" ? "@muse-code/sdk" : `@agentclientprotocol/${provider === "codex" ? "codex-acp" : "claude-agent-acp"}`;
      const manifest = JSON.parse(fs.readFileSync(require.resolve(`${packageName}/package.json`), "utf8"));
      assert.equal(manifest.version, require("../package.json").dependencies[packageName], "installed adapter differs from the pinned bump; install dependencies before interpreting this smoke");
      const adapterPath = provider === "muse" ? path.join(root, "out", "muse-adapter", "main.mjs")
        : path.resolve(path.dirname(require.resolve(`${packageName}/package.json`)), typeof manifest.bin === "string" ? manifest.bin : Object.values(manifest.bin)[0]);
      assert.equal(fs.realpathSync(spec.args[0]), fs.realpathSync(adapterPath), "spawn spec did not select the installed real adapter");
      if (provider === "muse") {
        assert.equal(spec.env.MUSE_CODE_EXECUTABLE, cli);
        assert.equal(spec.env.ELECTRON_RUN_AS_NODE, "1");
        say(`muse credential backend: ${spec.env.TBH_CREDENTIAL_BACKEND || "OS default"}`);
      }
      say(`${provider} adapter: ${manifest.version}; spawn=${JSON.stringify({ command: spec.command, args: spec.args, shell: spec.shell, cli, ELECTRON_RUN_AS_NODE: spec.env.ELECTRON_RUN_AS_NODE })}`);
      let connection = 0;
      const connect = () => {
        peer = new Peer(spec, scratch, path.join(output, `${provider}-${++connection}.jsonl`), rpcMs, turnMs, TerminalManager,
          new Backend(), new Backend(), parseRunProgressUpdate);
        active = peer;
      };
      const initialize = async () => {
        const result = await peer.request("initialize", { protocolVersion: 1, clientCapabilities: acpClientCapabilities(provider) });
        assert.equal(result.protocolVersion, 1, "initialize.protocolVersion must be 1");
        if (provider === "codex") assert.equal(result._meta?.steering?.supported, true, "initialize._meta.steering.supported must be true");
        return result;
      };
      connect();
      await check("initialize", async () => { await initialize(); return `protocolVersion=1${provider === "codex" ? "; _meta.steering.supported=true" : ""}`; });
      let sessionResponse;
      const created = await check("session/new", async () => {
        const response = await peer.request("session/new", { cwd: scratch, mcpServers: [] });
        assert(nonempty(response.sessionId), "session/new returned no sessionId");
        sessionId = response.sessionId;
        sessionResponse = backend.normalizeSessionResponse(response);
        return `sessionId=${sessionId}`;
      });
      if (!created) throw new Error("session/new failed; no session available for remaining checks");
      const selectedModel = await check("model", async () => {
        const selection = selectSmokeModel(sessionResponse, process.env[`ACP_SMOKE_${provider.toUpperCase()}_MODEL`]);
        const call = backend.setModel(sessionId, selection.modelId);
        const response = await peer.request(call.method, call.params);
        assert(backend.modelSetSucceeded(response), "model selection rejected");
        const choice = selectSmokeEffort(response, sessionResponse.models.availableModels.find(m => m.modelId === selection.modelId));
        selection.effort = choice.effort;
        if (selection.effort) {
          const effort = choice.configId ? { method: "session/set_config_option", params: { sessionId, configId: choice.configId, value: choice.effort } }
            : backend.setReasoningEffort(sessionId, selection.modelId, selection.effort);
          assert(effort, "advertised reasoning effort has no backend setter");
          await peer.request(effort.method, effort.params);
        }
        return `model=${selection.modelId}; effort=${selection.effort ?? "N/A (not advertised)"}; ${selection.basis}`;
      });
      if (!selectedModel) throw new Error("model selection failed; refusing paid prompts with an unknown/default model");
      let completedPrompt = false;
      const updates = (turn) => {
        const events = peer.events.slice(turn.from);
        const response = events.findIndex((e) => e.direction === "receive" && e.message.id === turn.id && !e.message.method);
        return (response < 0 ? events : events.slice(0, response))
          .filter((e) => e.direction === "receive" && e.message.method === "session/update" && e.message.params?.sessionId === sessionId)
          .map((e) => e.message.params.update);
      };
      const finish = async (turn) => {
        const result = await turn.promise;
        assert.equal(result?.stopReason, "end_turn", `prompt did not finish normally: ${JSON.stringify(result)}`);
        completedPrompt = true;
        return result;
      };
      await check("streaming", async () => {
        const turn = peer.prompt(sessionId, "Do not use tools. Explain how a library lends books in about 500 words, with several paragraphs.");
        await finish(turn);
        const chunks = updates(turn).filter((u) => u?.sessionUpdate === "agent_message_chunk");
        for (const chunk of chunks) assert(chunk.content?.type === "text" && typeof chunk.content.text === "string", "malformed agent_message_chunk");
        const incremental = chunks.filter((chunk) => nonempty(chunk.content.text));
        assert(incremental.length >= 2, `expected incremental agent_message_chunk notifications; received ${incremental.length} nonempty chunks`);
        return `${incremental.length} nonempty text chunks before prompt response`;
      });
      await check("tool call", async () => {
        const turn = peer.prompt(sessionId, `Use a file-reading tool to read ${path.join(scratch, "read-me.txt")} from disk, then briefly describe it. You must actually call a tool; the file contents are not in this conversation.`);
        await finish(turn);
        // Exercise the named Codex normalizer for BOTH providers, as well as
        // each backend's own path. This catches framing that the host consumes.
        const detail = checkTools(updates(turn), normalizeCodexUpdate, "read-me.txt");
        checkTools(updates(turn), (u) => backend.normalizeUpdate(u));
        return detail;
      });
      if (!permissionSmokeNotApplicable(provider)) await check("permission", async () => {
        const mode = backend.setMode(sessionId, provider === "codex" ? "read-only" : "default");
        await peer.request(mode.method, mode.params);
        const turn = peer.prompt(sessionId, `Create ${path.join(scratch, "permission-write.txt")} with one short line using a write tool. This is a permission-dialog smoke: ${provider === "codex" ? "use the shell tool with sandbox_permissions=require_escalated and a justification asking approval for this scratch-file write; explicitly request approval even though this is a temporary file" : provider === "claude" ? "use the Write tool so the client can approve it" : "use your write/edit tool and request approval for this scratch-file write"}. Do not touch any other directory. The client will approve automatically.`);
        await finish(turn);
        const requests = peer.received(turn.from, "session/request_permission", sessionId);
        assert(requests.length > 0, "write prompt produced no session/request_permission (permission capability remains unproven)");
        for (const params of requests) {
          const selectedId = approvalOption(params)?.optionId;
          assert(selectedId, "permission request had no approvable option");
          checkPermission(params, normalizeCodexPermissionParams(params), sessionId, selectedId);
          checkPermission(params, backend.normalizePermissionParams(params), sessionId, selectedId);
        }
        assert(fs.existsSync(path.join(scratch, "permission-write.txt")), "approved write did not create its scratch file");
        return `${requests.length} request(s), auto-approved; IDs/options/metadata survive normalization; file exists`;
      });
      // The action starts at the first text chunk of a deliberately long turn.
      // No assertion uses model wording, and a resolved/idle prompt cannot pass.
      const longText = "Do not use tools. Immediately begin a detailed 3000-word explanation of library cataloguing, with many paragraphs. Continue until all sections are complete.";
      if (provider === "codex") {
        await check("steering", async () => {
          const turn = peer.prompt(sessionId, longText);
          try {
            const result = await peer.onLiveChunk(turn, () => {
              const call = backend.interject(sessionId, "Add a short discussion of accessibility in the next section and continue.");
              return peer.request(call.method, call.params);
            });
            assert.equal(result?.outcome, "injected", `live steering must inject, received ${JSON.stringify(result)}`);
            return 'live agent_message_chunk observed; outcome="injected"';
          } finally {
            peer.notify("session/cancel", { sessionId });
            await bounded(turn.promise, "steered turn termination after cleanup cancel", 30_000);
          }
        });
      }
      await check("cancellation", async () => {
        const turn = peer.prompt(sessionId, longText);
        await peer.onLiveChunk(turn, () => peer.notify("session/cancel", { sessionId }));
        const result = await bounded(turn.promise, "cancelled session/prompt response", 30_000);
        assert.equal(result?.stopReason, "cancelled", `cancel returned ${JSON.stringify(result)}`);
        const recovery = peer.prompt(sessionId, "Do not use tools. Give one brief fact about libraries.");
        await finish(recovery);
        assert(updates(recovery).some((u) => u?.sessionUpdate === "agent_message_chunk" && nonempty(u.content?.text)), "post-cancel prompt returned without an agent message");
        return "live turn cancelled; same session completed a subsequent prompt";
      });
      if (provider !== "muse") await check("subagent", async () => {
        if (provider === "codex") {
          const mode = backend.setMode(sessionId, "agent");
          await peer.request(mode.method, mode.params);
        }
        const from = peer.normalized.length;
        await finish(peer.prompt(sessionId, SUBAGENT_PROMPT));
        const frames = () => peer.normalized.slice(from);
        // Declining the prompt is not a broken normalizer. A real launch whose
        // card/output never arrives IS a plumbing failure, even after end_turn.
        if (!delegationAttempted(frames(), "subagent")
            && !frames().some(f => isSubagentToolCall(f.update))) {
          return checkSubagents(frames(), sessionId, isSubagentToolCall);
        }
        await peer.waitUntil(() => {
          try { checkSubagents(frames(), sessionId, isSubagentToolCall); return true; }
          catch { return false; }
        }, "normalized subagent completion and result", workflowMs);
        return checkSubagents(frames(), sessionId, isSubagentToolCall);
      }, Math.min(2_147_483_647, turnMs + workflowMs + rpcMs));

      if (provider !== "codex") {
        const from = peer.normalized.length;
        const frames = () => peer.normalized.slice(from).filter(f => f.sessionId === sessionId);
        let launch;
        let launchFinished = false;
        let delivery;
        let workflowPassed = false;
        const observeDelivery = message => {
          if (launch && message.id === launch.id && !message.method) launchFinished = message.result?.stopReason === "end_turn";
          const done = frames().some(f => f.workflow?.done && !f.workflow.failed && !f.workflow.cancelled);
          if (provider === "muse" && !delivery && isMuseDeliveryChunk(message, sessionId, launchFinished, done)) {
            peer.record("delivery-observation", { sessionId, evidence: "unsolicited live answer chunk after launch response and workflow completion" });
            // In the notification callback: no sleep between evidence of Muse's
            // own delivery and sending the prompt that used to be refused.
            delivery = peer.prompt(sessionId, "Do not use tools. Reply with the single word ok.");
          }
        };
        peer.listeners.add(observeDelivery);
        try {
          workflowPassed = await check("workflow", async () => {
            launch = peer.prompt(sessionId, WORKFLOW_PROMPT);
            await finish(launch);
            if (!delegationAttempted(frames(), "workflow") && !frames().some(f => f.workflow)) {
              return checkWorkflow(frames(), provider);
            }
            await peer.waitUntil(() => frames().some(f => f.workflow?.done), "parsed workflow terminal update", workflowMs);
            return checkWorkflow(frames(), provider);
          }, Math.min(2_147_483_647, turnMs + workflowMs + rpcMs));
          if (provider === "muse") await check("delivery prompt", async () => {
            if (!delivery && !workflowPassed) throw inconclusive("NOT_OBSERVED", "not observed: workflow did not complete successfully");
            try { await peer.waitUntil(() => !!delivery, "Muse unprompted delivery chunk", deliveryMs); }
            catch (error) {
              if (error.code !== "ACP_SMOKE_TIMEOUT") throw error;
              throw inconclusive("NOT_OBSERVED", `not observed: no unprompted delivery chunk within ${deliveryMs}ms`);
            }
            await finish(delivery);
            assert(updates(delivery).some(u => u?.sessionUpdate === "agent_message_chunk" && nonempty(u.content?.text)),
              "delivery-time prompt completed without an answer");
            return "sent on an unsolicited live delivery chunk; session/prompt admitted and completed with end_turn";
          }, Math.min(2_147_483_647, deliveryMs + turnMs + rpcMs));
        } finally { peer.listeners.delete(observeDelivery); }
      }
      await check("resume", async () => {
        assert(completedPrompt, "not exercised: no completed prompt exists to verify conversation replay");
        await peer.stop();
        connect();
        await initialize();
        const from = peer.events.length;
        await peer.request("session/load", { sessionId, cwd: scratch, mcpServers: [] });
        const replay = peer.received(from, "session/update", sessionId).map((p) => p.update);
        const users = replay.filter((u) => u?.sessionUpdate === "user_message_chunk" && u.content?.type === "text" && nonempty(u.content.text));
        const agents = replay.filter((u) => u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text" && nonempty(u.content.text));
        assert(users.length > 0 && agents.length > 0, `session/load returned without conversation replay (user=${users.length}, agent=${agents.length})`);
        // A reopened Muse 1.4.0 conversation cannot launch workflows. Exercise
        // ordinary prompt admission here; workflow coverage uses the fresh one.
        const recovery = peer.prompt(sessionId, "Do not use tools. Reply with the single word ok.");
        await finish(recovery);
        assert(updates(recovery).some(u => u?.sessionUpdate === "agent_message_chunk" && nonempty(u.content?.text)), "reopened session returned no answer");
        return `fresh adapter replayed ${users.length} user and ${agents.length} agent chunks for ${sessionId}`;
      });
      await peer.stop();
      peer = undefined;
      active = undefined;
    } catch (e) {
      fatal = errorText(e);
      say(`${provider}: ${fatal}`);
    } finally {
      if (peer) {
        try { await peer.stop(); }
        catch (e) { rows.push({ provider, capability: "cleanup", result: "FAIL", detail: errorText(e) }); }
      }
      active = undefined;
      // An independent desktop lane still produces evidence if a protocol
      // capability failed. It never converts that earlier failure into a pass.
      await check("render", async () => {
        const { runRenderSmoke } = await import("./smoke-render.mjs");
        const rendered = await runRenderSmoke(provider, output, cli, scenario);
        if (rendered.scenarios.some(s => s.result === "INCONCLUSIVE")) throw inconclusive("NOT_OBSERVED", "render report has unproven scenarios; read render-report.md");
        return "real desktop host and chat.js rendered live scenarios; inspect render-report.md/json";
      }, Math.min(2_147_483_647, 6 * (rpcMs + turnMs + workflowMs + deliveryMs)));
      try {
        const { knownBoundaries, classifyBoundaries, renderReportMarkdown } = await import("./smoke-render-report.mjs");
        const events = fs.readdirSync(output).filter(name => new RegExp(`^${provider}-[0-9]+\\.jsonl$`).test(name))
          .flatMap(name => fs.readFileSync(path.join(output, name), "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)));
        const known = knownBoundaries(root, provider);
        const boundaries = classifyBoundaries(events, known);
        // Include the real desktop boundary net in the top-level headline too.
        const desktopReport = path.join(output, `${provider}-render`, "render-report.json");
        const desktop = fs.existsSync(desktopReport) ? JSON.parse(fs.readFileSync(desktopReport, "utf8")) : undefined;
        if (desktop?.cleanup) record("desktop cleanup", desktop.cleanup.result, desktop.cleanup.reason);
        unhandled.push(...[...boundaries.unhandled, ...(desktop?.boundaries?.unhandled ?? [])].map(row => ({ provider, ...row })));
        const audit = { provider, route: "direct ACP smoke boundary inventory (all checks, including resume)", scenarios: [], known, boundaries };
        fs.writeFileSync(path.join(output, `${provider}-boundaries.json`), JSON.stringify(audit, null, 2));
        fs.writeFileSync(path.join(output, `${provider}-boundaries.md`), renderReportMarkdown(audit));
        record("boundary audit", boundaries.unhandled.length ? "FAIL" : "PASS", `${boundaries.unhandled.length} unknown kinds or findings; ${boundaries.ignored.length} known ignored kinds; see ${provider}-boundaries.json`);
      } catch (error) { record("boundary audit", "FAIL", errorText(error)); }
      if (scratch) {
        try {
          assert(inside(fs.realpathSync(os.tmpdir()), scratch) && !inside(root, scratch), "refusing cleanup outside OS-temp scratch");
          assert(path.basename(scratch).startsWith(`grok-acp-smoke-${provider}-`), "unexpected scratch cleanup target");
          fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
          say(`${provider}: scratch removed`);
        } catch (e) { rows.push({ provider, capability: "cleanup", result: "FAIL", detail: errorText(e) }); }
      }
      for (const capability of required) {
        if (!rows.some((r) => r.provider === provider && r.capability === capability)) {
          rows.push({ provider, capability, result: "FAIL", detail: `not exercised: ${fatal || "run interrupted"}`.replace(/\r?\n/g, " ") });
        }
      }
      report();
    }
  }
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  console.log(`\n${report()}\n\nEvidence: ${output}`);
  for (const provider of [...new Set(rows.map((r) => r.provider))]) {
    const results = rows.filter(r => r.provider === provider);
    console.log(`${provider}: ${results.some(r => r.result === "FAIL") ? "FAIL — bump not validated; read the evidence"
      : results.some(r => r.result === "INCONCLUSIVE") ? "INCONCLUSIVE — unproven checks; read the evidence"
        : results.some(r => r.result === "NOT RUN") ? "PARTIAL — selected scenario only; not release validation" : "PASS — read the evidence before shipping"}`);
  }
  process.exitCode = smokeOutcome(rows, interrupted || unhandled.length > 0).exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Cleanup is bounded and any failure is in the saved report. A host that
  // denies process termination must not leave this instrument hanging on a
  // surviving terminal handle after it has already printed its verdict.
  main().then(() => process.exit(process.exitCode ?? 0)).catch((error) => {
    console.error(`[acp-smoke] ${errorText(error)}`);
    process.exit(1);
  });
}
