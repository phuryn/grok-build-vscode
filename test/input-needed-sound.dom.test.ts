import { afterEach, describe, expect, it } from "vitest";
import { bootWebview, dispatch, press } from "./webview-harness";

function boot(options: { remote?: boolean; vscode?: boolean; enabled?: boolean } = {}) {
  const notes: number[] = [];
  const contexts: any[] = [];
  const h = bootWebview({
    ...options,
    beforeScripts(w) {
      if (!options.remote && !options.vscode) (w as any).grokDesktopShell = true;
      class AudioContext {
        state = "suspended";
        currentTime = 0;
        destination = {};
        constructor() { contexts.push(this); }
        resume() { this.state = "running"; return Promise.resolve(); }
        suspend() { this.state = "suspended"; return Promise.resolve(); }
        createGain() {
          return { gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
        }
        createOscillator() {
          return { type: "sine", frequency: { value: 0 }, connect() {},
            start() { notes.push(this.frequency.value); }, stop() {} };
        }
      }
      (w as any).AudioContext = AudioContext;
    },
  });
  windows.push(h.window);
  dispatch(h.window, { type: "inputNeededSound", value: options.enabled !== false });
  press(h.window, h.doc.body);
  away(h.doc);
  return { ...h, notes, contexts };
}

const windows: ReturnType<typeof bootWebview>["window"][] = [];
afterEach(async () => {
  await Promise.all(windows.splice(0).map(w => w.happyDOM.close()));
});

function away(doc: Document, hidden = true, focused = false) {
  Object.defineProperty(doc, "visibilityState", { value: hidden ? "hidden" : "visible", configurable: true });
  Object.defineProperty(doc, "hasFocus", { value: () => focused, configurable: true });
}

function dot(h: ReturnType<typeof boot>, value: string, id = "conversation") {
  dispatch(h.window, { type: "sessionDot", id, dot: value });
}

function waiting(h: ReturnType<typeof boot>, id = "conversation") {
  dot(h, "working", id);
  dot(h, "needs-you", id);
}

const inputTone = [784, 659, 784];

describe("sound when input is needed (#228)", () => {
  it.each([
    ["desk", { vscode: true }], ["desktop", {}], ["remote", { remote: true }],
  ] as const)("plays locally on a live transition while away on %s", (_surface, options) => {
    const h = boot(options);
    waiting(h);
    expect(h.notes).toEqual(inputTone);
    expect(h.posted.some(m => /sound/i.test(m.type))).toBe(false);
  });

  it("stays silent while the panel is focused and visible, including after stepping away", () => {
    const h = boot();
    away(h.doc, false, true);
    waiting(h);
    expect(h.notes).toEqual([]);
    away(h.doc);
    dot(h, "needs-you");
    expect(h.notes).toEqual([]);
  });

  it.each([[false, false], [true, true]])("plays when hidden=%s and focused=%s", (hidden, focused) => {
    const h = boot();
    away(h.doc, hidden, focused);
    waiting(h);
    expect(h.notes).toEqual(inputTone);
  });

  it("is off by default and independent of completion and processing switches", () => {
    const h = boot({ enabled: false });
    expect(h.contexts).toHaveLength(0);
    dispatch(h.window, { type: "soundNotifications", value: true });
    dispatch(h.window, { type: "processingSound", value: true });
    waiting(h);
    expect(h.notes).toEqual([]);
    dispatch(h.window, { type: "inputNeededSound", value: true });
    dot(h, "needs-you"); // enabling the switch cannot notify an existing wait
    expect(h.notes).toEqual([]);
    waiting(h);
    expect(h.notes).toEqual(inputTone);
  });

  it("does not enable turn-finish or error tones", () => {
    const h = boot();
    dispatch(h.window, { type: "agentEnd" });
    dispatch(h.window, { type: "agentError", text: "failed" });
    expect(h.notes).toEqual([]);
  });

  it("unlocks and suspends with only this sound enabled", async () => {
    const h = boot();
    expect(h.contexts).toHaveLength(1);
    await Promise.resolve();
    expect(h.contexts[0].state).toBe("suspended");
    waiting(h);
    expect(h.contexts[0].state).toBe("running");
    await new Promise(resolve => h.window.setTimeout(resolve, 600));
    expect(h.contexts[0].state).toBe("suspended");
  });

  it("chimes once for a burst of permission, question, and plan cards and repeated dots", () => {
    const h = boot();
    dot(h, "working");
    dispatch(h.window, { type: "permissionRequest", req: { id: 1, toolCall: { title: "Run command" }, options: [] } });
    dot(h, "needs-you");
    dispatch(h.window, { type: "questionRequest", req: { id: 2, questions: [] } });
    dot(h, "needs-you");
    dispatch(h.window, { type: "exitPlanRequest", req: { id: 3, plan: "Do it" } });
    dot(h, "needs-you");
    expect(h.notes).toEqual(inputTone);
    waiting(h); // a later working → waiting moment is a new notification
    expect(h.notes).toEqual([...inputTone, ...inputTone]);
  });

  it("includes a conversation other than the one on screen", () => {
    const h = boot();
    dispatch(h.window, { type: "sessionName", id: "on-screen", name: "Current" });
    waiting(h, "in-background");
    expect(h.notes).toEqual(inputTone);
  });

  it("never chimes for the first waiting dot after a reload", () => {
    const h = boot();
    dot(h, "needs-you");
    dot(h, "needs-you");
    expect(h.notes).toEqual([]);
    waiting(h);
    expect(h.notes).toEqual(inputTone);
  });

  it.each(["sessions", "repoSessions", "pinnedSessions", "recentSessions"])("uses %s dots as silent baselines", type => {
    const h = boot();
    dispatch(h.window, { type, entries: [], cwd: "/w", dots: { pending: "needs-you", running: "working" } });
    dot(h, "needs-you", "pending");
    expect(h.notes).toEqual([]);
    dot(h, "needs-you", "running");
    expect(h.notes).toEqual(inputTone);
  });

  it("discards the pre-replay baseline and ignores replayed cards, dots, and post-replay options", () => {
    const h = boot();
    dot(h, "working");
    dispatch(h.window, { type: "historyReplay", active: true });
    dispatch(h.window, { type: "historyBatch", messages: [
      { type: "permissionRequest", req: { id: 1, toolCall: { title: "Old command" }, options: [] } },
      { type: "questionRequest", req: { id: 2, questions: [] } },
      { type: "exitPlanRequest", req: { id: 3, plan: "Old plan" } },
    ] });
    dot(h, "working");
    dot(h, "needs-you");
    dispatch(h.window, { type: "historyReplay", active: false });
    dispatch(h.window, { type: "permissionOptions", requestId: 1, options: [] });
    dot(h, "needs-you");
    expect(h.notes).toEqual([]);
    waiting(h);
    expect(h.notes).toEqual(inputTone);
  });

  it.each(["initialState", "hostReachable", "hostLink"])("forgets stale working state on reconnect via %s", type => {
    const h = boot({ remote: true });
    dot(h, "working");
    dispatch(h.window, { type, inputNeededSound: true,
      link: { reachable: false, restored: false, connection: 1, phase: "offline", since: 0 } });
    dot(h, "needs-you");
    expect(h.notes).toEqual([]);
    waiting(h);
    expect(h.notes).toEqual(inputTone);
  });

  it("forgets the old baseline when the connection changes without an offline frame", () => {
    const h = boot({ remote: true });
    const link = (connection: number) => dispatch(h.window, { type: "hostLink",
      link: { reachable: true, restored: true, connection, phase: "ready", since: 0 } });
    link(1);
    dot(h, "working");
    link(2);
    dot(h, "needs-you");
    expect(h.notes).toEqual([]);
    waiting(h);
    expect(h.notes).toEqual(inputTone);
  });
});
