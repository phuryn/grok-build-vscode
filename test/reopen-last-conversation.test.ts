import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GrokSidebar } from "../src/sidebar";
import { Uri } from "../src/host";
import { normalizeRepoPath } from "../src/sessions";

// #233: after a window reload or an extension-host restart the panel opened a
// blank "New session" instead of the conversation the person was in. The panel
// now remembers, per window root, the conversation it last showed, and a cold
// start reopens it.

vi.mock("../src/cli-locator", async original => ({
  ...await original<typeof import("../src/cli-locator")>(), locateGrokCli: vi.fn(() => undefined),
}));

const KEY = "grok.lastConversation";
let dir: string;
const hosts: any[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "reopen-last-"));
  vi.stubEnv("GROK_HOME", dir);
});
afterEach(() => {
  for (const s of hosts.splice(0)) {
    clearInterval(s.routineTimer); clearInterval(s.workflowTimer);
    for (const controller of s.providerRuns.values()) controller.abort();
  }
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

function host(saved: Record<string, any> = {}) {
  const values: Record<string, any> = { ...saved };
  const state = { get: (key: string, fallback?: any) => values[key] ?? fallback,
    update: vi.fn(async (key: string, value: any) => { values[key] = value; }) };
  const context = { globalState: state, subscriptions: [], extensionUri: Uri.file(process.cwd()), globalStorageUri: Uri.file(dir), extension: { packageJSON: { version: "4.15.9" } } };
  const h = {
    appendLine: vi.fn(), workspaceRoot: () => dir, workspaceFolders: () => [dir],
    getConfiguration: () => ({ get: (_key: string, fallback?: any) => fallback, inspect: () => undefined }),
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
    secrets: { get: async () => undefined },
    setContext: vi.fn(), showErrorMessage: vi.fn(), showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(), getActiveTextEditor: () => undefined,
    fs: { readFile: async () => Buffer.from(""), writeFile: async () => {}, createDirectory: async () => {} },
  };
  const s = new GrokSidebar(context as any, h as any) as any;
  hosts.push(s);
  for (const name of ["postVoiceConfigured", "postRemoteStatus", "postMcpConnectors", "postProjectSetup", "refreshGithubState", "refreshImplicitChip", "postProviderState", "probeProviderVersion", "warmDeepSeekCatalogOnBoot", "sweepEmptySessions", "postSessionsList"]) s[name] = vi.fn(async () => undefined);
  s.post = vi.fn();
  s.usableProviders = () => ["grok"];
  s.connectedProviders = () => ["grok"];
  s.startSession = vi.fn(async () => undefined);
  s.openSession = vi.fn(async () => undefined);
  return { s, state, values };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe("a cold start reopens the conversation the window last showed (#233)", () => {
  it("opens the remembered conversation instead of a blank session", async () => {
    const { s } = host({ [KEY]: { [normalizeRepoPath(dir)]: "conv-1" } });
    s.postInitialState();
    await settle();
    expect(s.openSession).toHaveBeenCalledWith("conv-1");
    expect(s.startSession).not.toHaveBeenCalled();
  });

  it("starts blank when nothing is remembered for this window's folder", async () => {
    const { s } = host({ [KEY]: { [normalizeRepoPath(path.join(dir, "other"))]: "conv-1" } });
    s.postInitialState();
    await settle();
    expect(s.openSession).not.toHaveBeenCalled();
    expect(s.startSession).toHaveBeenCalledWith(undefined, s.focused, "ensure");
  });

  it("starts blank when the remembered conversation's agent cannot answer now", async () => {
    const { s } = host({
      [KEY]: { [normalizeRepoPath(dir)]: "conv-1" },
      "grok.sessionMeta": { "conv-1": { provider: "codex" } },
    });
    s.postInitialState();
    await settle();
    expect(s.openSession).not.toHaveBeenCalled();
    expect(s.startSession).toHaveBeenCalledWith(undefined, s.focused, "ensure");
  });

  it("falls back to a blank session when the reopen throws", async () => {
    const { s } = host({ [KEY]: { [normalizeRepoPath(dir)]: "conv-1" } });
    s.openSession = vi.fn(async () => { throw new Error("load failed"); });
    s.postInitialState();
    await settle(); await settle();
    expect(s.openSession).toHaveBeenCalledWith("conv-1");
    expect(s.startSession).toHaveBeenCalledWith(undefined, s.focused, "ensure");
  });

  it("leaves a view rebuilt under a live session on that session", async () => {
    const { s } = host({ [KEY]: { [normalizeRepoPath(dir)]: "conv-1" } });
    s.focused.client = { sessionId: "live" };
    s.postInitialState();
    await settle();
    expect(s.openSession).not.toHaveBeenCalled();
    expect(s.startSession).toHaveBeenCalledWith(undefined, s.focused, "ensure");
  });
});

describe("what the panel remembers", () => {
  const key = () => normalizeRepoPath(dir);

  it("remembers a conversation with history", () => {
    const { s, values } = host();
    Object.assign(s.focused, { activeSessionId: "conv-2", hasHistory: true, client: { sessionId: "conv-2" } });
    s.rememberLocalConversation();
    expect(values[KEY]).toEqual({ [key()]: "conv-2" });
  });

  it("forgets it when the person is in a live new session", () => {
    const { s, values } = host({ [KEY]: { [normalizeRepoPath(dir)]: "conv-2", other: "x" } });
    Object.assign(s.focused, { activeSessionId: "fresh", hasHistory: false, client: { sessionId: "fresh" } });
    s.rememberLocalConversation();
    expect(values[KEY]).toEqual({ other: "x" });
  });

  it("leaves it alone before any agent runs, and while an open is still loading", () => {
    const { s, state } = host({ [KEY]: { [normalizeRepoPath(dir)]: "conv-2" } });
    s.rememberLocalConversation(); // pristine startup session: no client, no history
    Object.assign(s.focused, { hasHistory: true, activeSessionId: undefined, client: {} });
    s.rememberLocalConversation(); // opening: history promised, id not yet assigned
    expect(state.update.mock.calls.some(([k]: any[]) => k === KEY)).toBe(false);
  });

  it("writes only when the remembered conversation changes", () => {
    const { s, state } = host({ [KEY]: { [normalizeRepoPath(dir)]: "conv-2" } });
    Object.assign(s.focused, { activeSessionId: "conv-2", hasHistory: true, client: { sessionId: "conv-2" } });
    s.rememberLocalConversation();
    expect(state.update.mock.calls.some(([k]: any[]) => k === KEY)).toBe(false);
  });
});
