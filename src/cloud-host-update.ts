import type { HostMsg } from "./protocol";
import { promises as fs, readFileSync } from "node:fs";
import * as path from "node:path";

// Restart-safe BOOT function defined in grok-remote/src/pool-bootstrap.ts.
export const CLOUD_UPDATE_BOOT_MARKER = "cleanup_display";
export function cloudHostBootSupportsUpdate(home: string): boolean {
  try { return readFileSync(path.join(home, "afkpilot-boot.sh"), "utf8").includes(CLOUD_UPDATE_BOOT_MARKER); }
  catch { return false; }
}

export const CLOUD_WORKFLOW_SILENCE_MS = 30 * 60_000;
export const CLOUD_AGENT_QUIET_MS = 90_000;

/** Latest frame wins per run and per session; a lost completion cannot block forever. */
export function cloudLiveWorkflowRuns(sessions: Iterable<{ buffer: readonly HostMsg[] }>,
  receivedAt: WeakMap<object, number>, now: number): number {
  let count = 0;
  for (const session of sessions) {
    const latest = new Map<string, Extract<HostMsg, { type: "runProgress" }>>();
    for (const message of session.buffer) {
      if (message.type === "runProgress" && message.update.kind === "workflow") latest.set(message.update.id, message);
    }
    for (const message of latest.values()) {
      const at = receivedAt.get(message);
      if (!message.update.done && at !== undefined && now - at < CLOUD_WORKFLOW_SILENCE_MS) count++;
    }
  }
  return count;
}

/** BOOT rechecks the host and reinstalls agent CLIs after this handoff. */
export async function removeCloudHostUpdateStamps(home: string): Promise<void> {
  for (const stamp of [path.join(home, "afkpilot", ".afkpilot-host-checked"),
    path.join(home, ".afkpilot-agents-updated")]) {
    try { await fs.unlink(stamp); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export type CloudHostUpdateState = Extract<HostMsg, { type: "cloudHostUpdateState" }>;
const HOUR = 3_600_000;
const CLIENT_THROTTLE = 300_000;
export const CLOUD_UPDATE_REFUSAL = "The cloud host is updating. Please wait for it to reconnect.";

export interface CloudHostUpdateAttempt { target: string; at: number }

export function parseCloudHostUpdateAttempt(record: string): CloudHostUpdateAttempt | null {
  try {
    const value = JSON.parse(record);
    return version(value?.target) && Number.isSafeInteger(value.at) && value.at >= 0
      ? { target: value.target, at: value.at } : null;
  } catch { return null; }
}

function version(value: unknown): string | null {
  return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value)
    && value.split(".").every((n) => Number.isSafeInteger(Number(n))) ? value : null;
}

export function installedCloudHostVersion(record: string | null | undefined): string | null {
  const match = record?.trim().match(/(?:^|\/)Grok-Build-Desktop-(\d+\.\d+\.\d+)-linux-x86_64\.AppImage$/);
  return version(match?.[1]);
}

export function compareCloudVersions(a: string, b: string): number {
  const left = a.split(".").map(Number), right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

export function cloudUpdateMandatory(installed: string | null, latest: string | null, floor: unknown): boolean {
  const validFloor = version(floor);
  return !!(installed && latest && validFloor
    && compareCloudVersions(installed, validFloor) < 0
    && compareCloudVersions(validFloor, latest) <= 0);
}

export interface CloudUpdateSession {
  turnToken?: object;
  pendingPermissions: { size: number };
  pendingQuestions: { size: number };
  pendingExitPlans: { size: number };
  priming: boolean;
  queuedSends: readonly unknown[];
}

/** No human-wait expiry: every session, including background sessions, must settle. */
export function cloudHostIsIdle(sessions: Iterable<CloudUpdateSession>, commandRunning: boolean,
  signingIn: boolean, admittedWork = 0, liveWorkflowRuns = 0,
  lastAgentActivity = -Infinity, now = 0): boolean {
  if (commandRunning || signingIn || admittedWork > 0 || liveWorkflowRuns > 0
    || now - lastAgentActivity < CLOUD_AGENT_QUIET_MS) return false;
  for (const s of sessions) {
    if (s.turnToken || s.priming || s.pendingPermissions.size || s.pendingQuestions.size
      || s.pendingExitPlans.size || s.queuedSends.length) return false;
  }
  return true;
}

interface Options {
  installed: string | null;
  attempt?: CloudHostUpdateAttempt | null;
  /** Small synchronous record: persist before exit; null clears a completed attempt. */
  saveAttempt: (attempt: CloudHostUpdateAttempt | null) => void;
  check: () => Promise<unknown>;
  idle: () => boolean;
  publish: (state: CloudHostUpdateState) => void | Promise<void>;
  maintenance: () => Promise<void>;
  removeStamp: () => Promise<void>;
  exit: () => void;
  now?: () => number;
  random?: () => number;
}

/** Metadata and BOOT handoff only. This never starts, probes or installs an agent. */
export class CloudHostUpdate {
  private readonly now: () => number;
  private timer?: ReturnType<typeof setInterval>;
  private startup?: ReturnType<typeof setTimeout>;
  private lastTick: number;
  private nextCheck: number;
  private lastClientCheck = -Infinity;
  private retryAfter = 0;
  private failures = 0;
  private checking = false;
  private disposed = false;
  private connectedOnce = false;
  private applying = false;
  private state: CloudHostUpdateState;
  private attempt: CloudHostUpdateAttempt | null;

  constructor(private readonly opts: Options) {
    this.now = opts.now ?? Date.now;
    this.lastTick = this.now();
    const jitter = Math.floor((opts.random ?? Math.random)() * 60_000);
    this.nextCheck = this.now() + jitter;
    this.state = { type: "cloudHostUpdateState", installed: opts.installed, latest: null, state: "current" };
    this.attempt = opts.attempt ?? null;
    if (this.attempt && opts.installed && compareCloudVersions(opts.installed, this.attempt.target) >= 0) {
      this.attempt = null;
      try { opts.saveAttempt(null); }
      catch { /* A completed record is inert; the next startup can retry removing it. */ }
    }
    if (this.automaticRetryHeld()) {
      this.state = { ...this.state, latest: this.attempt!.target, state: "failed", error: this.attemptFailureText() };
    }
    this.startup = setTimeout(() => void this.check(), jitter);
    this.startup.unref?.();
    this.timer = setInterval(() => this.tick(), 1_000);
    this.timer.unref?.();
  }

  get snapshot(): CloudHostUpdateState { return { ...this.state }; }
  get admitting(): boolean { return !this.applying; }

  private automaticRetryHeld(): boolean {
    return !!(this.attempt && this.state.installed
      && compareCloudVersions(this.state.installed, this.attempt.target) < 0
      && this.now() < this.attempt.at + HOUR);
  }

  private attemptFailureText(mandatory = false): string {
    return `The update to ${this.attempt!.target} did not finish installing. `
      + (mandatory ? "It will retry automatically in about an hour — or press Update now."
        : "Press Update now to try again.");
  }

  connected(): void {
    if (this.connectedOnce) void this.check();
    this.connectedOnce = true;
  }

  clientReady(): void {
    if (this.now() - this.lastClientCheck < CLIENT_THROTTLE) return;
    this.lastClientCheck = this.now();
    void this.check();
  }

  private tick(): void {
    const now = this.now();
    const woke = now - this.lastTick > 30_000;
    this.lastTick = now;
    if (woke || now >= this.nextCheck) void this.check();
    this.considerApply();
  }

  async check(): Promise<void> {
    if (this.disposed || this.applying || this.checking || this.now() < this.retryAfter) return;
    this.checking = true;
    // An earlier client-ready consumes the startup check too.
    if (this.startup) clearTimeout(this.startup);
    try {
      const raw = await this.opts.check() as { latest?: unknown; mandatoryBelow?: unknown } | null;
      const latest = version(raw?.latest);
      if (!latest) throw new Error("The latest cloud host version could not be checked.");
      if (this.disposed || this.applying) return;
      const available = !!this.state.installed && compareCloudVersions(this.state.installed, latest) < 0;
      const mandatory = cloudUpdateMandatory(this.state.installed, latest, raw?.mandatoryBelow);
      // A manual request remains queued even if another metadata check lands.
      const held = this.automaticRetryHeld() && this.state.state !== "queued";
      this.state = { type: "cloudHostUpdateState", installed: this.state.installed, latest,
        state: available ? (held ? "failed" : mandatory || this.state.state === "queued" ? "queued" : "available") : "current",
        ...(available && held ? { error: this.attemptFailureText(mandatory) } : {}),
        ...(mandatory ? { mandatory: true } : {}) };
      this.failures = 0;
      this.retryAfter = 0;
      this.nextCheck = this.now() + HOUR;
      await this.opts.publish(this.snapshot);
    } catch {
      if (this.disposed || this.applying) return;
      this.retryAfter = this.now() + Math.min(HOUR, 60_000 * 2 ** Math.min(this.failures++, 6));
      this.nextCheck = this.retryAfter;
    } finally {
      this.checking = false;
    }
    this.considerApply();
  }

  request(): void {
    if (this.disposed || this.applying || !this.state.installed || !this.state.latest
      || compareCloudVersions(this.state.installed, this.state.latest) >= 0
      || !["available", "failed"].includes(this.state.state)) return;
    this.state = { ...this.state, state: "queued", error: undefined };
    void Promise.resolve(this.opts.publish(this.snapshot)).catch(() => {});
    this.considerApply();
  }

  considerApply(): void {
    if (this.disposed || this.applying) return;
    if (this.state.state === "failed" && this.state.mandatory && this.attempt && !this.automaticRetryHeld()) {
      this.state = { ...this.state, state: "queued", error: undefined };
      void Promise.resolve(this.opts.publish(this.snapshot)).catch(() => {});
    }
    if (this.disposed || this.applying || this.state.state !== "queued" || !this.opts.idle()) return;
    // This latch is synchronous with the idle read, before the first await.
    this.applying = true;
    void this.apply();
  }

  private async apply(): Promise<void> {
    this.attempt = { target: this.state.latest!, at: this.now() };
    try {
      await this.opts.maintenance();
      if (this.disposed) return;
      this.state = { ...this.state, state: "updating" };
      await this.opts.publish(this.snapshot);
      if (this.disposed) return;
      this.attempt.at = this.now();
      this.opts.saveAttempt(this.attempt);
      await this.opts.removeStamp();
      if (this.disposed) return;
      this.opts.exit();
    } catch {
      this.applying = false;
      this.state = { ...this.state, state: "failed", error: "Could not restart the cloud host to update. Please try again." };
      await Promise.resolve(this.opts.publish(this.snapshot)).catch(() => {});
    }
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
    clearTimeout(this.startup);
  }
}
