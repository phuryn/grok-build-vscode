import { randomUUID, createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { AcpClient } from "./acp";
import { AgyBackend, agyAcpDir, agySessionPathKey } from "./agy-backend";
import type { SubscriptionWindow } from "./subscription-usage";

export function agyMeterDirectory(profile: string): string {
  return path.join(profile, "afk-pilot-meter");
}

/** Memory-only identity for the managed sign-in. A refreshed access token leaves it unchanged. */
export function agyUsageCredentialContext(profile: string, methodId: string | undefined): string | undefined {
  if (methodId !== undefined && methodId !== "oauth-personal") return;
  try {
    const file = path.join(profile, "acp_token.json");
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 16_384) return;
    const { client_id, refresh_token, project_id } = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof refresh_token !== "string" || !refresh_token) return;
    return `agy:${createHash("sha256").update(JSON.stringify([profile, client_id, refresh_token, project_id])).digest("hex")}`;
  } catch { return undefined; }
}

const QUOTA_GROUPS: Readonly<Record<string, string>> = {
  "gemini models": "Gemini",
  "claude and gpt models": "Claude & GPT",
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function quotaReset(date: string): string | undefined {
  const match = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4}), (\d{2}):(\d{2}) UTC$/.exec(date);
  if (!match) return;
  const [, month, day, year, hour, minute] = match;
  const monthIndex = MONTHS.indexOf(month);
  if (monthIndex < 0 || +year < 100 || +hour > 23 || +minute > 59) return;
  const reset = new Date(Date.UTC(+year, monthIndex, +day, +hour, +minute));
  if (reset.getUTCMonth() === monthIndex) return reset.toISOString();
}

/** Parse only recognized quota sections and complete, valid window lines. */
export function agySubscriptionWindows(text: string, now = Date.now()): SubscriptionWindow[] {
  const result = new Map<string, SubscriptionWindow>();
  const observedAt = new Date(now).toISOString();
  let inQuota = false;
  let family: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#{1,6}\s/.test(line)) {
      inQuota = /^\s*#{1,6}\s+Quota Limits\s*$/i.test(line);
      family = undefined;
    } else if (inQuota && /^[-*]\s/.test(line)) {
      const heading = /^[-*]\s+\*\*(.+?)\*\*\s*$/.exec(line)?.[1];
      family = heading && Object.hasOwn(QUOTA_GROUPS, heading.toLowerCase()) ? QUOTA_GROUPS[heading.toLowerCase()] : undefined;
    } else if (inQuota && family) {
      const match = /^\s+[-*]\s+\*\*(Weekly|Five Hour) Limit Remaining:\*\*\s+(\d+(?:\.\d+)?)% remaining \(resets ([^)]+)\)\s*$/i.exec(line);
      if (!match || +match[2] > 100) continue;
      const periodEnd = quotaReset(match[3]);
      if (!periodEnd) continue;
      const weekly = match[1].toLowerCase() === "weekly";
      const periodType = `${family === "Gemini" ? "gemini" : "claude-gpt"}_${weekly ? "weekly" : "5h"}`;
      result.set(periodType, { periodType, label: `${family} · ${weekly ? "Weekly" : "5-hour"}`,
        usedPercent: 100 - +match[2], periodEnd, observedAt });
    }
  }
  return [...result.values()];
}

/**
 * The quota the model in use draws on. Antigravity meters Gemini models in one
 * pool and its Claude and GPT-OSS models in another, so a Gemini conversation
 * showing the second pool reads as another product's subscription. An id that
 * names neither family (or no model yet) keeps every window.
 */
export function agyWindowsForModel(windows: readonly SubscriptionWindow[], modelId: string | undefined): SubscriptionWindow[] {
  const group = !modelId ? undefined : /^gemini-/.test(modelId) ? "gemini" : /^(?:claude|gpt)-/.test(modelId) ? "claude-gpt" : undefined;
  return group ? windows.filter((window) => window.periodType.startsWith(`${group}_`)) : [...windows];
}

function usableId(id: unknown): id is string {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
}

function missing(file: string): boolean {
  try { fs.statSync(file); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
}

export class AgyUsageMeter {
  private readonly profile: string;
  private readonly cwd: string;
  private readonly conversations: string;
  private client?: AcpClient;
  private clientIdentity?: string;
  private idle?: ReturnType<typeof setTimeout>;
  private reading?: Promise<SubscriptionWindow[]>;

  constructor(
    private readonly binary: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly signal?: AbortSignal,
    private readonly settleMs = 1_500,
  ) {
    this.profile = path.resolve(agyAcpDir(env));
    this.cwd = agyMeterDirectory(this.profile);
    this.conversations = path.join(this.profile, "conversations");
  }

  credentialContext(methodId?: string): string | undefined {
    return agyUsageCredentialContext(this.profile, methodId);
  }

  read(methodId?: string): Promise<SubscriptionWindow[]> {
    const identity = this.credentialContext(methodId);
    if (!identity || this.signal?.aborted) return Promise.resolve([]);
    return this.reading ??= this.refresh(identity).catch(async () => {
      await this.dispose();
      return [];
    }).finally(() => { this.reading = undefined; });
  }

  async dispose(): Promise<void> {
    clearTimeout(this.idle);
    const client = this.client;
    this.client = undefined;
    this.clientIdentity = undefined;
    await client?.dispose();
  }

  private async connection(identity: string): Promise<AcpClient> {
    if (this.client && this.clientIdentity === identity) return this.client;
    await this.dispose();
    this.signal?.throwIfAborted();
    const client = new AcpClient({
      cliPath: this.binary, cwd: this.cwd, env: { ...this.env, GEMINI_HOME: path.dirname(this.profile) }, signal: this.signal,
      backend: new AgyBackend(),
      refuseServerRequests: true, log: () => {},
      timeouts: { requestTimeoutMs: 30_000, promptIdleTimeoutMs: 10_000, promptAbsoluteTimeoutMs: 15_000 },
    });
    this.client = client;
    this.clientIdentity = identity;
    client.once("exit", () => { if (this.client === client) void this.dispose(); });
    await client.start();
    if (this.credentialContext() !== identity) throw new Error("Meter sign-in changed");
    await client.authenticate("oauth-personal", 30_000);
    return client;
  }

  private remembered(file: string): string | undefined {
    if (missing(file)) return;
    const { sessionId } = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!usableId(sessionId)) throw new Error("Invalid meter session id");
    return sessionId;
  }

  private remember(file: string, sessionId: string): void {
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ sessionId }), { flag: "wx", flush: true });
      fs.renameSync(tmp, file);
    } finally { fs.rmSync(tmp, { force: true }); }
  }

  private ownsSession(id: string): boolean {
    const { cwd } = JSON.parse(fs.readFileSync(path.join(this.conversations, `${id}.meta`), "utf8"));
    return typeof cwd === "string" && agySessionPathKey(cwd, process.platform) === agySessionPathKey(this.cwd, process.platform);
  }

  /** A create with a lost reply is recovered by its dedicated cwd. */
  private recoverSession(): string | undefined {
    if (missing(this.conversations)) return;
    const matches = fs.readdirSync(this.conversations).flatMap(name => {
      const id = name.endsWith(".meta") ? name.slice(0, -5) : undefined;
      if (!usableId(id) || missing(path.join(this.conversations, `${id}.db`))) return [];
      try {
        if (this.ownsSession(id)) return [id];
      } catch { /* a missing or unreadable sidecar cannot identify this conversation */ }
      return [];
    });
    if (matches.length > 1) throw new Error("Multiple meter conversations share the meter directory");
    return matches[0];
  }

  private async refresh(identity: string): Promise<SubscriptionWindow[]> {
    clearTimeout(this.idle);
    fs.mkdirSync(this.cwd, { recursive: true });
    const file = path.join(this.cwd, "session.json");
    const remembered = this.remembered(file);
    let id = remembered;
    const existing = id && !missing(path.join(this.conversations, `${id}.db`));
    const client = await this.connection(identity);
    if (this.credentialContext() !== identity) return [];
    try {
      if (existing && id) {
        if (!this.ownsSession(id)) return [];
        await client.loadSession(id, undefined, true);
      } else {
        // Each generation can create only once, even across host processes.
        // An unresolved create keeps its claim until the vendor's disk row appears.
        id = this.recoverSession();
        if (id) {
          await client.loadSession(id, undefined, true);
        } else {
          const claim = path.join(this.cwd, `create-${remembered ?? "first"}`);
          try { fs.writeFileSync(claim, "", { flag: "wx", flush: true }); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return []; throw error; }
          // A concurrent recovery may have published the next generation.
          if (this.remembered(file) !== remembered) return [];
          ({ sessionId: id } = await client.newSession());
          if (!usableId(id)) throw new Error("Invalid meter session id");
        }
      }
      let text = "";
      const collect = (chunk: string) => { if (text.length + chunk.length <= 65_536) text += chunk; };
      client.on("messageChunk", collect);
      try {
        await client.prompt("/usage");
        // 1.5.2 was measured with this collection interval after the response.
        await new Promise<void>(resolve => setTimeout(resolve, this.settleMs));
      } finally { client.off("messageChunk", collect); }
      if (id !== remembered && !missing(path.join(this.conversations, `${id}.db`))) this.remember(file, id);
      return this.credentialContext() === identity ? agySubscriptionWindows(text) : [];
    } finally {
      if (this.client === client && !this.signal?.aborted) {
        this.idle = setTimeout(() => void this.dispose(), 5 * 60_000);
        this.idle.unref();
      }
    }
  }
}
