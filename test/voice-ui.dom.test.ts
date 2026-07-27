// DOM-level tests for the voice-input mic button, driving the REAL media/chat.js
// inside happy-dom. Covers the click→record→transcribe→insert lifecycle and the
// host-driven state sync / error reset — no microphone, ffmpeg, or network.
import { describe, it, expect } from "vitest";
import { bootWebview, dispatch, click, Posted } from "./webview-harness";

const $ = (doc: Document, id: string) => doc.getElementById(id) as HTMLElement;
const types = (posted: Posted[]) => posted.map((p) => p.type);

describe("voice control mic button", () => {
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

  it("replaces the composer selection with a batch transcript", () => {
    const { window, doc } = bootWebview();
    const mic = $(doc, "mic-btn");
    const input = $(doc, "input") as HTMLTextAreaElement;
    input.value = "Fix the eror now";
    input.setSelectionRange(8, 12); // "eror"

    click(window, mic);
    click(window, mic);
    dispatch(window, { type: "voiceTranscript", text: "error", send: false });

    expect(input.value).toBe("Fix the error now");
    expect(input.selectionStart).toBe(13);
    expect(input.selectionEnd).toBe(13);
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

  it("inserts live dictation at the cursor and preserves the rest of the sentence", () => {
    const { window, doc } = bootWebview();
    const mic = $(doc, "mic-btn");
    const input = $(doc, "input") as HTMLTextAreaElement;
    input.value = "Fix here";
    input.setSelectionRange(3, 3);

    click(window, mic);
    dispatch(window, { type: "voicePartial", text: "this" });
    expect(input.value).toBe("Fix this here");
    expect(input.selectionStart).toBe(8);

    dispatch(window, { type: "voicePartial", text: "this text" });
    expect(input.value).toBe("Fix this text here");
    expect(input.selectionStart).toBe(13);

    dispatch(window, { type: "voiceTranscript", text: "this new text", send: false });
    expect(input.value).toBe("Fix this new text here");
    expect(input.selectionStart).toBe(17);
    expect(input.selectionEnd).toBe(17);
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
  });

  it("manual Send stops live voice, clears the composer, and ignores late voice events", () => {
    const { window, posted, doc } = bootWebview();
    const mic = $(doc, "mic-btn");
    const send = $(doc, "send-btn");
    const input = $(doc, "input") as HTMLTextAreaElement;

    click(window, mic);
    dispatch(window, { type: "voiceState", status: "listening" });
    dispatch(window, { type: "voicePartial", text: "fix the parser" });
    click(window, send);

    expect(posted.find((p) => p.type === "voiceStop")).toMatchObject({
      type: "voiceStop",
      discard: true,
    });
    expect(posted.find((p) => p.type === "send")).toMatchObject({
      type: "send",
      text: "fix the parser",
    });
    expect(input.value).toBe("");
    expect(mic.classList.contains("listening")).toBe(false);

    dispatch(window, { type: "voicePartial", text: "late partial" });
    dispatch(window, { type: "voiceTranscript", text: "late transcript" });
    dispatch(window, { type: "voiceSubmit", text: "late submit" });
    dispatch(window, { type: "voiceState", status: "listening" });
    dispatch(window, { type: "voiceState", status: "transcribing" });

    expect(input.value).toBe("");
    expect(mic.classList.contains("listening")).toBe(false);
    expect(mic.classList.contains("transcribing")).toBe(false);
    expect(posted.filter((p) => p.type === "send")).toHaveLength(1);

    dispatch(window, { type: "agentEnd" });
    click(window, mic);
    dispatch(window, { type: "voiceState", status: "listening" });
    dispatch(window, { type: "voicePartial", text: "new recording" });
    expect(input.value).toBe("new recording");
  });

  it("manual Queue stops live voice and late partials do not refill the composer", () => {
    const { window, posted, doc } = bootWebview();
    const mic = $(doc, "mic-btn");
    const send = $(doc, "send-btn");
    const input = $(doc, "input") as HTMLTextAreaElement;

    click(window, mic);
    dispatch(window, { type: "voiceState", status: "listening" });
    dispatch(window, { type: "voicePartial", text: "check the next result" });
    dispatch(window, { type: "setBusy", value: true });
    click(window, send);

    expect(posted.find((p) => p.type === "voiceStop")).toMatchObject({
      type: "voiceStop",
      discard: true,
    });
    expect(posted.find((p) => p.type === "queueSend")).toMatchObject({
      type: "queueSend",
      text: "check the next result",
    });
    expect(input.value).toBe("");

    dispatch(window, { type: "voicePartial", text: "late partial" });
    expect(input.value).toBe("");
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
