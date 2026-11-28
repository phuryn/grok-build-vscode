// Keep-awake — hold an OS wake lock while work needs the machine awake: an AFK
// Pilot link (so an idle laptop doesn't drop the uplink mid-remote-turn) OR a
// local agent turn in flight (desktop / VS Code without a remote link). The
// opt-out key remains `grok.remote.keepAwake` (ships today); it now covers both
// triggers. Not "app is open" — a standing wake lock drains laptops.
//
// There is no cross-platform Node API for this and we don't want a native
// dependency, so each platform gets the wake lock its OS already ships:
//   macOS  `caffeinate -i -s`  (built in since 10.8 — the IOPMAssertion behind
//                               Electron's powerSaveBlocker; NOT the third-party
//                               "Caffeine" app, nothing to install)
//   Windows PowerShell + SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED)
//   Linux  `systemd-inhibit --what=idle:sleep --mode=block`
//
// Each child also watches OUR pid and exits when the extension host dies, so a
// missed kill can't strand a wake lock on the user's machine.
//
// EVERY failure here is silent by design: a wake lock we couldn't take is a
// missing convenience, never a reason to interrupt the user. Nothing in this
// module throws to its caller, shows a notification, or retries in a loop — the
// worst case is one line in the Grok output channel and a machine that sleeps
// the way it did before the feature existed.
//
// The plan builders are pure; only KeepAwake spawns.

import { ChildProcess, spawn } from "node:child_process";

/** Shown in `systemd-inhibit --list` so a user can see who holds the lock. */
export const KEEP_AWAKE_WHO = "AFK Pilot";
export const KEEP_AWAKE_WHY = "Agent turn or AFK Pilot link — staying awake";

/** How often each child re-checks that the extension host is still alive. */
export const KEEP_AWAKE_WATCH_SECONDS = 30;

/** logind inhibitor classes we ask for, best first. `sleep` blocks an explicit
 *  suspend request and needs polkit's inhibit-block-sleep (normal for an active
 *  local session); `idle` alone only stops the idle timer but never fails. */
export type LinuxInhibitWhat = "idle:sleep" | "idle";

export interface KeepAwakePlan {
  file: string;
  args: string[];
}

export interface KeepAwakeOptions {
  /** Extension-host pid — the child exits when this process is gone. */
  pid: number;
  /** os.release(), used only to detect WSL. */
  release?: string;
  what?: LinuxInhibitWhat;
}

/** WSL's kernel release carries a Microsoft tag. A Linux wake lock inside WSL is
 *  meaningless — the Windows host decides when the box sleeps — and systemd
 *  often isn't even running, so we no-op with a log line instead of spawning a
 *  process that fails every time. */
export function isWslRelease(release: string | undefined): boolean {
  return !!release && /microsoft/i.test(release);
}

/** ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x00000001), as the decimal
 *  a PowerShell `[uint32]` cast accepts — the hex literal parses as a negative
 *  Int32 and the P/Invoke signature rejects it. */
export const ES_CONTINUOUS_SYSTEM_REQUIRED = 2147483649;

/** The PowerShell held by the Windows wake lock. SetThreadExecutionState is a
 *  per-THREAD flag, so the script must keep sitting on its own main thread —
 *  hence the sleep loop rather than a one-shot call. Deliberately does NOT ask
 *  for ES_DISPLAY_REQUIRED: you're away, the screen should still go dark. */
export function windowsKeepAwakeScript(pid: number, watchSeconds = KEEP_AWAKE_WATCH_SECONDS): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -Namespace GrokKeepAwake -Name Native -MemberDefinition '[DllImport(\"kernel32.dll\", SetLastError = true)] public static extern uint SetThreadExecutionState(uint esFlags);'",
    `if ([GrokKeepAwake.Native]::SetThreadExecutionState([uint32]${ES_CONTINUOUS_SYSTEM_REQUIRED}) -eq 0) { exit 1 }`,
    `while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds ${watchSeconds} }`,
  ].join("\n");
}

/** -EncodedCommand (UTF-16LE base64) rather than -Command: the script embeds
 *  quotes and brackets, and encoding sidesteps every layer of shell quoting. */
export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** How to hold the wake lock on this platform, or null when we can't (WSL, or
 *  an OS we have no lock for — the caller logs and carries on unprotected). */
export function buildKeepAwakePlan(platform: NodeJS.Platform, opts: KeepAwakeOptions): KeepAwakePlan | null {
  const watch = KEEP_AWAKE_WATCH_SECONDS;
  switch (platform) {
    case "darwin":
      // -i: no idle sleep. -s: no system sleep on AC. -w: die with the host.
      // No -d — the display is free to sleep.
      return { file: "caffeinate", args: ["-i", "-s", "-w", String(opts.pid)] };
    case "win32":
      return {
        file: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          encodePowerShellCommand(windowsKeepAwakeScript(opts.pid, watch)),
        ],
      };
    case "linux": {
      if (isWslRelease(opts.release)) return null;
      return {
        file: "systemd-inhibit",
        args: [
          `--what=${opts.what ?? "idle:sleep"}`,
          `--who=${KEEP_AWAKE_WHO}`,
          `--why=${KEEP_AWAKE_WHY}`,
          "--mode=block",
          "--",
          "sh",
          "-c",
          `while kill -0 ${opts.pid} 2>/dev/null; do sleep ${watch}; done`,
        ],
      };
    }
    default:
      return null;
  }
}

/** A logind `block` on `sleep` can be refused by polkit; `idle` alone is always
 *  permitted and still stops the idle-suspend timer, which is the case that
 *  actually bites an AFK box. Returns null when there's nothing left to try. */
export function keepAwakeFallbackWhat(platform: NodeJS.Platform, what: LinuxInhibitWhat | undefined): LinuxInhibitWhat | null {
  if (platform !== "linux") return null;
  return (what ?? "idle:sleep") === "idle:sleep" ? "idle" : null;
}

/**
 * Wake-lock policy: setting on AND (AFK Pilot linked OR a turn is in flight).
 * Pure so the call sites can't disagree. Deliberately not "app is open".
 */
export function shouldKeepAwake(state: {
  enabled: boolean;
  linked: boolean;
  /** Any pooled session is `working` or `needs-you`. */
  turnInFlight?: boolean;
  /** A hosted cloud machine. An OS wake lock cannot stop the hypervisor
   *  pausing the whole VM — the uplink's `working` heartbeat is what does
   *  that job there — and systemd-inhibit only fails and logs on every
   *  wake. Sleeping between sessions is that machine's cost model, not a
   *  problem to fight. */
  cloudHost?: boolean;
}): boolean {
  if (state.cloudHost) return false;
  return state.enabled && (state.linked || !!state.turnInFlight);
}

/**
 * Owns at most one wake-lock child. `start`/`stop` are idempotent, so callers
 * can just re-assert the desired state after any lifecycle event.
 */
export class KeepAwake {
  private proc?: ChildProcess;
  private what: LinuxInhibitWhat | undefined;
  /** Set once the platform has told us it can't do this, so a repeated
   *  start() doesn't re-log the same line on every config change. */
  private unsupportedLogged = false;

  constructor(
    private readonly log: (line: string) => void,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly pid: number = process.pid,
    private readonly release?: string,
  ) {}

  get active(): boolean {
    return !!this.proc;
  }

  start(): void {
    if (this.proc) return;
    this.what = undefined;
    this.spawnPlan();
  }

  stop(): void {
    const proc = this.proc;
    this.proc = undefined;
    if (!proc?.pid) return;
    try {
      if (this.platform === "win32") {
        // The PowerShell child is spawned under no shell, but taskkill /T also
        // reaps anything it started — and never leaves the lock held.
        spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      } else {
        // Negative pid: the whole detached group, so systemd-inhibit's `sh`
        // child goes with it instead of orphaning and holding the inhibitor.
        process.kill(-proc.pid, "SIGTERM");
      }
    } catch {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
    this.log("[keep-awake] released");
  }

  private spawnPlan(): void {
    const plan = buildKeepAwakePlan(this.platform, { pid: this.pid, release: this.release, what: this.what });
    if (!plan) {
      if (!this.unsupportedLogged) {
        this.unsupportedLogged = true;
        this.log(
          isWslRelease(this.release)
            ? "[keep-awake] skipped — under WSL the Windows host controls sleep (set it there, e.g. powercfg)"
            : `[keep-awake] no wake lock available on ${this.platform}`,
        );
      }
      return;
    }
    let proc: ChildProcess;
    try {
      proc = spawn(plan.file, plan.args, {
        stdio: "ignore",
        windowsHide: true,
        // POSIX: own process group so stop() can take the child's children too.
        detached: this.platform !== "win32",
      });
    } catch (e) {
      this.log(`[keep-awake] ${plan.file} failed to start: ${(e as Error)?.message ?? e}`);
      return;
    }
    this.proc = proc;
    // Don't hold the extension host open on this child's account.
    proc.unref();
    proc.on("error", (e) => {
      if (this.proc !== proc) return;
      this.proc = undefined;
      this.log(`[keep-awake] ${plan.file} unavailable: ${(e as Error)?.message ?? e}`);
    });
    proc.on("exit", (code) => {
      if (this.proc !== proc) return; // a stop()/restart already replaced it
      this.proc = undefined;
      if (code === 0) return; // the host-pid watcher ran out — nothing to say
      const next = keepAwakeFallbackWhat(this.platform, this.what);
      if (next) {
        this.log(`[keep-awake] systemd-inhibit --what=${this.what ?? "idle:sleep"} refused (exit ${code}); retrying with --what=${next}`);
        this.what = next;
        this.spawnPlan();
        return;
      }
      this.log(`[keep-awake] ${plan.file} exited with ${code} — the system may still sleep while you're away`);
    });
    this.log(`[keep-awake] holding a wake lock via ${plan.file}`);
  }
}
