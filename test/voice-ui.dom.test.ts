// DOM-level tests for the voice-input mic button, driving the REAL media/chat.js
// inside happy-dom. Covers the click→record→transcribe→insert lifecycle and the
// host-driven state sync / error reset — no microphone, ffmpeg, or network.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { bootWebview, dispatch, click, Posted } from "./webview-harness";

const $ = (doc: Document, id: string) => doc.getElementById(id) as HTMLElement;
const types = (posted: Posted[]) => posted.map((p) => p.type);
const sidebarSrc = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");

describe("voice control mic button", () => {
  it.each([false, true])("reports that another chat owns the mic (editor tab: %s)", editor => {
    const { window, doc, posted } = bootWebview({ vscode: true, beforeScripts: window => {
      if (editor) window.document.body.dataset.editorChat = "true";
    } });
    if (editor) dispatch(window, { type: "editorChatBound", binding: 7 });
    const mic = doc.querySelector<HTMLButtonElement>("#mic-btn")!;
    dispatch(window, { type: "localVoiceBusy", value: true });
    expect(mic.disabled).toBe(true);
    expect(mic.title).toBe("Dictation is active in another chat");
    expect(mic.classList.contains("busy-elsewhere")).toBe(true);
    posted.length = 0;
    click(window, mic);
    expect(posted).toHaveLength(0);

    dispatch(window, { type: "localVoiceBusy", value: false });
    expect(mic.disabled).toBe(false);
    click(window, mic);
    expect(posted).toContainEqual(editor
      ? { type: "editorChatAction", binding: 7, message: { type: "voiceStart" } }
      : { type: "voiceStart" });
  });

  it("starts idle showing the mic icon", () => {
    const { doc } = bootWebview();
    const mic = $(doc, "mic-btn");
    expect(mic.classList.contains("listening")).toBe(false);
    expect(mic.classList.contains("transcribing")).toBe(false);
    expect(mic.innerHTML).toContain("svg"); // mic glyph
  });

  it("first click shows 'connecting'; waves appear only once the host confirms the stream is live", () => {
    const { window, posted, doc } = bootWebview();
    const mic = $(doc, "mic-btn");

    click(window, mic);

    expect(types(posted)).toContain("voiceStart");
    expect(mic.classList.contains("connecting")).toBe(true);   // not capturing yet
    expect(mic.classList.contains("listening")).toBe(false);

    dispatch(window, { type: "voiceState", status: "listening" }); // stream ready → "talk now"
    expect(mic.classList.contains("listening")).toBe(true);
    expect(mic.innerHTML).toContain("mic-waves"); // animated bars while listening
  });

  it("second click stops and requests transcription", () => {
    const { window, posted, doc } = bootWebview();
    const mic = $(doc, "mic-btn");

    click(window, mic); // → listening
    click(window, mic); // → transcribing

    expect(types(posted)).toEqual(["voiceStart", "voiceStop"]);
    expect(mic.classList.contains("transcribing")).toBe(true);
    expect((mic as HTMLButtonElement).disabled).toBe(true); // can't click while transcribing
  });

  it("ignores clicks while transcribing (no duplicate voiceStop)", () => {
    const { window, posted, doc } = bootWebview();
    const mic = $(doc, "mic-btn");
    click(window, mic); // listening
    click(window, mic); // transcribing
    click(window, mic); // ignored

    expect(posted.filter((p) => p.type === "voiceStop")).toHaveLength(1);
    expect(posted.filter((p) => p.type === "voiceStart")).toHaveLength(1);
  });

  it("inserts the transcript into the composer and returns to idle", () => {
    const { window, doc } = bootWebview();
    const mic = $(doc, "mic-btn");
    const input = $(doc, "input") as HTMLTextAreaElement;
    click(window, mic);
    click(window, mic);

    dispatch(window, { type: "voiceTranscript", text: "The quick brown fox jumps over the lazy dog." });

    expect(input.value).toBe("The quick brown fox jumps over the lazy dog.");
    expect(mic.classList.contains("transcribing")).toBe(false);
    expect(mic.classList.contains("listening")).toBe(false);
  });

  it("auto-submits when the host flags a 'grok send' command", () => {
    const { window, posted, doc } = bootWebview();
    const mic = $(doc, "mic-btn");
    const input = $(doc, "input") as HTMLTextAreaElement;
    click(window, mic);
    click(window, mic);

    dispatch(window, { type: "voiceTranscript", text: "fix the bug", send: true });

    const sent = posted.find((p) => p.type === "send");
    expect(sent).toBeTruthy();
    expect((sent as Posted).text).toBe("fix the bug");
    expect(mic.classList.contains("transcribing")).toBe(false); // back to idle
  });

  it("does not auto-submit when send is false", () => {
    const { window, posted, doc } = bootWebview();
    dispatch(window, { type: "voiceTranscript", text: "fix the bug", send: false });
    expect(posted.some((p) => p.type === "send")).toBe(false);
  });

  it("appends to existing text with a separating space", () => {
    const { window, doc } = bootWebview();
    const input = $(doc, "input") as HTMLTextAreaElement;
    input.value = "Please";
    dispatch(window, { type: "voiceTranscript", text: "refactor this" });
    expect(input.value).toBe("Please refactor this");
  });

  it("does not double-space when existing text already ends in whitespace", () => {
    const { window, doc } = bootWebview();
    const input = $(doc, "input") as HTMLTextAreaElement;
    input.value = "Note: ";
    dispatch(window, { type: "voiceTranscript", text: "hello" });
    expect(input.value).toBe("Note: hello");
  });

  it("inserts batch dictation at the caret and preserves the suffix", () => {
    const { window, doc } = bootWebview();
    const input = $(doc, "input") as HTMLTextAreaElement;
    input.value = "Please review now";
    input.setSelectionRange(13, 13);

    click(window, $(doc, "mic-btn"));
    click(window, $(doc, "mic-btn"));
    dispatch(window, { type: "voiceTranscript", text: "this", send: false });

    expect(input.value).toBe("Please review this now");
    expect(input.selectionStart).toBe(18);
    expect(input.selectionEnd).toBe(18);
  });

  it("resets to idle when the host reports a voiceError", () => {
    const { window, doc } = bootWebview();
    const mic = $(doc, "mic-btn");
    click(window, mic);
    dispatch(window, { type: "voiceState", status: "listening" });
    expect(mic.classList.contains("listening")).toBe(true);

    dispatch(window, { type: "voiceError" });

    expect(mic.classList.contains("listening")).toBe(false);
    expect(mic.classList.contains("transcribing")).toBe(false);
    expect((mic as HTMLButtonElement).disabled).toBe(false);
  });

  it("stops listening when the host resets voice; a busy dictation went to the HOST queue, not a send", () => {
    const { window, posted, doc } = bootWebview();
    const mic = $(doc, "mic-btn");
    click(window, mic);
    dispatch(window, { type: "voiceState", status: "listening" });
    dispatch(window, { type: "setBusy", value: true });
    dispatch(window, { type: "voiceSubmit", text: "queued" }); // routed to the host-owned queue

    dispatch(window, { type: "voiceState", status: "idle" });   // host stops voice on session switch
    expect(mic.classList.contains("listening")).toBe(false);
    expect(mic.classList.contains("connecting")).toBe(false);

    // The webview never fires sends at turn end — the HOST owns the queue and
    // flushes it in the session the message belongs to.
    expect((posted.find((p) => p.type === "queueSend") as Posted)?.text).toBe("queued");
    dispatch(window, { type: "agentEnd" });
    expect(posted.some((p) => p.type === "send")).toBe(false);
  });

  it("honors a host voiceState sync to transcribing", () => {
    const { window, doc } = bootWebview();
    const mic = $(doc, "mic-btn");
    dispatch(window, { type: "voiceState", status: "transcribing" });
    expect(mic.classList.contains("transcribing")).toBe(true);
  });

  it("ignores an unknown voiceState status", () => {
    const { window, doc } = bootWebview();
    const mic = $(doc, "mic-btn");
    dispatch(window, { type: "voiceState", status: "bogus" });
    expect(mic.classList.contains("listening")).toBe(false);
    expect(mic.classList.contains("transcribing")).toBe(false);
  });
});

describe("voice control: live streaming transcription", () => {
  it("shows live partials in the composer as they stream in", () => {
    const { window, doc } = bootWebview();
    const mic = $(doc, "mic-btn");
    const input = $(doc, "input") as HTMLTextAreaElement;
    click(window, mic); // start listening

    dispatch(window, { type: "voicePartial", text: "add a logout" });
    expect(input.value).toBe("add a logout");
    dispatch(window, { type: "voicePartial", text: "add a logout button to the navbar" });
    expect(input.value).toBe("add a logout button to the navbar");
  });

  it("preserves text typed before dictation and appends the live tail", () => {
    const { window, doc } = bootWebview();
    const mic = $(doc, "mic-btn");
    const input = $(doc, "input") as HTMLTextAreaElement;
    input.value = "Note:";
    click(window, mic);

    dispatch(window, { type: "voicePartial", text: "fix the parser" });
    expect(input.value).toBe("Note: fix the parser");
  });

  it("anchors to the caret at MIC START, even when the client is unconfigured", () => {
    // The client is not the authority on the key: it can believe voice is
    // unconfigured while the host records anyway. The capture used to sit inside
    // that guard, so the first partial rendered "" + transcript and wiped the
    // draft. Moving the caret after the click is what makes this test bite —
    // rendering re-captures lazily as a fallback, so anchoring at start is only
    // observable once the two positions differ.
    const { window, posted, doc } = bootWebview();
    const input = $(doc, "input") as HTMLTextAreaElement;
    input.value = "Keep this draft";
    input.setSelectionRange(5, 5);
    dispatch(window, { type: "voiceConfigured", value: false });

    click(window, $(doc, "mic-btn"));
    expect(posted.some((p) => p.type === "voiceStart")).toBe(true);

    input.setSelectionRange(0, 0); // caret wanders before the first partial lands
    dispatch(window, { type: "voicePartial", text: "the" });

    expect(input.value).toBe("Keep the this draft"); // not "theKeep this draft"
  });

  it("final voiceTranscript replaces the live tail (not appends) in streaming mode", () => {
    const { window, doc } = bootWebview();
    const mic = $(doc, "mic-btn");
    const input = $(doc, "input") as HTMLTextAreaElement;
    click(window, mic);
    dispatch(window, { type: "voicePartial", text: "add a logout buttn" }); // interim typo
    dispatch(window, { type: "voiceTranscript", text: "add a logout button", send: false });

    expect(input.value).toBe("add a logout button"); // replaced, not doubled
    expect(mic.classList.contains("listening")).toBe(false);
  });

  it("auto-submits the live transcript when send is flagged (hands-free 'grok send')", () => {
    const { window, posted, doc } = bootWebview();
    const mic = $(doc, "mic-btn");
    click(window, mic);
    dispatch(window, { type: "voicePartial", text: "add a logout button" });
    dispatch(window, { type: "voiceTranscript", text: "add a logout button", send: true });

    const sent = posted.find((p) => p.type === "send");
    expect(sent).toBeTruthy();
    expect((sent as Posted).text).toBe("add a logout button");
    expect(posted.filter((p) => p.type === "voiceStop")).toHaveLength(0);
  });
});

describe("voice control: continuous listening + queue (hands-free)", () => {
  it("voiceSubmit sends immediately when idle, clears composer, and KEEPS listening", () => {
    const { window, posted, doc } = bootWebview();
    const mic = $(doc, "mic-btn");
    const input = $(doc, "input") as HTMLTextAreaElement;
    click(window, mic);
    dispatch(window, { type: "voiceState", status: "listening" });
    dispatch(window, { type: "voicePartial", text: "add a logout button grok send" });

    dispatch(window, { type: "voiceSubmit", text: "add a logout button" });

    const sent = posted.find((p) => p.type === "send");
    expect((sent as Posted)?.text).toBe("add a logout button");
    expect(input.value).toBe("");                              // composer cleared for next utterance
    expect(mic.classList.contains("listening")).toBe(true);   // mic stays on — no click needed
  });

  it("submits the visible draft plus dictation when hands-free send is detected", () => {
    const { window, posted, doc } = bootWebview();
    const input = $(doc, "input") as HTMLTextAreaElement;
    input.value = "Please review";
    click(window, $(doc, "mic-btn"));
    dispatch(window, { type: "voicePartial", text: "the authentication code" });
    expect(input.value).toBe("Please review the authentication code");

    dispatch(window, { type: "voiceSubmit", text: "the authentication code" });

    expect(posted.find((p) => p.type === "send")).toEqual({
      type: "send",
      text: "Please review the authentication code",
    });
  });

  it("submits the existing draft for a bare hands-free send phrase", () => {
    const { window, posted, doc } = bootWebview();
    const input = $(doc, "input") as HTMLTextAreaElement;
    input.value = "Please review";
    click(window, $(doc, "mic-btn"));

    dispatch(window, { type: "voiceSubmit", text: "" });

    expect(posted.find((p) => p.type === "send")).toEqual({
      type: "send",
      text: "Please review",
    });
    expect(input.value).toBe("");
  });

  it("routes a voiceSubmit to the HOST queue while Grok is busy — never a direct send", () => {
    const { window, posted, doc } = bootWebview();
    const mic = $(doc, "mic-btn");
    click(window, mic);
    dispatch(window, { type: "setBusy", value: true });       // Grok is responding
    dispatch(window, { type: "voiceSubmit", text: "second message" });

    expect(posted.some((p) => p.type === "send")).toBe(false); // not sent — queued host-side
    expect((posted.find((p) => p.type === "queueSend") as Posted)?.text).toBe("second message");

    dispatch(window, { type: "agentEnd" });                    // the HOST flushes, not the webview
    expect(posted.some((p) => p.type === "send")).toBe(false);
  });

  it("clears the queued blocks when the host empties the queue on process exit", () => {
    const { window, doc } = bootWebview();
    click(window, $(doc, "mic-btn"));
    dispatch(window, { type: "setBusy", value: true });
    dispatch(window, { type: "queuedSends", items: ["stale"] }); // host snapshot → block renders
    expect(doc.querySelectorAll(".msg.queued").length).toBe(1);

    dispatch(window, { type: "exit", code: 1 });                 // session dies…
    dispatch(window, { type: "queuedSends", items: [] });        // …host clears its queue
    expect(doc.querySelectorAll(".msg.queued").length).toBe(0);
  });

  it("posts each message dictated during one response to the host queue, in order", () => {
    const { window, posted, doc } = bootWebview();
    const mic = $(doc, "mic-btn");
    click(window, mic);
    dispatch(window, { type: "setBusy", value: true });
    dispatch(window, { type: "voiceSubmit", text: "msg one" });
    dispatch(window, { type: "voiceSubmit", text: "msg two" });

    expect(posted.filter((p) => p.type === "queueSend").map((p) => (p as Posted).text))
      .toEqual(["msg one", "msg two"]);
    expect(posted.some((p) => p.type === "send")).toBe(false); // combining + flushing is the host's job
  });
});

describe("voice control: 'grok send' command highlight", () => {
  it("wraps a trailing send phrase in an accent pill on the backdrop", () => {
    const { window, doc } = bootWebview();
    const mic = $(doc, "mic-btn");
    const hl = $(doc, "input-highlight");
    click(window, mic);

    dispatch(window, { type: "voicePartial", text: "add a logout button grok send" });

    expect(hl.innerHTML).toContain('class="cmd-token"');
    expect(hl.textContent).toContain("grok send");
    // the highlighted token is exactly the command
    expect(hl.querySelector(".cmd-token")?.textContent).toBe("grok send");
  });

  it("does not highlight when there is no trailing command", () => {
    const { window, doc } = bootWebview();
    const mic = $(doc, "mic-btn");
    const hl = $(doc, "input-highlight");
    click(window, mic);

    dispatch(window, { type: "voicePartial", text: "just a normal message" });

    expect(hl.innerHTML).not.toContain("cmd-token");
  });

  it("uses the host-provided phrase", () => {
    const { window, doc } = bootWebview();
    const hl = $(doc, "input-highlight");
    const input = $(doc, "input") as HTMLTextAreaElement;
    dispatch(window, { type: "voiceConfigured", value: true, sendPhrase: "go now" });
    input.value = "do the thing go now";
    input.dispatchEvent(new (window as any).Event("input", { bubbles: true }));

    expect(hl.querySelector(".cmd-token")?.textContent).toBe("go now");
  });
});

describe("voice control: API-key setup hint", () => {
  it("shows a 'needs setup' hint when the host reports no key", () => {
    const { window, doc } = bootWebview();
    const mic = $(doc, "mic-btn");
    expect(mic.classList.contains("needs-setup")).toBe(false); // optimistic default

    dispatch(window, { type: "voiceConfigured", value: false });

    expect(mic.classList.contains("needs-setup")).toBe(true);
    expect(mic.title.toLowerCase()).toContain("set up");
  });

  it("does NOT flash listening on click when unconfigured, but still asks the host (for setup guidance)", () => {
    const { window, posted, doc } = bootWebview();
    const mic = $(doc, "mic-btn");
    dispatch(window, { type: "voiceConfigured", value: false });

    click(window, mic);

    expect(mic.classList.contains("listening")).toBe(false); // no misleading flash
    expect(types(posted)).toContain("voiceStart"); // host still decides + shows guidance
  });

  it("explains that voice needs Grok instead of starting when Grok is disconnected", async () => {
    const h = bootWebview();
    dispatch(h.window, {
      type: "providerState",
      providers: [{ id: "claude", connected: true }, { id: "grok", connected: false }],
    });
    dispatch(h.window, { type: "voiceConfigured", value: false });
    h.posted.length = 0;

    const mic = $(h.doc, "mic-btn");
    expect(mic.title).toContain("Voice needs Grok");
    click(h.window, mic);

    expect(types(h.posted)).not.toContain("voiceStart");
    const confirm = h.doc.querySelector(".confirm-overlay") as HTMLElement;
    expect(confirm).toBeTruthy();
    expect(confirm.textContent).toContain("Voice needs Grok");
    expect(confirm.textContent).toContain("Connect Grok");

    const go = [...confirm.querySelectorAll("button")].find((el) => el.textContent === "Connect Grok");
    click(h.window, go!);
    await Promise.resolve();
    expect(h.doc.getElementById("settings-overlay")).toBeTruthy();
    expect(h.doc.querySelector("#settings-overlay .settings-nav-item.active")?.textContent)
      .toContain("Providers");
  });

  it("host setup guidance accepts either vendor and explains API access", () => {
    const setup = sidebarSrc.slice(sidebarSrc.indexOf("private async promptVoiceKeySetup"), sidebarSrc.indexOf("private rejectVoiceStart"));
    expect(setup).toContain("showInformationMessage");
    expect(setup).toContain("OPENAI_API_KEY");
    expect(setup).toContain("xAI key / Grok sign-in");
    expect(setup).toContain("do not include transcription API access");
    expect(setup).not.toContain("runGrokLogin");
  });

  it("still starts when a dedicated key is configured even if Grok is disconnected", () => {
    const h = bootWebview();
    dispatch(h.window, {
      type: "providerState",
      providers: [{ id: "claude", connected: true }, { id: "grok", connected: false }],
    });
    dispatch(h.window, { type: "voiceConfigured", value: true });
    h.posted.length = 0;
    click(h.window, $(h.doc, "mic-btn"));
    expect(types(h.posted)).toContain("voiceStart");
    expect(h.doc.querySelector(".confirm-overlay")).toBeNull();
  });

  it("clears the hint and records normally once a key is configured", () => {
    const { window, doc } = bootWebview();
    const mic = $(doc, "mic-btn");
    dispatch(window, { type: "voiceConfigured", value: false });
    expect(mic.classList.contains("needs-setup")).toBe(true);

    dispatch(window, { type: "voiceConfigured", value: true });
    expect(mic.classList.contains("needs-setup")).toBe(false);

    click(window, mic);
    expect(mic.classList.contains("connecting")).toBe(true);
    dispatch(window, { type: "voiceState", status: "listening" });
    expect(mic.classList.contains("listening")).toBe(true);
  });
});

describe("composer marks provisional dictation apart from the send command", () => {
  it("tints only the dictated span, leaving typed text unmarked", () => {
    const { window, doc } = bootWebview();
    const input = $(doc, "input") as HTMLTextAreaElement;
    input.value = "Keep this draft";
    input.setSelectionRange(5, 5);
    dispatch(window, { type: "voiceConfigured", value: true });
    click(window, $(doc, "mic-btn"));

    dispatch(window, { type: "voicePartial", text: "the" });

    const marked = doc.querySelectorAll("#input-highlight .voice-token");
    expect(marked).toHaveLength(1);
    expect(marked[0].textContent).toBe("the "); // the separator is part of what was inserted
    // The text the user typed is not marked — that is the whole point.
    expect($(doc, "input-highlight").textContent).toBe("Keep the this draft");
  });

  it("gives the send phrase the command style, and does not double-mark it", () => {
    // The phrase arrives INSIDE the dictated span, so the two ranges overlap.
    // The command has to win: it is the irreversible one.
    const { window, doc } = bootWebview();
    const input = $(doc, "input") as HTMLTextAreaElement;
    input.value = "";
    dispatch(window, { type: "voiceConfigured", value: true, sendPhrase: "grok send" });
    click(window, $(doc, "mic-btn"));

    dispatch(window, { type: "voicePartial", text: "ship it grok send" });

    const cmd = doc.querySelectorAll("#input-highlight .cmd-token");
    const live = doc.querySelectorAll("#input-highlight .voice-token");
    expect(cmd).toHaveLength(1);
    expect(cmd[0].textContent).toBe("grok send");
    expect(live).toHaveLength(1);
    expect(live[0].textContent).toBe("ship it "); // stops where the command starts
  });

  it("marks nothing once dictation has finished", () => {
    const { window, doc } = bootWebview();
    const input = $(doc, "input") as HTMLTextAreaElement;
    dispatch(window, { type: "voiceConfigured", value: true });
    click(window, $(doc, "mic-btn"));
    dispatch(window, { type: "voicePartial", text: "hello" });
    expect(doc.querySelectorAll("#input-highlight .voice-token")).toHaveLength(1);

    dispatch(window, { type: "voiceTranscript", text: "hello" });

    // Finalised text is ordinary text: nothing is provisional any more.
    expect(doc.querySelectorAll("#input-highlight .voice-token")).toHaveLength(0);
  });
});
