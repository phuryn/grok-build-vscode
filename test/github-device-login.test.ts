/**
 * Headless GitHub sign-in for the clone form.
 *
 * Pins the measured gh 2.79.0 banner, the argv that produced it, and that
 * `gh auth setup-git` runs after a successful login — the step whose absence
 * leaves clone failing exactly as before. The runner is driven over a fake
 * process; nothing here spawns `gh`.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDeviceLoginPrompt } from "../src/device-login";
import {
  GITHUB_AUTH_SETUP_GIT_ARGS,
  GITHUB_CLI_BIN,
  GITHUB_DEVICE_LOGIN_ARGS,
  githubDeviceLoginEnv,
  githubDeviceLoginFailureText,
  githubDeviceLoginPlan,
  isGithubCliMissing,
  runGithubDeviceLogin,
} from "../src/github-device-login";
import type { DeviceLoginIo } from "../src/device-login-run";
import { INBOUND_DISPOSITION, REMOTE_REQUIRES_BOUND_SESSION, allowFromRemote } from "../src/remote-policy";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sidebar = fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8").replace(/\r\n/g, "\n");

function methodBody(signature: string): string {
  const start = sidebar.indexOf(signature);
  expect(start, `${signature} must exist`).toBeGreaterThan(-1);
  const next = sidebar.indexOf("\n  private ", start + signature.length);
  const nextAsync = sidebar.indexOf("\n  async ", start + signature.length);
  const cuts = [next, nextAsync].filter((n) => n >= 0);
  const end = cuts.length ? Math.min(...cuts) : sidebar.length;
  return sidebar.slice(start, end);
}

/** Verbatim from `gh auth login --hostname github.com --git-protocol https
 *  --skip-ssh-key --web` on a plain pipe, gh 2.79.0. */
const GH_REAL = [
  "! First copy your one-time code: 0D15-6BD9",
  "Open this URL to continue in your web browser: https://github.com/login/device",
].join("\n");

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { writes: [] as string[], write(chunk: string) { this.writes.push(String(chunk)); return true; } };
  killed: string[] = [];
  kill(signal?: string) {
    this.killed.push(signal ?? "SIGTERM");
    return true;
  }
}

function fakeIoSequence(): { io: DeviceLoginIo; children: FakeChild[]; calls: unknown[][] } {
  const children: FakeChild[] = [];
  const calls: unknown[][] = [];
  const io = {
    spawn: ((...args: unknown[]) => {
      calls.push(args);
      const child = new FakeChild();
      children.push(child);
      return child;
    }) as unknown as DeviceLoginIo["spawn"],
  };
  return { io, children, calls };
}

describe("the measured gh device-code banner", () => {
  it("is read by parseDeviceLoginPrompt unchanged", () => {
    expect(parseDeviceLoginPrompt(GH_REAL)).toEqual({
      url: "https://github.com/login/device",
      code: "0D15-6BD9",
    });
  });
});

describe("the headless GitHub login plan", () => {
  it("answers every interactive prompt with flags, and does not need a paste-back", () => {
    expect(githubDeviceLoginPlan()).toEqual({ args: [...GITHUB_DEVICE_LOGIN_ARGS] });
    expect(githubDeviceLoginPlan().needsCode).toBeUndefined();
    expect(GITHUB_DEVICE_LOGIN_ARGS).toEqual([
      "auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--skip-ssh-key", "--web",
    ]);
    expect(GITHUB_AUTH_SETUP_GIT_ARGS).toEqual(["auth", "setup-git"]);
    expect(GITHUB_CLI_BIN).toBe("gh");
  });

  it("does not set CI on the login child — that is how some CLIs skip auth entirely", () => {
    const env = githubDeviceLoginEnv({ PATH: "/usr/bin", CI: "1" });
    expect(env.CI).toBeUndefined();
    expect(env.BROWSER).toBe("none");
    expect(env.TERM).toBe("dumb");
  });
});

describe("saying what went wrong", () => {
  it("names gh missing, an expired code, and an account that cannot", () => {
    expect(githubDeviceLoginFailureText("missing")).toContain("gh");
    expect(githubDeviceLoginFailureText("missing")).toMatch(/not installed/i);
    expect(githubDeviceLoginFailureText("failed")).toMatch(/expired/i);
    expect(githubDeviceLoginFailureText("not-permitted")).toMatch(/account cannot/i);
  });

  it("does not pretend a setup-git failure was an expired code", () => {
    expect(githubDeviceLoginFailureText("failed", { setupGit: true })).toMatch(/git was not configured/i);
    expect(githubDeviceLoginFailureText("failed", { setupGit: true })).not.toMatch(/expired/i);
  });

  it("reads spawn ENOENT as a missing CLI", () => {
    expect(isGithubCliMissing("spawn gh ENOENT")).toBe(true);
    expect(isGithubCliMissing("timed out waiting")).toBe(false);
  });
});

describe("running login then setup-git", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reports the prompt from the login child, then runs setup-git after exit 0", () => {
    const { io, children, calls } = fakeIoSequence();
    const onPrompt = vi.fn();
    const onDone = vi.fn();
    runGithubDeviceLogin("gh", { onPrompt, onDone }, io, {});

    expect(calls[0][0]).toBe("gh");
    expect(calls[0][1]).toEqual([...GITHUB_DEVICE_LOGIN_ARGS]);
    const loginOpts = calls[0][2] as { env: NodeJS.ProcessEnv; stdio: string[] };
    expect(loginOpts.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(loginOpts.env.CI).toBeUndefined();
    expect(loginOpts.env.BROWSER).toBe("none");

    children[0].stderr.emit("data", GH_REAL);
    expect(onPrompt).toHaveBeenCalledWith({
      url: "https://github.com/login/device",
      code: "0D15-6BD9",
    });
    expect(onDone).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);

    children[0].emit("close", 0);
    expect(calls).toHaveLength(2);
    expect(calls[1][0]).toBe("gh");
    expect(calls[1][1]).toEqual([...GITHUB_AUTH_SETUP_GIT_ARGS]);
    const setupOpts = calls[1][2] as { env: NodeJS.ProcessEnv };
    expect(setupOpts.env.CI).toBe("1");
    expect(onDone).not.toHaveBeenCalled();

    children[1].emit("close", 0);
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });

  it("does not run setup-git when login fails", () => {
    const { io, children, calls } = fakeIoSequence();
    const onDone = vi.fn();
    runGithubDeviceLogin("gh", { onPrompt: vi.fn(), onDone }, io, {});
    children[0].stderr.emit("data", GH_REAL);
    children[0].emit("close", 1);
    expect(calls).toHaveLength(1);
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ ok: false, failure: "failed" }));
  });

  it("treats a failed setup-git as a failure of the whole flow", () => {
    const { io, children } = fakeIoSequence();
    const onDone = vi.fn();
    runGithubDeviceLogin("gh", { onPrompt: vi.fn(), onDone }, io, {});
    children[0].stderr.emit("data", GH_REAL);
    children[0].emit("close", 0);
    children[1].stderr.emit("data", "failed to configure git");
    children[1].emit("close", 1);
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      failure: "failed",
      setupGit: true,
    }));
  });
});

describe("remote policy", () => {
  it("admits setupGithubCli from a remote at full, and does not bind it to a conversation", () => {
    expect(INBOUND_DISPOSITION.setupGithubCli).toBe("full");
    expect(allowFromRemote("setupGithubCli", "full")).toBe(true);
    expect(allowFromRemote("setupGithubCli", "propose")).toBe(false);
    expect(REMOTE_REQUIRES_BOUND_SESSION.setupGithubCli).toBe(false);
  });
});

describe("the local vs remote branch in the host", () => {
  it("keeps the terminal line for a local webview and runs the headless flow for a remote", () => {
    const body = methodBody("async setupGithubCli(");
    expect(body).toContain('origin === "remote"');
    expect(body).toContain("startGithubDeviceLogin(");
    expect(body).toContain("githubSignInCommand(");
    expect(body.indexOf("startGithubDeviceLogin(")).toBeLessThan(body.indexOf("githubSignInCommand("));
    expect(body).not.toMatch(/\bspawn\s*\(/);
  });

  it("starts the runner rather than spawning gh itself, and runs setup-git inside that runner", () => {
    const start = methodBody("private startGithubDeviceLogin(");
    expect(start).toContain("runGithubDeviceLogin(");
    expect(start).toContain("GITHUB_CLI_BIN");
    expect(start).not.toMatch(/\bspawn\s*\(/);
    expect(start).not.toContain("execFile");
  });

  it("a new GitHub login tap cancels the orphan rather than repeating its code", () => {
    const start = methodBody("private startGithubDeviceLogin(");
    expect(start).toContain("prev.handle?.cancel()");
    expect(start).not.toContain("already in flight; repeated its state");
  });

  it("cancelDeviceLogin with provider github stops the gh child", () => {
    const cancel = methodBody("private cancelGithubDeviceLogin(");
    expect(cancel).toContain("running.handle?.cancel()");
    expect(cancel).toContain("this.postGithubState()");
    const handler = sidebar.slice(
      sidebar.indexOf('case "cancelDeviceLogin"'),
      sidebar.indexOf('case "recheckConnection"'),
    );
    expect(handler).toContain('msg.provider === "github"');
    expect(handler).toContain("cancelGithubDeviceLogin");
  });
});
