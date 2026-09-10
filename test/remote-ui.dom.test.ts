import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { bootWebview, click, dispatch, press } from "./webview-harness";

const sidebarSrc = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");

function key(window: any, el: Element, init: Record<string, unknown>) {
  const event = new window.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  el.dispatchEvent(event);
  return event;
}

function bootRemotePcm() {
  let node: any;
  const harness = bootWebview({
    remote: true,
    beforeScripts: (w) => {
      const track = { stop() {}, addEventListener() {} };
      Object.defineProperty((w as any).navigator, "mediaDevices", {
        configurable: true,
        value: { getUserMedia: async () => ({ getTracks: () => [track] }) },
      });
      class FakeNode {
        port = { onmessage: undefined as any, postMessage() {} };
        constructor() { node = this; }
        connect() {}
        disconnect() {}
      }
      class FakeAudioContext {
        state = "running";
        audioWorklet = { addModule: async () => {} };
        destination = {};
        createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
        createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
        close() { return Promise.resolve(); }
      }
      (w as any).AudioWorkletNode = FakeNode;
      (w as any).AudioContext = FakeAudioContext;
    },
  });
  return { ...harness, getNode: () => node };
}

// #projects-rail lives in web/chat.html, never in getHtml(). The gear's
// Basic/Advanced entry points are gated on that mount existing, so a harness
// without it shows the VS Code shape instead of AFK Pilot's.
const withRailMount = (w: any) => {
  const el = w.document.createElement("aside");
  el.id = "projects-rail";
  el.hidden = true;
  w.document.body.appendChild(el);
  const search = w.document.createElement("input");
  search.id = "rail-search";
  w.document.body.appendChild(search);
};

/** Open the gear, then the Settings overlay where Text size lives. */
const openSettingsGeneral = (window: any, doc: Document) => {
  click(window, (doc.getElementById("rail-gear-btn") || doc.getElementById("gear-btn"))!);
  const entry = [...doc.querySelectorAll("#gear-popover .toolbar-popover-item")]
    .find((el) => /(^|\s)Settings$/.test((el.textContent || "").replace(/\s+/g, " ").trim()));
  if (entry) click(window, entry as HTMLElement);
};

const fontSlider = (doc: Document) =>
  doc.querySelector('[data-id="chatFontScale"] input[type="range"]') as HTMLInputElement | null;

const clickSettingsNav = (window: any, doc: Document, title: string) => {
  const item = [...doc.querySelectorAll("#settings-overlay .settings-nav-item")]
    .find((el) => (el.textContent || "").trim() === title);
  click(window, item);
};

describe("AFK Pilot shared webview controls", () => {
  it("inserts remote dictation at the caret and preserves the suffix", async () => {
    const { window, posted, doc } = bootRemotePcm();
    const input = doc.getElementById("input") as HTMLTextAreaElement;
    input.value = "Please now";
    input.setSelectionRange(6, 6);

    click(window, doc.getElementById("mic-btn")!);
    await new Promise((resolve) => setTimeout(resolve, 0));
    dispatch(window, { type: "voiceState", status: "listening" });
    dispatch(window, { type: "voicePartial", text: "fix the tests" });

    expect(input.value).toBe("Please fix the tests now");
    expect(input.selectionStart).toBe(20);
    expect(posted).toContainEqual({ type: "remoteVoiceStart" });
    click(window, doc.getElementById("mic-btn")!);
  });

  it("manual remote Send discards capture and ignores a late transcript", async () => {
    const { window, posted, doc } = bootRemotePcm();
    const input = doc.getElementById("input") as HTMLTextAreaElement;

    click(window, doc.getElementById("mic-btn")!);
    await new Promise((resolve) => setTimeout(resolve, 0));
    dispatch(window, { type: "voiceState", status: "listening" });
    dispatch(window, { type: "voicePartial", text: "send this visible draft" });
    click(window, doc.getElementById("send-btn")!);

    expect(posted).toContainEqual({ type: "remoteVoiceStop", cancel: true });
    expect(posted.find((message) => message.type === "send")).toMatchObject({
      type: "send",
      text: "send this visible draft",
    });
    dispatch(window, { type: "voicePartial", text: "late partial" });
    dispatch(window, { type: "voiceTranscript", text: "late transcript" });
    dispatch(window, { type: "voiceSubmit", text: "late submit" });
    expect(input.value).toBe("");
    expect(doc.getElementById("mic-btn")!.classList.contains("listening")).toBe(false);
  });

  it("clears both usage ledgers when a browser tab switches conversations", () => {
    const { window, doc } = bootWebview({ remote: true });
    dispatch(window, {
      type: "usage",
      turn: { inputTokens: 16000, costUsdTicks: 80_000_000 },
      session: { inputTokens: 32000, costUsdTicks: 180_384_000 },
    });

    dispatch(window, { type: "clearMessages" });
    click(window, doc.getElementById("donut") as HTMLElement);

    const text = doc.getElementById("context-popover")!.textContent!;
    expect(text).not.toContain("Session total");
    expect(text).not.toContain("Last turn");
    expect(text).not.toContain("Cost");
  });

  it("voice-config refresh skips a tab that has no cwd yet", () => {
    const body = sidebarSrc.slice(
      sidebarSrc.indexOf("private postVoiceConfigured("),
      sidebarSrc.indexOf("private voiceSetting<"),
    );
    expect(body).toContain("cwdIfPresent");
    expect(body).not.toContain("remoteSessionFor");
    expect(body).not.toMatch(/remoteClients\.cwd\(/);
  });

  it("keeps remote voice completion out of the host prompt path", () => {
    const continuous = sidebarSrc.slice(
      sidebarSrc.indexOf("private async commitRemoteVoice"),
      sidebarSrc.indexOf("private async handleRemoteVoiceStop"),
    );
    const stopped = sidebarSrc.slice(
      sidebarSrc.indexOf("private async handleRemoteVoiceStop"),
      sidebarSrc.indexOf("private dropRemoteVoice"),
    );

    expect(continuous).toContain('type: "voiceSubmit"');
    expect(stopped).toContain('type: "voiceSubmit"');
    expect(continuous).toContain('text: text.trim()');
    expect(stopped).toContain('text: text.trim()');
    expect(continuous).not.toContain("if (trimmed)");
    expect(stopped).not.toContain("if (text.trim())");
    expect(continuous).not.toContain("handleSend");
    expect(stopped).not.toContain("handleSend");
  });

  it("leaves Enter to a touch-device textarea and keeps the Send button as the submit path", () => {
    const { window, posted, doc } = bootWebview({
      remote: true,
      beforeScripts: (w) => {
        (w as any).matchMedia = () => ({ matches: true });
      },
    });
    const input = doc.getElementById("input") as HTMLTextAreaElement;
    input.value = "first line";

    const event = key(window, input, { key: "Enter" });

    expect(event.defaultPrevented).toBe(false);
    expect(posted.filter((m) => m.type === "send")).toHaveLength(0);
    click(window, doc.getElementById("send-btn")!);
    expect(posted.find((m) => m.type === "send")).toMatchObject({ text: "first line" });
  });

  it("keeps Enter-to-send for remote users with a desktop pointer", () => {
    const { window, posted, doc } = bootWebview({
      remote: true,
      beforeScripts: (w) => {
        (w as any).matchMedia = () => ({ matches: false });
      },
    });
    const input = doc.getElementById("input") as HTMLTextAreaElement;
    input.value = "send from desktop";

    const event = key(window, input, { key: "Enter" });

    expect(event.defaultPrevented).toBe(true);
    expect(posted.find((m) => m.type === "send")).toMatchObject({ text: "send from desktop" });
  });

  it("waits for a delayed worklet flush before posting the final chunk and stop", async () => {
    let node: any;
    let stopped = false;
    let resumeCalls = 0;
    let closeCalls = 0;
    const { window, posted, doc } = bootWebview({
      remote: true,
      beforeScripts: (w) => {
        const track = { stop: () => { stopped = true; }, addEventListener: () => {} };
        Object.defineProperty((w as any).navigator, "mediaDevices", {
          configurable: true,
          value: { getUserMedia: async () => ({ getTracks: () => [track] }) },
        });
        class FakeNode {
          port: any;
          constructor() {
            node = this;
            this.port = {
              onmessage: undefined,
              postMessage: (message: unknown) => {
                if (message !== "flush") return;
                setTimeout(() => {
                  this.port.onmessage({ data: new Uint8Array([3, 0]).buffer });
                  this.port.onmessage({ data: { type: "flushed" } });
                }, 80);
              },
            };
          }
          connect() {}
          disconnect() {}
        }
        class FakeAudioContext {
          state = "suspended";
          audioWorklet = { addModule: async () => {} };
          destination = {};
          async resume() {
            resumeCalls++;
            this.state = "running";
          }
          createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
          createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
          close() { closeCalls++; return Promise.resolve(); }
        }
        (w as any).AudioWorkletNode = FakeNode;
        (w as any).AudioContext = FakeAudioContext;
      },
    });
    const input = doc.getElementById("input") as HTMLTextAreaElement;
    input.value = "Please";

    click(window, doc.getElementById("mic-btn")!);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resumeCalls).toBe(1);
    expect(posted).toContainEqual({ type: "remoteVoiceStart" });

    dispatch(window, { type: "voiceState", status: "listening" });
    expect(doc.getElementById("mic-btn")!.classList.contains("listening")).toBe(true);
    expect(posted.filter((m) => m.type === "voiceStart")).toHaveLength(0);

    node.port.onmessage({ data: new Uint8Array([1, 0, 2, 0]).buffer });
    expect(posted).toContainEqual({ type: "remoteVoiceChunk", data: "AQACAA==" });

    click(window, doc.getElementById("mic-btn")!);
    await vi.waitFor(() => expect(posted.some((m) => m.type === "remoteVoiceStop")).toBe(true));
    expect(posted).toContainEqual({ type: "remoteVoiceChunk", data: "AwA=" });
    expect(posted).toContainEqual({ type: "remoteVoiceStop" });
    expect(posted.findIndex((message) => message.type === "remoteVoiceChunk" && message.data === "AwA="))
      .toBeLessThan(posted.findIndex((message) => message.type === "remoteVoiceStop"));
    expect(stopped).toBe(true);
    expect(closeCalls).toBe(1);
  });

  it("retains more than 16 PCM chunks while delayed STT setup becomes ready", async () => {
    let node: any;
    const { window, posted, doc } = bootWebview({
      remote: true,
      beforeScripts: (w) => {
        const track = { stop: () => {}, addEventListener: () => {} };
        Object.defineProperty((w as any).navigator, "mediaDevices", {
          configurable: true,
          value: { getUserMedia: async () => ({ getTracks: () => [track] }) },
        });
        class FakeNode {
          port = { onmessage: undefined as any, postMessage: () => {} };
          constructor() { node = this; }
          connect() {}
          disconnect() {}
        }
        class FakeAudioContext {
          audioWorklet = { addModule: async () => {} };
          destination = {};
          createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
          createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
          close() { return Promise.resolve(); }
        }
        (w as any).AudioWorkletNode = FakeNode;
        (w as any).AudioContext = FakeAudioContext;
      },
    });

    click(window, doc.getElementById("mic-btn")!);
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let i = 0; i < 24; i++) {
      node.port.onmessage({ data: new Uint8Array([i, 0]).buffer });
    }
    expect(posted.filter((m) => m.type === "remoteVoiceChunk")).toHaveLength(0);

    dispatch(window, { type: "voiceState", status: "listening" });

    const chunks = posted.filter((m) => m.type === "remoteVoiceChunk");
    expect(chunks).toHaveLength(24);
    expect(chunks[0]).toEqual({ type: "remoteVoiceChunk", data: "AAA=" });
    expect(chunks[23]).toEqual({ type: "remoteVoiceChunk", data: "FwA=" });
  });

  it("cancels visibly instead of truncating when the bounded pre-ready budget is exhausted", async () => {
    let node: any;
    const { window, posted, doc } = bootWebview({
      remote: true,
      beforeScripts: (w) => {
        const track = { stop: () => {}, addEventListener: () => {} };
        Object.defineProperty((w as any).navigator, "mediaDevices", {
          configurable: true,
          value: { getUserMedia: async () => ({ getTracks: () => [track] }) },
        });
        class FakeNode {
          port = { onmessage: undefined as any, postMessage: () => {} };
          constructor() { node = this; }
          connect() {}
          disconnect() {}
        }
        class FakeAudioContext {
          audioWorklet = { addModule: async () => {} };
          destination = {};
          createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
          createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
          close() { return Promise.resolve(); }
        }
        (w as any).AudioWorkletNode = FakeNode;
        (w as any).AudioContext = FakeAudioContext;
      },
    });

    click(window, doc.getElementById("mic-btn")!);
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let i = 0; i < 129; i++) {
      node.port.onmessage({ data: new ArrayBuffer(4096) });
    }

    expect(posted).toContainEqual({ type: "remoteVoiceStop", cancel: true });
    expect(posted.filter((m) => m.type === "remoteVoiceChunk")).toHaveLength(0);
    expect(doc.querySelector(".msg.error")?.textContent).toMatch(/no audio was sent.*try dictating again/i);
    expect(doc.getElementById("mic-btn")!.classList.contains("connecting")).toBe(false);
  });

  it("keeps the browser microphone closed when the host reports voice unavailable", async () => {
    let getUserMediaCalls = 0;
    const { window, posted, doc } = bootWebview({
      remote: true,
      beforeScripts: (w) => {
        Object.defineProperty((w as any).navigator, "mediaDevices", {
          configurable: true,
          value: {
            getUserMedia: async () => {
              getUserMediaCalls++;
              return { getTracks: () => [] };
            },
          },
        });
        (w as any).AudioWorkletNode = class {};
      },
    });
    const mic = doc.getElementById("mic-btn") as HTMLButtonElement;

    dispatch(window, { type: "voiceConfigured", value: false });
    click(window, mic);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mic.disabled).toBe(true);
    expect(mic.title).toMatch(/unavailable.*host/i);
    expect(mic.title).not.toMatch(/set up/i);
    expect(getUserMediaCalls).toBe(0);
    expect(posted.filter((m) => m.type === "remoteVoiceStart")).toEqual([]);
  });

  it("surfaces a denied browser microphone permission and resets the button", async () => {
    const { window, posted, doc } = bootWebview({
      remote: true,
      beforeScripts: (w) => {
        Object.defineProperty((w as any).navigator, "mediaDevices", {
          configurable: true,
          value: {
            getUserMedia: async () => {
              throw new (w as any).DOMException("Permission denied", "NotAllowedError");
            },
          },
        });
        (w as any).AudioWorkletNode = class {};
      },
    });

    click(window, doc.getElementById("mic-btn")!);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(doc.querySelector(".msg.error")?.textContent).toMatch(/access was denied/i);
    expect(doc.querySelector(".msg.error")?.textContent).toMatch(/browser settings/i);
    expect(doc.getElementById("mic-btn")!.classList.contains("connecting")).toBe(false);
    expect((doc.getElementById("mic-btn") as HTMLButtonElement).disabled).toBe(false);
    expect(posted.filter((m) => m.type === "remoteVoiceStart")).toEqual([]);
  });

  it("distinguishes a device with no microphone from a permission denial", async () => {
    const { window, doc } = bootWebview({
      remote: true,
      beforeScripts: (w) => {
        Object.defineProperty((w as any).navigator, "mediaDevices", {
          configurable: true,
          value: {
            getUserMedia: async () => {
              throw new (w as any).DOMException("No device", "NotFoundError");
            },
          },
        });
        (w as any).AudioWorkletNode = class {};
      },
    });

    click(window, doc.getElementById("mic-btn")!);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(doc.querySelector(".msg.error")?.textContent).toBe("No microphone was found on this device.");
  });

  it("releases an opened stream when worklet setup fails", async () => {
    let stopped = false;
    let closed = false;
    const { window, posted, doc } = bootWebview({
      remote: true,
      beforeScripts: (w) => {
        const track = { stop: () => { stopped = true; } };
        Object.defineProperty((w as any).navigator, "mediaDevices", {
          configurable: true,
          value: { getUserMedia: async () => ({ getTracks: () => [track] }) },
        });
        class FakeAudioContext {
          audioWorklet = { addModule: async () => { throw new Error("worklet failed"); } };
          close() { closed = true; return Promise.resolve(); }
        }
        (w as any).AudioWorkletNode = class {};
        (w as any).AudioContext = FakeAudioContext;
      },
    });

    click(window, doc.getElementById("mic-btn")!);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stopped).toBe(true);
    expect(closed).toBe(true);
    expect(doc.querySelector(".msg.error")?.textContent).toMatch(/could not start/i);
    expect(doc.getElementById("mic-btn")!.classList.contains("connecting")).toBe(false);
    expect(posted.filter((m) => m.type === "remoteVoiceStart")).toEqual([]);
  });

  it("cancels a pending microphone start and discards a late stream", async () => {
    let resolveStream!: (stream: { getTracks: () => Array<{ stop: () => void }> }) => void;
    let stopped = false;
    const { window, posted, doc } = bootWebview({
      remote: true,
      beforeScripts: (w) => {
        Object.defineProperty((w as any).navigator, "mediaDevices", {
          configurable: true,
          value: {
            getUserMedia: () => new Promise((resolve) => { resolveStream = resolve; }),
          },
        });
        (w as any).AudioWorkletNode = class {};
      },
    });
    const mic = doc.getElementById("mic-btn")!;

    click(window, mic);
    expect(mic.classList.contains("connecting")).toBe(true);
    click(window, mic);
    expect(mic.classList.contains("connecting")).toBe(false);

    resolveStream({ getTracks: () => [{ stop: () => { stopped = true; } }] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stopped).toBe(true);
    expect(posted.filter((m) => m.type === "remoteVoiceStart")).toEqual([]);
    expect(doc.querySelector(".msg.error")).toBeNull();
  });

  it("does not overwrite a passive same-repo tab's composer with another tab's partial", () => {
    const { window, doc } = bootWebview({ remote: true });
    const input = doc.getElementById("input") as HTMLTextAreaElement;
    input.value = "my independent draft";

    dispatch(window, { type: "voiceState", status: "listening" });
    dispatch(window, { type: "voicePartial", text: "someone else's dictation" });

    expect(input.value).toBe("my independent draft");
  });

  it("sends a spoken prompt through the relay in the same metered frame as typed input", () => {
    const typed = bootWebview({ remote: true });
    const typedInput = typed.doc.getElementById("input") as HTMLTextAreaElement;
    typedInput.value = "charge this prompt";
    click(typed.window, typed.doc.getElementById("send-btn")!);
    const typedSend = typed.posted.find((message) => message.type === "send");

    const spoken = bootWebview({ remote: true });
    const spokenInput = spoken.doc.getElementById("input") as HTMLTextAreaElement;
    spokenInput.value = "live transcript";
    dispatch(spoken.window, { type: "voiceSubmit", text: "charge this prompt" });
    const spokenSend = spoken.posted.find((message) => message.type === "send");

    expect(spokenSend).toMatchObject({ type: typedSend.type, text: typedSend.text });
    expect(spokenSend.submissionId).toEqual(expect.any(String));
    expect(spokenInput.value).toBe("");
  });

  it("queues a spoken prompt during a busy remote turn instead of starting a concurrent prompt", () => {
    const { window, posted } = bootWebview({ remote: true });
    dispatch(window, { type: "agentStart" });

    dispatch(window, { type: "voiceSubmit", text: "wait for the current turn" });

    expect(posted.filter((message) => message.type === "send")).toEqual([]);
    expect(posted.find((message) => message.type === "queueSend")).toEqual({
      type: "queueSend",
      text: "wait for the current turn",
    });
  });

  it("recovers a typed prompt and unlocks the composer when the relay rejects it", () => {
    const { window, doc } = bootWebview({ remote: true });
    const input = doc.getElementById("input") as HTMLTextAreaElement;
    input.value = "do not lose this typed prompt";
    click(window, doc.getElementById("send-btn")!);

    dispatch(window, {
      type: "error",
      text: "Slow down — at most 5 messages per minute.",
    });

    expect(doc.querySelector(".msg.error")?.textContent)
      .toBe("Slow down — at most 5 messages per minute.");
    expect(doc.querySelector(".msg.queued .queued-text")?.textContent)
      .toBe("do not lose this typed prompt");
    expect(doc.querySelector(".msg.queued .queued-tag")?.textContent).toBe("Not sent");
    expect(doc.getElementById("send-btn")!.classList.contains("stop")).toBe(false);

    press(window, doc.querySelector('.msg.queued .queued-action[title^="Edit"]')!);
    expect(input.value).toBe("do not lose this typed prompt");
    expect(doc.querySelector(".msg.queued")).toBeNull();
  });

  it("recovers a spoken prompt and unlocks the composer when the relay rejects it", () => {
    const { window, doc } = bootWebview({ remote: true });
    dispatch(window, { type: "voiceSubmit", text: "do not lose this dictated prompt" });

    dispatch(window, {
      type: "error",
      text: "Free plan limit reached (25 messages this week). Resets in 2 days. Upgrade to Remote Max for unlimited use.",
    });

    expect(doc.querySelector(".msg.error")?.textContent)
      .toMatch(/^Free plan limit reached/);
    expect(doc.querySelector(".msg.queued .queued-text")?.textContent)
      .toBe("do not lose this dictated prompt");
    expect(doc.querySelector(".msg.queued .queued-tag")?.textContent).toBe("Not sent");
    expect(doc.getElementById("send-btn")!.classList.contains("stop")).toBe(false);
  });

  it("retains a pending remote prompt across another view's turn until its relay rejection", () => {
    const { window, doc } = bootWebview({ remote: true });
    const input = doc.getElementById("input") as HTMLTextAreaElement;
    input.value = "keep my phone prompt";
    click(window, doc.getElementById("send-btn")!);

    dispatch(window, { type: "userMessage", text: "sent from the desk", chips: [] });
    dispatch(window, { type: "agentStart" });
    dispatch(window, {
      type: "error",
      text: "Slow down — at most 5 messages per minute.",
    });

    expect(doc.querySelector(".msg.queued .queued-text")?.textContent)
      .toBe("keep my phone prompt");
    expect(doc.querySelector(".msg.queued .queued-tag")?.textContent).toBe("Not sent");
  });

  it("clears a pending remote prompt only when its own text-bearing echo arrives", () => {
    const { window, posted, doc } = bootWebview({ remote: true, beforeScripts: withRailMount });
    const input = doc.getElementById("input") as HTMLTextAreaElement;
    input.value = "accepted phone prompt";
    click(window, doc.getElementById("send-btn")!);
    const submissionId = posted.find((message) => message.type === "send")!.submissionId;

    dispatch(window, { type: "userMessage", text: "accepted phone prompt", chips: [], submissionId });
    dispatch(window, { type: "agentStart" });
    dispatch(window, {
      type: "error",
      text: "Slow down — at most 5 messages per minute.",
    });

    expect(doc.querySelectorAll(".msg.user:not(.queued)")).toHaveLength(1);
    expect(doc.querySelector(".msg.queued")).toBeNull();
  });

  it("falls back to text ownership when an old host echoes no submission id", () => {
    const { window, doc } = bootWebview({ remote: true });
    const input = doc.getElementById("input") as HTMLTextAreaElement;
    input.value = "accepted by an old extension";
    click(window, doc.getElementById("send-btn")!);

    dispatch(window, {
      type: "userMessage",
      text: "accepted by an old extension",
      chips: [],
    });

    expect(doc.querySelectorAll(".msg.user:not(.queued)")).toHaveLength(1);
  });

  it("falls back to attachment ownership for an image-only echo from an old host", () => {
    const { window, doc } = bootWebview({ remote: true });
    const chip = {
      id: "image-1",
      path: "C:\\tmp\\image.png",
      relPath: "image.png",
      hidden: false,
      imageIndex: 1,
      mimeType: "image/png",
    };
    dispatch(window, { type: "chips", chips: [chip] });
    click(window, doc.getElementById("send-btn")!);

    dispatch(window, {
      type: "userMessage",
      text: "",
      chips: [{ ...chip, id: "desk-image" }],
    });
    expect(doc.querySelectorAll(".msg.user:not(.queued)")).toHaveLength(2);

    dispatch(window, { type: "userMessage", text: "", chips: [chip] });
    expect(doc.querySelectorAll(".msg.user:not(.queued)")).toHaveLength(2);
  });

  it("reconciles an image-only send by id without consuming another view's echo", () => {
    const { window, posted, doc } = bootWebview({ remote: true });
    const chip = {
      id: "image-1",
      path: "C:\\tmp\\image.png",
      relPath: "image.png",
      hidden: false,
      imageIndex: 1,
      mimeType: "image/png",
    };
    dispatch(window, { type: "chips", chips: [chip] });
    click(window, doc.getElementById("send-btn")!);
    const submissionId = posted.find((message) => message.type === "send")!.submissionId;

    dispatch(window, {
      type: "userMessage",
      text: "",
      chips: [{ ...chip, id: "desk-image" }],
      submissionId: "another-view-submission",
    });
    expect(doc.querySelectorAll(".msg.user:not(.queued)")).toHaveLength(2);

    dispatch(window, { type: "userMessage", text: "", chips: [chip], submissionId });
    expect(doc.querySelectorAll(".msg.user:not(.queued)")).toHaveLength(2);
  });

  it("does not treat an unrelated host error as rejection of an in-flight send", () => {
    const { window, doc } = bootWebview({ remote: true });
    const input = doc.getElementById("input") as HTMLTextAreaElement;
    input.value = "still in flight";
    click(window, doc.getElementById("send-btn")!);

    dispatch(window, { type: "error", text: "Could not rename this conversation." });

    expect(doc.querySelector(".msg.queued")).toBeNull();
    expect(doc.getElementById("send-btn")!.classList.contains("stop")).toBe(true);
  });

  it("echoes an image-only queued dequeue whose text is empty", () => {
    const { window, posted } = bootWebview({ remote: true });
    dispatch(window, {
      type: "queuedSends",
      items: [""],
      queued: [{
        text: "",
        chips: [{
          id: "image:/s/a.png:1:1",
          path: "/s/a.png",
          relPath: "Image #1",
          hidden: false,
          imageIndex: 1,
          mimeType: "image/png",
        }],
      }],
    });
    dispatch(window, { type: "submitQueuedSend", id: "queued-send-id-img1", text: "" });
    expect(posted).toContainEqual({
      type: "send",
      text: "",
      queuedSendId: "queued-send-id-img1",
    });
  });

  it("meters a dequeued prompt as a send frame carrying its submission identity", () => {
    const typed = bootWebview({ remote: true });
    const typedInput = typed.doc.getElementById("input") as HTMLTextAreaElement;
    typedInput.value = "charge this queued prompt";
    click(typed.window, typed.doc.getElementById("send-btn")!);
    const typedSend = typed.posted.find((message) => message.type === "send");

    const queued = bootWebview({ remote: true });
    dispatch(queued.window, { type: "queuedSends", items: ["charge this queued prompt"] });
    dispatch(queued.window, { type: "submitQueuedSend", id: "queued-send-id-0001", text: "charge this queued prompt" });
    const dequeuedSend = queued.posted.find((message) => message.type === "send");

    expect(dequeuedSend).toEqual({
      type: typedSend.type,
      text: typedSend.text,
      queuedSendId: "queued-send-id-0001",
    });
  });

  it("converts a repeated dequeue instruction only once in one page", () => {
    const { window, posted } = bootWebview({ remote: true });
    const instruction = {
      type: "submitQueuedSend",
      id: "queued-send-id-0002",
      text: "do this once",
    };

    dispatch(window, instruction);
    dispatch(window, instruction);

    expect(posted.filter((message) => message.type === "send")).toEqual([
      { type: "send", text: "do this once", queuedSendId: instruction.id },
    ]);
  });

  it("keeps an over-quota dequeued prompt visible and editable", () => {
    const { window, posted, doc } = bootWebview({ remote: true });
    dispatch(window, { type: "queuedSends", items: ["do not lose this"] });
    dispatch(window, { type: "submitQueuedSend", id: "queued-send-id-0003", text: "do not lose this" });
    expect(posted).toContainEqual({
      type: "send",
      text: "do not lose this",
      queuedSendId: "queued-send-id-0003",
    });

    dispatch(window, {
      type: "error",
      text: "Free plan limit reached (25 messages this week). Resets in 2 days. Upgrade to Remote Max for unlimited use.",
    });

    expect(doc.querySelector(".msg.error")?.textContent)
      .toBe("Free plan limit reached (25 messages this week). Resets in 2 days. Upgrade to Remote Max for unlimited use.");
    expect(doc.querySelector(".msg.queued .queued-text")?.textContent).toBe("do not lose this");
    expect(doc.querySelector(".msg.queued .queued-tag")?.textContent).toBe("Not sent");
    expect(doc.querySelector(".msg.queued .queued-tag")?.getAttribute("title"))
      .toMatch(/rejected.*edit.*retry/i);
    expect(doc.querySelectorAll(".msg.queued .queued-action")).toHaveLength(2);
    expect(doc.querySelector(".queued-steer")).toBeNull(); // No host capability advertised.
    expect(doc.getElementById("send-btn")!.classList.contains("stop")).toBe(false);
  });

  it("cancels host-side remote voice when the page is torn down", async () => {
    let stopped = false;
    const { window, posted, doc } = bootWebview({
      remote: true,
      beforeScripts: (w) => {
        const track = { stop: () => { stopped = true; }, addEventListener: () => {} };
        Object.defineProperty((w as any).navigator, "mediaDevices", {
          configurable: true,
          value: { getUserMedia: async () => ({ getTracks: () => [track] }) },
        });
        class FakeNode {
          port = { onmessage: undefined as any, postMessage: () => {} };
          connect() {}
          disconnect() {}
        }
        class FakeAudioContext {
          audioWorklet = { addModule: async () => {} };
          destination = {};
          createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
          createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
          close() { return Promise.resolve(); }
        }
        (w as any).AudioWorkletNode = FakeNode;
        (w as any).AudioContext = FakeAudioContext;
      },
    });

    click(window, doc.getElementById("mic-btn")!);
    await new Promise((resolve) => setTimeout(resolve, 0));
    window.dispatchEvent(new window.Event("pagehide"));

    expect(posted).toContainEqual({ type: "remoteVoiceStop", cancel: true });
    expect(stopped).toBe(true);
  });

  it("previews remote text size while dragging, then persists and applies it on release", () => {
    const { window, doc } = bootWebview({ remote: true, beforeScripts: withRailMount });
    // Text size lives in Settings → General, not on the
    // composer's popover: that one is about this conversation (model, effort),
    // and how big the text is on this device is not a property of it.
    openSettingsGeneral(window, doc);

    const slider = fontSlider(doc);
    expect(slider).toBeTruthy();
    expect(doc.getElementById("settings-overlay")!.textContent).toContain("Text size");
    // Model and Effort deliberately stay on the conversation surface.

    const output = slider.parentElement!.querySelector("output")!;
    slider.value = "140";
    slider.dispatchEvent(new (window as any).Event("input", { bubbles: true }));

    expect(output.textContent).toBe("140%");
    expect(doc.body.style.getPropertyValue("--chat-zoom")).toBe("1");
    expect((window as any).localStorage.getItem("grok.remote.fontScale")).toBeNull();

    slider.dispatchEvent(new (window as any).Event("change", { bubbles: true }));

    expect(doc.body.style.getPropertyValue("--chat-zoom")).toBe("1.4");
    expect((window as any).localStorage.getItem("grok.remote.fontScale")).toBe("1.4");
  });

  it("keeps AFK Pilot zoom independent from later local VS Code font-scale updates", () => {
    const { window, doc } = bootWebview({
      remote: true,
      beforeScripts: (w) => {
        (w as any).localStorage.setItem("grok.remote.fontScale", "1.4");
      },
    });

    expect(doc.body.style.getPropertyValue("--chat-zoom")).toBe("1.4");
    dispatch(window, { type: "fontScale", value: 1.3 });
    expect(doc.body.style.getPropertyValue("--chat-zoom")).toBe("1.4");
  });

  it("defaults remote read-aloud off, exposes its hook, and renders the independent gear toggle", () => {
    let cancellations = 0;
    const changes: Array<{ available: boolean; enabled: boolean }> = [];
    const { window, posted, doc } = bootWebview({
      remote: true,
      beforeScripts: (w) => {
        (w as any).SpeechSynthesisUtterance = class {};
        (w as any).speechSynthesis = {
          cancel() { cancellations += 1; },
          speak() {},
        };
        (w as any).addEventListener("grokRemoteTtsChange", (event: CustomEvent) => {
          changes.push(event.detail);
        });
      },
    });
    const api = (window as any).grokRemoteTts;
    dispatch(window, {
      type: "initialState",
      readRepliesAloud: false,
    });

    expect(api.available).toBe(true);
    expect(api.enabled).toBe(false);
    expect(api.setEnabled(true)).toBe(true);
    expect(api.enabled).toBe(true);
    expect((window as any).localStorage.getItem("grok.remote.tts")).toBe("true");
    expect(api.toggle()).toBe(false);
    expect(cancellations).toBe(1);
    expect(changes).toEqual([
      { available: true, enabled: true },
      { available: true, enabled: false },
    ]);
    expect(posted).toContainEqual({
      type: "remotePreferences",
      fontScale: 100,
      readRepliesAloud: false,
      summarizeRepliesAloud: false,
      usesTouch: false,
    });

    click(window, doc.getElementById("gear-btn")!);
    const settings = [...doc.querySelectorAll("#gear-popover .toolbar-popover-item")]
      .find((el) => /(^|\s)Settings$/.test((el.textContent || "").replace(/\s+/g, " ").trim()))!;
    click(window, settings);
    clickSettingsNav(window, doc, "Voice");
    const toggle = doc.querySelector('[data-id="readRepliesAloud"] .settings-switch') as HTMLElement;
    expect(toggle).toBeTruthy();
    expect(toggle.classList.contains("on")).toBe(false);
    click(window, toggle);
    expect(api.enabled).toBe(true);
    expect(posted.some((m) => m.type === "setReadRepliesAloud")).toBe(false);
  });

  it("reports browser preferences only after the host proves support", () => {
    const { window, posted, doc } = bootWebview({ remote: true, beforeScripts: withRailMount });
    dispatch(window, {
      type: "session",
      sessionId: "s1",
      models: [],
      currentModelId: "grok-build",
    });
    expect(posted.filter((message) => message.type === "remotePreferences")).toEqual([]);

    openSettingsGeneral(window, doc);
    const slider = fontSlider(doc)!;
    expect(slider).toBeTruthy();
    slider.value = "150";
    slider.dispatchEvent(new (window as any).Event("change", { bubbles: true }));
    expect(posted.filter((message) => message.type === "remotePreferences")).toEqual([]);

    dispatch(window, {
      type: "initialState",
      readRepliesAloud: false,
    });
    expect(posted).toContainEqual({
      type: "remotePreferences",
      fontScale: 150,
      readRepliesAloud: false,
      summarizeRepliesAloud: false,
      usesTouch: false,
    });

    const slider2 = fontSlider(doc)!;
    slider2.value = "140";
    slider2.dispatchEvent(new (window as any).Event("change", { bubbles: true }));

    expect(posted.at(-1)).toEqual({
      type: "remotePreferences",
      fontScale: 140,
      readRepliesAloud: false,
      summarizeRepliesAloud: false,
      usesTouch: false,
    });
  });

  it("keeps remote summarization per-device, paid-call explicit, and dependent on remote TTS", () => {
    const spoken: string[] = [];
    class Utterance {
      constructor(public text: string) {}
    }
    const { window, posted, doc } = bootWebview({
      remote: true,
      beforeScripts: (w) => {
        (w as any).localStorage.setItem("grok.remote.tts", "true");
        (w as any).localStorage.setItem("grok.remote.ttsSummary", "true");
        (w as any).SpeechSynthesisUtterance = Utterance;
        (w as any).speechSynthesis = {
          cancel() {},
          speak(value: Utterance) { spoken.push(value.text); },
        };
      },
    });
    dispatch(window, { type: "initialState", readRepliesAloud: false });
    click(window, doc.getElementById("gear-btn")!);
    const settings = [...doc.querySelectorAll("#gear-popover .toolbar-popover-item")]
      .find((el) => /(^|\s)Settings$/.test((el.textContent || "").replace(/\s+/g, " ").trim()))!;
    click(window, settings);
    clickSettingsNav(window, doc, "Voice");
    const summarize = doc.querySelector('[data-id="summarizeRepliesAloud"]') as HTMLElement;
    expect(summarize.querySelector(".settings-switch.on")).not.toBeNull();
    expect(summarize.textContent).toMatch(/costs an extra/i);

    posted.length = 0;
    dispatch(window, { type: "clearMessages" });
    dispatch(window, {
      type: "session",
      sessionId: "switched-conversation",
      models: [],
      currentModelId: "grok-build",
    });
    dispatch(window, { type: "agentStart" });
    dispatch(window, { type: "messageChunk", text: "Full reply.\n```ts\nhidden();\n```" });
    dispatch(window, { type: "agentEnd" });
    const request = posted.find((message) => message.type === "summarizeSpeech") as any;
    expect(request.text).toBe("Full reply.");
    expect(spoken).toEqual([]);
    dispatch(window, { type: "speechSummary", requestId: request.requestId, text: "Brief update." });
    expect(spoken).toEqual(["Brief update."]);

    click(window, doc.querySelector('[data-id="readRepliesAloud"] .settings-switch')!);
    expect((window as any).localStorage.getItem("grok.remote.tts")).toBe("false");
    expect((window as any).localStorage.getItem("grok.remote.ttsSummary")).toBe("false");
    const disabledSummary = doc.querySelector('[data-id="summarizeRepliesAloud"]') as HTMLElement;
    expect(disabledSummary.classList.contains("is-disabled")).toBe(true);
    expect(disabledSummary.querySelector(".settings-switch.on")).toBeNull();
    expect(posted.at(-1)).toEqual({
      type: "remotePreferences",
      fontScale: 100,
      readRepliesAloud: false,
      summarizeRepliesAloud: false,
      usesTouch: false,
    });
  });

  it("speaks the original reply when a requested summary never arrives", () => {
    const spoken: string[] = [];
    let fireFallback: (() => void) | undefined;
    class Utterance {
      constructor(public text: string) {}
    }
    const { window, posted } = bootWebview({
      remote: true,
      beforeScripts: (w) => {
        const nativeSetTimeout = (w as any).setTimeout.bind(w);
        (w as any).setTimeout = (callback: () => void, delay: number, ...args: unknown[]) => {
          if (delay === 12_000) {
            fireFallback = () => callback();
            return 12_000;
          }
          return nativeSetTimeout(callback, delay, ...args);
        };
        (w as any).localStorage.setItem("grok.remote.tts", "true");
        (w as any).localStorage.setItem("grok.remote.ttsSummary", "true");
        (w as any).SpeechSynthesisUtterance = Utterance;
        (w as any).speechSynthesis = {
          cancel() {},
          speak(value: Utterance) { spoken.push(value.text); },
        };
      },
    });
    dispatch(window, { type: "initialState", readRepliesAloud: false });
    posted.length = 0;
    dispatch(window, { type: "agentStart" });
    dispatch(window, { type: "messageChunk", text: "The full reply remains useful." });
    dispatch(window, { type: "agentEnd" });

    const request = posted.find((message) => message.type === "summarizeSpeech") as any;
    expect(request.text).toBe("The full reply remains useful.");
    expect(spoken).toEqual([]);

    expect(fireFallback).toBeTypeOf("function");
    fireFallback!();
    expect(spoken).toEqual(["The full reply remains useful."]);

    dispatch(window, { type: "speechSummary", requestId: request.requestId, text: "Late summary." });
    expect(spoken).toEqual(["The full reply remains useful."]);
  });

  it("does not expose the remote TTS hook in the VS Code webview", () => {
    const { window } = bootWebview();
    expect((window as any).grokRemoteTts).toBeUndefined();
  });

  it("does not let the local VS Code read-aloud flag enable remote speech", () => {
    const spoken: string[] = [];
    class Utterance {
      constructor(public text: string) {}
    }
    const { window } = bootWebview({
      remote: true,
      beforeScripts: (w) => {
        (w as any).SpeechSynthesisUtterance = Utterance;
        (w as any).speechSynthesis = {
          cancel() {},
          speak(value: Utterance) { spoken.push(value.text); },
        };
      },
    });
    dispatch(window, { type: "readRepliesAloud", value: true });
    dispatch(window, { type: "agentStart" });
    dispatch(window, { type: "messageChunk", text: "Remote reply." });
    dispatch(window, { type: "agentEnd" });
    expect(spoken).toEqual([]);
  });

  it("reads completed replies aloud while omitting fenced code", () => {
    const spoken: string[] = [];
    class Utterance {
      constructor(public text: string) {}
    }
    const { window } = bootWebview({
      remote: true,
      beforeScripts: (w) => {
        (w as any).localStorage.setItem("grok.remote.tts", "true");
        (w as any).localStorage.setItem("grok.remote.ttsSummary", "false");
        (w as any).SpeechSynthesisUtterance = Utterance;
        (w as any).speechSynthesis = {
          cancel() {},
          speak(value: Utterance) { spoken.push(value.text); },
        };
      },
    });

    dispatch(window, { type: "agentStart" });
    dispatch(window, { type: "messageChunk", text: "Done.\n```ts\nconst secret = 1;\n```\nUse the Send button." });
    dispatch(window, { type: "agentEnd" });

    expect(spoken).toEqual(["Done. Use the Send button."]);
  });

  it("never re-speaks a completed buffered reply during reconnect replay", () => {
    const spoken: string[] = [];
    class Utterance {
      constructor(public text: string) {}
    }
    const { window } = bootWebview({
      remote: true,
      beforeScripts: (w) => {
        (w as any).localStorage.setItem("grok.remote.tts", "true");
        (w as any).localStorage.setItem("grok.remote.ttsSummary", "false");
        (w as any).SpeechSynthesisUtterance = Utterance;
        (w as any).speechSynthesis = {
          cancel() {},
          speak(value: Utterance) { spoken.push(value.text); },
        };
      },
    });

    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "agentStart" });
    dispatch(window, { type: "messageChunk", text: "Old reply." });
    dispatch(window, { type: "agentEnd" });
    dispatch(window, { type: "historyReplay", active: false });
    expect(spoken).toEqual([]);

    dispatch(window, { type: "agentStart" });
    dispatch(window, { type: "messageChunk", text: "New reply." });
    dispatch(window, { type: "agentEnd" });
    expect(spoken).toEqual(["New reply."]);
  });

  it("speaks the full reply when a buffered in-flight turn finishes after sync", () => {
    const spoken: string[] = [];
    class Utterance {
      constructor(public text: string) {}
    }
    const { window } = bootWebview({
      remote: true,
      beforeScripts: (w) => {
        (w as any).localStorage.setItem("grok.remote.tts", "true");
        (w as any).localStorage.setItem("grok.remote.ttsSummary", "false");
        (w as any).SpeechSynthesisUtterance = Utterance;
        (w as any).speechSynthesis = {
          cancel() {},
          speak(value: Utterance) { spoken.push(value.text); },
        };
      },
    });

    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "agentStart" });
    dispatch(window, { type: "messageChunk", text: "Started before reconnect. " });
    dispatch(window, { type: "historyReplay", active: false });
    dispatch(window, { type: "messageChunk", text: "Finished after sync." });
    dispatch(window, { type: "agentEnd" });

    expect(spoken).toEqual(["Started before reconnect. Finished after sync."]);
  });

  it("keeps snapshot suppression active across nested load-session replay brackets", () => {
    const spoken: string[] = [];
    class Utterance {
      constructor(public text: string) {}
    }
    const { window } = bootWebview({
      remote: true,
      beforeScripts: (w) => {
        (w as any).localStorage.setItem("grok.remote.tts", "true");
        (w as any).localStorage.setItem("grok.remote.ttsSummary", "false");
        (w as any).SpeechSynthesisUtterance = Utterance;
        (w as any).speechSynthesis = {
          cancel() {},
          speak(value: Utterance) { spoken.push(value.text); },
        };
      },
    });

    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "messageChunk", text: "Loaded history." });
    dispatch(window, { type: "historyReplay", active: false });
    dispatch(window, { type: "agentStart" });
    dispatch(window, { type: "messageChunk", text: "Buffered live turn." });
    dispatch(window, { type: "agentEnd" });
    dispatch(window, { type: "historyReplay", active: false });

    expect(spoken).toEqual([]);
  });
});

describe("tap to enlarge (remote)", () => {
  const chip = (extra: Record<string, unknown> = {}) => ({
    id: "image-1",
    path: "/staged/image-1.jpg",
    relPath: "Image #1",
    hidden: false,
    imageIndex: 1,
    mimeType: "image/jpeg",
    previewSrc: "data:image/jpeg;base64,dGh1bWI=",
    ...extra,
  });

  it("asks the host for a real render and swaps it into the open overlay", () => {
    // A remote only holds a 320px thumbnail. Without this round trip, tapping
    // enlarges the thumbnail — which is what issue #88 asked for and did not get
    // away from the desk.
    const { window, posted, doc } = bootWebview({ remote: true });
    dispatch(window, { type: "chips", chips: [chip({ fullId: "handle-1" })] });

    click(window, doc.querySelector(".attachment .chip-preview, .attachment button")!);

    expect(posted.find((m) => m.type === "requestImageFull")).toMatchObject({ fullId: "handle-1" });
    const img = doc.querySelector(".image-preview-overlay img") as HTMLImageElement;
    expect(img.src).toBe("data:image/jpeg;base64,dGh1bWI="); // thumbnail until the render lands

    dispatch(window, { type: "imageFull", fullId: "handle-1", src: "data:image/jpeg;base64,ZnVsbA==" });
    expect(img.src).toBe("data:image/jpeg;base64,ZnVsbA==");
  });

  it("ignores a render for a picture the overlay has moved on from", () => {
    // A slow reply must not replace whatever the user is looking at now.
    const { window, doc } = bootWebview({ remote: true });
    dispatch(window, { type: "chips", chips: [chip({ fullId: "handle-1" })] });
    click(window, doc.querySelector(".attachment .chip-preview, .attachment button")!);

    dispatch(window, { type: "imageFull", fullId: "some-other-handle", src: "data:image/jpeg;base64,d3Jvbmc=" });

    const img = doc.querySelector(".image-preview-overlay img") as HTMLImageElement;
    expect(img.src).toBe("data:image/jpeg;base64,dGh1bWI=");
  });

  it("sends nothing when the host offered no handle", () => {
    // Capability detection: an older host never issues one, and the client must
    // not emit a frame it cannot answer.
    const { window, posted, doc } = bootWebview({ remote: true });
    dispatch(window, { type: "chips", chips: [chip()] });

    click(window, doc.querySelector(".attachment .chip-preview, .attachment button")!);

    expect(posted.filter((m) => m.type === "requestImageFull")).toHaveLength(0);
  });
});

describe("remembered remote session (the A→B→A→B repo bounce)", () => {
  it("remembers the repo the SESSION lives in, not the one being browsed", () => {
    // Browsing repo B's history while the live session is in repo A is a normal
    // state — the chip says "Browsing B; live session is in A". Remembering B
    // alongside A's session id makes the next reconnect send selectRepo(B) and
    // then resumeSession(a session in A): two contradictory commands the host
    // obeys in order, which is the bounce.
    const { window } = bootWebview({ remote: true });
    dispatch(window, {
      type: "repos",
      entries: [{ cwd: "/work/a", label: "a", available: true }, { cwd: "/work/b", label: "b", available: true }],
      selectedCwd: "/work/b",
      activeCwd: "/work/a",
    });
    dispatch(window, {
      type: "sessions",
      entries: [{ id: "s1", displayName: "live one", updatedAt: 1, cwd: "/work/a" }],
      activeId: "s1",
    });

    const saved = JSON.parse(
      window.sessionStorage.getItem(
        Object.keys(window.sessionStorage).find((k) => k.startsWith("grok.remote.tabSession:"))!,
      )!,
    );
    expect(saved.id).toBe("s1");
    expect(saved.repoCwd).toBe("/work/a"); // the session's repo, NOT the browsed "/work/b"
    expect(saved.cwd).toBe("/work/a");
  });
});

describe("full-size loading spinner", () => {
  const imgChip = {
    id: "image-1",
    path: "/staged/image-1.jpg",
    relPath: "Image #1",
    hidden: false,
    imageIndex: 1,
    mimeType: "image/jpeg",
    previewSrc: "data:image/jpeg;base64,dGh1bWI=",
    fullId: "handle-1",
  };

  it("spins while the render is in flight and stops when it lands", () => {
    const { window, doc } = bootWebview({ remote: true });
    dispatch(window, { type: "chips", chips: [imgChip] });
    click(window, doc.querySelector(".attachment .chip-preview, .attachment button")!);

    const spinner = doc.querySelector(".image-preview-spinner") as HTMLElement;
    expect(spinner.hidden).toBe(false);
    // The low-res picture stays on screen underneath rather than being blanked.
    expect((doc.querySelector(".image-preview-overlay img") as HTMLImageElement).src)
      .toBe("data:image/jpeg;base64,dGh1bWI=");

    dispatch(window, { type: "imageFull", fullId: "handle-1", src: "data:image/jpeg;base64,ZnVsbA==" });
    expect(spinner.hidden).toBe(true);
  });

  it("stops spinning when the host has no render to give", () => {
    // A source that was swept or deleted answers with no src. Left alone the
    // disc would turn forever over a picture that is never going to sharpen.
    const { window, doc } = bootWebview({ remote: true });
    dispatch(window, { type: "chips", chips: [imgChip] });
    click(window, doc.querySelector(".attachment .chip-preview, .attachment button")!);
    expect((doc.querySelector(".image-preview-spinner") as HTMLElement).hidden).toBe(false);

    dispatch(window, { type: "imageFull", fullId: "handle-1" });

    expect((doc.querySelector(".image-preview-spinner") as HTMLElement).hidden).toBe(true);
    expect((doc.querySelector(".image-preview-overlay img") as HTMLImageElement).src)
      .toBe("data:image/jpeg;base64,dGh1bWI=");
  });

  it("does not spin when there is nothing to wait for", () => {
    const { window, doc } = bootWebview({ remote: true });
    const { fullId: _drop, ...noHandle } = imgChip;
    dispatch(window, { type: "chips", chips: [noHandle] });
    click(window, doc.querySelector(".attachment .chip-preview, .attachment button")!);
    expect((doc.querySelector(".image-preview-spinner") as HTMLElement).hidden).toBe(true);
  });
});
