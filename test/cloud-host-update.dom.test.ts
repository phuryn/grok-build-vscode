import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudHostUpdate } from "../src/cloud-host-update";
import { bootWebview, click, dispatch, openAppSettings, type Harness } from "./webview-harness";

const opened: Harness[] = [];
function boot(remote = true, beforeScripts?: NonNullable<Parameters<typeof bootWebview>[0]>["beforeScripts"]) {
  const h = bootWebview({ remote, beforeScripts }); opened.push(h); return h;
}
afterEach(async () => { for (const h of opened.splice(0)) await h.window.happyDOM.abort(); });
const available = { type: "cloudHostUpdateState", installed: "4.13.0", latest: "4.13.1", state: "available" };
function banner(h: Harness) { return h.doc.getElementById("cloud-host-update-banner"); }
function link(h: Harness, reachable: boolean, connection = 1) {
  dispatch(h.window, { type: "hostLink", link: { reachable, connection, phase: reachable ? "up" : "offline", restored: reachable, since: Date.now() } });
}
function request(h: Harness) {
  dispatch(h.window, available);
  click(h.window, banner(h)!.querySelector("button")!);
}

describe("cloud update capability and outcome", () => {
  it("uses frame arrival, never the host version or cloud hint", () => {
    const h = boot(true, (win) => { (win as any).grokCloudHost = true; });
    dispatch(h.window, { type: "initialState", extVersion: "99.0.0", hostKind: "desktop" });
    expect(banner(h)).toBeNull();
    dispatch(h.window, available);
    expect(banner(h)?.textContent).toContain("Update available — 4.13.1");
    h.posted.length = 0;
    click(h.window, banner(h)!.querySelector("button")!);
    expect(h.posted).toEqual([{ type: "cloudHostUpdate" }]);
  });

  it("forgets both banner and About row across a host reconnect until a new frame", () => {
    const h = boot(); link(h, true);
    dispatch(h.window, available);
    openAppSettings(h.window, h.doc);
    click(h.window, h.doc.querySelector('[data-category="about"]')!);
    const row = () => h.doc.querySelector('[data-id="aboutCloudHostUpdate"]');
    expect(row()?.textContent).toContain("Update now");
    h.posted.length = 0;
    click(h.window, row()!.querySelector("button")!);
    expect(h.posted).toContainEqual({ type: "cloudHostUpdate" });
    link(h, false); link(h, true, 2);
    expect(banner(h)).toBeNull(); expect(row()).toBeNull();
    dispatch(h.window, { type: "initialState", extVersion: "4.13.1" });
    expect(banner(h)).toBeNull();
    dispatch(h.window, available);
    expect(banner(h)?.textContent).toContain("came back on 4.13.0");
  });

  it("also forgets capability on the legacy hostReachable signal", () => {
    const h = boot(); dispatch(h.window, available);
    dispatch(h.window, { type: "hostReachable" });
    expect(banner(h)).toBeNull();
  });

  it("shows required queued and updating states without an action button", () => {
    const h = boot();
    dispatch(h.window, { ...available, state: "queued", mandatory: true });
    expect(banner(h)?.textContent).toContain("Required update — Will update when the agent is idle");
    expect(banner(h)?.querySelector("button")).toBeNull();
    dispatch(h.window, { ...available, state: "updating" });
    expect(banner(h)?.textContent).toContain("Updating the cloud host");
  });

  it("claims success only from the asset version after reconnect, including a newer BOOT release", () => {
    const h = boot(); request(h);
    dispatch(h.window, { ...available, state: "updating" });
    link(h, false); link(h, true, 2);
    expect(banner(h)).toBeNull();
    dispatch(h.window, { ...available, installed: "4.13.2", latest: "4.13.2", state: "current" });
    expect(banner(h)?.textContent).toBe("Updated to 4.13.2");
    expect(banner(h)?.querySelector("button")).toBeNull();
  });

  it("remembers the request across a page reload but never persists capability", () => {
    const first = boot(); request(first);
    dispatch(first.window, { ...available, state: "updating" });
    const storage = first.window.sessionStorage;
    const key = Array.from({ length: storage.length }, (_, i) => storage.key(i)!)
      .find((k) => k.startsWith("grok.cloudHostUpdate:"))!;
    const saved = storage.getItem(key)!;
    const second = boot(true, (win) => { win.sessionStorage.setItem(key, saved); });
    expect(banner(second)).toBeNull();
    dispatch(second.window, { ...available, installed: "4.13.1", state: "current" });
    expect(banner(second)?.textContent).toBe("Updated to 4.13.1");
  });

  it.each(["network", "latest:null"])("keeps the successful outcome when the new host's first check fails (%s)", async (failure) => {
    const h = boot(); request(h);
    dispatch(h.window, { ...available, state: "updating" });
    link(h, false); link(h, true, 2);
    const publish = vi.fn((frame) => { dispatch(h.window, frame); });
    const update = new CloudHostUpdate({
      installed: "4.13.1", attempt: { target: "4.13.1", at: Date.now() },
      saveAttempt: vi.fn(), random: () => 0.5,
      check: async () => {
        if (failure === "network") throw new Error("network unavailable");
        return { latest: null };
      },
      idle: () => true, publish, maintenance: async () => {}, removeStamp: async () => {}, exit: vi.fn(),
    });
    try {
      dispatch(h.window, update.snapshot);
      expect(banner(h)?.textContent).toBe("Updated to 4.13.1");
      await update.check();
      expect(publish).not.toHaveBeenCalled();
      expect(banner(h)?.textContent).toBe("Updated to 4.13.1");
      expect(banner(h)?.querySelector("button")).toBeNull();
    } finally { update.dispose(); }
  });

  it("preserves success across frames and reconnects until a later request fails", () => {
    const h = boot(); request(h);
    dispatch(h.window, { ...available, state: "updating" });
    link(h, false); link(h, true, 2);
    const current = { ...available, installed: "4.13.1", state: "current" };
    dispatch(h.window, current);
    link(h, false, 2); link(h, true, 3);
    expect(banner(h)).toBeNull();
    dispatch(h.window, current);
    expect(banner(h)?.textContent).toBe("Updated to 4.13.1");
    const later = { ...current, latest: "4.13.2", state: "available" };
    dispatch(h.window, later);
    expect(banner(h)?.textContent).toContain("Updated to 4.13.1");
    dispatch(h.window, { ...current, state: "failed", error: "An old failure" });
    expect(banner(h)?.textContent).toContain("Updated to 4.13.1");
    dispatch(h.window, later);
    click(h.window, banner(h)!.querySelector("button")!);
    dispatch(h.window, { ...later, state: "failed", error: "Could not restart the cloud host to update. Please try again." });
    expect(banner(h)?.textContent).toContain("Could not restart the cloud host to update. Please try again.");
    expect(banner(h)?.textContent).not.toContain("Updated to");
  });

  it("shows the host's retry explanation instead of the generic old-version outcome", () => {
    const h = boot(); request(h);
    dispatch(h.window, { ...available, state: "updating" });
    link(h, false); link(h, true, 2);
    dispatch(h.window, { ...available, state: "failed", error: "The update did not finish installing." });
    const error = "The update to 4.13.1 did not finish installing. It will retry automatically in about an hour — or press Update now.";
    dispatch(h.window, { ...available, state: "failed", mandatory: true, error });
    expect(banner(h)?.textContent).toContain(error);
    expect(banner(h)?.querySelector("button")?.textContent).toBe("Update now");
  });

  it("reports the deadline without resurrecting controls on a disconnected host", () => {
    let deadline: (() => void) | undefined;
    const h = boot(true, (win) => {
      const original = win.setTimeout.bind(win);
      win.setTimeout = ((fn: () => void, ms: number) => {
        if (ms > 899_000 && ms <= 900_000) { deadline = fn; return 1; }
        return original(fn, ms);
      }) as typeof win.setTimeout;
    });
    request(h); dispatch(h.window, { ...available, state: "updating" }); link(h, false);
    expect(deadline).toBeTypeOf("function"); deadline!();
    expect(h.doc.body.textContent).toContain("has not confirmed its update after 15 minutes");
    expect(banner(h)).toBeNull();
  });

  it("does not change the desk UI", () => {
    const h = boot(false);
    dispatch(h.window, available);
    expect(banner(h)).toBeNull();
  });
});
