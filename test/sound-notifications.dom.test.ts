// #107 — a running-but-silent AudioContext holds the OS audio session and
// blocks Windows sleep. Drives the real media/chat.js entry points: document
// pointerdown/keydown unlock, host/gear sound settings, and live agentEnd /
// agentError tones. AudioContext is stubbed only so the test can observe
// create / resume / suspend without changing runtime behavior.
import { describe, expect, it } from "vitest";
import { openAppSettings, bootWebview, dispatch, click, press } from "./webview-harness";

type FakeCtx = {
  state: string;
  resumeCalls: number;
  suspendCalls: number;
  oscStarts: number;
};

function installFakeAudio(w: any): FakeCtx[] {
  const created: FakeCtx[] = [];
  class FakeAudioContext {
    state = "suspended";
    currentTime = 0;
    destination = {};
    resumeCalls = 0;
    suspendCalls = 0;
    oscStarts = 0;
    constructor() { created.push(this); }
    resume() {
      this.resumeCalls += 1;
      this.state = "running";
      return Promise.resolve();
    }
    suspend() {
      this.suspendCalls += 1;
      this.state = "suspended";
      return Promise.resolve();
    }
    createGain() {
      return {
        gain: {
          value: 0,
          setValueAtTime() {},
          exponentialRampToValueAtTime() {},
        },
        connect() {},
      };
    }
    createOscillator() {
      const ctx = this;
      return {
        type: "sine",
        frequency: { value: 0 },
        connect() {},
        start() { ctx.oscStarts += 1; },
        stop() {},
      };
    }
  }
  w.AudioContext = FakeAudioContext;
  w.webkitAudioContext = FakeAudioContext;
  return created;
}

function gesture(window: any, doc: Document) {
  press(window, doc.body);
}

function hidePanel(doc: Document) {
  Object.defineProperty(doc, "visibilityState", { value: "hidden", configurable: true });
  Object.defineProperty(doc, "hasFocus", { value: () => false, configurable: true });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("AudioContext is not held open while silent (#107)", () => {
  it("does not create an AudioContext on gestures when every sound setting is off", () => {
    let created: FakeCtx[] = [];
    const { window, doc } = bootWebview({
      beforeScripts: (w) => { created = installFakeAudio(w); },
    });
    gesture(window, doc);
    doc.dispatchEvent(new (window as any).KeyboardEvent("keydown", { bubbles: true }));
    expect(created).toHaveLength(0);
  });

  it("creates on the first gesture once sound notifications are on, then suspends while idle", async () => {
    let created: FakeCtx[] = [];
    const { window, doc } = bootWebview({
      beforeScripts: (w) => { created = installFakeAudio(w); },
    });
    dispatch(window, { type: "soundNotifications", value: true });
    gesture(window, doc);
    expect(created).toHaveLength(1);
    await Promise.resolve();
    expect(created[0].state).toBe("suspended");
    expect(created[0].resumeCalls).toBe(1);
    expect(created[0].suspendCalls).toBe(1);
    expect(created[0].oscStarts).toBe(0);
  });

  it("plays a completion tone while away and suspends after the last note", async () => {
    let created: FakeCtx[] = [];
    const { window, doc } = bootWebview({
      beforeScripts: (w) => { created = installFakeAudio(w); },
    });
    dispatch(window, { type: "soundNotifications", value: true });
    gesture(window, doc);
    await Promise.resolve();
    hidePanel(doc);

    dispatch(window, { type: "agentEnd" });
    expect(created).toHaveLength(1);
    expect(created[0].oscStarts).toBe(2); // done = two notes
    expect(created[0].state).toBe("running");

    await sleep(500);
    expect(created[0].state).toBe("suspended");
    expect(created[0].suspendCalls).toBeGreaterThanOrEqual(2); // unlock + after tone
  });

  it.each([{ type: "agentEnd" }, { type: "agentError", text: "Failed" }])(
    "keeps replay and the second surface silent for $type", (message) => {
      let created: FakeCtx[] = [];
      const { window, doc } = bootWebview({ beforeScripts: (w) => {
        w.document.body.dataset.editorChat = "true";
        created = installFakeAudio(w);
      } });
      dispatch(window, { type: "soundNotifications", value: true });
      gesture(window, doc);
      hidePanel(doc);

      dispatch(window, { type: "historyReplay", active: true });
      dispatch(window, message);
      dispatch(window, { type: "historyReplay", active: false });
      expect(created[0].oscStarts).toBe(0);
      dispatch(window, { ...message, suppressTurnSound: true });
      expect(created[0].oscStarts).toBe(0);
      dispatch(window, message);
      expect(created[0].oscStarts).toBe(2);
      Object.defineProperty(doc, "visibilityState", { value: "visible", configurable: true });
      Object.defineProperty(doc, "hasFocus", { value: () => true, configurable: true });
      dispatch(window, message);
      expect(created[0].oscStarts).toBe(2);
      hidePanel(doc);
      dispatch(window, { type: "soundNotifications", value: false });
      dispatch(window, message);
      expect(created[0].oscStarts).toBe(2);
    },
  );

  it("does not suspend a second tone when a previous tone's suspend is still pending", async () => {
    let created: FakeCtx[] = [];
    const { window, doc } = bootWebview({
      beforeScripts: (w) => { created = installFakeAudio(w); },
    });
    dispatch(window, { type: "soundNotifications", value: true });
    gesture(window, doc);
    await Promise.resolve();
    hidePanel(doc);

    dispatch(window, { type: "agentEnd" });
    const suspendsAfterFirst = created[0].suspendCalls;
    dispatch(window, { type: "agentError", text: "failed" });
    expect(created[0].oscStarts).toBe(4); // done (2) + error (2)
    expect(created[0].state).toBe("running");

    // Done's last note ends ~360ms; if that suspend weren't cancelled it would
    // cut the error tone (last note ~440ms) off. Still running at 400ms means
    // the first scheduled suspend did not win.
    await sleep(400);
    expect(created[0].state).toBe("running");
    expect(created[0].suspendCalls).toBe(suspendsAfterFirst);

    await sleep(200);
    expect(created[0].state).toBe("suspended");
    expect(created[0].suspendCalls).toBe(suspendsAfterFirst + 1);
  });

  it("unlocks on the next gesture after a mid-session settings flip", async () => {
    let created: FakeCtx[] = [];
    const { window, doc } = bootWebview({
      beforeScripts: (w) => { created = installFakeAudio(w); },
    });
    gesture(window, doc);
    doc.dispatchEvent(new (window as any).KeyboardEvent("keydown", { bubbles: true }));
    expect(created).toHaveLength(0);

    dispatch(window, { type: "soundNotifications", value: true });
    expect(created).toHaveLength(0);

    gesture(window, doc);
    expect(created).toHaveLength(1);
    await Promise.resolve();
    expect(created[0].state).toBe("suspended");
  });

  it("unlocks from the gear switch itself, which is a real user gesture", async () => {
    let created: FakeCtx[] = [];
    const { window, doc } = bootWebview({
      beforeScripts: (w) => { created = installFakeAudio(w); },
    });
    openAppSettings(window, doc);
    const notifications = [...doc.querySelectorAll("#settings-overlay .settings-nav-item")].find(
      (el) => (el.textContent || "").trim() === "Notifications",
    ) as HTMLElement;
    click(window, notifications);
    const toggle = doc.querySelector('[data-id="soundNotifications"] .settings-switch') as HTMLElement;
    expect(toggle).toBeTruthy();
    expect(created).toHaveLength(0);
    click(window, toggle);
    expect(created).toHaveLength(1);
    await Promise.resolve();
    expect(created[0].state).toBe("suspended");
  });

  it("creates from the still-processing setting the same way, not only completion sounds", async () => {
    let created: FakeCtx[] = [];
    const { window, doc } = bootWebview({
      beforeScripts: (w) => { created = installFakeAudio(w); },
    });
    dispatch(window, { type: "processingSound", value: true });
    expect(created).toHaveLength(0);
    gesture(window, doc);
    expect(created).toHaveLength(1);
    await Promise.resolve();
    expect(created[0].state).toBe("suspended");
  });
});
