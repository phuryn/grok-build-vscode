import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudHostUpdate, cloudHostIsIdle, cloudUpdateMandatory, installedCloudHostVersion, parseCloudHostUpdateAttempt, type CloudHostUpdateAttempt } from "../src/cloud-host-update";
import { Session } from "../src/session";
import { allowFromRemote, mayDeliverRemoteHostMsg, remoteRequiresBoundSession } from "../src/remote-policy";
import { parseWebviewMsg } from "../src/desktop/webview-msg-validate";
import { parseRelayFrame } from "../src/remote-frames";
import { TerminalManager } from "../src/terminal-manager";

const updates: CloudHostUpdate[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(() => { updates.splice(0).forEach((u) => u.dispose()); vi.useRealTimers(); });

function setup(overrides: Partial<ConstructorParameters<typeof CloudHostUpdate>[0]> = {}) {
  const events: string[] = [];
  const sessions = [new Session(), new Session()];
  const check = vi.fn(async () => ({ latest: "4.13.1", mandatoryBelow: null }));
  const exit = vi.fn(() => { events.push("exit"); });
  const saveAttempt = vi.fn(() => { events.push("attempt saved"); });
  const update = new CloudHostUpdate({
    installed: "4.13.0", check, saveAttempt, random: () => 0.5,
    idle: () => cloudHostIsIdle(sessions, false, false),
    publish: (s) => { events.push(s.state); },
    maintenance: async () => { expect(update.admitting).toBe(false); events.push("maintenance"); },
    removeStamp: async () => { events.push("stamp removed"); }, exit,
    ...overrides,
  });
  updates.push(update);
  return { update, check, events, exit, sessions, saveAttempt };
}

describe("BOOT asset version", () => {
  it.each([
    ["Grok-Build-Desktop-4.13.0-linux-x86_64.AppImage", "4.13.0"],
    ["https://github.com/phuryn/grok-build-vscode/releases/download/v4.13.0/Grok-Build-Desktop-4.13.0-linux-x86_64.AppImage\n", "4.13.0"],
    [undefined, null], [null, null], ["", null], ["junk", null],
    ["Grok-Build-Desktop-4.13.0-linux-arm64.AppImage", null],
    ["Grok-Build-Desktop-4.13.0-beta-linux-x86_64.AppImage", null],
    ["junkGrok-Build-Desktop-4.13.0-linux-x86_64.AppImage", null],
  ])("parses %s", (asset, wanted) => expect(installedCloudHostVersion(asset)).toBe(wanted));

  it("never offers or applies an update without an asset record", async () => {
    const h = setup({ installed: null, check: async () => ({ latest: "9.0.0", mandatoryBelow: "9.0.0" }) });
    await h.update.check(); h.update.request();
    expect(h.update.snapshot).toMatchObject({ installed: null, state: "current" });
    expect(h.exit).not.toHaveBeenCalled();
  });
});

describe("metadata schedule", () => {
  it.each([0, 0.9999])("keeps startup jitter within a minute (%s)", async (random) => {
    const h = setup({ random: () => random });
    const delay = Math.floor(random * 60_000);
    if (delay) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(h.check).not.toHaveBeenCalled();
    }
    await vi.advanceTimersByTimeAsync(delay ? 1 : 0);
    expect(h.check).toHaveBeenCalledTimes(1);
  });

  it("jitters startup, checks hourly, and coalesces the initial uplink hello", async () => {
    const h = setup(); h.update.connected();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_599_999);
    expect(h.check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.check).toHaveBeenCalledTimes(2);
  });

  it("checks a suspended wall-clock gap and an uplink reconnect", async () => {
    const h = setup(); await h.update.check(); h.update.connected();
    vi.setSystemTime(Date.now() + 600_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.check).toHaveBeenCalledTimes(2);
    h.update.connected(); await vi.advanceTimersByTimeAsync(0);
    expect(h.check).toHaveBeenCalledTimes(3);
  });

  it("throttles client-ready for five minutes and consumes the startup check", async () => {
    const h = setup(); h.update.clientReady(); await vi.advanceTimersByTimeAsync(0);
    h.update.clientReady();
    await vi.advanceTimersByTimeAsync(299_999); h.update.clientReady();
    expect(h.check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); h.update.clientReady();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.check).toHaveBeenCalledTimes(2);
  });

  it.each(["reject", "null", "junk"])("backs off %s metadata even across reconnect and ready", async (failure) => {
    const check = vi.fn(async () => {
      if (failure === "reject") throw new Error("network unavailable");
      return { latest: failure === "null" ? null : "junk" };
    });
    const h = setup({ check });
    const previous = h.update.snapshot;
    await h.update.check();
    h.update.connected(); h.update.connected(); h.update.clientReady();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(check).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(3);
    expect(h.update.snapshot).toEqual(previous);
    expect(h.events).toEqual([]);
  });
});

describe("mandatory floor", () => {
  it.each([
    ["4.13.0", "4.13.1", "4.13.1", true],
    ["4.9.0", "4.13.1", "4.10.0", true],
    ["4.13.1", "4.13.2", "4.13.1", false],
    ["4.13.0", "4.13.1", "4.14.0", false],
    ["4.13.0", "4.13.1", "v4.13.1", false],
    ["4.13.0", "4.13.1", null, false],
    [null, "4.13.1", "4.13.1", false],
  ])("evaluates %s < %s with floor %s", (installed, latest, floor, wanted) => {
    expect(cloudUpdateMandatory(installed, latest, floor)).toBe(wanted);
  });

  it("queues automatically, but waits for all sessions", async () => {
    const h = setup({ check: async () => ({ latest: "4.13.1", mandatoryBelow: "4.13.1" }) });
    h.sessions[1].turnToken = {};
    await h.update.check();
    expect(h.update.snapshot).toMatchObject({ mandatory: true, state: "queued" });
    expect(h.exit).not.toHaveBeenCalled();
    h.sessions[1].turnToken = undefined;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.exit).toHaveBeenCalledTimes(1);
  });
});

describe("idle gate and handoff", () => {
  it.each(["turn", "permission", "question", "plan", "priming", "queued"])("does not expire a background session's %s", async (kind) => {
    const h = setup(); const s = h.sessions[1];
    if (kind === "turn") s.turnToken = {};
    if (kind === "permission") s.pendingPermissions.set(1, {} as never);
    if (kind === "question") s.pendingQuestions.set(1, "tool");
    if (kind === "plan") s.pendingExitPlans.set(1, { planText: "plan" });
    if (kind === "priming") s.priming = true;
    if (kind === "queued") s.queuedSends = [{ text: "next", chips: [] }];
    await h.update.check(); h.update.request();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.update.snapshot.state).toBe("queued");
    expect(h.update.admitting).toBe(true);
    expect(h.exit).not.toHaveBeenCalled();
  });

  it.each([[true, false, 0], [false, true, 0], [false, false, 1]] as const)(
    "holds for running command=%s, sign-in=%s, admitted work=%s", (command, login, work) => {
      expect(cloudHostIsIdle([new Session()], command, login, work)).toBe(false);
      expect(cloudHostIsIdle([new Session()], false, false, 0)).toBe(true);
    });

  it("two phones queue one handoff, allowing a new turn while queued", async () => {
    const h = setup(); h.sessions[0].turnToken = {};
    await h.update.check(); h.events.length = 0;
    h.update.request(); h.update.request();
    expect(h.events).toEqual(["queued"]);
    expect(h.update.admitting).toBe(true);
    h.sessions[1].turnToken = {}; h.sessions[0].turnToken = undefined;
    h.update.considerApply(); expect(h.exit).not.toHaveBeenCalled();
    h.sessions[1].turnToken = undefined;
    h.update.considerApply();
    expect(h.update.admitting).toBe(false);
    h.update.request(); h.update.considerApply();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.events).toEqual(["queued", "maintenance", "updating", "attempt saved", "stamp removed", "exit"]);
    expect(h.exit).toHaveBeenCalledTimes(1);
  });

  it("reports current after BOOT installs the target and never offers a downgrade", async () => {
    for (const installed of ["4.13.1", "4.14.0"]) {
      const h = setup({ installed }); await h.update.check(); h.update.request();
      expect(h.update.snapshot.state).toBe("current");
      expect(h.exit).not.toHaveBeenCalled();
    }
  });

  it.each(["maintenance", "publish", "removeStamp"])("does not exit after an asynchronous %s failure", async (stage) => {
    const fail = async () => { throw new Error("injected I/O failure"); };
    const h = setup(stage === "publish"
      ? { publish: async (s) => { if (s.state === "updating") await fail(); } }
      : { [stage]: fail });
    await h.update.check(); h.update.request(); await vi.advanceTimersByTimeAsync(0);
    expect(h.exit).not.toHaveBeenCalled();
    expect(h.update.snapshot.state).toBe("failed");
    expect(h.update.admitting).toBe(true);
  });

  it("refuses a late agent terminal request before spawning anything", async () => {
    const h = setup(); await h.update.check(); h.update.request();
    const terminal = new TerminalManager({ beforeCreate: () => {
      if (!h.update.admitting) throw new Error("The cloud host is updating.");
    } });
    expect(() => terminal.ownedBy({}).create({ command: "must never run" })).toThrow("cloud host is updating");
    expect(terminal.anyRunning()).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
  });
});

describe("remembered BOOT attempts", () => {
  const mandatory = async () => ({ latest: "4.13.1", mandatoryBelow: "4.13.1" });

  it("persists the target before exit and suppresses another automatic attempt after BOOT returns the old host", async () => {
    let disk: CloudHostUpdateAttempt | null = null;
    const first = setup({ check: mandatory, saveAttempt: (attempt) => { disk = attempt; } });
    await first.update.check(); await vi.advanceTimersByTimeAsync(0);
    expect(first.exit).toHaveBeenCalledOnce();
    expect(disk).toEqual({ target: "4.13.1", at: 1_000_000 });
    first.update.dispose();
    vi.setSystemTime(Date.now() + 120_000); // BOOT's unsuccessful download budget.
    const second = setup({ attempt: disk, check: mandatory });
    expect(second.update.snapshot.state).toBe("failed");
    await second.update.check();
    expect(second.update.snapshot).toMatchObject({ state: "failed", mandatory: true });
    expect(second.update.snapshot.error).toContain("The update to 4.13.1 did not finish installing");
    expect(second.update.snapshot.error).toContain("retry automatically in about an hour");
    second.update.connected(); second.update.connected(); second.update.clientReady();
    await vi.advanceTimersByTimeAsync(3_479_999);
    expect(second.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(second.exit).toHaveBeenCalledOnce();
    expect(second.saveAttempt).toHaveBeenCalledWith({ target: "4.13.1", at: 4_600_000 });
  });

  it("allows a manual press during cooldown, still waiting for an active turn", async () => {
    const h = setup({ attempt: { target: "4.13.1", at: Date.now() }, check: mandatory });
    h.sessions[0].turnToken = {};
    await h.update.check(); h.update.request();
    await h.update.check(); // Metadata must not retract the manual override.
    expect(h.update.snapshot.state).toBe("queued");
    expect(h.exit).not.toHaveBeenCalled();
    h.sessions[0].turnToken = undefined;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.exit).toHaveBeenCalledOnce();
  });

  it("retries an expired attempt immediately when mandatory, but never forces an optional update", async () => {
    vi.setSystemTime(4_000_000);
    const attempt = { target: "4.13.1", at: Date.now() - 3_600_000 };
    const optional = setup({ attempt }); await optional.update.check();
    expect(optional.update.snapshot.state).toBe("available");
    expect(optional.exit).not.toHaveBeenCalled();
    const required = setup({ attempt, check: mandatory });
    await required.update.check(); await vi.advanceTimersByTimeAsync(0);
    expect(required.exit).toHaveBeenCalledOnce();
  });

  it("keeps the cooldown across a newer release and still waits for idle after it expires", async () => {
    const h = setup({ attempt: { target: "4.13.1", at: Date.now() },
      check: async () => ({ latest: "4.13.2", mandatoryBelow: "4.13.2" }) });
    h.sessions[1].pendingQuestions.set(1, "question");
    await h.update.check();
    expect(h.update.snapshot).toMatchObject({ state: "failed", latest: "4.13.2" });
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(h.update.snapshot.state).toBe("queued");
    expect(h.exit).not.toHaveBeenCalled();
    h.sessions[1].pendingQuestions.clear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.exit).toHaveBeenCalledOnce();
    expect(h.saveAttempt).toHaveBeenCalledWith({ target: "4.13.2", at: Date.now() });
  });

  it.each(["4.13.1", "4.14.0"])("clears a completed attempt when installed is %s", async (installed) => {
    const h = setup({ installed, attempt: { target: "4.13.1", at: Date.now() }, check: mandatory });
    expect(h.saveAttempt).toHaveBeenCalledWith(null);
    await h.update.check();
    expect(h.update.snapshot.state).toBe("current");
    expect(h.exit).not.toHaveBeenCalled();
  });

  it("does not delete BOOT's stamp or exit when the attempt cannot be persisted", async () => {
    const removeStamp = vi.fn(async () => {});
    const h = setup({ check: mandatory, removeStamp, saveAttempt: () => { throw new Error("disk full"); } });
    await h.update.check(); await vi.advanceTimersByTimeAsync(0);
    expect(removeStamp).not.toHaveBeenCalled(); expect(h.exit).not.toHaveBeenCalled();
    expect(h.update.snapshot.state).toBe("failed");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.events.filter((event) => event === "maintenance")).toHaveLength(1);
  });

  it("tolerates failure to delete an already-completed, now-inert record", async () => {
    const h = setup({ installed: "4.13.1", attempt: { target: "4.13.1", at: Date.now() },
      saveAttempt: () => { throw new Error("read-only filesystem"); } });
    await h.update.check();
    expect(h.update.snapshot.state).toBe("current");
    expect(h.exit).not.toHaveBeenCalled();
  });

  it.each(["", "junk", "null", "{}", '{"target":"junk","at":1}', '{"target":"4.13.1","at":-1}'])(
    "ignores malformed bookkeeping: %s", (record) => expect(parseCloudHostUpdateAttempt(record)).toBeNull());

  it("reads the persisted record without accepting installer inputs", () => {
    expect(parseCloudHostUpdateAttempt('{"target":"4.13.1","at":123,"command":"untrusted"}'))
      .toEqual({ target: "4.13.1", at: 123 });
  });
});

describe("cloud update policy", () => {
  it("admits only a full remote on cloud, with no bound conversation or project", () => {
    expect(allowFromRemote("cloudHostUpdate", "full", { isCloud: true })).toBe(true);
    expect(allowFromRemote("cloudHostUpdate", "full")).toBe(false);
    expect(allowFromRemote("cloudHostUpdate", "propose", { isCloud: true })).toBe(false);
    expect(allowFromRemote("cloudHostUpdate", "read-only", { isCloud: true })).toBe(false);
    expect(remoteRequiresBoundSession("cloudHostUpdate")).toBe(false);
    expect(mayDeliverRemoteHostMsg({ type: "cloudHostUpdateState", installed: null, latest: null, state: "current" }, [], undefined, (a, b) => a === b)).toBe(true);
  });

  it("accepts only the fixed action, never a client-supplied installer input", () => {
    expect(parseWebviewMsg({ type: "cloudHostUpdate" })).toEqual({ type: "cloudHostUpdate" });
    for (const key of ["version", "url", "path", "command"]) {
      expect(parseWebviewMsg({ type: "cloudHostUpdate", [key]: "untrusted" })).toBeNull();
      expect(parseRelayFrame(JSON.stringify({ t: "msg", clientId: "phone", msg: { type: "cloudHostUpdate", [key]: "untrusted" } }))).toBeNull();
    }
    expect(parseRelayFrame(JSON.stringify({ t: "msg", clientId: "phone", msg: { type: "cloudHostUpdate" } })))
      .toMatchObject({ msg: { type: "cloudHostUpdate" } });
  });
});
