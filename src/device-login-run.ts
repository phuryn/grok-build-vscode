/**
 * Running a headless CLI sign-in, behind an injectable seam.
 *
 * Separate from `device-login.ts` for the same two reasons `git-clone.ts` is
 * separate from `project-create.ts`: a unit test cannot spawn a real sign-in,
 * and sidebar.ts holds no bare process calls.
 *
 * `spawn`, not `execFile`, because the interesting moment is in the MIDDLE of
 * the run. The URL and code arrive within a second or two and the child then
 * polls for as long as fifteen minutes; a caller that waits for exit learns the
 * code only once it is useless. So this streams: it reports the prompt the
 * instant it can be parsed, and reports the outcome separately when the child
 * finishes.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { grokCliNeedsShell } from "./cli-process";
import {
  classifyDeviceLoginFailure,
  deviceLoginEnv,
  DEVICE_LOGIN_PROMPT_TIMEOUT_MS,
  DEVICE_LOGIN_TIMEOUT_MS,
  parseClaudeAuthStatus,
  parseDeviceLoginPrompt,
  type DeviceLoginFailure,
  type DeviceLoginPrompt,
} from "./device-login";

/** Injected process seam. */
export interface DeviceLoginIo {
  spawn: typeof nodeSpawn;
}

const REAL_IO: DeviceLoginIo = { spawn: nodeSpawn };

export type DeviceLoginResult =
  | { ok: true; output: string }
  | { ok: false; cancelled: true; output: string }
  | { ok: false; failure: DeviceLoginFailure; output: string };

export interface DeviceLoginCallbacks {
  /** Called at most once, as soon as a URL can be parsed. */
  onPrompt(prompt: DeviceLoginPrompt): void;
  /** Called exactly once. */
  onDone(result: DeviceLoginResult): void;
}

export interface DeviceLoginHandle {
  /** Stop the child and settle as cancelled. Safe to call twice, and safe to
   *  call after the run already finished. */
  cancel(): void;
  /** Write a paste-code to stdin and a newline. No-op when this run does not
   *  need one, after a code was already written, or after the run settled.
   *  The string is the vendor's user-facing code, not a credential. */
  submitCode(code: string): void;
}

export interface DeviceLoginRunOptions {
  /** Open stdin and accept {@link DeviceLoginHandle.submitCode}. */
  needsCode?: boolean;
  /** Use `env` as-is instead of wrapping it with {@link deviceLoginEnv}.
   *  GitHub login prepares the env itself so it can omit `CI`. */
  rawEnv?: boolean;
}

/** Enough to hold any banner a CLI prints before the URL. */
const HEAD_LIMIT = 32 * 1024;
/** Enough to hold the error a CLI prints before giving up. Tail-biased: the
 *  useful part of a failure is the last thing said, not the first. */
const TAIL_LIMIT = 128 * 1024;

/** After asking politely, insist. A CLI polling an HTTPS endpoint can sit in a
 *  socket read that a term signal does not interrupt promptly. */
const KILL_GRACE_MS = 2_000;

const idleHandle = (): DeviceLoginHandle => ({ cancel: () => {}, submitCode: () => {} });

export function runDeviceLogin(
  cliPath: string,
  args: readonly string[],
  callbacks: DeviceLoginCallbacks,
  io?: DeviceLoginIo,
  env?: NodeJS.ProcessEnv,
  opts: DeviceLoginRunOptions = {},
): DeviceLoginHandle {
  const spawnIo = io ?? REAL_IO;
  const runEnv = env ?? process.env;
  const needsCode = !!opts.needsCode;
  let head = "";
  let tail = "";
  let sawPrompt = false;
  let settled = false;
  let cancelled = false;
  let submitted = false;
  let promptTimer: ReturnType<typeof setTimeout> | undefined;
  let runTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  const clearTimers = () => {
    if (promptTimer) clearTimeout(promptTimer);
    if (runTimer) clearTimeout(runTimer);
    if (killTimer) clearTimeout(killTimer);
    promptTimer = undefined;
    runTimer = undefined;
    killTimer = undefined;
  };

  const settle = (result: DeviceLoginResult) => {
    if (settled) return;
    settled = true;
    clearTimers();
    callbacks.onDone(result);
  };

  let child: ReturnType<typeof nodeSpawn>;
  try {
    const shell = grokCliNeedsShell(cliPath);
    // Node joins shell:true commands without quoting the executable.
    child = spawnIo.spawn(shell ? `"${cliPath}"` : cliPath, [...args], {
      // Device-code flows (Grok, Codex) must not wait on input: a child holding
      // an open stdin it will never read from looks identical to a child that
      // is working. Paste-code (Claude `auth login`) is the other shape — the
      // person brings a code back and we write it to stdin. Only that plan
      // opens the pipe.
      stdio: [needsCode ? "pipe" : "ignore", "pipe", "pipe"],
      env: opts.rawEnv ? runEnv : deviceLoginEnv(runEnv, { needsCode }),
      shell,
      windowsHide: true,
    });
  } catch (error) {
    settle({ ok: false, failure: "failed", output: String((error as Error)?.message ?? error) });
    return idleHandle();
  }

  const stop = () => {
    try { child.kill(); } catch { /* already gone */ }
    killTimer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, KILL_GRACE_MS);
    // Never hold the host's event loop open for a child nobody is waiting on.
    killTimer.unref?.();
  };

  const absorb = (chunk: unknown) => {
    const text = String(chunk);
    if (!sawPrompt && head.length < HEAD_LIMIT) head += text;
    tail = (tail + text).slice(-TAIL_LIMIT);
    if (sawPrompt) return;
    const parsed = parseDeviceLoginPrompt(head);
    if (!parsed) return;
    sawPrompt = true;
    if (promptTimer) clearTimeout(promptTimer);
    promptTimer = undefined;
    // needsCode is the plan's, not the parser's. A paste-code URL can carry
    // `code=true` as a flag; that is not a chip to show, and inferring the
    // flow from a missing printed code would flip on the next CLI change.
    const prompt: DeviceLoginPrompt = needsCode
      ? { url: parsed.url, needsCode: true }
      : parsed;
    callbacks.onPrompt(prompt);
  };

  // BOTH streams. grok 1.0.5 prints the URL and the code to stderr, which is
  // the sort of thing that turns a working feature into a silent one if you
  // only wire up stdout.
  child.stdout?.on("data", absorb);
  child.stderr?.on("data", absorb);

  child.on("error", (error: Error) => {
    tail = `${tail}\n${error.message}`;
    settle({ ok: false, failure: "failed", output: tail });
  });

  child.on("close", (code: number | null) => {
    if (cancelled) {
      settle({ ok: false, cancelled: true, output: tail });
      return;
    }
    if (code === 0) {
      settle({ ok: true, output: tail });
      return;
    }
    settle({ ok: false, failure: classifyDeviceLoginFailure(tail, sawPrompt), output: tail });
  });

  // A CLI whose sign-in wants a real terminal does not fail — it waits, with
  // nothing on either stream, for a keypress that cannot arrive. Without this
  // the phone would spin for the full fifteen minutes.
  promptTimer = setTimeout(() => {
    if (sawPrompt || settled) return;
    stop();
    settle({ ok: false, failure: classifyDeviceLoginFailure(tail, false), output: tail });
  }, DEVICE_LOGIN_PROMPT_TIMEOUT_MS);
  promptTimer.unref?.();

  runTimer = setTimeout(() => {
    if (settled) return;
    stop();
    settle({ ok: false, failure: "failed", output: tail });
  }, DEVICE_LOGIN_TIMEOUT_MS);
  runTimer.unref?.();

  return {
    cancel: () => {
      if (settled) return;
      cancelled = true;
      stop();
      // Do not wait for `close`: a child that ignores the signal would leave
      // the panel spinning, and the user has already said they are done.
      settle({ ok: false, cancelled: true, output: tail });
    },
    submitCode: (code: string) => {
      if (settled || submitted || !needsCode) return;
      const text = code.trim();
      if (!text) return;
      const stdin = child.stdin;
      if (!stdin || typeof stdin.write !== "function") return;
      submitted = true;
      try { stdin.write(`${text}\n`); } catch { /* already gone */ }
    },
  };
}

/** How long `claude auth status` may sit before we treat the output as unreadable. */
const AUTH_STATUS_TIMEOUT_MS = 15_000;

/**
 * Whether Anthropic's CLI reports a usable login. `loggedIn: true` is the
 * authority; the JSON is not logged, because a future CLI might put a token
 * next to the flag.
 */
export function probeClaudeAuthStatus(
  cliPath: string,
  io?: DeviceLoginIo,
  env?: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<boolean | undefined> {
  if (signal?.aborted) return Promise.resolve(undefined);
  const spawnIo = io ?? REAL_IO;
  const runEnv = env ?? process.env;
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: boolean | undefined) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let out = "";
    let child: ReturnType<typeof nodeSpawn>;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      child = spawnIo.spawn(cliPath, ["auth", "status"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: deviceLoginEnv(runEnv),
        windowsHide: true,
        signal,
      });
    } catch {
      done(undefined);
      return;
    }
    const finish = (value: boolean | undefined) => {
      if (timer) clearTimeout(timer);
      done(value);
    };
    const absorb = (chunk: unknown) => { out += String(chunk); };
    child.stdout?.on("data", absorb);
    child.stderr?.on("data", absorb);
    child.on("error", () => finish(undefined));
    child.on("close", () => finish(parseClaudeAuthStatus(out)));
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish(parseClaudeAuthStatus(out));
    }, AUTH_STATUS_TIMEOUT_MS);
    timer.unref?.();
  });
}
