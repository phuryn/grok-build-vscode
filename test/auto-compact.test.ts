import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTO_COMPACT_PRESETS, autoCompactNotice } from "../src/auto-compact";
import { AcpClient } from "../src/acp";
import { AgyBackend } from "../src/agy-backend";
import { ClaudeBackend } from "../src/claude-backend";
import { CodexBackend } from "../src/codex-backend";
import { DeepSeekBackend } from "../src/deepseek-backend";
import { grokBackend } from "../src/grok-backend";
import { MuseBackend } from "../src/muse-backend";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "afk-compaction-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function launch(compactAt?: number, modelWindow?: number) {
  return { cwd: root, cliPath: process.execPath, compactAt, modelWindow,
    env: { CLAUDE_CONFIG_DIR: root, CODEX_HOME: root, GROK_HOME: root } };
}

describe("agent-owned automatic compaction", () => {
  const claude = () => new ClaudeBackend({ adapterPath: "fake-claude.js" });
  const codex = () => new CodexBackend({ adapterPath: "fake-codex.js" });
  const deepseek = (harness: "default" | "minimal" = "default") => new DeepSeekBackend({
    storageRoot: root, harness, assets: join(process.cwd(), "resources/deepseek"),
  });
  const claudeKey = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";
  const grokKey = "GROK_AUTO_COMPACT_THRESHOLD_PERCENT";

  it("leaves all five launches alone while off and leaves Antigravity alone when on", () => {
    const c = claude();
    for (const backend of [c, codex(), grokBackend, new MuseBackend(), deepseek()]) {
      expect(backend.spawn(launch()).autoCompact).toBeUndefined();
    }
    expect(c.sessionParams()).toEqual({});
    const agy = new AgyBackend({ program: "cli" });
    expect(agy.spawn(launch(300_000))).toEqual(agy.spawn(launch()));
  });

  it.each(AUTO_COMPACT_PRESETS)("passes preset %i to the native backends", limit => {
    const c = claude();
    const claudeRun = c.spawn(launch(limit));
    expect(c.sessionParams()).toMatchObject({ _meta: { claudeCode: { options: {
      env: { [claudeKey]: String(limit + 33_000) }, settings: { env: { [claudeKey]: String(limit + 33_000) } },
    } } } });
    expect(claudeRun.autoCompact?.(1_000_000)).toEqual({ tokens: limit, source: "limit" });
    expect(claudeRun.autoCompact?.(200_000)).toEqual({ tokens: 167_000, source: "agent" });
    const codexRun = codex().spawn(launch(limit));
    expect(JSON.parse(codexRun.env.CODEX_CONFIG!).model_auto_compact_token_limit).toBe(limit);
    const codexNative = 450_000;
    expect(codexRun.autoCompact?.(475_000)).toEqual({
      tokens: Math.min(limit, codexNative), source: limit < codexNative ? "limit" : "agent",
    });
    const museRun = new MuseBackend().spawn(launch(limit));
    const musePolicy = JSON.parse(museRun.env.GROK_MUSE_POSTURE!).compact;
    expect(musePolicy.hard).toBe(limit / 1_048_576);
    expect(musePolicy.soft).toBeLessThan(musePolicy.hard);
    expect(museRun.autoCompact?.(1_048_576)).toEqual({ tokens: limit, source: "limit" });

    for (const harness of ["default", "minimal"] as const) {
      const run = deepseek(harness).spawn(launch(limit));
      expect(run.args.at(-2)).toBe("--patch");
      expect(readFileSync(run.args.at(-1)!, "utf8"))
        .toBe(`- id: compaction-basic\n  config:\n    thresholdRatio: ${limit / 1_048_576}\n`);
      expect(run.autoCompact?.(1_048_576)).toEqual({
        tokens: Math.min(limit, 727_040), source: limit < 727_040 ? "limit" : "agent",
      });
    }
    const grok = grokBackend.spawn(launch(limit, 500_000));
    expect(grok.env[grokKey]).toBe(limit < 400_000 ? String(limit / 5_000) : undefined);
    expect(grok.autoCompact?.(500_000, Math.min(80, limit / 5_000))).toEqual({
      tokens: Math.min(limit, 400_000), source: limit < 400_000 ? "limit" : "agent",
    });
  });

  it("keeps Grok's earlier reported threshold and requires a live percentage for the meter", () => {
    const native = grokBackend.spawn(launch(300_000, 256_000));
    expect(native.env[grokKey]).toBeUndefined();
    expect(native.autoCompact?.(256_000)).toBeNull();
    expect(native.autoCompact?.(256_000, 80)).toEqual({ tokens: 204_800, source: "agent" });
    const capped = grokBackend.spawn(launch(300_000, 500_000));
    expect(capped.args).toContain("--no-leader");
    expect(capped.autoCompact?.(500_000, 50)).toEqual({ tokens: 250_000, source: "agent" });
    writeFileSync(join(root, "config.toml"), "[session]\nauto_compact_threshold_percent = 50\n");
    expect(grokBackend.spawn(launch(300_000, 500_000)).env[grokKey]).toBeUndefined();
  });

  it("keeps Codex's native cap and earlier explicit limits", () => {
    expect(codex().spawn(launch(300_000)).autoCompact?.(258_400)).toEqual({ tokens: 244_800, source: "agent" });
    writeFileSync(join(root, "config.toml"), "model_auto_compact_token_limit = 150_000\n");
    const options = launch(300_000);
    const run = codex().spawn({ ...options, env: { ...options.env, CODEX_CONFIG: '{"features":{"x":true}}' } });
    expect(JSON.parse(run.env.CODEX_CONFIG!)).toEqual({ features: { x: true }, model_auto_compact_token_limit: 150_000 });
    expect(run.autoCompact?.(475_000)).toEqual({ tokens: 150_000, source: "agent" });
  });

  it.each(["DISABLE_COMPACT", "DISABLE_AUTO_COMPACT"])("respects Claude's %s", key => {
    const backend = claude();
    const options = launch(300_000);
    const run = backend.spawn({ ...options, env: { ...options.env, [key]: "1" } });
    expect(backend.sessionParams()).toEqual({});
    expect(run.autoCompact?.(1_000_000)).toBeNull();
  });

  it("respects Claude's settings switch and preserves its file", () => {
    const backend = claude();
    const file = join(root, "settings.json");
    const contents = '{"autoCompactEnabled":false}';
    writeFileSync(file, contents);
    expect(backend.spawn(launch(300_000)).autoCompact?.(1_000_000)).toBeNull();
    expect(backend.sessionParams()).toEqual({});
    expect(readFileSync(file, "utf8")).toBe(contents);
  });

  it("keeps Claude's earlier window in its CLI shorthand", () => {
    const backend = claude();
    const options = launch(300_000);
    const run = backend.spawn({ ...options, env: { ...options.env, [claudeKey]: "200k" } });
    expect(backend.sessionParams()).toEqual({});
    expect(run.autoCompact?.(1_000_000)).toEqual({ tokens: 167_000, source: "agent" });
  });

  it("labels completion only with the evidence the agent sent", () => {
    expect(autoCompactNotice({ before: 304_000, after: 38_000 }, { tokens: 300_000, source: "limit" }))
      .toBe("Context compacted at your 300K limit: 304K, now 38K.");
    expect(autoCompactNotice({ after: 38_000 })).toBe("Context compacted. Now 38K.");
    expect(autoCompactNotice({})).toBe("Context compacted.");
  });

  it("deduplicates Claude's automatic completion and ignores manual and replayed boundaries", () => {
    const backend = claude();
    const client = new AcpClient({ ...launch(300_000), backend, log: () => {} });
    const wire = client as any;
    wire.autoCompact = backend.spawn(launch(300_000)).autoCompact;
    client.sessionId = "active";
    const report = vi.fn();
    client.on("autoCompaction", report);
    const boundary = (toolCallId: string, trigger: string) => wire.handleSessionUpdate({
      sessionUpdate: "tool_call_update", toolCallId,
      _meta: { contextCompaction: { version: 1, trigger, preTokens: 304_000, postTokens: 38_000 } },
    }, undefined, "active");
    boundary("manual", "manual");
    wire.loadingSessionId = "active";
    boundary("replayed", "automatic");
    wire.loadingSessionId = undefined;
    boundary("live", "automatic");
    boundary("live", "automatic");
    expect(report.mock.calls).toEqual([[{ id: "live", before: 304_000, after: 38_000 }]]);
  });
});

it("writes a standalone Settings change and mirrors the result to the desk and remote", async () => {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  const prefs = new Map<string, unknown>();
  const listeners: Array<(event: { affectsConfiguration(key: string): boolean }) => void> = [];
  const deskPost = vi.fn();
  const settingsPost = vi.fn();
  const remotePost = vi.fn();
  const update = vi.fn(async (key: string, value: unknown) => {
    prefs.set(key, value);
    for (const listener of listeners) listener({ affectsConfiguration: section => section === `grok.${key}` });
  });
  sidebar.focused = new Session();
  sidebar.host = {
    getConfiguration: () => ({ get: (key: string, fallback: unknown) => prefs.get(key) ?? fallback, update }),
    onDidChangeConfiguration: (listener: (typeof listeners)[number]) => {
      listeners.push(listener);
      return { dispose() {} };
    },
    createFileSystemWatcher: () => ({ onDidCreate() {}, onDidChange() {}, onDidDelete() {}, dispose() {} }),
  };
  for (const method of ["forgetPostedVoiceConfigured", "restorePersistedDraft", "watchActiveEditor",
    "applyTerminalShellPref", "maybeStartUplink"]) sidebar[method] = vi.fn();
  sidebar.chatLocalResourceRoots = () => [];
  sidebar.getHtml = () => "";
  sidebar.workspaceRoot = () => root;
  sidebar.reaper = {};
  sidebar.settingsEditor = { webview: { postMessage: settingsPost } };
  sidebar.broadcastRemoteDevice = remotePost;
  sidebar.resolveWebviewView({ webview: { postMessage: deskPost, onDidReceiveMessage: vi.fn() } });

  await sidebar.onSettingsPanelMessage({ type: "setAutoCompact", key: "enabled", value: true });
  expect(update).toHaveBeenCalledWith("autoCompactEnabled", true, "global");
  const receipt = { type: "autoCompactSettings", value: { enabled: true, tokens: 300_000 } };
  for (const post of [deskPost, settingsPost, remotePost]) expect(post).toHaveBeenCalledWith(receipt);
});
