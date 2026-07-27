import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch } from "./webview-harness";

function key(window: any, el: Element, init: Record<string, unknown>) {
  const event = new window.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  el.dispatchEvent(event);
  return event;
}

describe("AFK Pilot shared webview controls", () => {
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

  it("uses browser speech recognition for remote dictation without posting host voice messages", () => {
    let recognition: any;
    class FakeRecognition {
      continuous = false;
      interimResults = false;
      onresult?: (event: any) => void;
      onerror?: () => void;
      onend?: () => void;
      constructor() { recognition = this; }
      start() {}
      stop() { this.onend?.(); }
    }
    const { window, posted, doc } = bootWebview({
      remote: true,
      beforeScripts: (w) => { (w as any).webkitSpeechRecognition = FakeRecognition; },
    });
    const input = doc.getElementById("input") as HTMLTextAreaElement;
    input.value = "Please now";
    input.setSelectionRange(6, 6);

    click(window, doc.getElementById("mic-btn")!);
    expect(doc.getElementById("mic-btn")!.classList.contains("listening")).toBe(true);
    expect(posted.filter((m) => m.type === "voiceStart")).toHaveLength(0);

    const result: any = [{ transcript: "fix the tests" }];
    result.isFinal = true;
    recognition.onresult({ results: [result] });
    expect(input.value).toBe("Please fix the tests now");

    click(window, doc.getElementById("mic-btn")!);
    expect(doc.getElementById("mic-btn")!.classList.contains("listening")).toBe(false);
  });

  it("stops browser dictation on manual send and ignores late results", () => {
    let recognition: any;
    class FakeRecognition {
      onresult?: (event: any) => void;
      onerror?: () => void;
      onend?: () => void;
      start() {}
      stop() { this.onend?.(); }
      abort() { this.onend?.(); }
      constructor() { recognition = this; }
    }
    const { window, posted, doc } = bootWebview({
      remote: true,
      beforeScripts: (w) => { (w as any).webkitSpeechRecognition = FakeRecognition; },
    });
    const input = doc.getElementById("input") as HTMLTextAreaElement;

    click(window, doc.getElementById("mic-btn")!);
    const lateResult = recognition.onresult;
    const partial: any = [{ transcript: "send this message" }];
    partial.isFinal = false;
    lateResult({ results: [partial] });
    expect(input.value).toBe("send this message");

    click(window, doc.getElementById("send-btn")!);
    expect(posted.find((m) => m.type === "send")).toMatchObject({ text: "send this message" });
    expect(posted.filter((m) => m.type === "voiceStop")).toHaveLength(0);
    expect(input.value).toBe("");
    expect(doc.getElementById("mic-btn")!.classList.contains("listening")).toBe(false);

    const stale: any = [{ transcript: "late words" }];
    stale.isFinal = true;
    lateResult({ results: [stale] });
    expect(input.value).toBe("");
  });

  it("previews remote text size while dragging, then persists and applies it on release", () => {
    const { window, doc } = bootWebview({ remote: true });
    click(window, doc.getElementById("gear-btn")!);
    const config = [...doc.querySelectorAll("#gear-popover .toolbar-popover-item")]
      .find((el) => el.textContent?.includes("Config & debug"))!;
    click(window, config);

    const slider = doc.getElementById("remote-font-scale") as HTMLInputElement;
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
      usesTouch: false,
    });

    click(window, doc.getElementById("gear-btn")!);
    const config = [...doc.querySelectorAll("#gear-popover .toolbar-popover-item")]
      .find((el) => el.textContent?.includes("Config & debug"))!;
    click(window, config);
    const toggle = [...doc.querySelectorAll("#gear-popover .toolbar-popover-item")]
      .find((el) => el.textContent?.includes("Read replies aloud")) as HTMLElement;
    expect(toggle).toBeTruthy();
    expect(toggle.querySelector(".popover-switch.on")).toBeNull();
    click(window, toggle);
    expect(api.enabled).toBe(true);
    expect(posted.some((m) => m.type === "setReadRepliesAloud")).toBe(false);
  });

  it("reports browser preferences only after the host proves support", () => {
    const { window, posted, doc } = bootWebview({ remote: true });
    dispatch(window, {
      type: "session",
      sessionId: "s1",
      models: [],
      currentModelId: "grok-build",
    });
    expect(posted.filter((message) => message.type === "remotePreferences")).toEqual([]);

    click(window, doc.getElementById("gear-btn")!);
    const config = [...doc.querySelectorAll("#gear-popover .toolbar-popover-item")]
      .find((el) => el.textContent?.includes("Config & debug"))!;
    click(window, config);
    const slider = doc.getElementById("remote-font-scale") as HTMLInputElement;
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
      usesTouch: false,
    });

    slider.value = "140";
    slider.dispatchEvent(new (window as any).Event("change", { bubbles: true }));

    expect(posted.at(-1)).toEqual({
      type: "remotePreferences",
      fontScale: 140,
      readRepliesAloud: false,
      usesTouch: false,
    });
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
