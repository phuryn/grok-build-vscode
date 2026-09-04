/**
 * Tidying up must never fail the warm-up (#146).
 *
 * This warm-up doubles as the credential probe: the caller promotes a provider
 * to "Connected" only when it returns successfully. So anything that throws
 * after the models have been delivered — a throwaway session that will not
 * delete, a scratch directory Windows will not remove — is indistinguishable
 * from "this account does not work", and the provider never connects.
 *
 * That is exactly what #146 was: on Windows the adapter can still hold its
 * scratch directory for a moment after exiting, `fs.rmSync` threw EPERM from a
 * `finally`, and Claude never reached Connected on any attempt, ever, while
 * Codex on the same machine was fine. Codex had grown these protections one day
 * after this module was written; they were never carried across.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { warmClaudeModelCache } from "../src/claude-model-cache";

const state = vi.hoisted(() => ({
  cwds: [] as string[],
  failNewSessionTimes: 0,
  failDelete: false,
  /** Windows refusing to remove the scratch dir. A spy cannot be used: the
   *  module imports `node:fs` as a namespace, whose exports are not
   *  redefinable, so the module itself is wrapped instead. */
  failRmSync: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const rmSync: typeof actual.rmSync = (target, options) => {
    if (state.failRmSync) {
      throw Object.assign(new Error(`EPERM, Permission denied: ${String(target)}`), { code: "EPERM" });
    }
    return actual.rmSync(target, options);
  };
  return { ...actual, default: { ...actual, rmSync }, rmSync };
});

vi.mock("../src/acp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/acp")>();
  class FakeAcpClient {
    availableModels = [{ modelId: "claude-opus-5", name: "Opus" }];
    currentModelId = "claude-opus-5";
    constructor(readonly options: { cwd: string }) {
      state.cwds.push(options.cwd);
    }
    async start(): Promise<void> {}
    async newSession(): Promise<{ sessionId: string }> {
      if (state.failNewSessionTimes > 0) {
        state.failNewSessionTimes -= 1;
        throw new Error("Internal error");
      }
      return { sessionId: "throwaway-1" };
    }
    async deleteSession(): Promise<void> {
      if (state.failDelete) throw new Error("no rollout found for thread id");
    }
    async dispose(): Promise<void> {}
  }
  return { ...actual, AcpClient: FakeAcpClient };
});

let tempRoot: string;
let logs: string[];
let seen: string[] | undefined;

function run(extra: Record<string, unknown> = {}) {
  return warmClaudeModelCache({
    cliPath: "C:\\Users\\someone\\.local\\bin\\claude.exe",
    tempRoot,
    log: (message) => logs.push(message),
    onModels: (models) => { seen = models.map((m) => m.modelId); },
    ...extra,
  });
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-warm-test-"));
  logs = [];
  seen = undefined;
  state.cwds = [];
  state.failNewSessionTimes = 0;
  state.failDelete = false;
  state.failRmSync = false;
});

afterEach(() => {
  // Clear it first, or the teardown below hits the same refusal the test armed.
  state.failRmSync = false;
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("claude model-cache warm-up (#146)", () => {
  it("caches the models and cleans up when everything works", async () => {
    await expect(run()).resolves.toBeUndefined();
    expect(seen).toEqual(["claude-opus-5"]);
    expect(fs.readdirSync(tempRoot)).toEqual([]);
  });

  it("still succeeds when the throwaway session will not delete", async () => {
    state.failDelete = true;
    await expect(run()).resolves.toBeUndefined();
    expect(seen).toEqual(["claude-opus-5"]);
    expect(logs.some((l) => l.includes("models already cached, continuing"))).toBe(true);
  });

  it("still succeeds when the scratch directory cannot be removed", async () => {
    // The reported failure. EPERM on the directory itself, thrown after the
    // adapter has already exited 0 — unguarded it replaced a warm-up that had
    // ALREADY cached the models with its own failure, and the provider was
    // never promoted.
    state.failRmSync = true;
    await expect(run()).resolves.toBeUndefined();
    expect(seen).toEqual(["claude-opus-5"]);
    expect(logs.some((l) => l.includes("left a scratch dir behind"))).toBe(true);
  });

  it("retries in the workspace when the scratch session is refused", async () => {
    // The other reported variant: `session/new` answering "Internal error" for
    // a session in a bare temp directory. The workspace is the cwd a real
    // session uses, so it is known to be acceptable.
    state.failNewSessionTimes = 1;
    await expect(run({ fallbackCwd: "C:\\repo" })).resolves.toBeUndefined();
    expect(seen).toEqual(["claude-opus-5"]);
    expect(state.cwds).toHaveLength(2);
    expect(state.cwds[0].startsWith(tempRoot)).toBe(true);
    expect(state.cwds[1]).toBe("C:\\repo");
    expect(logs.some((l) => l.includes("retrying in the workspace"))).toBe(true);
  });

  it("fails honestly when the scratch session is refused and there is nowhere to retry", async () => {
    state.failNewSessionTimes = 1;
    await expect(run()).rejects.toThrow("Internal error");
    expect(state.cwds).toHaveLength(1);
  });

  it("does not swallow a real failure in the workspace either", async () => {
    state.failNewSessionTimes = 2;
    await expect(run({ fallbackCwd: "C:\\repo" })).rejects.toThrow("Internal error");
    expect(state.cwds).toHaveLength(2);
  });
});
