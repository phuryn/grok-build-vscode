import { AcpClient } from "../src/acp";
import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { MuseBackend, withMuseCredentialBackend } from "../src/muse-backend";
import { locateMuseCli } from "../src/muse-cli-locator";
import { ACP_PROVIDERS, INTERNAL_PROVIDERS, isAcpProvider, isInternalProvider, supportsSessionDeletion, supportsModeSwitching, usesPerCallContextOccupancy } from "../src/acp-backend";

describe("Muse backend boundary", () => {
  it("spawns the installed ESM entry under Node with the user's executable", () => {
    const backend = new MuseBackend();
    const spec = backend.spawn({ cliPath: "/bin/muse", cwd: "/workspace", env: { TEST: "kept" } });
    expect(backend.provider).toBe("muse");
    expect(spec.command).toBe(process.execPath);
    expect(spec.args[0]).toBe(path.resolve(__dirname, "../src/muse-adapter/main.mjs"));
    expect(spec.env).toEqual({ ...withMuseCredentialBackend({ TEST: "kept" }), ELECTRON_RUN_AS_NODE: "1", MUSE_CODE_EXECUTABLE: "/bin/muse" });
    expect(spec.shell).toBe(false);
    expect(ACP_PROVIDERS).toEqual(["grok", "codex", "claude"]);
    expect(isAcpProvider("muse")).toBe(false);
  });

  // Muse 1.4.0 cannot save a sign-in to the keychain off macOS
  // (meta-models/muse-code-sdk#38); its file store saves normally.
  it("forces Muse's file credential store off macOS, and only there", () => {
    expect(withMuseCredentialBackend({ A: "1" }, "win32")).toEqual({ A: "1", TBH_CREDENTIAL_BACKEND: "file" });
    expect(withMuseCredentialBackend({ A: "1" }, "linux")).toEqual({ A: "1", TBH_CREDENTIAL_BACKEND: "file" });
    expect(withMuseCredentialBackend({ A: "1" }, "darwin")).toEqual({ A: "1" });
    expect(withMuseCredentialBackend({ TBH_CREDENTIAL_BACKEND: "keychain" }, "linux"))
      .toEqual({ TBH_CREDENTIAL_BACKEND: "keychain" });
    const backend = new MuseBackend();
    const spec = backend.spawn({ cliPath: "/bin/muse", cwd: "/w", env: {} });
    expect(spec.env?.TBH_CREDENTIAL_BACKEND).toBe(process.platform === "darwin" ? undefined : "file");
  });

  it("honours an explicit Windows executable", () => {
    expect(locateMuseCli({ platform: "win32", configuredPath: "muse.exe", isExecutable: () => true })).toBe(path.resolve("muse.exe"));
    expect(locateMuseCli({ platform: "win32", env: { MUSE_CODE_EXECUTABLE: "muse.exe" }, isExecutable: () => true })).toBe(path.resolve("muse.exe"));
    expect(locateMuseCli({ platform: "win32", configuredPath: "missing.exe", isExecutable: () => false })).toBeUndefined();
  });

  it("checks the Windows installer target, never the POSIX home-bin fallback", () => {
    const checked: string[] = [];
    expect(locateMuseCli({ platform: "win32", env: {}, home: "C:\\Users\\test", which: () => undefined,
      isExecutable: file => { checked.push(file); return false; },
    })).toBeUndefined();
    expect(checked).toEqual(["C:\\Users\\test\\AppData\\Local\\Programs\\muse\\muse.cmd"]);
  });

  it("finds the PowerShell installer shim before the running editor has the new PATH", () => {
    const binary = "D:\\User data\\Programs\\muse\\muse.cmd";
    const options = { platform: "win32" as const, env: { LOCALAPPDATA: "D:\\User data", PATH: "" },
      which: () => undefined, isExecutable: (file: string) => file === binary };
    expect(locateMuseCli(options)).toBe(binary);
    expect(locateMuseCli({ ...options, configuredPath: "C:\\missing.exe" })).toBeUndefined();
    expect(locateMuseCli({ ...options, which: () => "C:\\path\\muse.exe", isExecutable: () => true })).toBe("C:\\path\\muse.exe");
  });

  it("checks executability, honours an explicit missing path, and finds the user bin fallback", () => {
    const isExecutable = (file: string) => file === path.join("/home/test", ".local/bin/muse");
    const options = { platform: "darwin" as const, home: "/home/test", env: {}, isExecutable, which: () => undefined };
    expect(locateMuseCli(options)).toBe(path.join("/home/test", ".local/bin/muse"));
    expect(locateMuseCli({ ...options, configuredPath: "/missing" })).toBeUndefined();
  });
});


it("keeps legacy wire ids frozen while internal capabilities distinguish Muse", () => {
  expect(ACP_PROVIDERS).toEqual(["grok", "codex", "claude"]);
  expect(INTERNAL_PROVIDERS).toEqual(["grok", "codex", "claude", "muse"]);
  expect(isAcpProvider("muse")).toBe(false);
  expect(isInternalProvider("muse")).toBe(true);
  expect(supportsSessionDeletion("muse")).toBe(false);
  expect(supportsModeSwitching("muse")).toBe(false);
  expect(usesPerCallContextOccupancy("muse")).toBe(false);
  expect(() => new MuseBackend().setMode("s", "yolo")).toThrow("unavailable");
  expect(new MuseBackend().setReasoningEffort("s", undefined, "ultra")).toEqual({
    method: "session/set_config_option", params: { sessionId: "s", configId: "reasoning_effort", value: "ultra" },
  });
});

it("lists every page scoped to the requested workspace", async () => {
  const calls: any[] = [];
  const result = await new MuseBackend().listSessions(async (method, params) => {
    calls.push([method, params]);
    return { sessions: [{ sessionId: params.cursor ? "two" : "one", cwd: "/project", _meta: { turnCount: 2 } }],
      nextCursor: params.cursor ? null : "opaque" };
  }, "/project");
  expect(calls).toEqual([["session/list", { cwd: "/project" }], ["session/list", { cwd: "/project", cursor: "opaque" }]]);
  expect(result.sessions.map(s => s.sessionId)).toEqual(["one", "two"]);
  expect(result.sessions[0].turnCount).toBe(2);
});


it("reports Muse's exact context occupancy, including decreases and zero", () => {
  const client = new AcpClient({ cliPath: "/unused", cwd: "/workspace", backend: new MuseBackend(), log: () => {} });
  const seen: any[] = [];
  client.on("contextUsage", (...args) => seen.push(args));
  for (const used of [250, 100, 0]) (client as any).handleSessionUpdate({ sessionUpdate: "usage_update", used, size: 1007997 });
  expect(seen).toEqual([[250, 1007997], [100, 1007997], [0, 1007997]]);
});
