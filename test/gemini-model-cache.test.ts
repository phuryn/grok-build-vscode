import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { warmGeminiModelCache } from "../src/gemini-model-cache";

const state = vi.hoisted(() => ({
  cwds: [] as string[],
  failNewSessionTimes: 0,
  failDelete: false,
  failRmSync: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const rmSync: typeof actual.rmSync = (target, options) => {
    if (state.failRmSync) {
      throw Object.assign(new Error(`EPERM: ${String(target)}`), { code: "EPERM" });
    }
    return actual.rmSync(target, options);
  };
  return { ...actual, default: { ...actual, rmSync }, rmSync };
});

vi.mock("../src/acp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/acp")>();
  class FakeAcpClient {
    availableModels = [{ modelId: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }];
    currentModelId = "gemini-3.8-flash";
    constructor(readonly options: { cwd: string }) {
      state.cwds.push(options.cwd);
    }
    async start(): Promise<void> {}
    async newSession(): Promise<{ sessionId: string }> {
      if (state.failNewSessionTimes > 0) {
        state.failNewSessionTimes -= 1;
        throw new Error("Temporary session creation error");
      }
      return { sessionId: "throwaway-gemini-1" };
    }
    async deleteSession(): Promise<void> {
      if (state.failDelete) throw new Error("session delete not found");
    }
    async dispose(): Promise<void> {}
  }
  return { ...actual, AcpClient: FakeAcpClient };
});

let tempRoot: string;
let logs: string[];
let seen: string[] | undefined;

function run(extra: Record<string, unknown> = {}) {
  return warmGeminiModelCache({
    cliPath: "gemini",
    tempRoot,
    log: (message) => logs.push(message),
    onModels: (models) => {
      seen = models.map((m) => m.modelId);
    },
    ...extra,
  });
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-warm-test-"));
  logs = [];
  seen = undefined;
  state.cwds = [];
  state.failNewSessionTimes = 0;
  state.failDelete = false;
  state.failRmSync = false;
});

afterEach(() => {
  state.failRmSync = false;
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("Gemini model-cache warm-up", () => {
  it("caches models and removes scratch directory", async () => {
    await expect(run()).resolves.toBeUndefined();
    expect(seen).toEqual(["gemini-3.8-flash"]);
    expect(state.cwds).toHaveLength(1);
    expect(fs.readdirSync(tempRoot)).toHaveLength(0);
  });

  it("tolerates throwaway session delete failure", async () => {
    state.failDelete = true;
    await expect(run()).resolves.toBeUndefined();
    expect(seen).toEqual(["gemini-3.8-flash"]);
    expect(logs.some((msg) => msg.includes("throwaway session cleanup failed"))).toBe(true);
  });

  it("retries in fallbackCwd if scratch directory fails", async () => {
    state.failNewSessionTimes = 1;
    const fallbackCwd = path.join(tempRoot, "fallback-repo");
    fs.mkdirSync(fallbackCwd);

    await expect(run({ fallbackCwd })).resolves.toBeUndefined();
    expect(seen).toEqual(["gemini-3.8-flash"]);
    expect(state.cwds).toHaveLength(2);
    expect(state.cwds[1]).toBe(fallbackCwd);
  });
});
