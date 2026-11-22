import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAgySkills, rewriteAgyPrompt } from "./agy-skills";
import type { AgyUsageMeter } from "./agy-usage";
import type { PromptContentBlock, SlashCommand } from "./acp";
import { isCliFile } from "./cli-path";
import type {
  AcpBackend,
  BackendConfigState,
  BackendSessionListEntry,
  BackendSessionListResult,
  BackendSpawnOptions,
  BackendSpawnSpec,
  BackendUpdate,
} from "./acp-backend";

/** The persisted values identify a history folder. Both profiles run agy. */
export type AgyProfile = "cli" | "server";

export function agyProfile(sessionId: string | undefined, saved: AgyProfile | undefined, key: boolean, env = process.env): AgyProfile {
  return saved ?? (sessionId ? agyHistoryProfile(sessionId, env) : key ? "server" : "cli");
}

/** Where Google's installer puts agy, and where AFK's own install writes it. */
export function agyInstallDir(env = process.env, platform = process.platform, home = os.homedir()): string {
  const paths = platform === "win32" ? path.win32 : path.posix;
  return platform === "win32" ? paths.join(env.LOCALAPPDATA || paths.join(home, "AppData", "Local"), "agy", "bin")
    : paths.join(home, ".local", "bin");
}

export function locateAgyCli(env = process.env, platform = process.platform, home = os.homedir(), check = isCliFile): string | undefined {
  const win = platform === "win32";
  const paths = win ? path.win32 : path.posix;
  const executable = win ? "agy.exe" : "agy";
  const installer = agyInstallDir(env, platform, home);
  const pathKey = win ? Object.keys(env).find(key => key.toLowerCase() === "path") : "PATH";
  const dirs = (env[pathKey ?? "PATH"] ?? "").split(paths.delimiter).map(dir => dir.trim().replace(/^"(.*)"$/, "$1"));
  return [installer, ...dirs].filter(dir => paths.isAbsolute(dir)).map(dir => paths.join(dir, executable))
    .find(candidate => check(candidate, platform));
}

export function agyHistoryProfile(sessionId: string, env = process.env): AgyProfile {
  if (path.basename(sessionId) !== sessionId || /[\\/]/.test(sessionId)) return "server";
  const home = agyGeminiHome(env);
  if (fs.existsSync(path.join(home, "antigravity-acp", "conversations", `${sessionId}.db`))) return "server";
  return fs.existsSync(path.join(home, "antigravity-cli", "conversations", `${sessionId}.db`)) ? "cli" : "server";
}

/** `GEMINI_HOME`, else `~/.gemini` -- the same resolution the server uses. */
export function agyGeminiHome(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const explicit = env.GEMINI_HOME?.trim();
  if (!explicit) return path.join(home, ".gemini");
  return explicit === "~" || explicit.startsWith("~/") || explicit.startsWith("~\\")
    ? path.join(home, explicit.slice(1))
    : explicit;
}

export function agyProfileDir(profile: AgyProfile, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return path.join(agyGeminiHome(env, home), profile === "server" ? "antigravity-acp" : "antigravity-cli");
}

export function agyWorkingFolderPrompt(cwd: string): string {
  return `The project folder for this session is ${cwd}. It is your working directory: run every command with its working directory set to this folder, and create or edit files inside it unless the user names another location. The other workspace folders listed in your context hold skills only.`;
}

export function agySessionParams(cwd: string): Record<string, unknown> {
  return { _meta: { antigravity: { systemPrompt: { append: agyWorkingFolderPrompt(cwd) } } } };
}

export function agyThinkingLevel(level: string): "low" | "medium" | "high" | undefined {
  if (level === "none" || level === "minimal" || level === "low") return "low";
  if (level === "medium") return "medium";
  if (level === "high" || level === "xhigh") return "high";
  return undefined;
}

function optionValue(option: any): unknown {
  return option?.currentValue ?? option?.value;
}

function optionValues(option: any): any[] {
  return Array.isArray(option?.options) ? option.options.flatMap((entry: any) => Array.isArray(entry?.options) ? entry.options : [entry]) : [];
}

function selectValues(option: any): string[] {
  return optionValues(option).map((entry) => entry?.value).filter((value): value is string => typeof value === "string");
}

function configOption(configOptions: unknown, id: string): any {
  return Array.isArray(configOptions) ? configOptions.find((option) => option?.id === id) : undefined;
}

/** The window the context meter shows before the CLI's first `usage_update`
 *  says it: every one measured carried `size: 1048576`, and the catalog names
 *  none, so the meter kept the last conversation's window (200K, or a Grok
 *  conversation's 256K). The first `usage_update` replaces it. */
export const AGY_DEFAULT_CONTEXT_WINDOW = 1_048_576;

const EFFORT_ID = "thought_level";
const LEVEL_ORDER = ["minimal", "low", "medium", "high", "xhigh", "extra_high", "max"];
const LEGACY_VARIANTS: Readonly<Record<string, [string, string]>> = {
  "gemini-3.5-flash-extra-low": ["gemini-3.5-flash", "low"],
  "gemini-3.5-flash-low": ["gemini-3.5-flash", "medium"],
  "gemini-3-flash-agent": ["gemini-3.5-flash", "high"],
  "gemini-pro-agent": ["gemini-3.1-pro", "high"],
};

/**
 * One row per model family, effort as its level. The CLI lists every
 * variant as a model (`gemini-3.8-flash-high`, `-medium`, `-low`, ...) but its
 * `configOptions` describe a family with a `thought_level` -- the shape the
 * host's picker already has for every other provider. A family's levels come
 * from the variants listed for it, because `thought_level` only lists the
 * CURRENT family's (Gemini 3.1 Pro has high and low, the Flash models three);
 * a family with no listed variants falls back to the current option's levels.
 */
export function modelsFromAgyConfigOptions(
  configOptions: unknown,
  variantIds: readonly string[] = [],
): { currentModelId?: string; availableModels: any[] } {
  const model = configOption(configOptions, "model");
  const thinking = configOption(configOptions, EFFORT_ID);
  const currentModelId = typeof optionValue(model) === "string" ? optionValue(model) as string : undefined;
  const currentLevel = typeof optionValue(thinking) === "string" ? optionValue(thinking) as string : undefined;
  const currentLevels = selectValues(thinking);
  const levelsOf = (family: string): string[] => {
    if (family === currentModelId && thinking) return currentLevels;
    const listed = variantIds.flatMap((id) => {
      const legacy = LEGACY_VARIANTS[id];
      if (legacy) return legacy[0] === family ? [legacy[1]] : [];
      const suffix = id.slice(family.length + 1);
      return id.startsWith(`${family}-`) && LEVEL_ORDER.includes(suffix) ? [suffix] : [];
    });
    return [...new Set(listed)].sort((a, b) => LEVEL_ORDER.indexOf(a) - LEVEL_ORDER.indexOf(b));
  };
  return {
    currentModelId,
    availableModels: optionValues(model).flatMap((entry) => {
      const modelId = typeof entry?.value === "string" ? entry.value : "";
      if (!modelId) return [];
      const levels = levelsOf(modelId);
      return [{
        modelId,
        name: typeof entry?.name === "string" && entry.name.trim() ? entry.name : modelId,
        _meta: {
          totalContextTokens: AGY_DEFAULT_CONTEXT_WINDOW,
          supportsReasoningEffort: levels.length > 0,
          reasoningEfforts: levels.map((value) => ({ value })),
          ...(modelId === currentModelId && currentLevel ? { reasoningEffort: currentLevel } : {}),
        },
      }];
    }),
  };
}

export function normalizeAgySessionResponse(response: any): any {
  if (!response || typeof response !== "object") return response;
  const variantIds = Array.isArray(response.models?.availableModels)
    ? response.models.availableModels.map((entry: any) => entry?.modelId).filter((id: unknown): id is string => typeof id === "string")
    : [];
  const models = modelsFromAgyConfigOptions(response.configOptions, variantIds);
  return models.availableModels.length ? { ...response, models } : response;
}

export function configStateFromAgyOptions(response: any, fallback: BackendConfigState): BackendConfigState {
  const model = optionValue(configOption(response?.configOptions, "model"));
  const level = optionValue(configOption(response?.configOptions, EFFORT_ID));
  return {
    modelId: typeof model === "string" ? model : fallback.modelId,
    reasoningEffort: typeof level === "string" ? level : fallback.reasoningEffort,
    modeId: fallback.modeId,
  };
}

const AGY_CLI_MODE_IDS = { agent: "default", acceptEdits: "accept-edits", auto: "auto", plan: "plan", yolo: "default" } as const;

/**
 * Google refusing the credential DURING a turn. The agent can return a successful
 * prompt result while sending the API's message as agent text (`format_execution_
 * error`) and ending the turn, so the session would otherwise sit there looking
 * fine. These are the Gemini API's own wordings for a bad, expired or missing
 * key and a refused token. Unverified against a live bad key.
 *
 * Anchored to the start of the chunk: that error is one chunk that is the
 * whole message (the API's own sentence, or `Agent execution error: ...` when
 * it does not parse), while an agent explaining an "API key not valid" error in
 * someone's code says it mid-reply, and must not reopen the sign-in.
 */
const REJECTED_CREDENTIAL = /^\s*(?:API key not valid\b|API key expired\b|Request had invalid authentication credentials\b|Method doesn't allow unregistered callers\b|Agent execution error:.*\b(?:API_KEY_INVALID|API_KEY_EXPIRED|UNAUTHENTICATED)\b)/s;

export function isAgyRejectedCredentialText(text: unknown): boolean {
  return typeof text === "string" && REJECTED_CREDENTIAL.test(text);
}

/** `-32000` is Antigravity's auth-required code and nothing else uses it. */
export function isAgyCredentialError(error: unknown): boolean {
  const value = error as any;
  if (value?.code === -32000) return true;
  const message = String(value?.message ?? value?.data?.message ?? value ?? "");
  return /authentication required|auth[_ ]required|onboarding failed|logged out\. sign in again|invalid (?:gemini )?api key|api key (?:not valid|required)|GEMINI_API_KEY.*(?:not set|missing|required)/i.test(message);
}

function updatePaths(update: any): string[] {
  const out: string[] = [];
  for (const location of Array.isArray(update?.locations) ? update.locations : []) {
    if (typeof location?.path === "string") out.push(location.path);
  }
  for (const block of Array.isArray(update?.content) ? update.content : []) {
    if (block?.type === "diff" && typeof block.path === "string") out.push(block.path);
  }
  return [...new Set(out.map((value) => value.replace(/\\/g, "/").toLowerCase()))];
}

function outputText(update: any): string {
  const raw = update?.rawOutput;
  return typeof raw === "string" ? raw : typeof raw?.output === "string" ? raw.output : "";
}

/**
 * The server reports an approved edit twice: once as the call the user
 * approved ("Run create_file?", with the diff), then again under a new id
 * (`<sessionId>:<n>`, "Running edit_file") that is the one which actually
 * runs. At the end of the turn it sweeps the first as `failed` -- "Tool call
 * was approved but never executed." -- so, left alone, every approved edit
 * leaves a red card beside a green one. The executing call is folded into the
 * approved card instead: its progress moves the approved card, and the sweep
 * is dropped for a card whose execution was seen.
 */
export class AgyToolCallMerger {
  private pendingEdits: { id: string; paths: string[] }[] = [];
  private readonly aliases = new Map<string, string>();
  private readonly absorbed = new Set<string>();

  accept(update: any): any | undefined {
    const id = update?.toolCallId;
    if (typeof id !== "string") return update;
    if (update.sessionUpdate === "tool_call") {
      if (update.kind === "edit" && update.status === "pending") {
        this.pendingEdits.push({ id, paths: updatePaths(update) });
        return update;
      }
      if (update.kind === "edit" && !this.aliases.has(id) && !this.pendingEdits.some((edit) => edit.id === id)) {
        const approved = this.claim(updatePaths(update));
        if (approved) {
          this.aliases.set(id, approved);
          this.absorbed.add(approved);
          // Progress only: the approved card keeps its title, diff and paths.
          return { sessionUpdate: "tool_call_update", toolCallId: approved, status: update.status ?? "in_progress" };
        }
      }
      return update;
    }
    if (update.sessionUpdate !== "tool_call_update") return update;
    const approved = this.aliases.get(id);
    if (approved) return { ...update, toolCallId: approved };
    if (this.absorbed.has(id) && update.status === "failed" && /approved but never executed/i.test(outputText(update))) {
      return undefined;
    }
    if (update.status === "completed" || update.status === "failed" || update.status === "cancelled") {
      this.pendingEdits = this.pendingEdits.filter((edit) => edit.id !== id);
    }
    return update;
  }

  /** The approved edit an executing one belongs to: the same file, or -- when
   *  either side names none -- the only edit awaiting execution. */
  private claim(paths: readonly string[]): string | undefined {
    let index = this.pendingEdits.findIndex((edit) => edit.paths.some((value) => paths.includes(value)));
    if (index < 0 && this.pendingEdits.length === 1 && (!paths.length || !this.pendingEdits[0].paths.length)) index = 0;
    if (index < 0) return undefined;
    const [edit] = this.pendingEdits.splice(index, 1);
    return edit.id;
  }
}

/**
 * Antigravity names its tool only in a call's title -- "Run edit_file?" while
 * it awaits approval, "Running edit_file" as it runs and in replayed history --
 * and a command is titled with the command line itself.
 */
export function agyToolNameFromTitle(title: unknown): string | undefined {
  if (typeof title !== "string") return undefined;
  const match = /^(?:Run ([a-z][a-z0-9_]*)\?|Running ([a-z][a-z0-9_]*))$/.exec(title.trim());
  return match ? match[1] ?? match[2] : undefined;
}

/** The renderer's own names for what an Antigravity tool does. */
const RENDERER_TOOL: Record<string, string> = {
  run_command: "run_command", shell: "run_command",
  view_file: "view_file", read_file: "view_file", client_view_file: "view_file",
  edit_file: "edit_file", replace_file_content: "edit_file", multi_replace_file_content: "edit_file", client_edit_file: "edit_file",
  create_file: "write_file", write_to_file: "write_file", write_file: "write_file", client_create_file: "write_file",
  list_dir: "list_dir", list_directory: "list_dir",
  grep_search: "grep",
  find_by_name: "search_files", find_file: "search_files",
  read_url_content: "web_fetch",
  search_web: "search_web",
};

function firstText(raw: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function firstNumber(raw: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** A replayed call's arguments arrive as the JSON text the model wrote. */
function agyRawInput(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
    } catch { return undefined; }
  }
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
}

/**
 * Antigravity's arguments in the field names the renderer reads, which every
 * other provider already sends: `command`/`cwd` for a command, `file_path` for
 * a file, `target_directory`, `pattern` and `path`, `url`, `query`. Its own
 * names (`CommandLine`/`command_line`, `AbsolutePath`/`absolute_path`,
 * `TargetFile`, ...) stay beside them.
 */
export function agyRendererInput(tool: string | undefined, raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  const add = (key: string, value: unknown) => { if (value !== undefined && out[key] === undefined) out[key] = value; };
  switch (tool ? RENDERER_TOOL[tool] : undefined) {
    case "run_command":
      add("command", firstText(raw, "CommandLine", "command_line", "commandLine"));
      add("cwd", firstText(raw, "Cwd", "working_dir", "workingDir"));
      break;
    case "view_file":
      add("file_path", firstText(raw, "AbsolutePath", "absolute_path", "FilePath"));
      add("start_line", firstNumber(raw, "StartLine"));
      add("end_line", firstNumber(raw, "EndLine"));
      break;
    case "edit_file":
    case "write_file":
      add("file_path", firstText(raw, "TargetFile", "target_file", "FilePath", "AbsolutePath"));
      break;
    case "list_dir":
      add("target_directory", firstText(raw, "DirectoryPath", "directory_path", "SearchDirectory"));
      break;
    case "grep":
      add("pattern", firstText(raw, "Query", "query", "Pattern"));
      add("path", firstText(raw, "SearchPath", "SearchDirectory", "search_path"));
      break;
    case "search_files":
      add("pattern", firstText(raw, "Pattern", "pattern", "Query"));
      add("path", firstText(raw, "SearchDirectory", "SearchPath", "search_directory"));
      break;
    case "web_fetch":
      add("url", firstText(raw, "Url"));
      break;
    case "search_web":
      add("query", firstText(raw, "Query"));
      break;
  }
  return out;
}

/** A finished command's output where the renderer reads it (`output`). */
function agyCommandOutput(rawOutput: unknown): unknown {
  if (!rawOutput || typeof rawOutput !== "object" || Array.isArray(rawOutput)) return rawOutput;
  const raw = rawOutput as Record<string, unknown>;
  const output = firstText(raw, "combinedOutput", "formatted_output", "combined_output") ?? (typeof raw.output === "string" ? raw.output : undefined);
  const exitCode = firstNumber(raw, "exit_code", "exitCode");
  return { ...raw, ...(output !== undefined ? { output } : {}), ...(exitCode !== undefined ? { exit_code: exitCode } : {}) };
}

/**
 * `invoke_subagent` as the subagent card every other provider gets. Its
 * arguments name each child (`Subagents: [{Role, Prompt, TypeName, Model}]`);
 * the card's title is the role and its task the prompt.
 */
function agySubagentInput(raw: Record<string, unknown>): { description?: string; prompt?: string; subagent_type?: string } | undefined {
  const entries = Array.isArray(raw.Subagents) ? raw.Subagents.filter((entry) => entry && typeof entry === "object") as Record<string, unknown>[] : [];
  if (!entries.length) return undefined;
  const roles = entries.map((entry) => firstText(entry, "Role")).filter((role): role is string => !!role);
  const prompts = entries.map((entry) => firstText(entry, "Prompt")).filter((prompt): prompt is string => !!prompt);
  return {
    ...(roles.length ? { description: roles.length > 1 ? `${roles[0]} and ${roles.length - 1} more` : roles[0] } : {}),
    ...(prompts.length ? { prompt: prompts.join("\n\n") } : {}),
    ...(firstText(entries[0], "TypeName") ? { subagent_type: firstText(entries[0], "TypeName") } : {}),
  };
}

/** The stream id a subagent card collects its child's calls under. */
export function agySubagentSessionId(launchId: string): string {
  return `agy-subagent:${launchId}`;
}

/**
 * What each call is, remembered across the updates that do not say -- and
 * which subagent, if any, it belongs to.
 *
 * The server reports nothing about a child after `invoke_subagent` launches
 * it: the call completes at once with the model's own summary ("Invoke
 * subagent"), there is no child id, no progress and no completion, the
 * child's text is suppressed, and its tool calls arrive on the parent session
 * looking exactly like the parent's -- same session id, same id formats, same
 * kinds, no `_meta` (measured, 1.4.0). So a window decides: every call first
 * seen after a launch, until the turn ends, is that subagent's, and goes to
 * the newest card still open; its later updates follow it. The known cost: a
 * call the parent makes while a child runs lands in the card too. A card
 * settles when the turn that launched it ends (or, replayed, at the next
 * user message or the end of the load). The server streams calls only inside
 * a turn, so nothing can arrive for a card between turns.
 */
export class AgyToolCallShapes {
  private readonly tools = new Map<string, string>();
  /** This turn's subagent cards still open, oldest first; the newest takes new calls. */
  private openCards: string[] = [];
  /** A call's card, once it was first seen inside a subagent's window. */
  private readonly childOf = new Map<string, string>();
  /** Calls first seen with no window open: the parent's. */
  private readonly parentCalls = new Set<string>();

  normalize(update: any): { update: any; childSessionId?: string } {
    const id = typeof update?.toolCallId === "string" ? update.toolCallId : undefined;
    if (!id) return { update };
    const titled = agyToolNameFromTitle(update.title);
    if (titled) this.tools.set(id, titled);
    else if (update.kind === "execute" && !this.tools.has(id)) this.tools.set(id, "run_command");
    const tool = this.tools.get(id);
    const raw = agyRawInput(update.rawInput);
    if (tool === "invoke_subagent") return { update: this.subagent(update, id, raw) };
    const card = this.cardFor(id);
    const shaped = tool ? this.shape(update, tool, raw) : update;
    return card ? { update: shaped, childSessionId: agySubagentSessionId(card) } : { update: shaped };
  }

  /** Settle every open card: the turn (or the replayed turn) is over. */
  settle(outcome: "completed" | "cancelled" | "failed"): any[] {
    const status = outcome === "completed" ? "completed" : "cancelled";
    const settled = this.openCards.map((toolCallId) => ({
      // No result text exists: the server suppresses the child's own words,
      // and the parent's reply carries what it found.
      sessionUpdate: "tool_call_update", toolCallId, kind: "subagent", tool: "invoke_subagent", status, rawOutput: { output: "" },
    }));
    this.openCards = [];
    return settled;
  }

  private cardFor(id: string): string | undefined {
    const known = this.childOf.get(id);
    if (known) return known;
    if (this.parentCalls.has(id)) return undefined;
    const open = this.openCards.at(-1);
    if (open) {
      this.childOf.set(id, open);
      return open;
    }
    this.parentCalls.add(id);
    return undefined;
  }

  private shape(update: any, tool: string, raw: Record<string, unknown> | undefined): any {
    const out: any = { ...update, tool: RENDERER_TOOL[tool] ?? tool };
    if (raw) out.rawInput = agyRendererInput(tool, raw);
    if (RENDERER_TOOL[tool] === "run_command") {
      // The server titles a command with the command line, and the renderer
      // reads a path out of a title (backticks, a leading verb). A PowerShell
      // line is full of both: "Run ''\"]([^" was such a path. The label comes
      // from `rawInput.command`.
      if (out.title !== undefined) out.title = "Run command";
      if (update.rawOutput !== undefined) out.rawOutput = agyCommandOutput(update.rawOutput);
    }
    return out;
  }

  private subagent(update: any, id: string, raw: Record<string, unknown> | undefined): any {
    const input = raw ? agySubagentInput(raw) : undefined;
    const out: any = { ...update, kind: "subagent", tool: "invoke_subagent", child_session_id: agySubagentSessionId(id) };
    if (input) {
      out.rawInput = { ...raw, ...input };
      out.title = input.description ?? "Subagent";
    } else {
      // The running update carries `rawInput: {}` and the generic title.
      delete out.rawInput;
      delete out.title;
    }
    const ended = update.status === "failed" || update.status === "cancelled";
    if (ended) {
      // Refused or stopped before it ran: nothing will arrive for it.
      this.openCards = this.openCards.filter((card) => card !== id);
      return out;
    }
    if (update.sessionUpdate === "tool_call" && !this.openCards.includes(id)) this.openCards.push(id);
    if (update.status === "completed") {
      // The launch "completes" at once with the model's summary of the call
      // ("Invoke subagent"); the child is only starting. A replayed launch
      // arrives completed too, ahead of its child's calls. Running until the
      // turn ends.
      out.status = "in_progress";
      delete out.rawOutput;
    }
    return out;
  }
}

export function normalizeAgyPermissionParams(params: any): any {
  const toolCall = params?.toolCall;
  const raw = agyRawInput(toolCall?.rawInput);
  if (!raw) return params;
  const tool = agyToolNameFromTitle(toolCall.title) ?? (toolCall.kind === "execute" ? "run_command" : undefined);
  return { ...params, toolCall: { ...toolCall, rawInput: agyRendererInput(tool, raw) } };
}

export function normalizeAgyUpdate(update: any, meta: any, toolCalls: AgyToolCallMerger, shapes = new AgyToolCallShapes()): BackendUpdate {
  if (!update || typeof update !== "object") return { update, meta };
  if (update.sessionUpdate === "available_commands_update" && Array.isArray(update.availableCommands)) {
    // Keep sign-out in AFK's account controls. The CLI's own /compact gets the
    // mark the meter's Compact button looks for, as Muse's adapter sets it.
    const availableCommands = update.availableCommands
      .filter((command: any) => command?.name !== "logout")
      .map((command: any) => command?.name === "compact"
        ? { ...command, _meta: { ...(command._meta ?? {}), "afk/compact": true } } : command);
    return { update: { ...update, availableCommands }, meta };
  }
  // The backend maps native modes before this shared update normalizer.
  if (update.sessionUpdate === "current_mode_update") return { meta };
  if (update.sessionUpdate === "usage_update") {
    return { update, meta, contextUsed: update.used, contextWindow: update.size };
  }
  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    const merged = toolCalls.accept(update);
    if (!merged) return { meta };
    const shaped = shapes.normalize(merged);
    return { update: shaped.update, meta, ...(shaped.childSessionId ? { childSessionId: shaped.childSessionId } : {}) };
  }
  // A replayed user message starts the next turn: the last one's cards are done.
  if (update.sessionUpdate === "user_message_chunk") {
    const precede = shapes.settle("completed");
    return precede.length ? { update, meta, precede } : { update, meta };
  }
  if (update.sessionUpdate === "agent_message_chunk" && isAgyRejectedCredentialText(update.content?.text)) {
    return { update, meta, credentialRejected: true };
  }
  return { update, meta };
}

export function agySessionPathKey(value: string, platform: NodeJS.Platform): string {
  const api = platform === "win32" ? path.win32 : path.posix;
  const resolved = api.resolve(value);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

export interface AgyHistoryFs {
  readDir(dir: string): string[];
  readFile(file: string): string;
  /** When a file last changed, or undefined if it cannot be read. */
  modifiedAt(file: string): number | undefined;
}

const realHistoryFs: AgyHistoryFs = {
  readDir: (dir) => fs.readdirSync(dir),
  readFile: (file) => fs.readFileSync(file, "utf8"),
  modifiedAt: (file) => { try { return fs.statSync(file).mtimeMs; } catch { return undefined; } },
};

/** Sidecars locate older conversations even when agy is unavailable. */
export function listAgySessions(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  options: AgyCatalogOptions = {},
): BackendSessionListEntry[] {
  return agySessionsFor(listAgyCatalog(platform, options), cwd, platform);
}

export interface AgyCatalogOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  fs?: AgyHistoryFs;
  /** Skip a conversation whose transcript last changed before this (ms),
   *  without reading its metadata -- the history horizon. */
  since?: number;
  /** Read these whatever their age (pinned conversations). */
  keepIds?: ReadonlySet<string>;
}

/** Every folder's conversations in one directory read: what
 *  {@link listAgySessions} reads, before it keeps one folder's. */
export function listAgyCatalog(
  platform: NodeJS.Platform = process.platform,
  options: AgyCatalogOptions = {},
): BackendSessionListEntry[] {
  const io = options.fs ?? realHistoryFs;
  const dir = path.join(agyProfileDir("server", options.env, options.home), "conversations");
  const meterDir = path.join(path.dirname(dir), "afk-pilot-meter");
  let meterId: unknown;
  try { meterId = JSON.parse(io.readFile(path.join(meterDir, "session.json")))?.sessionId; } catch { /* meter has not started */ }
  let names: string[];
  try { names = io.readDir(dir); } catch { return []; }
  const sessions: BackendSessionListEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".db")) continue;
    const sessionId = name.slice(0, -3);
    if (sessionId === meterId) continue;
    const updatedAt = io.modifiedAt(path.join(dir, name));
    if (options.since !== undefined && updatedAt !== undefined && updatedAt < options.since
      && !options.keepIds?.has(sessionId)) continue;
    let sessionCwd: unknown;
    try { sessionCwd = JSON.parse(io.readFile(path.join(dir, `${sessionId}.meta`)))?.cwd; } catch { continue; }
    if (typeof sessionCwd !== "string" || agySessionPathKey(sessionCwd, platform) === agySessionPathKey(meterDir, platform)) continue;
    sessions.push({ sessionId, cwd: sessionCwd, ...(updatedAt !== undefined ? { updatedAt } : {}) });
  }
  return sessions;
}

/** One folder's rows out of {@link listAgyCatalog}, ignoring Windows case. */
export function agySessionsFor(
  catalog: readonly BackendSessionListEntry[],
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): BackendSessionListEntry[] {
  const target = agySessionPathKey(cwd, platform);
  return catalog.filter((entry) => agySessionPathKey(entry.cwd, platform) === target);
}

export interface AgyBackendOptions {
  profile?: AgyProfile;
  geminiDir?: string;
  usageMeter?: AgyUsageMeter;
}

export class AgyBackend implements AcpBackend<"agy"> {
  readonly provider = "agy" as const;
  readonly processName = "Antigravity CLI";
  readonly usesClientPlanGate = false;
  readonly backgroundCommands = true;
  nativeApprovalModes = false;
  pickerModes?: (keyof typeof AGY_CLI_MODE_IDS)[];
  private cliHistory = false;
  private printUsageAvailable = false;
  rewritePrompt = rewriteAgyPrompt;
  private readonly toolCalls = new AgyToolCallMerger();
  private readonly shapes = new AgyToolCallShapes();
  private thinkingLevels?: string[];
  private geminiHome?: string;
  private nativeCommands: SlashCommand[] = [];
  private skills: SlashCommand[] = [];
  private skillsScan?: Promise<SlashCommand[]>;

  constructor(private readonly options: AgyBackendOptions = {}) {}

  private pickerMode(mode: unknown): string | undefined {
    return Object.entries(AGY_CLI_MODE_IDS).find(([, native]) => native === mode)?.[0];
  }

  spawn(options: BackendSpawnOptions): BackendSpawnSpec {
    this.geminiHome = this.options.geminiDir ?? path.resolve(agyGeminiHome(options.env));
    const args = ["acp"];
    if (this.options.profile === "server" || this.options.geminiDir) args.push("--gemini-dir", this.geminiHome);
    if (this.options.profile === "server") args.push("--app-data-dir", "antigravity-acp");
    if (/\.[cm]?js$/i.test(options.cliPath)) {
      return { command: process.execPath, args: [options.cliPath, ...args], env: { ...options.env, ELECTRON_RUN_AS_NODE: "1" }, shell: false };
    }
    return { command: options.cliPath, args, env: { ...options.env }, shell: false };
  }

  sessionParams(cwd: string): Record<string, unknown> {
    this.nativeCommands = [];
    this.skills = [];
    this.skillsScan = undefined;
    return agySessionParams(cwd);
  }

  readonly emptyForkParams = agySessionParams;

  subscriptionCredentialContext(): string | undefined {
    return this.printUsageAvailable && this.options.usageMeter ? "agy:cli" : undefined;
  }

  readSubscriptionUsage() {
    return (this.printUsageAvailable && this.options.usageMeter?.read()) || Promise.resolve([]);
  }

  async availableCommands(cwd: string): Promise<SlashCommand[]> {
    const scan = this.skillsScan ??= discoverAgySkills(cwd, this.geminiHome ?? agyGeminiHome());
    const skills = await scan;
    if (scan === this.skillsScan) this.skills = skills;
    return this.mergedCommands();
  }

  private mergedCommands(): SlashCommand[] {
    const nativeNames = new Set(this.nativeCommands.map(command => command.name.toLowerCase()));
    return [...this.nativeCommands, ...this.skills.filter(skill => !nativeNames.has(skill.name))];
  }

  normalizeSessionResponse(response: any): any {
    if (Array.isArray(response?.configOptions)) {
      this.thinkingLevels = selectValues(configOption(response.configOptions, EFFORT_ID));
    }
    const modes = selectValues(configOption(response?.configOptions, "mode"));
    this.pickerModes = (Object.keys(AGY_CLI_MODE_IDS) as (keyof typeof AGY_CLI_MODE_IDS)[])
      .filter(mode => modes.includes(AGY_CLI_MODE_IDS[mode]));
    this.nativeApprovalModes = this.pickerModes.includes("agent");
    return normalizeAgySessionResponse(response);
  }
  normalizePromptResult(result: any): any { return result; }
  normalizeUpdate(update: any, meta: any): BackendUpdate {
    if (update?.sessionUpdate === "current_mode_update") {
      const currentModeId = this.pickerMode(update.currentModeId);
      return currentModeId ? { update: { ...update, currentModeId }, meta } : { meta };
    }
    const normalized = normalizeAgyUpdate(update, meta, this.toolCalls, this.shapes);
    if (normalized.update?.sessionUpdate === "available_commands_update" && Array.isArray(normalized.update.availableCommands)) {
      this.nativeCommands = normalized.update.availableCommands.filter((command: any) => typeof command?.name === "string");
      normalized.update.availableCommands = this.mergedCommands();
    }
    return normalized;
  }
  turnEnded(outcome: "completed" | "cancelled" | "failed"): any[] { return this.shapes.settle(outcome); }
  normalizePermissionParams(params: any): any { return normalizeAgyPermissionParams(params); }

  setModel(sessionId: string, modelId: string): { method: string; params: any } {
    return { method: "session/set_config_option", params: { sessionId, configId: "model", value: modelId } };
  }

  setReasoningEffort(sessionId: string, _modelId: string | undefined, level: string): { method: string; params: any } | null {
    const value = this.thinkingLevels?.includes(level) ? level : agyThinkingLevel(level);
    if (value && this.thinkingLevels && !this.thinkingLevels.includes(value)) return null;
    return value ? { method: "session/set_config_option", params: { sessionId, configId: EFFORT_ID, value } } : null;
  }

  setMode(sessionId: string, modeId: string): { method: string; params: any } {
    if (!this.pickerModes?.some(mode => mode === modeId)) throw new Error("This session does not offer that mode.");
    return { method: "session/set_config_option", params: { sessionId, configId: "mode", value: AGY_CLI_MODE_IDS[modeId as keyof typeof AGY_CLI_MODE_IDS] } };
  }

  steeringCapabilities(init: any) {
    this.cliHistory = !!init?.agentCapabilities?.sessionCapabilities?.list;
    const [major, minor, patch] = /^(\d+)\.(\d+)\.(\d+)/.exec(init?.agentInfo?.version ?? "")?.slice(1).map(Number) ?? [0, 0, 0];
    const supported = major > 1 || (major === 1 && minor >= 5);
    // On an unverified version print mode could send /usage as a prompt.
    this.printUsageAvailable = major > 1 || (major === 1 && (minor > 5 || (minor === 5 && patch >= 8)));
    return { supported, acceptsContent: false };
  }
  readonly ownsSteeringQueue = true;
  readonly nativeCompactCommand = true;
  interject(sessionId: string, text: string, content?: readonly PromptContentBlock[]) {
    return { method: "session/prompt", params: { sessionId, prompt: content ?? [{ type: "text", text }] } };
  }
  steerDelivered(result: any): boolean { return typeof result?.stopReason === "string"; }
  configState(response: any, fallback: BackendConfigState): BackendConfigState {
    const state = configStateFromAgyOptions(response, fallback);
    if (Array.isArray(response?.configOptions)) {
      this.thinkingLevels = selectValues(configOption(response.configOptions, EFFORT_ID));
      if (this.thinkingLevels.length === 0) state.reasoningEffort = undefined;
    }
    if (this.nativeApprovalModes) {
      const fallbackMode = state.modeId === "yolo" ? "agent" : state.modeId;
      state.modeId = this.pickerMode(optionValue(configOption(response?.configOptions, "mode")) ?? response?.modes?.currentModeId) ?? fallbackMode;
    }
    return state;
  }
  modelSetSucceeded(): boolean { return true; }

  async listSessions(
    request: (method: string, params: any) => Promise<any>,
    cwd: string,
    platform: NodeJS.Platform,
  ): Promise<BackendSessionListResult> {
    const sessions = new Map<string, BackendSessionListEntry>();
    if (!this.cliHistory) return { sessions: [], nextCursor: null };
    const paths = platform === "win32" ? path.win32 : path.posix;
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await request("session/list", { ...(cwd ? { cwd } : {}), ...(cursor ? { cursor } : {}) });
      for (const row of Array.isArray(page?.sessions) ? page.sessions : []) {
        const { sessionId, cwd, title, updatedAt } = row ?? {};
        if (typeof sessionId === "string" && sessionId && typeof cwd === "string" && paths.isAbsolute(cwd)) {
          sessions.set(sessionId, { sessionId, cwd, agyProgram: this.options.profile ?? "cli", title: typeof title === "string" ? title : undefined,
            updatedAt: typeof updatedAt === "string" ? updatedAt : undefined });
        }
      }
      cursor = typeof page?.nextCursor === "string" && !cursors.has(page.nextCursor) ? page.nextCursor : undefined;
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return { sessions: [...sessions.values()], nextCursor: null };
  }

  isCredentialError(error: unknown): boolean { return isAgyCredentialError(error); }
}
