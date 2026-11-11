/**
 * Headless GitHub CLI sign-in for a remote clone form.
 *
 * The desk path still opens a terminal and runs `githubSignInCommand`. A
 * browser has no terminal to look at, and on a cloud machine that terminal
 * would open on an Xvfb screen nobody is at. `gh auth login --web` on a plain
 * pipe is the same shape as `grok login --device-auth`: it prints a URL and a
 * one-time code, polls by itself, and exits 0 when the browser approves.
 * Measured on gh 2.79.0; `parseDeviceLoginPrompt` already reads that banner.
 *
 * `gh auth login` alone is not enough — see `githubSignInCommand`. After a
 * successful login this runs `gh auth setup-git` through the same spawn seam,
 * and a failure there is a failure of the whole flow.
 *
 * Never writes a token. `gh` owns the credential; we display a URL and a short
 * code and nothing else.
 */
import { spawn as nodeSpawn } from "node:child_process";
import {
  classifyDeviceLoginFailure,
  deviceLoginEnv,
  type DeviceLoginFailure,
  type DeviceLoginPlan,
  type DeviceLoginPrompt,
} from "./device-login";
import {
  runDeviceLogin,
  type DeviceLoginHandle,
  type DeviceLoginIo,
  type DeviceLoginResult,
} from "./device-login-run";

const REAL_IO: DeviceLoginIo = { spawn: nodeSpawn };

/** Argv after the `gh` path. Flags answer every interactive prompt gh 2.79.0
 *  asked on a pipe, so the child prints the device banner and polls. */
export const GITHUB_DEVICE_LOGIN_ARGS = [
  "auth",
  "login",
  "--hostname",
  "github.com",
  "--git-protocol",
  "https",
  "--skip-ssh-key",
  "--web",
] as const;

/** Wires the credential into git. Idempotent; required after login. */
export const GITHUB_AUTH_SETUP_GIT_ARGS = ["auth", "setup-git"] as const;

export const GITHUB_CLI_BIN = "gh";

/** `setup-git` is a one-shot. Generous for a cold binary, short enough that a
 *  hung helper cannot sit for the full device-code window. */
const SETUP_GIT_TIMEOUT_MS = 20_000;

export function githubDeviceLoginPlan(): DeviceLoginPlan {
  return { args: [...GITHUB_DEVICE_LOGIN_ARGS] };
}

/**
 * Environment for the login child.
 *
 * `deviceLoginEnv` sets `CI=1` so a CLI that would wait on a keypress gives
 * up. gh 2.79.0 printed the device banner on a plain pipe *without* that
 * variable; `CI=1` is how some CLIs skip auth entirely, which would look like
 * no-prompt here. Keep the rest (no browser on the host, dumb terminal).
 */
export function githubDeviceLoginEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = deviceLoginEnv(base);
  delete env.CI;
  return env;
}

export function isGithubCliMissing(output: string): boolean {
  return /enoent|not found|not recognized|cannot find/i.test(output);
}

export type GithubDeviceLoginFailure = DeviceLoginFailure | "missing";

/** The failure, said to the person who pressed Sign in to GitHub. */
export function githubDeviceLoginFailureText(
  failure: GithubDeviceLoginFailure,
  opts: { setupGit?: boolean } = {},
): string {
  if (opts.setupGit) {
    return "Signed in to GitHub, but git was not configured to use it. Try again.";
  }
  switch (failure) {
    case "missing":
      return "The GitHub CLI (gh) is not installed.";
    case "not-permitted":
      return "That GitHub account cannot complete this sign-in.";
    case "expired":
    case "failed":
      return "GitHub sign-in did not complete. The code may have expired — try again.";
    case "unsupported":
      return "This version of the GitHub CLI has no headless sign-in. Update it, then try again.";
    case "no-prompt":
      return "The GitHub CLI did not offer a sign-in code, which usually means its sign-in needs a real terminal.";
  }
}

export type GithubDeviceLoginResult = DeviceLoginResult & { setupGit?: boolean };

export interface GithubDeviceLoginCallbacks {
  onPrompt(prompt: DeviceLoginPrompt): void;
  onDone(result: GithubDeviceLoginResult): void;
}

const idleHandle = (): DeviceLoginHandle => ({ cancel: () => {}, submitCode: () => {} });

/**
 * Login, then `gh auth setup-git`. Reports the prompt the moment it can be
 * parsed; `onDone` fires only after both commands have settled (or either
 * failed). Cancel is safe twice and after settle.
 */
export function runGithubDeviceLogin(
  cliPath: string,
  callbacks: GithubDeviceLoginCallbacks,
  io?: DeviceLoginIo,
  env?: NodeJS.ProcessEnv,
): DeviceLoginHandle {
  const spawnIo = io ?? REAL_IO;
  const runEnv = env ?? process.env;
  let settled = false;
  let cancelled = false;
  let setupChild: ReturnType<typeof nodeSpawn> | undefined;
  let setupTimer: ReturnType<typeof setTimeout> | undefined;

  const finish = (result: GithubDeviceLoginResult) => {
    if (settled) return;
    settled = true;
    if (setupTimer) clearTimeout(setupTimer);
    setupTimer = undefined;
    callbacks.onDone(result);
  };

  const stopSetup = () => {
    if (setupTimer) clearTimeout(setupTimer);
    setupTimer = undefined;
    if (!setupChild) return;
    try { setupChild.kill(); } catch { /* already gone */ }
  };

  const beginSetupGit = (loginOutput: string) => {
    let out = "";
    let child: ReturnType<typeof nodeSpawn>;
    try {
      child = spawnIo.spawn(cliPath, [...GITHUB_AUTH_SETUP_GIT_ARGS], {
        stdio: ["ignore", "pipe", "pipe"],
        env: deviceLoginEnv(runEnv),
        windowsHide: true,
      });
    } catch (error) {
      const output = String((error as Error)?.message ?? error);
      if (isGithubCliMissing(output)) {
        finish({ ok: false, failure: "failed", output });
        return;
      }
      finish({ ok: false, failure: "failed", output, setupGit: true });
      return;
    }
    setupChild = child;
    const absorb = (chunk: unknown) => {
      out = (out + String(chunk)).slice(-128 * 1024);
    };
    child.stdout?.on("data", absorb);
    child.stderr?.on("data", absorb);
    const done = (ok: boolean, extra = "") => {
      const output = extra ? `${out}\n${extra}` : out;
      if (cancelled) {
        finish({ ok: false, cancelled: true, output });
        return;
      }
      if (ok) {
        finish({ ok: true, output: loginOutput });
        return;
      }
      if (isGithubCliMissing(output)) {
        finish({ ok: false, failure: "failed", output });
        return;
      }
      finish({
        ok: false,
        failure: classifyDeviceLoginFailure(output, true),
        output,
        setupGit: true,
      });
    };
    child.on("error", (error: Error) => done(false, error.message));
    child.on("close", (code: number | null) => done(code === 0));
    setupTimer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      done(false);
    }, SETUP_GIT_TIMEOUT_MS);
    setupTimer.unref?.();
  };

  const login = runDeviceLogin(
    cliPath,
    [...GITHUB_DEVICE_LOGIN_ARGS],
    {
      onPrompt: (prompt) => {
        if (cancelled || settled) return;
        callbacks.onPrompt(prompt);
      },
      onDone: (result) => {
        if (cancelled) {
          finish({ ok: false, cancelled: true, output: result.output });
          return;
        }
        if (!result.ok) {
          finish(result);
          return;
        }
        beginSetupGit(result.output);
      },
    },
    spawnIo,
    githubDeviceLoginEnv(runEnv),
    { rawEnv: true },
  );

  if (settled) return idleHandle();

  return {
    cancel: () => {
      if (settled) return;
      cancelled = true;
      login.cancel();
      stopSetup();
      // Login's cancel settles its own onDone, which finishes us. If login
      // already finished and setup-git is running, that path will not fire,
      // so finish here too — `finish` is idempotent.
      finish({ ok: false, cancelled: true, output: "" });
    },
    submitCode: () => {},
  };
}
