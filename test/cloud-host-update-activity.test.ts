import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CLOUD_UPDATE_BOOT_MARKER, cloudHostBootSupportsUpdate, cloudHostIsIdle, cloudLiveWorkflowRuns } from "../src/cloud-host-update";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { parseRunProgressUpdate } from "../src/run-progress";

vi.mock("node:os", async (original) => ({ ...await original<typeof import("node:os")>(), homedir: vi.fn() }));
let home: string;
const sidebars: any[] = [];
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(10_000_000);
  home = mkdtempSync(join(tmpdir(), "cloud-activity-"));
  vi.mocked(homedir).mockReturnValue(home);
  vi.stubEnv("GROK_CLOUD_ENVIRONMENT", "1");
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ latest: "4.13.1", mandatoryBelow: "4.13.1" }) })));
});
afterEach(() => {
  for (const sidebar of sidebars.splice(0)) sidebar.cloudHostUpdate?.dispose();
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

function fixture(boot: string | null = `${CLOUD_UPDATE_BOOT_MARKER}() { :; }`, provider: Session["provider"] = "grok") {
  if (boot !== null) writeFileSync(join(home, "afkpilot-boot.sh"), boot);
  mkdirSync(join(home, "afkpilot"));
  writeFileSync(join(home, "afkpilot", ".afkpilot-asset"), "Grok-Build-Desktop-4.13.0-linux-x86_64.AppImage");
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  const session = new Session(); session.provider = provider;
  Object.assign(sidebar, {
    host: { exitCloudHost: vi.fn(), appendLine: vi.fn() },
    uplink: { publishCloudUpdate: vi.fn(), maintenance: vi.fn(async () => {}) },
    focused: new Session(), pool: new Set([session]), cloudHostWork: 0,
    cloudWorkflowReceivedAt: new WeakMap(), cloudLastAgentActivity: -Infinity,
    terminalManager: { anyRunning: () => false }, deviceLoginInFlight: () => false,
    relayUrl: () => "wss://relay.invalid", workflowCompletion: vi.fn(),
    sendRemoteSession: vi.fn(), postLocal: vi.fn(),
  });
  sidebars.push(sidebar);
  sidebar.startCloudHostUpdate();
  const client = new EventEmitter();
  sidebar.trackCloudAgentActivity(session, client, session.gen);
  client.on("subagentLifecycle", update => sidebar.emit(session, { type: "runProgress", update }));
  const workflow = (done = false, id = "run") => client.emit("subagentLifecycle", parseRunProgressUpdate({
    sessionUpdate: "workflow_updated", run_id: id, status: done ? "completed" : "active",
  }));
  return { sidebar, session, client, workflow, update: sidebar.cloudHostUpdate, exit: sidebar.host.exitCloudHost };
}

it.each([null, "#!/bin/sh\nXvfb :99 &\nexec host", "directory"])(
  "old, missing or unreadable BOOT offers nothing and ignores the floor (%s)", async boot => {
    const h = fixture(boot === "directory" ? null : boot);
    if (boot === "directory") {
      mkdirSync(join(home, "afkpilot-boot.sh"));
      h.sidebar.startCloudHostUpdate();
    }
    expect(cloudHostBootSupportsUpdate(home)).toBe(false);
    expect(h.update).toBeUndefined();
    await h.sidebar.onAdmittedMessage({ type: "cloudHostUpdate" });
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(fetch).not.toHaveBeenCalled();
    expect(h.sidebar.uplink.publishCloudUpdate).not.toHaveBeenCalled();
    expect(h.sidebar.uplink.maintenance).not.toHaveBeenCalled();
    expect(h.exit).not.toHaveBeenCalled();
  });

it.each([false, true])("new BOOT keeps manual/mandatory update behaviour (mandatory=%s)", async mandatory => {
  vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ latest: "4.13.1", mandatoryBelow: mandatory ? "4.13.1" : null }) } as Response);
  const h = fixture();
  expect(cloudHostBootSupportsUpdate(home)).toBe(true);
  await h.update.check();
  if (!mandatory) {
    expect(h.update.snapshot.state).toBe("available");
    h.update.request();
  }
  await vi.waitFor(() => expect(h.exit).toHaveBeenCalledOnce());
  expect(h.sidebar.uplink.maintenance).toHaveBeenCalledOnce();
});

it.each(["grok", "claude", "muse"] as const)("holds a background %s workflow until completion and quiet", async provider => {
  vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ latest: "4.13.1" }) } as Response);
  const h = fixture(undefined, provider);
  h.workflow();
  await h.update.check(); h.update.request();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.update.snapshot.state).toBe("queued");
  expect(h.exit).not.toHaveBeenCalled();
  h.workflow(true);
  expect(cloudLiveWorkflowRuns([h.session], h.sidebar.cloudWorkflowReceivedAt, Date.now())).toBe(0);
  await vi.advanceTimersByTimeAsync(89_999);
  expect(h.exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await vi.waitFor(() => expect(h.exit).toHaveBeenCalledOnce());
});

it("expires a silent run at 30 minutes, measured from its latest report", async () => {
  const h = fixture(); h.workflow(); await h.update.check();
  await vi.advanceTimersByTimeAsync(60_000); h.workflow();
  await vi.advanceTimersByTimeAsync(1_799_999);
  expect(h.exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await vi.waitFor(() => expect(h.exit).toHaveBeenCalledOnce());
});

it("reconsiders a queued update when disk polling repairs a completed workflow", async () => {
  const h = fixture(); h.workflow(); await h.update.check();
  await vi.advanceTimersByTimeAsync(120_000);
  h.sidebar.workflowCompletion.mockImplementation((_session: Session, update: object) => ({ ...update, done: true }));
  h.sidebar.refreshWorkflowCompletions(h.session);
  expect(h.update.admitting).toBe(false); // Immediate reconsideration, without a timer tick.
  await vi.waitFor(() => expect(h.exit).toHaveBeenCalledOnce());
});

it.each(["messageChunk", "thoughtChunk", "toolCallUpdate", "mediaContent", "childStream", "update"])(
  "holds an unprompted delivery's %s and resets the 90-second quiet period", async event => {
    const h = fixture(undefined, "muse");
    h.client.emit(event, "delivery"); await h.update.check();
    expect(h.session.turnToken).toBeUndefined();
    await vi.advanceTimersByTimeAsync(89_000); h.client.emit(event, "more delivery");
    await vi.advanceTimersByTimeAsync(89_999);
    expect(h.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(h.exit).toHaveBeenCalledOnce());
  });

it("uses the latest frame per run and keeps identical run IDs in separate sessions", () => {
  const h = fixture(); h.workflow(); h.workflow();
  const other = new Session();
  const frame = structuredClone(h.session.buffer[0]); other.buffer.push(frame);
  h.sidebar.cloudWorkflowReceivedAt.set(frame, Date.now());
  const count = () => cloudLiveWorkflowRuns([h.session, other], h.sidebar.cloudWorkflowReceivedAt, Date.now());
  expect(count()).toBe(2);
  h.workflow(true); expect(count()).toBe(1);
  expect(cloudHostIsIdle([h.session, other], false, false, 0, count(), -Infinity, Date.now())).toBe(false);
  vi.setSystemTime(Date.now() + 1_800_000);
  expect(count()).toBe(0);
  expect(cloudHostIsIdle([h.session, other], false, false, 0, count(), -Infinity, Date.now())).toBe(true);
});

it("counts replayed agent output conservatively but ignores a replaced client's output", () => {
  const h = fixture();
  h.session.replaying = true;
  h.client.emit("messageChunk", "replayed or concurrent live output");
  expect(cloudHostIsIdle([h.session], false, false, 0, 0, h.sidebar.cloudLastAgentActivity, Date.now())).toBe(false);
  vi.setSystemTime(Date.now() + 90_000);
  h.session.gen++;
  h.client.emit("messageChunk", "stale client");
  expect(cloudHostIsIdle([h.session], false, false, 0, 0, h.sidebar.cloudLastAgentActivity, Date.now())).toBe(true);
});

const relayBootstrap = new URL("../../grok-remote/src/pool-bootstrap.ts", import.meta.url);
it.skipIf(!existsSync(relayBootstrap))("pins the restart-safe BOOT marker to the relay function", () => {
  expect(CLOUD_UPDATE_BOOT_MARKER).toBe("cleanup_display");
  expect(readFileSync(relayBootstrap, "utf8")).toContain(`${CLOUD_UPDATE_BOOT_MARKER}() {`);
});
