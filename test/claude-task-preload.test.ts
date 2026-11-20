import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { ClaudeBackend } from "../src/claude-backend";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
let out: string;
let spec: ReturnType<ClaudeBackend["spawn"]>;

beforeAll(() => {
  // Use freshly emitted production code so an old out/ cannot hide a startup
  // regression. Compile once for the whole file, regardless of local builds.
  out = mkdtempSync(join(root, ".tmp-claude-task-preload-"));
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const compiled = spawnSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", ".", "--outDir", out], {
    cwd: root, env, encoding: "utf8", timeout: 60_000,
  });
  expect(compiled.error).toBeUndefined();
  expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
  const { ClaudeBackend } = require(join(out, "claude-backend.js")) as typeof import("../src/claude-backend");
  // Delete, not stubEnv(undefined): assigning undefined to process.env stores
  // the string "undefined", which selects the test adapter branch and drops
  // the preload from the spawn arguments.
  const testAdapter = process.env.GROK_TEST_CLAUDE_ACP_ADAPTER_PATH;
  delete process.env.GROK_TEST_CLAUDE_ACP_ADAPTER_PATH;
  try {
    spec = new ClaudeBackend({ nodePath: require("electron") }).spawn({ cliPath: "unused", cwd: root, env });
  } finally {
    if (testAdapter !== undefined) process.env.GROK_TEST_CLAUDE_ACP_ADAPTER_PATH = testAdapter;
  }
  expect(spec.args[0]).toBe("--import");
  expect(spec.args.at(-1)).toMatch(/claude-agent-acp[\\/]dist[\\/]/);
}, 65_000);

afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

function launch(args: string[]) {
  const result = spawnSync(spec.command, args, { cwd: root, env: spec.env, encoding: "utf8", timeout: 10_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return result;
}

const probe = `
    import assert from "node:assert/strict";
    import { pathToFileURL } from "node:url";
    const { AsyncTaskRuntime } = await import(new URL("./async-tasks.js", pathToFileURL(process.argv[1])));
    const updates = [];
    const runtime = new AsyncTaskRuntime(true, "session", async ({ update }) => { updates.push(update); });
    const spawn = (id, background) => ({
      task_type: "local_agent", task_id: id, tool_use_id: "call-" + id,
      subagent_type: "general", is_backgrounded: background,
    });
    const child = { task_id: "child", task_type: "local_agent" };
    await runtime.backgroundTasksChanged([child]);
    assert.equal(runtime.claimStop("child"), false);
    await runtime.taskStarted(spawn("child", true));
    await runtime.taskStarted(spawn("foreground", false));
    await runtime.backgroundTasksChanged([child, { task_id: "unattributed", task_type: "local_agent" }]);
    assert.equal(runtime.claimStop("child"), true);
    assert.equal(runtime.claimStop("child"), false);
    assert.equal(runtime.claimStop("foreground"), false);
    assert.equal(runtime.claimStop("unattributed"), false);
    await runtime.taskStopped("child");
    await runtime.taskNotification({ task_id: "child", status: "killed" });
    assert.deepEqual(updates.map(update => [update.sessionUpdate, update.asyncTaskId]), [
      ["async_task_spawned", "child"], ["async_task_state_update", "child"],
    ]);
    assert.equal(updates[0].toolCallId, "call-child");
    assert.equal(updates[0].canStop, true);
    assert.equal(updates[1].state, "stopped");
    console.log("patched adapter runtime");
`;

it("starts the bundled Electron runtime and patches the installed adapter's AIR module", () => {
  // The eval receives the installed entry path in argv[1] and imports the
  // adapter's relative dependency without starting a conversation.
  const result = launch([...spec.args.slice(0, -1), "--input-type=module", "--eval", probe, spec.args.at(-1)!]);
  expect(result.stdout.trim()).toBe("patched adapter runtime");
});

it("patches the module next to the entry even with a second installed copy", () => {
  const dir = join(out, "second-copy");
  const dist = join(dir, "dist");
  mkdirSync(dist, { recursive: true });
  const installed = dirname(spec.args.at(-1)!);
  copyFileSync(join(installed, "..", "package.json"), join(dir, "package.json"));
  for (const file of ["async-tasks.js", "air-extension.js"]) copyFileSync(join(installed, file), join(dist, file));
  const entry = join(dist, "entry.js");
  writeFileSync(entry, probe);
  const result = launch([...spec.args.slice(0, -1), entry]);
  expect(result.stdout.trim()).toBe("patched adapter runtime");
});

it.each([
  { name: "missing target", version: "0.76.0" },
  { name: "renamed export", version: "0.76.0", source: "export class RenamedRuntime {};" },
  { name: "unsupported version", version: "0.77.0", source: 'console.log("unexpected runtime import");' },
])("starts the entry with a $name", ({ name, version, source }) => {
  const dir = join(out, name);
  const entry = join(dir, "dist", "entry.js");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version, type: "module" }));
  writeFileSync(entry, 'console.log("adapter entry started");');
  if (source) writeFileSync(join(dirname(entry), "async-tasks.js"), source);
  const result = launch([...spec.args.slice(0, -1), entry]);
  expect(result.stderr).toBe("");
  expect(result.stdout.trim()).toBe("adapter entry started");
});

it("starts the installed adapter when the optional preload file is missing", () => {
  const preload = join(out, "claude-async-task-bridge.mjs");
  const saved = preload + ".saved";
  renameSync(preload, saved);
  try {
    // The version entry point does not start the provider CLI or a conversation.
    const manifest = require("@agentclientprotocol/claude-agent-acp/package.json");
    expect(launch([...spec.args, "--version"]).stdout.trim()).toBe(manifest.version);
  } finally {
    renameSync(saved, preload);
  }
});
