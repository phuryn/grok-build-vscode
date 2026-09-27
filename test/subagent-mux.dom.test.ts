// Replays a sanitized grok 1.0.3 multiplexed-stdout capture (parent + two
// background children interleaved word-level) through parse/route + chat.js.
// Asserts the parent transcript is not garbled by child prose or child tools.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { bootWebview, dispatch } from "./webview-harness";
import {
  childStreamFromRoute,
  isForeignSessionUpdate,
  isSubagentLifecycleUpdate,
  parseAcpLine,
  routeSessionUpdate,
} from "../src/acp-dispatch";

const PARENT = "019fff34-47e9-78e0-b75e-e22f7ecf8aab";
const CHILD_A = "019fff34-5c66-7111-91b6-e7e75f5e645a";
const CHILD_B = "019fff34-5c68-79b0-bd94-4fe7c3fd8caf";

const LINES = fs
  .readFileSync(path.join(__dirname, "fixtures", "grok-subagent-mux.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

function nextFrame(window: any): Promise<void> {
  return new Promise((r) => window.requestAnimationFrame(() => r()));
}

async function replayMux(window: any) {
  dispatch(window, { type: "agentStart" });
  for (const rec of LINES) {
    if (rec.method === "_x.ai/session_notification") {
      const update = rec.params?.update;
      if (isSubagentLifecycleUpdate(update)) {
        dispatch(window, { type: "subagentUpdate", update });
      }
      continue;
    }
    const ev = parseAcpLine(JSON.stringify(rec));
    if (!ev || ev.kind !== "session-update") continue;
    const route = routeSessionUpdate(ev.update);
    if (!route) continue;
    if (isForeignSessionUpdate(ev.sessionId, PARENT)) {
      const payload = childStreamFromRoute(ev.sessionId, route);
      if (payload) dispatch(window, { type: "childStream", ...payload });
      continue;
    }
    if (route.event === "messageChunk") dispatch(window, { type: "messageChunk", text: route.text });
    else if (route.event === "thoughtChunk") dispatch(window, { type: "thoughtChunk", text: route.text });
    else if (route.event === "userMessageChunk") dispatch(window, { type: "userMessageChunk", text: route.text });
    else if (route.event === "toolCall") dispatch(window, { type: "toolCall", call: route.payload });
    else if (route.event === "toolCallUpdate") dispatch(window, { type: "toolCallUpdate", call: route.payload });
  }
  await nextFrame(window);
}

function spawnCard(window: any, toolCallId: string, description: string) {
  dispatch(window, {
    type: "toolCall",
    call: {
      toolCallId,
      title: "spawn_subagent",
      _meta: { "x.ai/tool": { name: "spawn_subagent" } },
      rawInput: { description, subagent_type: "explore" },
    },
  });
}

function startedAck(window: any, toolCallId: string, subagentId: string) {
  dispatch(window, {
    type: "toolCallUpdate",
    call: {
      toolCallId,
      status: "completed",
      rawOutput: {
        type: "Text",
        text: `Subagent started in background.\nsubagent_id: ${subagentId}`,
      },
    },
  });
}

function streamChildren(card: HTMLElement): HTMLElement[] {
  return [...(card.querySelector(".subagent-stream")?.children || [])] as HTMLElement[];
}

function parentTranscript(doc: Document): string {
  const bits: string[] = [];
  for (const el of doc.querySelectorAll("#messages .msg.agent, #messages .msg.thinking, #messages .msg.user")) {
    if (el.closest(".subagent-card")) continue;
    bits.push(el.textContent || "");
  }
  return bits.join("\n");
}

function parentToolText(doc: Document): string {
  const bits: string[] = [];
  for (const el of doc.querySelectorAll("#messages .tool-group, #messages .tool-flat, #messages .tool-item")) {
    if (el.closest(".subagent-card")) continue;
    bits.push(el.textContent || "");
  }
  return bits.join("\n");
}

describe("grok 1.0.3 multiplexed subagent stream (sanitized live capture)", () => {
  it("keeps child prose and child tools out of the parent transcript", async () => {
    const { window, doc } = bootWebview();
    await replayMux(window);

    const parent = parentTranscript(doc);
    expect(parent).toContain("Spawning both subagents");
    expect(parent).toContain("Both subagents are running");
    expect(parent).not.toContain("I'll list the contents of the current working directory now");
    expect(parent).not.toContain("I'll write an original two-line poem");
    expect(parent).not.toContain("The current working directory contains one item");
    expect(parent).not.toContain("No other files were changed");
    expect(parent).not.toContain("Background subagent");
    expect(parent).not.toContain("<system-reminder>");

    const cards = [...doc.querySelectorAll(".subagent-card")] as HTMLElement[];
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.dataset.childSessionId).sort()).toEqual([CHILD_A, CHILD_B].sort());
    expect(cards.map((c) => c.dataset.subagentId).sort()).toEqual([CHILD_A, CHILD_B].sort());

    const byChild = Object.fromEntries(cards.map((c) => [c.dataset.childSessionId, c]));
    const listCard = byChild[CHILD_A];
    const poemCard = byChild[CHILD_B];
    expect(listCard.querySelector(".subagent-title")!.textContent).toContain("List directory files");
    expect(poemCard.querySelector(".subagent-title")!.textContent).toContain("Write two-line poem");

    // Fixture shape is prose → tool → prose. A single accumulated .subagent-prose
    // would keep both texts above the tool row; each segment must be its own
    // sibling so chronology matches the parent transcript's close-on-tool rule.
    const listBits = streamChildren(listCard);
    const listProse = listBits.filter((el) => el.classList.contains("subagent-prose"));
    const listToolAt = listBits.findIndex((el) => el.classList.contains("subagent-tool"));
    expect(listProse).toHaveLength(2);
    expect(listToolAt).toBeGreaterThan(-1);
    expect(listBits.indexOf(listProse[0])).toBeLessThan(listToolAt);
    expect(listBits.indexOf(listProse[1])).toBeGreaterThan(listToolAt);
    expect(listProse[0].textContent).toContain("I'll list the contents of the current working directory now");
    expect(listProse[0].textContent).not.toContain("README.txt");
    expect(listProse[1].textContent).toContain("README.txt");
    expect(listProse[1].textContent).not.toBe("running");

    const poemBits = streamChildren(poemCard);
    const poemProse = poemBits.filter((el) => el.classList.contains("subagent-prose"));
    const poemToolAt = poemBits.findIndex((el) => el.classList.contains("subagent-tool"));
    expect(poemProse.length).toBeGreaterThanOrEqual(2);
    expect(poemToolAt).toBeGreaterThan(-1);
    expect(poemBits.indexOf(poemProse[0])).toBeLessThan(poemToolAt);
    expect(poemBits.indexOf(poemProse[poemProse.length - 1])).toBeGreaterThan(poemToolAt);
    expect(poemProse[0].textContent).toContain("I'll write an original two-line poem");
    expect(poemProse[0].textContent).not.toContain("Soft rain writes secrets");
    expect(poemProse[poemProse.length - 1].textContent).toContain("Soft rain writes secrets");
    expect(poemProse[poemProse.length - 1].textContent).not.toContain("I'll write an original");

    const parentTools = parentToolText(doc);
    expect(parentTools).not.toContain("Get-Location");
    expect(parentTools).not.toContain("/tmp/probe-cwd");
    expect(listCard.querySelectorAll(".subagent-tool").length).toBeGreaterThan(0);
    expect(poemCard.querySelectorAll(".subagent-tool").length).toBeGreaterThan(0);
    expect([...poemCard.querySelectorAll(".subagent-tool")].some((row) =>
      (row.textContent || "").includes("Get-Location"),
    )).toBe(true);
  });

  it("drops a child chunk whose session matches no card (never splices the parent)", async () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "agentStart" });
    dispatch(window, { type: "messageChunk", text: "parent only" });
    dispatch(window, {
      type: "childStream",
      childSessionId: "no-such-child",
      event: "messageChunk",
      text: "ORPHAN_CHILD_PROSE_MUST_NOT_RENDER",
    });
    await new Promise((r) => window.requestAnimationFrame(r));
    expect(parentTranscript(doc)).toContain("parent only");
    expect(doc.body.textContent || "").not.toContain("ORPHAN_CHILD_PROSE_MUST_NOT_RENDER");
    expect(doc.querySelector(".subagent-card")).toBeNull();
  });

  it("cards stay collapsed with a live one-line status until expanded", async () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "toolCall",
      call: {
        toolCallId: "spawn-live",
        title: "spawn_subagent",
        _meta: { "x.ai/tool": { name: "spawn_subagent" } },
        rawInput: { description: "List directory files", subagent_type: "explore" },
      },
    });
    dispatch(window, {
      type: "subagentUpdate",
      update: { sessionUpdate: "subagent_spawned", subagent_id: CHILD_A, child_session_id: CHILD_A },
    });
    dispatch(window, {
      type: "childStream",
      childSessionId: CHILD_A,
      event: "messageChunk",
      text: "I'll list the contents of the current working directory now.",
    });
    await nextFrame(window);
    const card = doc.querySelector(".subagent-card") as HTMLElement;
    const stream = card.querySelector(".subagent-stream") as HTMLElement;
    expect(stream.hidden).toBe(true);
    expect((card.querySelector(".subagent-status") as HTMLElement).textContent).toBe("running");
    const row = card.querySelector(".subagent-row") as HTMLElement;
    expect(row.classList.contains("expandable")).toBe(true);
    row.click();
    expect(stream.hidden).toBe(false);
    expect(stream.textContent).toContain("I'll list the contents");
  });

  it("tags a started-ack card by exact subagent_id, not the first untagged FIFO card", async () => {
    const { window, doc } = bootWebview();
    const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    spawnCard(window, "spawn-a", "Task A");
    spawnCard(window, "spawn-b", "Task B");
    startedAck(window, "spawn-a", ID_A);

    const cards = [...doc.querySelectorAll(".subagent-card")] as HTMLElement[];
    expect(cards).toHaveLength(2);
    expect(cards[0].dataset.subagentId).toBe(ID_A);
    expect(cards[1].dataset.subagentId).toBeUndefined();

    // Lifecycle for A arrives after the ack tagged A. FIFO-first would steal B.
    dispatch(window, {
      type: "subagentUpdate",
      update: { sessionUpdate: "subagent_spawned", subagent_id: ID_A, child_session_id: ID_A },
    });
    expect(cards[0].dataset.subagentId).toBe(ID_A);
    expect(cards[0].dataset.childSessionId).toBe(ID_A);
    expect(cards[1].dataset.subagentId).toBeUndefined();
    expect(cards[1].dataset.childSessionId).toBeUndefined();

    dispatch(window, {
      type: "subagentUpdate",
      update: { sessionUpdate: "subagent_spawned", subagent_id: ID_B, child_session_id: ID_B },
    });
    expect(cards[1].dataset.subagentId).toBe(ID_B);
    expect(cards[1].dataset.childSessionId).toBe(ID_B);

    dispatch(window, { type: "childStream", childSessionId: ID_A, event: "messageChunk", text: "ALPHA_ONLY" });
    dispatch(window, { type: "childStream", childSessionId: ID_B, event: "messageChunk", text: "BRAVO_ONLY" });
    await nextFrame(window);
    expect(cards[0].querySelector(".subagent-prose")!.textContent).toContain("ALPHA_ONLY");
    expect(cards[0].querySelector(".subagent-prose")!.textContent).not.toContain("BRAVO_ONLY");
    expect(cards[1].querySelector(".subagent-prose")!.textContent).toContain("BRAVO_ONLY");
    expect(cards[1].querySelector(".subagent-prose")!.textContent).not.toContain("ALPHA_ONLY");
  });

  it("coalesces a child chunk storm to one markdown/thought paint per frame", async () => {
    const { window, doc } = bootWebview();
    spawnCard(window, "spawn-raf", "Batch paint");
    dispatch(window, {
      type: "subagentUpdate",
      update: { sessionUpdate: "subagent_spawned", subagent_id: CHILD_A, child_session_id: CHILD_A },
    });
    const card = doc.querySelector(".subagent-card") as HTMLElement;
    const stream = card.querySelector(".subagent-stream") as HTMLElement;

    dispatch(window, { type: "childStream", childSessionId: CHILD_A, event: "thoughtChunk", text: "Think" });
    dispatch(window, { type: "childStream", childSessionId: CHILD_A, event: "messageChunk", text: "I'll" });
    const prose = stream.querySelector(".subagent-prose") as HTMLElement;
    const thoughtBody = stream.querySelector(".subagent-thoughts-body") as HTMLElement;
    expect(prose.innerHTML).toBe("");
    expect(thoughtBody.textContent).toBe("");

    let prosePaints = 0;
    let thoughtPaints = 0;
    const obs = new window.MutationObserver((muts: MutationRecord[]) => {
      for (const m of muts) {
        if (m.target === prose || prose.contains(m.target as Node)) prosePaints += 1;
        if (m.target === thoughtBody || thoughtBody.contains(m.target as Node)) thoughtPaints += 1;
      }
    });
    obs.observe(stream, { childList: true, subtree: true, characterData: true });

    for (const word of [" list", " the", " contents", " now", "."]) {
      dispatch(window, { type: "childStream", childSessionId: CHILD_A, event: "messageChunk", text: word });
    }
    for (const word of [" about", " the", " directory", "."]) {
      dispatch(window, { type: "childStream", childSessionId: CHILD_A, event: "thoughtChunk", text: word });
    }
    expect(prose.innerHTML).toBe("");
    expect(thoughtBody.textContent).toBe("");
    expect(prosePaints).toBe(0);
    expect(thoughtPaints).toBe(0);

    // The counters are fed by a MutationObserver, so "some paint happened" is a
    // question about DELIVERY, not about the product — and delivery runs late
    // under full-suite load, which failed this test on macOS while the
    // coalescing it actually checks was working. Wait for the first paint,
    // bounded; the assertion that matters is the UPPER bound below, which is
    // the coalescing contract and is unaffected by waiting.
    await nextFrame(window);
    await Promise.resolve();
    for (let i = 0; i < 60 && (prosePaints === 0 || thoughtPaints === 0); i++) {
      await nextFrame(window);
      await Promise.resolve();
    }
    expect(prosePaints).toBeGreaterThan(0);
    expect(prosePaints).toBeLessThan(5);
    expect(thoughtPaints).toBeGreaterThan(0);
    expect(thoughtPaints).toBeLessThan(4);
    expect(prose.textContent).toContain("I'll list the contents now.");
    expect(thoughtBody.textContent).toContain("Think about the directory.");
    obs.disconnect();
  });
});
