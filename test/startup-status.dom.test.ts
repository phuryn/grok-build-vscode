import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootWebview, click, dispatch, type Harness } from "./webview-harness";
import { GrokSidebar } from "../src/sidebar";
import { Session, sessionUiSnapshot } from "../src/session";
import { RemoteClientState } from "../src/remote-client-state";
import { OUTBOUND_DISPOSITION, OUTBOUND_PROJECT_AUTH, mayDeliverRemoteHostMsg } from "../src/remote-policy";
import { parseWebviewMsg } from "../src/desktop/webview-msg-validate";
import { readFileSync } from "node:fs";

const opened: Harness[] = [];
function boot(remote = false, showOutput?: boolean) {
  const h = bootWebview({ remote, ready: false, beforeScripts: (win) => {
    win.setTimeout = setTimeout as any;
    win.clearTimeout = clearTimeout as any;
    vi.spyOn(win.Date, "now").mockImplementation(() => Date.now());
  } });
  opened.push(h);
  dispatch(h.window, { type: "initialState", cwd: "/repo", capabilities: { showOutput } });
  return h;
}
function status(h: Harness, stage: string | null, extra = {}) {
  dispatch(h.window, { type: "startupStatus", provider: "grok", stage, elapsedMs: 0, ...extra });
}
function strip(h: Harness) { return h.doc.getElementById("startup-strip")!; }
function send(h: Harness) { return h.doc.getElementById("send-btn") as HTMLButtonElement; }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100_000); });
afterEach(async () => {
  for (const h of opened.splice(0)) await h.window.happyDOM.abort();
  vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers();
});

describe("session startup composer strip", () => {
  it.each(["grok", "codex", "claude", "muse"])("names %s and keeps Send disabled", (provider) => {
    const h = boot();
    status(h, "starting", { provider });
    const name = provider[0].toUpperCase() + provider.slice(1);
    expect(strip(h).querySelector(".startup-stage")?.textContent).toBe("Starting " + name);
    expect(strip(h).parentElement?.className).toBe("composer-card");
    expect(strip(h).parentElement?.firstElementChild).toBe(strip(h));
    expect(send(h).disabled).toBe(true);
    expect(send(h).title).toBe(name + " is still starting");
  });
  it.each([
    ["updating", {}, "Updating the Grok CLI"],
    ["opening", { detail: "reading the project" }, "Opening the conversation"],
    ["loading", {}, "Loading messages"],
    ["loading", { messageCount: 42 }, "Loading 42 messages"],
  ])("renders %s", (stage, extra, label) => {
    const h = boot(); status(h, stage as string, extra as object);
    expect(strip(h).querySelector(".startup-stage")?.textContent).toBe(label);
    if (stage === "opening") expect(strip(h).querySelector(".startup-detail")?.textContent).toContain("reading the project");
  });
  it.each(["codex", "claude"])("names a %s CLI update and never calls it slow", (provider) => {
    const h = boot(); status(h, "updating", { provider, elapsedMs: 90000 });
    const name = provider[0].toUpperCase() + provider.slice(1);
    expect(strip(h).querySelector(".startup-stage")?.textContent).toBe(`Updating the ${name} CLI`);
    expect(strip(h).classList.contains("startup-slow")).toBe(false);
    expect(strip(h).textContent).not.toContain("taking longer than usual");
    expect(send(h).title).toBe(name + " is updating");
  });
  it("reveals seconds at 3s and amber/output at 20s across stage changes", () => {
    const h = boot(false, true); status(h, "starting");
    const seconds = () => strip(h).querySelector(".startup-seconds")?.textContent;
    vi.advanceTimersByTime(2999); expect(seconds()).toBe("");
    vi.advanceTimersByTime(1); expect(seconds()).toBe("3s");
    status(h, "opening", { elapsedMs: 3000, detail: "signing in" });
    vi.advanceTimersByTime(16999); expect(strip(h).classList.contains("startup-slow")).toBe(false);
    vi.advanceTimersByTime(1); expect(strip(h).classList.contains("startup-slow")).toBe(true);
    expect(seconds()).toBe("20s");
    expect(strip(h).textContent).toContain("taking longer than usual");
    const output = strip(h).querySelector("button")!;
    expect(output.hidden).toBe(false); click(h.window, output);
    expect(h.posted.at(-1)).toEqual({ type: "showLogs" });
    expect(parseWebviewMsg(h.posted.at(-1))).toEqual({ type: "showLogs" });
    status(h, null); dispatch(h.window, { type: "setBusy", value: false });
    expect(strip(h).hidden).toBe(true); expect(send(h).disabled).toBe(false);
    expect(strip(h).textContent).not.toContain("Connected");
  });
  it.each([[true, true], [false, false], [false, undefined]])("omits output on remote=%s / capability=%s", (remote, capability) => {
    const h = boot(remote, capability); status(h, "starting", { elapsedMs: 20000 });
    expect(strip(h).textContent).toContain("taking longer than usual");
    expect(strip(h).querySelector("button")!.hidden).toBe(true);
  });
  it("leaves an older host unchanged", () => {
    const h = boot();
    const welcome = h.doc.getElementById("welcome-version")!;
    dispatch(h.window, { type: "cliUpdating" });
    expect(welcome.hidden).toBe(false);
    expect(welcome.textContent).toBe("Updating Grok Build CLI");
    dispatch(h.window, { type: "initialized", info: { provider: "grok" } });
    vi.advanceTimersByTime(30000);
    expect(strip(h)).toBeNull(); expect(send(h).title).toBe("Initializing\u2026");
    expect(welcome.textContent).toBe("Starting");
    dispatch(h.window, { type: "setBusy", value: false });
    expect(welcome.hidden).toBe(false);
    expect(welcome.textContent).toBe("Connected");
  });
  it("keeps an on-demand CLI update visible, since it sets no startup stage", () => {
    const h = boot(true);
    const welcome = h.doc.getElementById("welcome-version")!;
    status(h, null);
    dispatch(h.window, { type: "clearMessages" });
    dispatch(h.window, { type: "cliUpdating" });
    expect(strip(h)?.hidden ?? true).toBe(true);
    expect(welcome.hidden).toBe(false);
    expect(welcome.textContent).toBe("Updating Grok Build CLI");
  });
  it("retires only duplicate welcome status after the first startup frame, including a null frame", () => {
    const h = boot(true);
    const style = h.doc.createElement("style");
    style.textContent = readFileSync(new URL("../media/chat.css", import.meta.url), "utf8");
    h.doc.head.appendChild(style);
    const welcome = h.doc.getElementById("welcome-version")!;
    // The relay shell can paint this before receiving any host frame.
    welcome.textContent = "Connecting";
    expect(welcome.hidden).toBe(false);
    status(h, null);
    expect(welcome.hidden).toBe(true);
    status(h, "updating");
    dispatch(h.window, { type: "cliUpdating" });
    expect(welcome.hidden).toBe(true);
    expect(h.window.getComputedStyle(welcome as any).display).toBe("none");
    expect(strip(h).textContent).toContain("Updating the Grok CLI");
    status(h, "opening");
    dispatch(h.window, { type: "initialized", info: { provider: "grok", version: "1.2.3" } });
    expect(welcome.hidden).toBe(true);
    status(h, "loading");
    dispatch(h.window, { type: "historyReplay", active: true });
    expect(welcome.hidden).toBe(true);
    dispatch(h.window, { type: "historyReplay", active: false });
    status(h, null);
    dispatch(h.window, { type: "setBusy", value: false });
    expect(welcome.hidden).toBe(true);
    dispatch(h.window, { type: "clearMessages" });
    expect(welcome.hidden).toBe(true);
    dispatch(h.window, { type: "onboarding", state: "no-project" });
    expect(welcome.hidden).toBe(false);
    expect(welcome.textContent).toBe("No project folder");
    dispatch(h.window, { type: "error", text: "Unable to start the agent" });
    expect(h.doc.getElementById("messages")!.textContent).toContain("Unable to start the agent");
  });
  it.each(["missing-cli", "auth-required"])("keeps actionable %s onboarding after startup frames", mode => {
    const h = boot(); status(h, "starting"); status(h, null);
    dispatch(h.window, { type: "onboarding", state: mode });
    expect(h.doc.getElementById("welcome-version")!.hidden).toBe(false);
    expect(h.doc.getElementById("welcome-onboarding")!.textContent).not.toBe("");
  });
  it("hides during machine wake and clears on a conversation switch", () => {
    const h = boot(true); status(h, "loading", { messageCount: 42 });
    const link = { reachable: false, restored: false, phase: "waking", since: Date.now(), connection: 1 };
    (h.window as any).afkpilotHostLink = link;
    dispatch(h.window, { type: "hostLink", link }); expect(strip(h).hidden).toBe(true);
    const up = { ...link, reachable: true, restored: true, phase: "up" };
    (h.window as any).afkpilotHostLink = up;
    dispatch(h.window, { type: "hostLink", link: up }); expect(strip(h).hidden).toBe(false);
    dispatch(h.window, { type: "clearMessages" }); expect(strip(h).hidden).toBe(true);
  });
  it("routes a background start only to its phone, including replay, and restores the current stage", () => {
    const desk = boot(), phone = boot(true), otherPhone = boot(true);
    const sidebar = Object.create(GrokSidebar.prototype) as any;
    const a = new Session(), b = new Session(); a.cwd = b.cwd = "/repo";
    a.activeSessionId = "desk"; b.activeSessionId = "phone"; b.provider = "claude";
    sidebar.focused = a; sidebar.sessionCache = new Map();
    sidebar.remoteClients = new RemoteClientState("/repo");
    sidebar.remoteClients.ready("phone"); sidebar.remoteClients.setActive("phone", b);
    sidebar.remoteClients.ready("other"); sidebar.remoteClients.setActive("other", a);
    sidebar.view = { webview: { postMessage: (m: unknown) => dispatch(desk.window, m) } };
    sidebar.localizeHistoryMessage = (m: unknown) => m; sidebar.mirrorToProjectsRail = () => {};
    sidebar.sessionCwd = (s: Session) => s.cwd; sidebar.authorizedSessionCwds = () => ["/repo"];
    sidebar.host = { appendLine: vi.fn() };
    sidebar.allAdapterCatalogs = () => [];
    sidebar.sendRemoteClient = (id: string, m: unknown) => dispatch((id === "phone" ? phone : otherPhone).window, m);
    sidebar.emit(b, { type: "setBusy", value: true, locked: true });
    expect(strip(desk)).toBeNull(); expect(strip(otherPhone)).toBeNull();
    expect(strip(phone).textContent).toContain("Starting Claude");
    b.replaying = true; sidebar.emit(b, { type: "historyReplay", active: true });
    expect(strip(phone).textContent).toContain("Loading messages");
    vi.advanceTimersByTime(5000);
    dispatch(phone.window, { type: "clearMessages" });
    for (const msg of sessionUiSnapshot(b, "agent")) dispatch(phone.window, msg);
    expect(strip(phone).textContent).toContain("5s");
    expect(b.buffer.some((m) => m.type === "startupStatus")).toBe(false);
    sidebar.refreshWorkflowCompletions = () => {}; sidebar.isAuthorizedCwd = () => true;
    sidebar.sendRemoteHistorySnapshot(b);
    expect(strip(phone).textContent).toContain("Loading messages");
    expect(strip(phone).textContent).toContain("5s");
    sidebar.emit(b, { type: "setBusy", value: false }); expect(strip(phone).hidden).toBe(true);
    expect(OUTBOUND_DISPOSITION.startupStatus).toBe("mirror"); expect(OUTBOUND_PROJECT_AUTH.startupStatus).toBe("scope");
    expect(mayDeliverRemoteHostMsg({ type: "startupStatus", provider: "grok", stage: "starting", elapsedMs: 0 }, ["/repo"], "/foreign", (a, b) => a === b)).toBe(false);
  });
});
