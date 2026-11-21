import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { agyInstallCommand, installAgyCli, updateAgyCliOnUpgrade, runAgyCommand } from "../src/agy-cli-lifecycle";

class FakeChild extends EventEmitter {
  readonly pid = 61561;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => this.close(null));

  close(code: number | null) {
    this.emit("exit", code);
    this.emit("close", code);
  }
}

function fakeProcess(launch: (file: string, args: string[], child: FakeChild) => void) {
  return vi.fn((file: string, args: string[]) => {
    const child = new FakeChild();
    queueMicrotask(() => launch(file, args, child));
    return child;
  });
}

afterEach(() => vi.useRealTimers());

it("invokes Google's unattended installer on Windows", () => {
  expect(agyInstallCommand("win32")).toEqual({
    file: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
      "irm https://antigravity.google/cli/install.ps1 | iex"],
  });
});

it.each(["darwin", "linux"] as const)("invokes Google's unattended installer on %s with pipe failure visible", platform => {
  expect(agyInstallCommand(platform)).toEqual({
    file: "bash",
    args: ["-o", "pipefail", "-c", "curl -fsSL https://antigravity.google/cli/install.sh | bash"],
  });
});

it("requires the located binary to answer --version even when the installer exits successfully", async () => {
  const child = fakeProcess((_file, _args, child) => child.close(0));
  const options = { command: { file: "fake installer", args: [] }, spawnChild: child as unknown as typeof spawn };
  await expect(installAgyCli({ ...options, locate: () => undefined })).rejects.toThrow("agy was not found");
  await expect(installAgyCli({ ...options, locate: () => "fake agy" })).rejects.toThrow("--version did not report");
  expect(child).toHaveBeenLastCalledWith("fake agy", ["--version"], expect.anything());
});

it("accepts an installed, answering CLI even when the script exits nonzero", async () => {
  const log = vi.fn();
  const child = fakeProcess((file, _args, child) => {
    if (file === "fake installer") child.stderr.write("Shell integration failed\n");
    else child.stdout.write("1.5.8\n");
    child.close(file === "fake installer" ? 1 : 0);
  });
  const beforeVersion = vi.fn(async () => {
    expect(child.mock.calls).toEqual([["fake installer", [], expect.anything()]]);
  });
  await expect(installAgyCli({ command: { file: "fake installer", args: [] }, locate: () => "fake agy",
    beforeVersion, spawnChild: child as unknown as typeof spawn, log })).resolves.toEqual({ binary: "fake agy", version: "1.5.8" });
  expect(beforeVersion).toHaveBeenCalledWith("fake agy");
  expect(log).toHaveBeenCalledWith("Shell integration failed");
  expect(child).toHaveBeenNthCalledWith(1, "fake installer", [], expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }));
});

it("cancels the Windows installer tree with taskkill and waits for exit", async () => {
  const controller = new AbortController();
  const installer = new FakeChild();
  const killer = new FakeChild();
  const child = vi.fn().mockReturnValueOnce(installer).mockReturnValueOnce(killer);
  const run = installAgyCli({ command: { file: "fake installer", args: [] }, signal: controller.signal,
    platform: "win32", spawnChild: child as typeof spawn, locate: () => undefined });
  const rejected = expect(run).rejects.toThrow("Installation cancelled.");
  controller.abort(new Error("Installation cancelled."));
  installer.close(null);
  killer.close(0);
  await rejected;
  expect(child).toHaveBeenLastCalledWith(expect.stringMatching(/System32\\taskkill\.exe$/i), ["/PID", "61561", "/T", "/F"], expect.anything());
  expect(installer.kill).not.toHaveBeenCalled();
});

it("cancels the POSIX process group started for the installer", async () => {
  const controller = new AbortController();
  const installer = new FakeChild();
  const child = vi.fn().mockReturnValue(installer);
  const killGroup = vi.fn(() => { queueMicrotask(() => installer.close(null)); return true; });
  const run = installAgyCli({ command: { file: "fake installer", args: [] }, platform: "linux", signal: controller.signal,
    spawnChild: child as typeof spawn, killGroup, locate: () => undefined });
  controller.abort(new Error("Installation cancelled."));
  await expect(run).rejects.toThrow("Installation cancelled.");
  expect(child).toHaveBeenCalledWith("fake installer", [], expect.objectContaining({ detached: true }));
  expect(killGroup).toHaveBeenCalledWith(-61561, "SIGKILL");
});

it("records one bounded update attempt per AFK upgrade, including failure", async () => {
  vi.useFakeTimers();
  let last: string | undefined;
  const remember = async (version: string) => { last = version; };
  const child = new FakeChild();
  const log = vi.fn();
  const killGroup = vi.fn(() => { child.close(null); return true; });
  const run = vi.fn((file: string, args: string[], opts: Parameters<typeof runAgyCommand>[2]) =>
    runAgyCommand(file, args, { ...opts, platform: "linux", spawnChild: vi.fn().mockReturnValue(child) as typeof spawn, killGroup }));
  await updateAgyCliOnUpgrade("fake agy", "4.17.2", last, remember, log, { run });
  expect(last).toBe("4.17.2");
  expect(run).not.toHaveBeenCalled();
  const upgrade = updateAgyCliOnUpgrade("fake agy", "4.17.3", last, remember, log, { run });
  await vi.advanceTimersByTimeAsync(19_999);
  expect(killGroup).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await upgrade;
  expect(killGroup).toHaveBeenCalledWith(-61561, "SIGKILL");
  expect(log).toHaveBeenCalledWith(expect.stringContaining("continuing with the installed CLI"));
  expect(last).toBe("4.17.3");
  await updateAgyCliOnUpgrade("fake agy", "4.17.3", last, remember, log, { run });
  expect(run).toHaveBeenCalledOnce();
  expect(run).toHaveBeenCalledWith("fake agy", ["update"], { timeoutMs: 20_000, log });
});
