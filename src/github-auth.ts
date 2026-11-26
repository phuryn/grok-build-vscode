/**
 * GitHub connection state, as a piece of state with an owner.
 *
 * Until this module, "are we signed in to GitHub?" was inferred from whether
 * a clone failed. That made failure the discovery mechanism. The host now
 * reads `gh api user --jq .login` and keeps a small snapshot: connected or
 * not, as whom, and whether that credential is working. Settings and the
 * clone form both read that snapshot.
 *
 * Branch on the exit code, then the login text. A failed call prints the
 * start of a JSON error object; treating stdout as the login would report a
 * user called `{`. `gh auth status --json` is not used: it is missing on the
 * gh 2.79 the cloud image ships.
 *
 * An environment token (`GH_TOKEN` / `GITHUB_TOKEN`) is a fact about this
 * process, not a gh credential-source string. When the API call fails and
 * one is set, the row names it instead of looking merely disconnected.
 *
 * The token path writes the secret to `gh auth login --with-token` on stdin
 * and never stores it. `gh` owns the credential after that, the same as the
 * device flow. A pasted token is a secret: never log it, never echo it, never
 * put it in a HostMsg. Error text is redacted before it leaves this file.
 * If an env token is already in force, the paste is refused before spawning.
 */
import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import {
  GITHUB_AUTH_SETUP_GIT_ARGS,
  GITHUB_CLI_BIN,
  isGithubCliMissing,
} from "./github-device-login";

/** Present on every gh we could plausibly meet, including 2.79.0. */
export const GITHUB_API_USER_ARGS = ["api", "user", "--jq", ".login"] as const;
export const GITHUB_REPO_LIST_LIMIT = 200;
export const GITHUB_REPO_LIST_ARGS = [
  "repo",
  "list",
  "--json",
  "nameWithOwner,isPrivate,updatedAt",
  "--limit",
  String(GITHUB_REPO_LIST_LIMIT),
] as const;
export const GITHUB_AUTH_LOGIN_WITH_TOKEN_ARGS = [
  "auth",
  "login",
  "--hostname",
  "github.com",
  "--git-protocol",
  "https",
  "--with-token",
] as const;

/** Fine-grained tokens are ~93 characters; this is a ceiling, not a guess at GitHub's. */
export const MAX_GITHUB_TOKEN_CHARS = 512;

const STATUS_TIMEOUT_MS = 8_000;
const REPO_LIST_TIMEOUT_MS = 30_000;
const LOGOUT_TIMEOUT_MS = 15_000;
const TOKEN_LOGIN_TIMEOUT_MS = 20_000;
const SETUP_GIT_TIMEOUT_MS = 20_000;
const MAX_OUTPUT = 128 * 1024;

export interface GithubAuthIo {
  execFile: typeof nodeExecFile;
  spawn: typeof nodeSpawn;
}

const REAL_IO: GithubAuthIo = { execFile: nodeExecFile, spawn: nodeSpawn };

export type GithubEnvTokenName = "GH_TOKEN" | "GITHUB_TOKEN";

export type GithubAuthState = {
  connected: boolean;
  login: string;
  envTokenInForce: boolean;
  error: boolean;
  cliPresent: boolean;
  /** Human copy. Never a token, never a command line that carried one. */
  message?: string;
};

export type GithubRepo = {
  nameWithOwner: string;
  isPrivate: boolean;
  updatedAt: string;
};

export const DISCONNECTED_GITHUB: GithubAuthState = {
  connected: false,
  login: "",
  envTokenInForce: false,
  error: false,
  cliPresent: true,
};

const MISSING_CLI_GITHUB: GithubAuthState = {
  connected: false,
  login: "",
  envTokenInForce: false,
  error: false,
  cliPresent: false,
};

/**
 * Strip a known secret and any GitHub token-shaped string from text that
 * might otherwise travel to a log, an error frame, or an exception message.
 */
export function redactGithubSecret(text: string, secret?: string): string {
  let out = String(text || "");
  if (secret) {
    const needle = String(secret);
    if (needle) out = out.split(needle).join("[token]");
  }
  out = out.replace(/github_pat_[A-Za-z0-9_]+/g, "[token]");
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9_]+\b/g, "[token]");
  return out;
}

/**
 * Which env token gh would see, if any. Presence only — never the value.
 * `GH_TOKEN` outranks `GITHUB_TOKEN`, matching gh itself.
 */
export function githubEnvTokenName(env: NodeJS.ProcessEnv = process.env): GithubEnvTokenName | undefined {
  if (env.GH_TOKEN) return "GH_TOKEN";
  if (env.GITHUB_TOKEN) return "GITHUB_TOKEN";
  return undefined;
}

export function githubEnvTokenBrokenMessage(name: GithubEnvTokenName): string {
  return `A token in this machine's ${name} environment variable is in force, and it is not working.`;
}

export function githubEnvTokenBlocksPasteMessage(name: GithubEnvTokenName): string {
  return `A token in this machine's ${name} environment variable is in force and will keep winning until it is removed.`;
}

export function githubEnvTokenBlocksSignOutMessage(name: GithubEnvTokenName): string {
  return `A token in this machine's ${name} environment variable is in force. Signing out of the GitHub CLI cannot clear it.`;
}

export function githubAuthDescription(state: GithubAuthState): string {
  if (!state.cliPresent) {
    return "The GitHub CLI (gh) is not installed on this machine.";
  }
  if (state.message) return state.message;
  if (state.error && state.envTokenInForce) {
    return githubEnvTokenBrokenMessage("GH_TOKEN");
  }
  if (!state.connected) {
    return "Connect GitHub to clone private repositories and list the ones this account can see.";
  }
  const who = state.login ? `@${state.login}` : "GitHub";
  if (state.error) {
    return `Signed in as ${who}, but the credential is not working.`;
  }
  return `Signed in as ${who}.`;
}

export function githubLogoutArgs(login?: string): string[] {
  const args = ["auth", "logout", "--hostname", "github.com"];
  if (login) args.push("--user", login);
  return args;
}

/**
 * Login text from a successful `gh api user --jq .login`. Callers must have
 * already checked the exit code: a failing call prints JSON that must not be
 * treated as a username.
 */
export function parseGithubApiLogin(stdout: string): string {
  const login = String(stdout || "").trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!login || login.startsWith("{") || login.startsWith("[")) return "";
  return login;
}

export function parseGithubRepoList(raw: string): GithubRepo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw || ""));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const repos: GithubRepo[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const nameWithOwner = typeof (item as { nameWithOwner?: unknown }).nameWithOwner === "string"
      ? (item as { nameWithOwner: string }).nameWithOwner.trim()
      : "";
    if (!nameWithOwner || !nameWithOwner.includes("/")) continue;
    repos.push({
      nameWithOwner,
      isPrivate: (item as { isPrivate?: unknown }).isPrivate === true,
      updatedAt: typeof (item as { updatedAt?: unknown }).updatedAt === "string"
        ? (item as { updatedAt: string }).updatedAt
        : "",
    });
  }
  return repos;
}

function execGh(
  args: readonly string[],
  io: GithubAuthIo,
  env: NodeJS.ProcessEnv,
  timeout: number,
): Promise<{ ok: boolean; stdout: string; stderr: string; missing: boolean }> {
  return new Promise((resolve) => {
    io.execFile(
      GITHUB_CLI_BIN,
      [...args],
      {
        env,
        timeout,
        windowsHide: true,
        maxBuffer: MAX_OUTPUT,
      },
      (error, stdout, stderr) => {
        const out = String(stdout || "");
        const err = String(stderr || "");
        const combined = `${err}\n${out}\n${error ? (error as Error).message : ""}`;
        if (isGithubCliMissing(combined)) {
          resolve({ ok: false, stdout: out, stderr: err, missing: true });
          return;
        }
        resolve({ ok: !error, stdout: out, stderr: err, missing: false });
      },
    );
  });
}

export async function readGithubAuthState(
  io: GithubAuthIo = REAL_IO,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GithubAuthState> {
  const envName = githubEnvTokenName(env);
  const envTokenInForce = !!envName;
  const result = await execGh(GITHUB_API_USER_ARGS, io, env, STATUS_TIMEOUT_MS);
  if (result.missing) {
    return { ...MISSING_CLI_GITHUB, envTokenInForce };
  }
  if (result.ok) {
    const login = parseGithubApiLogin(result.stdout);
    if (login) {
      return {
        connected: true,
        login,
        envTokenInForce,
        error: false,
        cliPresent: true,
      };
    }
  }
  if (envName) {
    return {
      connected: false,
      login: "",
      envTokenInForce: true,
      error: true,
      cliPresent: true,
      message: githubEnvTokenBrokenMessage(envName),
    };
  }
  return { ...DISCONNECTED_GITHUB };
}

const STAR_REPO = "phuryn/grok-build-vscode";
export const STAR_REPO_URL = `https://github.com/${STAR_REPO}`;

export async function starAfkPilotRepo(
  io: GithubAuthIo = REAL_IO,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (githubEnvTokenName(env)) return false;
  try {
    const result = await execGh(["api", "-X", "PUT", `user/starred/${STAR_REPO}`], io,
      { ...env, GH_HOST: "github.com" }, STATUS_TIMEOUT_MS);
    return result.ok;
  } catch {
    return false;
  }
}

export async function listGithubRepositories(
  io: GithubAuthIo = REAL_IO,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ repos: GithubRepo[]; truncated: boolean; error?: string }> {
  const result = await execGh(GITHUB_REPO_LIST_ARGS, io, env, REPO_LIST_TIMEOUT_MS);
  if (result.missing) {
    return { repos: [], truncated: false, error: "The GitHub CLI (gh) is not installed." };
  }
  if (!result.ok) {
    const raw = redactGithubSecret(`${result.stderr}\n${result.stdout}`.trim());
    return {
      repos: [],
      truncated: false,
      error: raw.slice(0, 300) || "Could not list GitHub repositories.",
    };
  }
  const repos = parseGithubRepoList(result.stdout);
  return {
    repos,
    truncated: repos.length >= GITHUB_REPO_LIST_LIMIT,
  };
}

export async function logoutGithub(
  login?: string,
  io: GithubAuthIo = REAL_IO,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; error?: string }> {
  const result = await execGh(githubLogoutArgs(login), io, env, LOGOUT_TIMEOUT_MS);
  if (result.missing) {
    return { ok: false, error: "The GitHub CLI (gh) is not installed." };
  }
  if (!result.ok) {
    const raw = redactGithubSecret(`${result.stderr}\n${result.stdout}`.trim());
    return { ok: false, error: raw.slice(0, 300) || "Could not sign out of GitHub." };
  }
  return { ok: true };
}

function spawnCollect(
  args: readonly string[],
  io: GithubAuthIo,
  env: NodeJS.ProcessEnv,
  timeout: number,
  stdinText?: string,
): Promise<{ ok: boolean; output: string; missing: boolean }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof nodeSpawn>;
    try {
      child = io.spawn(GITHUB_CLI_BIN, [...args], {
        stdio: [stdinText !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
        env,
        windowsHide: true,
      });
    } catch (error) {
      const output = redactGithubSecret(String((error as Error)?.message ?? error), stdinText);
      resolve({
        ok: false,
        output,
        missing: isGithubCliMissing(output),
      });
      return;
    }
    let out = "";
    const absorb = (chunk: unknown) => {
      out = (out + String(chunk)).slice(-MAX_OUTPUT);
    };
    child.stdout?.on("data", absorb);
    child.stderr?.on("data", absorb);
    let settled = false;
    const finish = (ok: boolean, extra = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = redactGithubSecret(extra ? `${out}\n${extra}` : out, stdinText);
      resolve({
        ok,
        output,
        missing: isGithubCliMissing(output),
      });
    };
    child.on("error", (error: Error) => finish(false, error.message));
    child.on("close", (code: number | null) => finish(code === 0));
    if (stdinText !== undefined) {
      try {
        child.stdin?.write(stdinText);
        child.stdin?.end();
      } catch (error) {
        try { child.kill(); } catch { /* already gone */ }
        finish(false, String((error as Error)?.message ?? error));
        return;
      }
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish(false);
    }, timeout);
    timer.unref?.();
  });
}

/**
 * `gh auth login --with-token` then `gh auth setup-git`.
 *
 * The token is written to stdin and never appears on argv. Output is redacted
 * before it returns. An env token already in this process is refused before
 * spawning — gh would keep using it, and a successful-looking paste would
 * not be the credential in force.
 */
export async function loginGithubWithToken(
  token: string,
  io: GithubAuthIo = REAL_IO,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; error?: string; setupGit?: boolean }> {
  const trimmed = String(token || "").trim();
  if (!trimmed) return { ok: false, error: "Paste a GitHub token." };
  if (trimmed.length > MAX_GITHUB_TOKEN_CHARS) {
    return { ok: false, error: "That token is too long." };
  }
  const envName = githubEnvTokenName(env);
  if (envName) {
    return { ok: false, error: githubEnvTokenBlocksPasteMessage(envName) };
  }
  const login = await spawnCollect(
    GITHUB_AUTH_LOGIN_WITH_TOKEN_ARGS,
    io,
    env,
    TOKEN_LOGIN_TIMEOUT_MS,
    trimmed,
  );
  if (login.missing) {
    return { ok: false, error: "The GitHub CLI (gh) is not installed." };
  }
  if (!login.ok) {
    return {
      ok: false,
      error: login.output.trim().slice(0, 300) || "GitHub did not accept that token.",
    };
  }
  const setup = await spawnCollect(
    GITHUB_AUTH_SETUP_GIT_ARGS,
    io,
    env,
    SETUP_GIT_TIMEOUT_MS,
  );
  if (!setup.ok) {
    return {
      ok: false,
      setupGit: true,
      error: "Signed in to GitHub, but git was not configured to use it. Try again.",
    };
  }
  return { ok: true };
}
