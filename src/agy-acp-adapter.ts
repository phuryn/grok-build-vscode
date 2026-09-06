import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface, type Interface } from "node:readline";
import { Readable, Writable } from "node:stream";
import { DEFAULT_GEMINI_MODELS } from "./gemini-backend";
import { MAX_DIFF_EXPAND_BYTES } from "./diff-view";
import { mergeDiffIntoContent, synthesizeEditDiff, type AcpDiffBlock } from "./diff-synthesize";

/**
 * What `agy` actually does with `--effort`, measured against 1.1.26.
 *
 * A model id either carries its reasoning level in the suffix or takes exactly
 * one `--effort` — never both, and never neither:
 *
 *     --model gemini-3.8-flash                 -> "requires --effort (low, medium, high)"
 *     --model gemini-3.8-flash --effort high   -> ok
 *     --model gemini-3.8-flash-low             -> ok
 *     --model gpt-oss-120b-medium              -> ok
 *     --model gpt-oss-120b-medium --effort high-> "conflicts with --effort=high"
 *
 * So the flag is not optional decoration on the models that group by effort:
 * omitting it fails the session outright, which is why "Default" resolves to a
 * real level here rather than to an absent flag. An id we do not know (a
 * dynamic variant) is assumed to already carry its own level.
 */
function modelRequiresEffort(modelId: string): boolean {
  const known = DEFAULT_GEMINI_MODELS.find((m) => m.modelId === modelId);
  return known ? known._meta.supportsReasoningEffort === true : false;
}

/** Where "Default" lands for a model that insists on a level. The middle one:
 *  the CLI offers no default of its own, and the previous hard-coded `high`
 *  bought maximum thinking on every turn without anyone choosing it. */
export const DEFAULT_AGY_EFFORT = "medium";

function toolKind(name: string): string {
  switch (name) {
    case "write_to_file":
    case "replace_file_content":
    case "multi_replace_file_content":
    case "sed_file":
      return "edit";
    case "run_command":
      return "execute";
    case "grep_search":
    case "search_web":
    case "find_by_name":
      return "search";
    case "view_file":
    case "list_dir":
    case "read_resource":
    case "read_url_content":
    case "read_browser_page":
      return "read";
    default:
      return "other";
  }
}

export function normalizeToolInput(name: string, params: any): Record<string, any> {
  const p = { ...(params || {}) };
  if (p.CommandLine) {
    p.command = p.CommandLine;
    p.cmd = p.CommandLine;
  }
  if (p.TargetFile) {
    p.file_path = p.TargetFile;
    p.path = p.TargetFile;
    p.target_file = p.TargetFile;
  }
  if (p.AbsolutePath) {
    p.file_path = p.AbsolutePath;
    p.path = p.AbsolutePath;
  }
  if (p.DirectoryPath) {
    p.directory = p.DirectoryPath;
    p.target_directory = p.DirectoryPath;
    p.path = p.DirectoryPath;
  }
  if (p.Query) {
    p.pattern = p.Query;
    p.query = p.Query;
  }
  if (p.Pattern) {
    p.pattern = p.Pattern;
    p.glob_pattern = p.Pattern;
  }
  if (p.SearchDirectory) {
    p.path = p.SearchDirectory;
    p.directory = p.SearchDirectory;
  }
  if (p.Url) {
    p.url = p.Url;
    p.uri = p.Url;
  }
  return p;
}

function toolTitle(name: string, params: any): string {
  const p = params || {};
  switch (name) {
    case "write_to_file": {
      const file = p.TargetFile || p.file_path || p.path ? path.basename(p.TargetFile || p.file_path || p.path) : "file";
      return `Create ${file}`;
    }
    case "replace_file_content":
    case "multi_replace_file_content": {
      const file = p.TargetFile || p.file_path || p.path ? path.basename(p.TargetFile || p.file_path || p.path) : "file";
      return `Edit ${file}`;
    }
    case "view_file": {
      const file = p.AbsolutePath || p.file_path || p.path ? path.basename(p.AbsolutePath || p.file_path || p.path) : "file";
      return `Read ${file}`;
    }
    case "list_dir": {
      const dir = p.DirectoryPath || p.directory || p.path ? path.basename(p.DirectoryPath || p.directory || p.path) : "directory";
      return `List ${dir}`;
    }
    case "grep_search": {
      const q = p.Query || p.pattern || p.query;
      return q ? `Search "${q}"` : "grep_search";
    }
    case "find_by_name": {
      const pattern = p.Pattern || p.pattern || p.Query || p.query;
      return pattern ? `Find "${pattern}"` : "find_by_name";
    }
    case "search_web": {
      const q = p.Query || p.pattern || p.query;
      return q ? `Web search "${q}"` : "search_web";
    }
    case "run_command": {
      const cmd = p.CommandLine || p.command || p.cmd;
      return cmd ? cmd.split(/\r?\n/)[0].slice(0, 80) : "run_command";
    }
    default:
      return name;
  }
}

/**
 * Normalize an absolute file path for use as a baseline cache key.
 * On Windows, paths are case-insensitive and slashes must be consistent.
 */
export function normalizeBaselineKey(file: string, cwd: string): string {
  const resolved = path.isAbsolute(file) ? path.normalize(file) : path.normalize(path.resolve(cwd, file));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Find the most authoritative transcript file for an Antigravity conversation.
 * Checks for untruncated `transcript_full.jsonl` first, then falls back to `transcript.jsonl`.
 * Checks candidate directories across all possible Gemini homes (~/.gemini/antigravity-cli,
 * ~/.gemini/antigravity-ide, ~/.gemini/antigravity, ~/.gemini/brain, etc.).
 */
export function findTranscriptPath(conversationId: string, geminiHome?: string): string | undefined {
  const home = geminiHome || path.join(os.homedir(), ".gemini");
  const baseDirs = [
    path.join(home, "antigravity-cli", "brain", conversationId, ".system_generated", "logs"),
    path.join(home, "antigravity-ide", "brain", conversationId, ".system_generated", "logs"),
    path.join(home, "antigravity", "brain", conversationId, ".system_generated", "logs"),
    path.join(home, "brain", conversationId, ".system_generated", "logs"),
    path.join(os.homedir(), ".gemini", "antigravity-cli", "brain", conversationId, ".system_generated", "logs"),
    path.join(os.homedir(), ".gemini", "antigravity-ide", "brain", conversationId, ".system_generated", "logs"),
    path.join(os.homedir(), ".gemini", "antigravity", "brain", conversationId, ".system_generated", "logs"),
    path.join(os.homedir(), ".gemini", "brain", conversationId, ".system_generated", "logs"),
  ];
  // 1. Prefer transcript_full.jsonl (untruncated, not double-encoded)
  for (const dir of baseDirs) {
    const fullPath = path.join(dir, "transcript_full.jsonl");
    if (fs.existsSync(fullPath)) return fullPath;
  }
  // 2. Fallback to transcript.jsonl
  for (const dir of baseDirs) {
    const compactPath = path.join(dir, "transcript.jsonl");
    if (fs.existsSync(compactPath)) return compactPath;
  }
  return undefined;
}

/**
 * Look up the most recent tool call arguments for a given tool name and file path
 * from the conversation's transcript on disk.
 */
export function findRecentTranscriptToolCall(
  conversationId: string | undefined,
  geminiHome: string | undefined,
  toolName: string,
  filePath: string,
  cwd: string,
  stepIndex?: number,
): any | undefined {
  if (!conversationId) return undefined;
  const transcriptPath = findTranscriptPath(conversationId, geminiHome);
  if (!transcriptPath) return undefined;
  try {
    const content = fs.readFileSync(transcriptPath, "utf8");
    const lines = content.split(/\r?\n/).filter(Boolean);
    const targetKey = normalizeBaselineKey(filePath, cwd);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const step = JSON.parse(lines[i]);
        if (stepIndex != null) {
          // A tool call in the transcript corresponds to the current step if its step_index
          // matches the tool step or the immediately preceding planner step.
          if (step.step_index !== stepIndex && step.step_index !== stepIndex - 1) {
            continue;
          }
        }
        if (Array.isArray(step.tool_calls)) {
          for (const tc of step.tool_calls) {
            const name = tc.name ?? tc.tool_name ?? tc.toolName ?? tc.tool?.name;
            if (name === toolName) {
              const raw = unwrapTranscriptStrings(tc.args ?? tc.parameters ?? tc.params ?? {});
              const file = raw?.TargetFile || raw?.file_path || raw?.path;
              if (typeof file === "string" && normalizeBaselineKey(file, cwd) === targetKey) {
                return raw;
              }
            }
          }
        }
      } catch {}
    }
  } catch {}
  return undefined;
}

/**
 * Antigravity's persistent `transcript.jsonl` (read only by `replayToolCalls`,
 * never by the live `stream-json` path) stores each string-valued tool
 * argument JSON-stringified a SECOND time — a real capture showed
 * `"TargetContent":"\"**Revision:** 3.1 …\""`, whose value, once the whole
 * line is parsed, is the literal string `"**Revision:** 3.1 …"` (leading and
 * trailing quote characters included). Passing that straight to
 * `synthesizeEditDiff` would frame every replayed diff in stray quotes. This
 * unwraps every string field that looks double-encoded (JSON.parse succeeds
 * and yields a string); a field that doesn't decode cleanly is left as-is —
 * this is replay of an already-completed edit, so a decode miss can only
 * leave that one field's quoting slightly off, never invent a wrong diff.
 */
export function unwrapTranscriptStrings(params: any): any {
  if (!params || typeof params !== "object") return params;
  const out: any = Array.isArray(params) ? [] : {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") {
      try {
        const decoded = JSON.parse(value);
        out[key] = typeof decoded === "string" ? decoded : value;
      } catch {
        // If double-quoted by transcript.jsonl but inner quotes broke JSON.parse:
        if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
          out[key] = value.slice(1, -1);
        } else {
          out[key] = value;
        }
      }
    } else if (value && typeof value === "object") {
      out[key] = unwrapTranscriptStrings(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Build the `{ type: "diff" }` block for one of agy's edit tools from its raw
 * (un-normalized) parameters (docs/UNIVERSAL_DIFF_SUPPORT_PLAN.md § 4.1).
 *
 * `write_to_file` reports only the new content — `diskOldText` (read by the
 * caller in the ACTIVE branch, before the write lands) supplies the "before"
 * side; a genuine creation leaves it undefined and the diff renders as a pure
 * add. `replace_file_content` / `multi_replace_file_content` already carry
 * both sides in their parameters, so no disk read is needed for those.
 *
 * `sed_file`'s parameter shape has not been captured against a live `agy`
 * process, so it is deliberately left unmapped rather than guessed (plan
 * § Offene Fragen #4) — its tool card falls back to the plain parameter view.
 */
export function synthesizeAgyToolDiff(
  name: string,
  rawParams: any,
  opts: { diskOldText?: string } = {},
): AcpDiffBlock | undefined {
  const p = rawParams && typeof rawParams === "object" ? rawParams : {};
  switch (name) {
    case "write_to_file": {
      const file = p.TargetFile || p.file_path || p.path;
      if (typeof file !== "string" || !file) return undefined;
      const newText = typeof p.CodeContent === "string" ? p.CodeContent : "";
      return synthesizeEditDiff({ path: file, oldText: opts.diskOldText ?? "", newText });
    }
    case "replace_file_content": {
      const file = p.TargetFile || p.file_path || p.path;
      if (typeof file !== "string" || !file) return undefined;
      const oldText = typeof p.TargetContent === "string" ? p.TargetContent : "";
      const newText = typeof p.ReplacementContent === "string" ? p.ReplacementContent : "";
      const parsedStart = typeof p.StartLine === "number" ? p.StartLine : (typeof p.StartLine === "string" ? parseInt(p.StartLine, 10) : NaN);
      const startLine = Number.isInteger(parsedStart) && parsedStart >= 1 ? parsedStart : undefined;
      // A replacement that changes the line count shifts every line after it —
      // `new_line` is only trustworthy when the region is line-count-neutral.
      const lineCountNeutral =
        (oldText ? oldText.split(/\r?\n/).length : 0) === (newText ? newText.split(/\r?\n/).length : 0);
      return synthesizeEditDiff({
        path: file,
        oldText,
        newText,
        oldLine: startLine,
        ...(lineCountNeutral && startLine !== undefined ? { newLine: startLine } : {}),
      });
    }
    case "multi_replace_file_content": {
      const file = p.TargetFile || p.file_path || p.path;
      if (typeof file !== "string" || !file) return undefined;
      const chunks = Array.isArray(p.ReplacementChunks) ? p.ReplacementChunks : [];
      if (!chunks.length) return undefined;
      const details = chunks.map((chunk: any) => {
        const parsedLine = typeof chunk?.StartLine === "number" ? chunk.StartLine : (typeof chunk?.StartLine === "string" ? parseInt(chunk.StartLine, 10) : NaN);
        return {
          old_string: typeof chunk?.TargetContent === "string" ? chunk.TargetContent : "",
          new_string: typeof chunk?.ReplacementContent === "string" ? chunk.ReplacementContent : "",
          ...(Number.isInteger(parsedLine) && parsedLine >= 1 ? { old_line: parsedLine } : {}),
        };
      });
      const first = chunks[0] ?? {};
      // Block-level oldText/newText mirror the FIRST chunk only (matching
      // Grok's own replace_all echo) — the full account lives in details[].
      return synthesizeEditDiff({
        path: file,
        oldText: typeof first.TargetContent === "string" ? first.TargetContent : "",
        newText: typeof first.ReplacementContent === "string" ? first.ReplacementContent : "",
        details,
      });
    }
    default:
      return undefined;
  }
}

export function isImplementationPlanTool(name: string, params: any): boolean {
  if (!params || typeof params !== "object") return false;
  const target = String(params.TargetFile || params.AbsolutePath || params.file_path || params.path || "");
  if (/(?:^|[\\/])implementation_plan\.md$/i.test(target)) return true;
  if (params.ArtifactMetadata?.RequestFeedback === true && /\.md$/i.test(target)) return true;
  return false;
}

export function extractPlanText(params: any, cwd?: string): string {
  if (!params || typeof params !== "object") return "";
  if (typeof params.CodeContent === "string" && params.CodeContent.trim()) {
    return params.CodeContent;
  }
  if (typeof params.content === "string" && params.content.trim()) {
    return params.content;
  }
  if (typeof params.ReplacementContent === "string" && params.ReplacementContent.trim()) {
    return params.ReplacementContent;
  }
  const target = params.TargetFile || params.AbsolutePath || params.file_path || params.path;
  if (typeof target === "string" && target) {
    try {
      const resolved = path.isAbsolute(target) ? target : (cwd ? path.resolve(cwd, target) : path.resolve(target));
      if (fs.existsSync(resolved)) {
        return fs.readFileSync(resolved, "utf8");
      }
    } catch {}
  }
  return "";
}

export interface StoredSessionInfo {
  conversationId: string;
  cwd: string;
  title?: string;
  updatedAt: number;
}

export function cleanPromptTitle(text: string): string {
  if (!text) return "Antigravity Session";
  const m = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  const raw = m ? m[1] : text;
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/<[^>]+>/g, "").trim())
    .filter((l) => l.length > 0 && !l.startsWith("Currently open") && !l.startsWith("The current local time"));
  const first = lines[0]?.trim();
  return first ? (first.length > 80 ? `${first.slice(0, 77)}…` : first) : "Antigravity Session";
}

export interface AgyAdapterOptions {
  agyPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  defaultModelId?: string;
  defaultEffort?: string;
  defaultModeId?: string;
  printTimeout?: string;
  geminiHome?: string;
  /** Where the `acpSessionId -> conversation_id` map lives. Injected by tests. */
  conversationStorePath?: string;
  inputStream?: NodeJS.ReadableStream;
  outputStream?: NodeJS.WritableStream;
  spawnFn?: (command: string, args: string[], options: any) => ChildProcessWithoutNullStreams;
  /** Overrides for `waitForDiskChangeText`'s retry loop. Production defaults
   *  to (50, 200) — a ~10s budget; tests inject a much smaller budget so the
   *  "the write never lands" cases don't each cost the full production wait. */
  diskPollAttempts?: number;
  diskPollDelayMs?: number;
}

export interface PromptUsage {
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  totalTokens: number;
}

export class AgyAcpAdapterServer {
  private readonly agyPath: string;
  cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly spawnFn: (command: string, args: string[], options: any) => ChildProcessWithoutNullStreams;
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readonly printTimeout: string;
  private readonly geminiHome: string;
  private readonly diskPollAttempts: number;
  private readonly diskPollDelayMs: number;

  /** `write_to_file`'s pre-write disk read (ACTIVE branch), reused by the DONE
   *  branch so the "before" side is never read after the write has landed —
   *  by then disk already holds the "after" text. Cleared per toolCallId once
   *  the tool step resolves (completed OR error). */
  private readonly pendingWriteOldText = new Map<string, string | undefined>();

  /**
   * Session-lifetime "last known good" content per absolute file path.
   *
   * Live evidence (agy 1.1.26, live capture with the user): edits land on
   * disk essentially instantly — VS Code's own editor reflects the change
   * immediately — so the earlier "write is slow, poll for it" model was
   * diagnosing the wrong race. For a near-instant local write, ACTIVE and
   * DONE for the same tool step can both be emitted (and read from stdout)
   * AFTER the file already changed, which means the ACTIVE-phase disk read
   * in `synthesizeAgyDiffContent` is reading POST-write content too — old
   * and new end up identical ("+0 −0"), not because the write was slow but
   * because there was never a real "before" moment on the wire to read from.
   *
   * This map breaks that by not depending on ACTIVE's timing at all for any
   * file this session has already touched: the DONE branch of every edit
   * updates this cache with the resulting content, and the NEXT edit to that
   * same path (even in a later turn) uses this cached value as its "before"
   * instead of re-reading disk at ACTIVE. Only the very first edit to a given
   * path in a session still relies on the ACTIVE-time disk read (there is no
   * prior cached value yet), so it remains exposed to the same race.
   */
  private readonly sessionFileBaseline = new Map<string, string | undefined>();

  /** Edits whose write hadn't landed on disk by the end of their own DONE
   *  poll — rechecked once more at turn-end (flushPendingEditRechecks). */
  private pendingEditRecheck: Array<{ toolCallId: string; file: string; diskOldText: string | undefined }> = [];

  /**
   * In-flight `synthesizeAgyDiffContent` calls for the current turn. Live
   * evidence: the "result" event (turn complete) can arrive WHILE a DONE-phase
   * poll (up to ~3s) is still running, so `flushPendingEditRechecks` running
   * synchronously at that point finds nothing queued yet — the entry is only
   * pushed once the poll itself gives up. The "result" handler awaits all of
   * these before flushing/resolving, so no edit's diff correction is lost to
   * that race.
   */
  private pendingDiffPromises: Promise<unknown>[] = [];

  private rl?: Interface;
  private agyProc?: ChildProcessWithoutNullStreams;
  private agyRl?: Interface;
  private agyErrRl?: Interface;

  sessionId?: string;
  currentModelId: string;
  currentEffort: string;
  currentModeId: string;
  activeConversationId?: string;
  pendingExitPlanId?: number | string;

  /** A model/effort/mode change that arrived while a turn was running. Applying
   *  it means respawning `agy`, which throws away work already billed for — so
   *  the respawn waits until the next prompt. */
  private respawnBeforeNextPrompt = false;
  /** Where `acpSessionId -> conversation_id` is remembered across adapter
   *  lifetimes. Without it, reopening a conversation started a blank one the UI
   *  still showed a full history for, and every follow-up had to be re-explained. */
  private readonly conversationStorePath: string;

  private pendingPrompt?: {
    id: number | string;
    resolve: (result: any) => void;
    reject: (error: any) => void;
    usage: PromptUsage;
  };

  constructor(options: AgyAdapterOptions = {}) {
    this.agyPath = options.agyPath || process.env.AGY_PATH || process.env.GEMINI_CLI_EXECUTABLE || "agy";
    this.cwd = options.cwd || process.env.AGY_CWD || process.cwd();
    this.env = options.env || { ...process.env };
    this.currentModelId = options.defaultModelId || "gemini-3.8-flash";
    this.currentEffort = options.defaultEffort || "";
    this.currentModeId = options.defaultModeId || process.env.AGY_DEFAULT_MODE || "agent";
    this.geminiHome = options.geminiHome || path.join(os.homedir(), ".gemini");
    this.conversationStorePath = options.conversationStorePath
      || path.join(this.geminiHome, "grok-acp-conversations.json");
    this.printTimeout = options.printTimeout || options.env?.AGY_PRINT_TIMEOUT || process.env.AGY_PRINT_TIMEOUT || "24h";
    this.input = options.inputStream || process.stdin;
    this.output = options.outputStream || process.stdout;
    this.spawnFn = options.spawnFn || ((cmd, args, opts) => spawn(cmd, args, opts));
    this.diskPollAttempts = options.diskPollAttempts ?? 50;
    this.diskPollDelayMs = options.diskPollDelayMs ?? 200;
  }

  start(): void {
    this.rl = createInterface({ input: this.input });
    this.rl.on("line", (line) => this.handleClientLine(line));
    this.input.on("end", () => this.dispose());
  }

  dispose(): void {
    this.rl?.close();
    this.rl = undefined;
    this.killAgyProc();
    this.activeConversationId = undefined;
    this.pendingExitPlanId = undefined;
    this.pendingWriteOldText.clear();
    this.pendingEditRecheck = [];
    this.pendingDiffPromises = [];
  }

  /** The whole map, or an empty one. A store we cannot read is not an error
   *  worth failing a session over — it only costs one lost resume. */
  private readConversationStore(): Record<string, StoredSessionInfo> {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.conversationStorePath, "utf8"));
      if (!parsed || typeof parsed !== "object") return {};
      const result: Record<string, StoredSessionInfo> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") {
          const enriched = this.enrichSessionFromTranscript(v);
          result[k] = {
            conversationId: v,
            cwd: enriched?.cwd || this.cwd || "",
            title: enriched?.title || "Antigravity Session",
            updatedAt: enriched?.updatedAt || Date.now(),
          };
        } else if (v && typeof v === "object") {
          const item = v as any;
          result[k] = {
            conversationId: typeof item.conversationId === "string" ? item.conversationId : "",
            cwd: typeof item.cwd === "string" ? item.cwd : this.cwd || "",
            title: typeof item.title === "string" ? item.title : undefined,
            updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : Date.now(),
          };
        }
      }
      return result;
    } catch {
      return {};
    }
  }

  private writeConversationStore(store: Record<string, StoredSessionInfo>): void {
    try {
      fs.mkdirSync(path.dirname(this.conversationStorePath), { recursive: true });
      fs.writeFileSync(this.conversationStorePath, JSON.stringify(store, null, 2), "utf8");
    } catch {
      // Best effort: a resume we cannot remember is worse than one we cannot
      // write, and neither is worth ending the session for.
    }
  }

  rememberConversation(
    sessionId: string,
    conversationId: string,
    meta?: { cwd?: string; title?: string; updatedAt?: number },
  ): void {
    const store = this.readConversationStore();
    const existing = store[sessionId];
    store[sessionId] = {
      conversationId: conversationId || existing?.conversationId || "",
      cwd: meta?.cwd || existing?.cwd || this.cwd || "",
      title: meta?.title || existing?.title,
      updatedAt: meta?.updatedAt || existing?.updatedAt || Date.now(),
    };
    this.writeConversationStore(store);
  }

  private forgetConversation(sessionId: string): void {
    const store = this.readConversationStore();
    if (!(sessionId in store)) return;
    delete store[sessionId];
    this.writeConversationStore(store);
  }

  lookupConversation(sessionId: string): string | undefined {
    const store = this.readConversationStore();
    const found = store[sessionId];
    if (found?.conversationId) return found.conversationId;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
      return sessionId;
    }
    return undefined;
  }

  private enrichSessionFromTranscript(conversationId: string): { title?: string; cwd?: string; updatedAt?: number } | undefined {
    const transcriptPath = findTranscriptPath(conversationId, this.geminiHome);
    if (!transcriptPath) return undefined;
    try {
      const stat = fs.statSync(transcriptPath);
      const lines = fs.readFileSync(transcriptPath, "utf8").split(/\r?\n/).filter(Boolean);
      let title: string | undefined;
      let cwd: string | undefined;
      for (const line of lines) {
        try {
          const s = JSON.parse(line);
          if (!title && s.type === "USER_INPUT" && typeof s.content === "string") {
            title = cleanPromptTitle(s.content);
          }
          if (!cwd && s.tool_calls && Array.isArray(s.tool_calls)) {
            for (const tc of s.tool_calls) {
              const c = tc.args?.Cwd || tc.args?.SearchPath || tc.args?.AbsolutePath || tc.args?.TargetFile;
              if (typeof c === "string") {
                const cleaned = c.replace(/^["']+|["']+$/g, "").replace(/\\\\/g, "\\");
                if (cleaned.includes(":") || cleaned.startsWith("/")) {
                  try {
                    cwd = fs.existsSync(cleaned) && fs.statSync(cleaned).isDirectory() ? cleaned : path.dirname(cleaned);
                  } catch {
                    cwd = path.dirname(cleaned);
                  }
                  break;
                }
              }
            }
          }
          if (title && cwd) break;
        } catch {}
      }
      return { title, cwd, updatedAt: stat.mtimeMs };
    } catch {
      return undefined;
    }
  }

  private readNativeAntigravitySessions(targetCwd?: string): any[] {
    const candidates = [
      path.join(this.geminiHome, "antigravity-cli", "conversation_summaries.db"),
      path.join(this.geminiHome, "antigravity", "conversation_summaries.db"),
      path.join(os.homedir(), ".gemini", "antigravity-cli", "conversation_summaries.db"),
      path.join(os.homedir(), ".gemini", "antigravity", "conversation_summaries.db"),
    ];
    const dbPath = candidates.find((p) => fs.existsSync(p));
    if (!dbPath) return [];

    try {
      // Use dynamic require so environments without node:sqlite don't crash
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const query = "SELECT conversation_id, title, workspace_uris, last_modified_time FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT 100";
      const rows = db.prepare(query).all() as Array<{
        conversation_id: string;
        title: string;
        workspace_uris: string;
        last_modified_time: string;
      }>;
      db.close();

      const normalizeKey = (p: string) => {
        const resolved = path.resolve(p);
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
      };
      const targetKey = targetCwd ? normalizeKey(targetCwd) : undefined;
      const results: any[] = [];

      for (const row of rows) {
        if (!row.conversation_id) continue;
        let uris: string[] = [];
        try {
          if (row.workspace_uris) uris = JSON.parse(row.workspace_uris);
        } catch {}

        let matchedCwd = "";
        if (Array.isArray(uris) && uris.length > 0) {
          for (const rawUri of uris) {
            let localPath = rawUri.replace(/^file:\/\//i, "");
            if (/^\/[a-zA-Z]:[/\\]/.test(localPath)) localPath = localPath.slice(1);
            try { localPath = decodeURIComponent(localPath); } catch {}
            const norm = normalizeKey(localPath);
            if (!targetKey || norm === targetKey || targetKey.startsWith(norm) || norm.startsWith(targetKey)) {
              matchedCwd = targetCwd || localPath;
              break;
            }
          }
        }
        if (targetKey && !matchedCwd) continue;

        const updatedAt = row.last_modified_time ? Date.parse(row.last_modified_time) || Date.now() : Date.now();
        results.push({
          sessionId: row.conversation_id,
          cwd: matchedCwd || targetCwd || this.cwd,
          title: row.title?.trim() || "Antigravity Session",
          updatedAt,
        });
      }
      return results;
    } catch {
      return [];
    }
  }

  listStoredSessions(targetCwd?: string): any[] {
    const store = this.readConversationStore();
    const result: any[] = [];
    const seenSessionIds = new Set<string>();
    const seenConversationIds = new Set<string>();

    const normalizeKey = (p: string) => {
      const resolved = path.resolve(p);
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    const targetKey = targetCwd ? normalizeKey(targetCwd) : undefined;

    // 1. Sessions stored via ACP
    for (const [sessionId, info] of Object.entries(store)) {
      if (!info) continue;
      if (!info.conversationId && (!info.title || info.title === "New session")) continue;
      const sessionCwd = info.cwd || this.cwd;
      if (targetKey && sessionCwd) {
        const norm = normalizeKey(sessionCwd);
        if (norm !== targetKey && !targetKey.startsWith(norm) && !norm.startsWith(targetKey)) {
          continue;
        }
      }
      seenSessionIds.add(sessionId);
      if (info.conversationId) seenConversationIds.add(info.conversationId);
      result.push({
        sessionId,
        cwd: targetCwd || sessionCwd,
        title: info.title || "Antigravity Session",
        updatedAt: info.updatedAt || Date.now(),
      });
    }

    // 2. Native Antigravity sessions from SQLite
    try {
      const nativeSessions = this.readNativeAntigravitySessions(targetCwd);
      for (const entry of nativeSessions) {
        if (!seenSessionIds.has(entry.sessionId) && !seenConversationIds.has(entry.sessionId)) {
          seenSessionIds.add(entry.sessionId);
          result.push(entry);
        }
      }
    } catch {}

    result.sort((a, b) => {
      const aTime = typeof a.updatedAt === "number" ? a.updatedAt : Date.parse(a.updatedAt) || 0;
      const bTime = typeof b.updatedAt === "number" ? b.updatedAt : Date.parse(b.updatedAt) || 0;
      return bTime - aTime;
    });

    return result;
  }

  replayTranscript(conversationId: string): void {
    const transcriptPath = findTranscriptPath(conversationId, this.geminiHome);
    if (!transcriptPath) return;

    const touchedFiles = new Set<string>();
    try {
      const content = fs.readFileSync(transcriptPath, "utf8");
      const lines = content.split(/\r?\n/).filter(Boolean);
      const replayToolCallSeq = { n: 0 };
      for (const line of lines) {
        try {
          const step = JSON.parse(line);
          if (step.type === "USER_INPUT" && typeof step.content === "string") {
            const m = step.content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
            const userText = m ? m[1].trim() : step.content.trim();
            if (userText) {
              this.sendNotification("session/update", {
                sessionId: this.sessionId,
                update: {
                  sessionUpdate: "user_message_chunk",
                  content: { type: "text", text: userText },
                },
              });
            }
          } else if (step.type === "PLANNER_RESPONSE" && typeof step.content === "string" && step.content.trim()) {
            this.sendNotification("session/update", {
              sessionId: this.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: step.content },
              },
            });
          }
          this.replayToolCalls(step, replayToolCallSeq, touchedFiles);
        } catch {}
      }

      // Seed sessionFileBaseline with the current on-disk content of all files touched in the replayed transcript.
      // Without this, the very first edit after a session reload has no cached baseline, falling back to an
      // ACTIVE-phase disk read that races against near-instant local writes (causing "+0 −0").
      for (const file of touchedFiles) {
        const currentDisk = this.readDiskTextForDiff(file);
        if (currentDisk !== undefined) {
          const key = normalizeBaselineKey(file, this.cwd);
          this.sessionFileBaseline.set(key, currentDisk);
        }
      }
    } catch {}
  }

  /**
   * Best-effort tool-call replay (docs/UNIVERSAL_DIFF_SUPPORT_PLAN.md § 4.6,
   * PR 4). Without Viewing on replay, every Antigravity edit made in a past
   * turn goes invisible the moment the conversation is reopened — the same
   * regression `applyToolDiffs` running on both `tool_call` and
   * `tool_call_update` was built to prevent for the live path (#30).
   *
   * `step.tool_calls[].args` is the one field this adapter already reads from
   * a live transcript ({@link enrichSessionFromTranscript}'s cwd inference),
   * so it is trustworthy. The tool NAME field is not independently confirmed
   * against a real `agy` transcript — every plausible key is tried, and a
   * step whose shape doesn't match any of them is skipped rather than guessed
   * at, so a wrong assumption here can only leave a tool unreplayed (today's
   * baseline), never render something incorrect.
   */
  private replayToolCalls(step: any, seq: { n: number }, touchedFiles?: Set<string>): void {
    const calls = Array.isArray(step?.tool_calls) ? step.tool_calls : [];
    for (const tc of calls) {
      if (!tc || typeof tc !== "object") continue;
      const name = tc.name ?? tc.tool_name ?? tc.toolName ?? tc.tool?.name;
      if (typeof name !== "string" || !name) continue;
      const rawParams = unwrapTranscriptStrings(tc.args ?? tc.parameters ?? tc.params ?? {});
      const params = normalizeToolInput(name, rawParams);
      if (touchedFiles && (name === "write_to_file" || name === "replace_file_content" || name === "multi_replace_file_content")) {
        const f = rawParams?.TargetFile || rawParams?.file_path || rawParams?.path;
        if (typeof f === "string" && f) touchedFiles.add(f);
      }
      const toolCallId = `replay-${seq.n++}`;
      const content = mergeDiffIntoContent(undefined, synthesizeAgyToolDiff(name, rawParams));
      this.sendNotification("session/update", {
        sessionId: this.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          title: toolTitle(name, params),
          kind: toolKind(name),
          status: "completed",
          rawInput: params,
          ...(content.length ? { content } : {}),
        },
      });
    }
  }

  /** A config change needs a fresh `agy` with new flags. Mid-turn that would
   *  discard tokens the user has already paid for, so it waits. */
  private requestRespawn(): void {
    if (this.pendingPrompt) {
      this.respawnBeforeNextPrompt = true;
      return;
    }
    this.killAgyProc();
  }

  /** Stop actually stops. ACP delivers `session/cancel` as a notification, and
   *  before this the adapter dropped it — `agy` ran the turn to completion (up
   *  to `--print-timeout`) while nothing was listening, and billed for it. */
  private cancelActiveTurn(): void {
    const pending = this.pendingPrompt;
    // Taken off the field first so killAgyProc does not reject a turn the
    // client asked us to end cleanly.
    this.pendingPrompt = undefined;
    this.killAgyProc();
    if (pending) {
      pending.resolve({ stopReason: "cancelled", usage: pending.usage });
    }
  }

  private killAgyProc(): void {
    this.pendingExitPlanId = undefined;
    if (this.pendingPrompt) {
      const pending = this.pendingPrompt;
      this.pendingPrompt = undefined;
      pending.reject(new Error("Session terminated or reset"));
    }
    if (this.agyRl) {
      this.agyRl.close();
      this.agyRl = undefined;
    }
    if (this.agyErrRl) {
      this.agyErrRl.close();
      this.agyErrRl = undefined;
    }
    if (this.agyProc) {
      try {
        this.agyProc.stdin.end();
      } catch {}
      try {
        this.agyProc.kill();
      } catch {}
      this.agyProc = undefined;
    }
  }

  writeJsonRpc(message: any): void {
    const text = JSON.stringify(message) + "\n";
    this.output.write(text);
  }

  private sendResponse(id: number | string | undefined, result: any): void {
    if (id == null) return;
    this.writeJsonRpc({ jsonrpc: "2.0", id, result });
  }

  private sendError(id: number | string | undefined, code: number, message: string): void {
    if (id == null) return;
    this.writeJsonRpc({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private sendNotification(method: string, params: any): void {
    this.writeJsonRpc({ jsonrpc: "2.0", method, params });
  }

  getConfigOptions(): any[] {
    return [
      {
        id: "model",
        currentValue: this.currentModelId,
        options: DEFAULT_GEMINI_MODELS.map((m) => ({
          value: m.modelId,
          name: m.name,
          description: m.description,
        })),
      },
      {
        id: "reasoning_effort",
        // The effective level, never "default" — for the models this option is
        // shown on, an absent level is not a state the CLI will start in.
        currentValue: modelRequiresEffort(this.currentModelId)
          ? this.currentEffort || DEFAULT_AGY_EFFORT
          : "default",
        options: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
        ],
      },
      {
        id: "mode",
        currentValue: this.currentModeId,
        options: [
          { value: "agent", name: "Agent" },
          { value: "yolo", name: "Auto accept" },
          { value: "plan", name: "Plan" },
        ],
      },
    ];
  }

  stagePromptImage(
    data: string,
    mimeType = "image/png",
    knownPath?: string,
  ): string {
    if (knownPath && typeof knownPath === "string") {
      try {
        if (fs.existsSync(knownPath) && fs.statSync(knownPath).isFile()) {
          return knownPath;
        }
      } catch {}
    }
    const ext = mimeType.includes("jpeg") || mimeType.includes("jpg")
      ? ".jpg"
      : mimeType.includes("webp")
        ? ".webp"
        : mimeType.includes("gif")
          ? ".gif"
          : ".png";
    const stagingDir = path.join(this.geminiHome, "staging");
    try {
      fs.mkdirSync(stagingDir, { recursive: true });
      const filePath = path.join(stagingDir, `image-${randomUUID()}${ext}`);
      fs.writeFileSync(filePath, Buffer.from(data, "base64"));
      return filePath;
    } catch {
      const fallbackDir = path.join(os.tmpdir(), "gemini-staging");
      fs.mkdirSync(fallbackDir, { recursive: true });
      const filePath = path.join(fallbackDir, `image-${randomUUID()}${ext}`);
      fs.writeFileSync(filePath, Buffer.from(data, "base64"));
      return filePath;
    }
  }

  processPromptBlocks(promptBlocks: any[], fallbackText?: string): string {
    let promptText = "";
    const imageInstructions: string[] = [];
    let imageCounter = 0;

    for (const block of promptBlocks) {
      if (typeof block === "string") {
        promptText += (promptText ? "\n" : "") + block;
      } else if (block && typeof block.text === "string") {
        promptText += (promptText ? "\n" : "") + block.text;
      } else if (block && block.type === "image") {
        imageCounter++;
        const data = typeof block.data === "string" ? block.data : "";
        const mimeType = typeof block.mimeType === "string" ? block.mimeType : "image/png";
        const knownPath = typeof block.path === "string" ? block.path : undefined;
        if (data || knownPath) {
          const imagePath = this.stagePromptImage(data, mimeType, knownPath);
          imageInstructions.push(
            `[Attached Image #${imageCounter}: Local file located at "${imagePath}". Please use the view_file tool on this path to inspect the image content.]`,
          );
        }
      }
    }
    if (!promptText && typeof fallbackText === "string") {
      promptText = fallbackText;
    }

    // Clean up contradictory hints meant for other CLIs so Antigravity isn't confused:
    promptText = promptText
      .replace(/\s*—\s*local staged copy;\s*thumbnail only;\s*do not access this path/gi, "")
      .replace(/\s*—\s*attached inline;\s*act on the path if needed,\s*but do not Read it/gi, "")
      .replace(/\s*\(attached inline\s*—\s*already visible to you;\s*do not read it from disk\)/gi, "");

    if (imageInstructions.length > 0) {
      promptText = (promptText ? promptText + "\n\n" : "") + imageInstructions.join("\n");
    }
    return promptText;
  }

  async handleClientLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: any;
    try {
      req = JSON.parse(trimmed);
    } catch {
      return;
    }
    const { id, method, params } = req;

    // Handle response to a pending exit_plan_mode request
    if (id != null && this.pendingExitPlanId != null && id === this.pendingExitPlanId) {
      this.pendingExitPlanId = undefined;
      const outcome = req.result?.outcome;
      if (outcome === "approved") {
        this.currentModeId = "agent";
        this.sendNotification("session/update", {
          sessionId: this.sessionId,
          update: {
            sessionUpdate: "current_mode_update",
            currentModeId: "agent",
          },
        });
        if (this.agyProc) {
          this.requestRespawn();
        }
      }
      return;
    }

    if (!method) return;

    switch (method) {
      case "initialize": {
        this.sendResponse(id, {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
          },
        });
        break;
      }

      case "session/new": {
        this.pendingExitPlanId = undefined;
        if (typeof params?.cwd === "string" && params.cwd) {
          this.cwd = params.cwd;
        }
        if (this.agyProc) {
          this.killAgyProc();
        }
        this.activeConversationId = undefined;
        this.sessionId = randomUUID();
        this.sendResponse(id, {
          sessionId: this.sessionId,
          models: {
            currentModelId: this.currentModelId,
            availableModels: DEFAULT_GEMINI_MODELS,
          },
          configOptions: this.getConfigOptions(),
        });
        break;
      }

      case "session/load": {
        this.pendingExitPlanId = undefined;
        if (typeof params?.cwd === "string" && params.cwd) {
          this.cwd = params.cwd;
        }
        if (this.agyProc) {
          this.killAgyProc();
        }
        const loadedSessionId = typeof params?.sessionId === "string" ? params.sessionId : randomUUID();
        this.sessionId = loadedSessionId;
        // Isolation is per SESSION, not "always start over": the conversation
        // this session owns is resumed, anyone else's is not.
        this.activeConversationId = this.lookupConversation(loadedSessionId);
        if (this.activeConversationId) {
          this.replayTranscript(this.activeConversationId);
        }
        this.sendResponse(id, {
          sessionId: this.sessionId,
          models: {
            currentModelId: this.currentModelId,
            availableModels: DEFAULT_GEMINI_MODELS,
          },
          configOptions: this.getConfigOptions(),
        });
        break;
      }

      case "session/set_config_option": {
        const configId = params?.configId;
        const value = params?.value;
        if (configId === "model" && typeof value === "string") {
          const prevModel = this.currentModelId;
          this.currentModelId = value;
          if (prevModel !== value && this.agyProc) {
            this.requestRespawn();
          }
        } else if ((configId === "reasoning_effort" || configId === "effort") && typeof value === "string") {
          const prevEffort = this.currentEffort;
          this.currentEffort = value === "default" ? "" : value;
          if (prevEffort !== this.currentEffort && this.agyProc) {
            this.requestRespawn();
          }
        } else if (configId === "mode" && typeof value === "string") {
          const prevMode = this.currentModeId;
          this.currentModeId = (value === "yolo" || value === "agent-full-access" || value === "bypassPermissions")
            ? "yolo"
            : value === "plan"
              ? "plan"
              : "agent";
          if (prevMode !== this.currentModeId && this.agyProc) {
            this.requestRespawn();
          }
        }
        this.sendResponse(id, {
          configOptions: this.getConfigOptions(),
        });
        break;
      }

      case "session/set_mode": {
        const rawModeId = typeof params?.modeId === "string" ? params.modeId : "agent";
        const modeId = (rawModeId === "yolo" || rawModeId === "agent-full-access" || rawModeId === "bypassPermissions")
          ? "yolo"
          : rawModeId === "plan"
            ? "plan"
            : "agent";
        const prevMode = this.currentModeId;
        this.currentModeId = modeId;
        if (prevMode !== modeId && this.agyProc) {
          this.requestRespawn();
        }
        this.sendResponse(id, {
          modes: {
            currentModeId: this.currentModeId,
          },
        });
        break;
      }

      case "session/prompt": {
        const promptBlocks = Array.isArray(params?.prompt) ? params.prompt : [];
        const promptText = this.processPromptBlocks(promptBlocks, params?.text);

        if (this.sessionId) {
          const cleanTitle = cleanPromptTitle(promptText);
          const store = this.readConversationStore();
          const existing = store[this.sessionId];
          if (existing) {
            if (!existing.title || existing.title === "Antigravity Session") {
              existing.title = cleanTitle;
            }
            existing.updatedAt = Date.now();
            if (this.cwd) existing.cwd = this.cwd;
            this.writeConversationStore(store);
          } else {
            store[this.sessionId] = {
              conversationId: this.activeConversationId || "",
              cwd: this.cwd || "",
              title: cleanTitle,
              updatedAt: Date.now(),
            };
            this.writeConversationStore(store);
          }
        }

        if (this.pendingPrompt) {
          // Overwriting it would strand the first request id with no reply ever.
          this.sendError(id, -32603, "A turn is already running in this session");
          break;
        }
        try {
          await this.executePrompt(id, promptText);
        } catch {
          // executePrompt already answered this id — a second error response
          // for one request is a protocol violation, not extra safety.
        }
        break;
      }

      case "session/cancel": {
        this.pendingExitPlanId = undefined;
        this.cancelActiveTurn();
        this.sendResponse(id, {});
        break;
      }

      case "session/delete": {
        const target = typeof params?.sessionId === "string" ? params.sessionId : this.sessionId;
        if (target) this.forgetConversation(target);
        if (!target || target === this.sessionId) {
          this.cancelActiveTurn();
          this.activeConversationId = undefined;
        }
        this.sendResponse(id, {});
        break;
      }

      case "session/list": {
        const targetCwd = typeof params?.cwd === "string" && params.cwd ? params.cwd : this.cwd;
        const sessions = this.listStoredSessions(targetCwd);
        this.sendResponse(id, { sessions });
        break;
      }

      case "_x.ai/interject":
      case "x.ai/interject": {
        const text = typeof params?.text === "string" ? params.text : "";
        if (text && this.agyProc && !this.agyProc.killed) {
          try {
            const payload = JSON.stringify({
              event: "user",
              message: {
                role: "user",
                content: text,
              },
            }) + "\n";
            this.agyProc.stdin.write(payload);
          } catch {}
        }
        this.sendResponse(id, {});
        break;
      }

      default: {
        if (id != null) {
          this.sendResponse(id, {});
        }
        break;
      }
    }
  }

  /** The file's current content for diff synthesis, or undefined when it
   *  can't be read (doesn't exist yet, too big, or unreadable) — a genuine
   *  creation or a size we won't hold twice in memory. */
  private readDiskTextForDiff(rawPath: string): string | undefined {
    try {
      const abs = path.isAbsolute(rawPath) ? path.normalize(rawPath) : path.normalize(path.resolve(this.cwd, rawPath));
      const stat = fs.statSync(abs);
      if (!stat.isFile() || stat.size > MAX_DIFF_EXPAND_BYTES) return undefined;
      return fs.readFileSync(abs, "utf8");
    } catch {
      return undefined;
    }
  }

  /**
   * Poll for the file's content to actually change from `before`.
   *
   * Live evidence (agy 1.1.26): the `DONE` step notification for
   * `replace_file_content` can arrive with the write not yet applied on
   * disk — confirmed via `mtime`/content comparisons taken right at `ACTIVE`
   * and right at `DONE`. Chasing this with an ever-longer poll has a hard
   * ceiling: a separate live capture showed the write still not landed even
   * ~10s after the ENTIRE multi-turn-second reasoning turn had been reported
   * complete by agy, confirmed later by `git diff` outside this extension —
   * agy's own write can lag its own completion signal by an effectively
   * unbounded amount, not just a race to close. This poll (bounded to ~10s)
   * catches the common case; the residual — a stale "+0 −0" card until the
   * conversation is reloaded — is a known limitation (see
   * docs/ANTIGRAVITY_INTEGRATION_COMPLETE_DOCUMENTATION.md § 9.4). Reload
   * replays from `transcript.jsonl` via `synthesizeAgyToolDiff` +
   * `unwrapTranscriptStrings`, which does carry the real before/after text.
   */
  private async waitForDiskChangeText(file: string, before: string | undefined): Promise<string | undefined> {
    for (let i = 0; i < this.diskPollAttempts; i++) {
      const text = this.readDiskTextForDiff(file);
      if (text !== before) return text;
      await new Promise((resolve) => setTimeout(resolve, this.diskPollDelayMs));
    }
    return this.readDiskTextForDiff(file);
  }

  /**
   * `content` for an agy edit tool's session/update, or undefined when the
   * tool isn't an edit / carries no resolvable diff.
   *
   * When available, authoritative tool parameters are read from the active
   * conversation's persistent transcript (`transcript_full.jsonl`), avoiding
   * disk-write timing races entirely. When the transcript entry is not yet
   * present or not found, synthesis falls back to disk reads.
   *
   * ACTIVE reads disk (before the write) or uses the session baseline; DONE
   * reads disk again (after the write has landed) for the "after" side and
   * updates the session baseline cache.
   */
  private async synthesizeAgyDiffContent(
    toolCallId: string,
    name: string,
    rawParams: any,
    phase: "active" | "done" | "error",
    stepIndex?: number,
  ): Promise<unknown[] | undefined> {
    if (name !== "write_to_file" && name !== "replace_file_content" && name !== "multi_replace_file_content") {
      return undefined;
    }
    const file = rawParams?.TargetFile || rawParams?.file_path || rawParams?.path;
    if (typeof file !== "string" || !file) return undefined;
    const baselineKey = normalizeBaselineKey(file, this.cwd);
    if (phase === "active") {
      // Prefer the session-lifetime baseline over a fresh disk read: for any
      // path already touched this session, a live read here can already be
      // reading the CURRENT edit's result (see sessionFileBaseline's doc) —
      // the cached value from the previous edit's DONE is the only reliable
      // "before" left. Only a path never seen this session falls back to a
      // live read, which is still exposed to the same race.
      const before = this.sessionFileBaseline.has(baselineKey)
        ? this.sessionFileBaseline.get(baselineKey)
        : this.readDiskTextForDiff(file);
      this.pendingWriteOldText.set(toolCallId, before);
      return undefined; // nothing to diff yet — the write hasn't landed
    }
    const diskOldText = this.pendingWriteOldText.get(toolCallId);
    this.pendingWriteOldText.delete(toolCallId);
    if (phase === "error") return undefined;

    // First check if authoritative tool parameters are recorded in the active transcript on disk.
    // If transcript_full.jsonl contains the tool call, it carries exact TargetContent/ReplacementContent,
    // avoiding disk timing races entirely.
    let diffFromTranscript: AcpDiffBlock | undefined;
    const transcriptArgs = findRecentTranscriptToolCall(this.activeConversationId, this.geminiHome, name, file, this.cwd, stepIndex);
    if (transcriptArgs) {
      diffFromTranscript = synthesizeAgyToolDiff(name, transcriptArgs, { diskOldText });
    }

    const diskNewText = await this.waitForDiskChangeText(file, diskOldText);
    this.sessionFileBaseline.set(baselineKey, diskNewText);

    if (diffFromTranscript) {
      return mergeDiffIntoContent(undefined, diffFromTranscript);
    }

    if (diskOldText === undefined && diskNewText === undefined) return undefined;
    if (diskOldText === diskNewText) {
      // Live evidence: some edits don't land on disk even within
      // waitForDiskChangeText's several-second budget — the write can be
      // deferred until the whole turn finishes, not just this tool step
      // (observed: the "turn complete" line logged before this poll gave
      // up). Queue it for one more check at turn-end (flushPendingEditRechecks).
      this.pendingEditRecheck.push({ toolCallId, file, diskOldText });
    }
    return mergeDiffIntoContent(
      undefined,
      synthesizeEditDiff({ path: file, oldText: diskOldText ?? "", newText: diskNewText ?? "" }),
    );
  }

  /**
   * Re-reads disk once more for every edit whose write hadn't landed by the
   * time its own DONE-phase poll gave up, and sends a corrective
   * `tool_call_update` (same `toolCallId`) if it has landed by now. Called
   * right before a turn's `result` resolves — see `synthesizeAgyDiffContent`.
   */
  private flushPendingEditRechecks(): void {
    const pending = this.pendingEditRecheck;
    this.pendingEditRecheck = [];
    for (const { toolCallId, file, diskOldText } of pending) {
      const diskNewText = this.readDiskTextForDiff(file);
      if (diskNewText === undefined || diskNewText === diskOldText) continue;
      const baselineKey = normalizeBaselineKey(file, this.cwd);
      this.sessionFileBaseline.set(baselineKey, diskNewText);
      const diff = synthesizeEditDiff({ path: file, oldText: diskOldText ?? "", newText: diskNewText });
      if (!diff) continue;
      this.sendNotification("session/update", {
        sessionId: this.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "completed",
          content: [diff],
        },
      });
    }
  }

  private ensureAgyProc(): ChildProcessWithoutNullStreams {
    if (this.respawnBeforeNextPrompt) {
      this.respawnBeforeNextPrompt = false;
      this.killAgyProc();
    }
    if (this.agyProc && !this.agyProc.killed && this.agyProc.stdin.writable) {
      return this.agyProc;
    }

    const args = [
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--print-timeout", this.printTimeout,
    ];

    if (this.cwd) {
      args.push("--add-dir", this.cwd);
    }
    const stagingDir = path.join(this.geminiHome, "staging");
    if (fs.existsSync(stagingDir)) {
      args.push("--add-dir", stagingDir);
    }

    if (this.currentModelId) {
      args.push("--model", this.currentModelId);
    }
    // Exactly as many `--effort` flags as this model accepts: one, or none.
    // See modelRequiresEffort for what the CLI rejects.
    if (modelRequiresEffort(this.currentModelId)) {
      const chosen = this.currentEffort && this.currentEffort !== "default"
        ? this.currentEffort
        : DEFAULT_AGY_EFFORT;
      args.push("--effort", chosen);
    }
    if (this.currentModeId === "plan") {
      args.push("--mode", "plan");
    }
    // Headless stream-json over stdio pipes has no interactive TTY for terminal confirmations
    // and no ACP permission-request protocol. Without --dangerously-skip-permissions, agy defaults
    // to "request-review", causing any command (including read-only 'git status') or file edit to
    // immediately fail with: "permission check failed ... user denied permission to run command".
    // In plan mode, --mode plan already restricts agy's planning behavior, while the adapter's
    // isImplementationPlanTool() intercepts implementation_plan.md and issues an x.ai/exit_plan_mode
    // review request for user confirmation.
    args.push("--dangerously-skip-permissions");
    if (this.activeConversationId) {
      args.push("--conversation", this.activeConversationId);
    }

    const proc = this.spawnFn(this.agyPath, args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(this.agyPath),
    });

    this.agyProc = proc;
    this.agyRl = createInterface({ input: proc.stdout });
    this.agyRl.on("line", (line) => this.handleAgyLine(line));
    // Drained, not just piped: an undrained stderr deadlocks the child once the
    // pipe buffer fills, and the host logs whatever we write to ours.
    if (proc.stderr) {
      this.agyErrRl = createInterface({ input: proc.stderr });
      this.agyErrRl.on("line", (line) => {
        if (line.trim()) process.stderr.write(`[agy] ${line}
`);
      });
    }

    proc.on("exit", (code) => {
      if (this.pendingPrompt) {
        const pending = this.pendingPrompt;
        this.pendingPrompt = undefined;
        if (code !== 0) {
          pending.reject(new Error(`Antigravity CLI exited with code ${code}`));
        } else {
          pending.resolve({
            stopReason: "end_turn",
            usage: pending.usage,
          });
        }
      }
      this.agyProc = undefined;
    });

    proc.on("error", (err) => {
      if (this.pendingPrompt) {
        const pending = this.pendingPrompt;
        this.pendingPrompt = undefined;
        pending.reject(err);
      }
      this.agyProc = undefined;
    });

    return proc;
  }

  handleAgyLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let ev: any;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (ev.event === "init") {
      if (typeof ev.conversation_id === "string" && ev.conversation_id) {
        this.activeConversationId = ev.conversation_id;
        if (this.sessionId) {
          this.rememberConversation(this.sessionId, ev.conversation_id, {
            cwd: this.cwd,
            updatedAt: Date.now(),
          });
        }
      }
      return;
    }

    if (ev.event === "step_update") {
      const step = ev.step_update;
      if (!step) return;

      if (step.step_type === "agent_response" && typeof step.text_delta === "string" && step.text_delta) {
        this.sendNotification("session/update", {
          sessionId: this.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: step.text_delta,
            },
          },
        });
      }

      if (step.step_type === "tool") {
        const toolCallId = `tool-${step.step_index}`;
        const name = step.tool_name || step.tool_info?.name || "tool";
        const rawParams = step.tool_info?.parameters || {};
        const params = normalizeToolInput(name, rawParams);
        const kind = toolKind(name);
        const title = toolTitle(name, params);

        if (step.state === "ACTIVE") {
          // synthesizeAgyDiffContent is async (DONE polls disk — see there),
          // but the ACTIVE path never awaits anything itself, so this still
          // resolves before any later stdout line can be processed.
          void this.synthesizeAgyDiffContent(toolCallId, name, rawParams, "active", step.step_index).then((content) => {
            this.sendNotification("session/update", {
              sessionId: this.sessionId,
              update: {
                sessionUpdate: "tool_call",
                toolCallId,
                title,
                kind,
                status: "in_progress",
                rawInput: params,
                ...(content && content.length ? { content } : {}),
              },
            });
          });
        } else {
          const isError = step.state === "ERROR";
          const output = step.tool_info?.output ?? step.tool_info?.error?.message ?? (isError ? "Tool execution failed" : "completed");
          // For an edit tool this polls disk for the write to actually land
          // (see waitForDiskChangeText) — up to ~3s before this update is
          // sent, which can reorder it after a later tool's own updates.
          // Accepted: negligible against a multi-second turn, and the
          // alternative (no poll) was a confirmed-live "+0 -0" diff. Tracked
          // in pendingDiffPromises so the turn's "result" handler can await
          // it — the poll can still be running when "result" arrives.
          const diffPromise = this.synthesizeAgyDiffContent(toolCallId, name, rawParams, isError ? "error" : "done", step.step_index).then((content) => {
            this.sendNotification("session/update", {
              sessionId: this.sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId,
              title,
              kind,
              status: isError ? "failed" : "completed",
              rawInput: params,
              rawOutput: typeof output === "string" ? { output } : output,
              ...(content && content.length ? { content } : {}),
            },
          });

          if (!isError && isImplementationPlanTool(name, rawParams)) {
            const planText = extractPlanText(rawParams, this.cwd);
            if (planText) {
              this.sendNotification("session/update", {
                sessionId: this.sessionId,
                update: {
                  sessionUpdate: "plan",
                  plan: planText,
                },
              });
            }
            if (this.currentModeId === "plan" || rawParams?.ArtifactMetadata?.RequestFeedback === true) {
              const planReqId = randomUUID();
              this.pendingExitPlanId = planReqId;
              this.writeJsonRpc({
                jsonrpc: "2.0",
                id: planReqId,
                method: "x.ai/exit_plan_mode",
                params: {
                  sessionId: this.sessionId,
                  planContent: planText,
                },
              });
            }
          }
          });
          this.pendingDiffPromises.push(diffPromise);
        }
      }

      if (step.usage && this.pendingPrompt) {
        const u = step.usage;
        this.pendingPrompt.usage.inputTokens = u.input_tokens ?? this.pendingPrompt.usage.inputTokens;
        this.pendingPrompt.usage.outputTokens = u.output_tokens ?? this.pendingPrompt.usage.outputTokens;
        this.pendingPrompt.usage.thoughtTokens = u.thinking_tokens ?? this.pendingPrompt.usage.thoughtTokens;
        this.pendingPrompt.usage.totalTokens = u.total_tokens ?? this.pendingPrompt.usage.totalTokens;
      }
      return;
    }

    if (ev.event === "result") {
      const res = ev.result;
      if (this.pendingPrompt) {
        const pending = this.pendingPrompt;
        this.pendingPrompt = undefined;
        void (async () => {
          // Wait for every in-flight edit diff (each up to ~3s of disk
          // polling — see pendingDiffPromises) to settle before the turn-end
          // recheck: live evidence showed "result" arriving WHILE a DONE-phase
          // poll was still running, which left flushPendingEditRechecks with
          // nothing queued yet (the entry is only pushed once the poll gives
          // up). This delays turn completion by however long the slowest
          // still-running poll needs — negligible next to the turn itself.
          const diffPromises = this.pendingDiffPromises;
          this.pendingDiffPromises = [];
          await Promise.allSettled(diffPromises);
          this.flushPendingEditRechecks();

          if (res?.usage) {
            pending.usage.inputTokens = res.usage.input_tokens ?? pending.usage.inputTokens;
            pending.usage.outputTokens = res.usage.output_tokens ?? pending.usage.outputTokens;
            pending.usage.thoughtTokens = res.usage.thinking_tokens ?? pending.usage.thoughtTokens;
            pending.usage.totalTokens = res.usage.total_tokens ?? pending.usage.totalTokens;
          }

          if (res?.status === "ERROR") {
            pending.reject(new Error(res.error || "Antigravity reported an error"));
          } else {
            const u = pending.usage;
            // One line per turn, so a quota question has an answer that is not a
            // guess. Only when the CLI actually reported usage — a zero line says
            // nothing and would bury the ones that do.
            if (u.totalTokens > 0) {
              process.stderr.write(
                `[agy] turn complete in=${u.inputTokens} out=${u.outputTokens} thinking=${u.thoughtTokens} total=${u.totalTokens}
`,
              );
            }
            pending.resolve({
              stopReason: "end_turn",
              usage: pending.usage,
            });
          }
        })();
      }
    }
  }

  private executePrompt(id: number | string, promptText: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = this.ensureAgyProc();
      this.pendingPrompt = {
        id,
        resolve: (val) => {
          this.sendResponse(id, val);
          resolve();
        },
        reject: (err) => {
          this.sendError(id, -32603, (err as Error).message || "Prompt error");
          reject(err);
        },
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          thoughtTokens: 0,
          totalTokens: 0,
        },
      };

      const payload = JSON.stringify({
        event: "user",
        message: {
          role: "user",
          content: promptText,
        },
      }) + "\n";

      proc.stdin.write(payload, (err) => {
        if (err) {
          this.pendingPrompt = undefined;
          this.sendError(id, -32603, `Failed to write prompt to Antigravity stdin: ${err.message}`);
          reject(err);
        }
      });
    });
  }
}

// When invoked directly as a standalone Node script
if (require.main === module) {
  const server = new AgyAcpAdapterServer();
  server.start();

  process.on("SIGINT", () => {
    server.dispose();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    server.dispose();
    process.exit(0);
  });
}
