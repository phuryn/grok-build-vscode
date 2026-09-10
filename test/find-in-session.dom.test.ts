// Find in the active conversation (#99). Drives the real media/chat.js.
// CSS.highlights does not exist in happy-dom — the production path must
// tolerate that (scroll + count, no <mark> wrapping). Do not stub a
// Highlight API the test environment does not have.
import { describe, it, expect, vi } from "vitest";
import { bootWebview, click, dispatch } from "./webview-harness";

function api(window: Window) {
  return (window as unknown as { __grokFind: FindApi }).__grokFind;
}

interface FindApi {
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
  query: () => string;
  setQuery: (q: string) => void;
  next: () => void;
  prev: () => void;
  matchCount: () => number;
  totalCount: () => number;
  hiddenCount: () => number;
  index: () => number;
  includeHidden: (on: boolean) => void;
  caseSensitive: () => boolean;
  setCaseSensitive: (on: boolean) => void;
  regex: () => boolean;
  setRegex: (on: boolean) => void;
  invalid: () => boolean;
  hasHighlightApi: () => boolean;
}

/**
 * Wait until the transcript actually contains what the caller dispatched.
 *
 * Four earlier versions of this were counted waits — one animation frame,
 * then two frames with a macrotask between, then "the node count stopped
 * changing" — and every one lost the same race for the same reason: chat.js
 * appends across an unknown number of turns of the event loop, and no fixed
 * count outruns an arbitrarily loaded machine.
 *
 * The stability version was the subtle one, and it is why this file kept
 * failing a DIFFERENT test on each saturated run. "Two consecutive equal
 * readings" is ALSO true of two readings of ZERO: on a loaded box the first two
 * frames can both land before chat.js has appended anything, and the helper
 * then reports the transcript rendered when the transcript is empty. It could
 * not tell "nothing has happened yet" from "everything has happened", so the
 * test that ran next asserted against a blank page and blamed the feature. Its
 * deadline made that worse by returning SILENTLY, so a genuine hang arrived as
 * a confusing assertion failure somewhere downstream.
 *
 * So the wait is for the CONTENT the caller just dispatched, and nothing else
 * counts as done. A predicate cannot be satisfied by an empty page, it is
 * bounded by how fast the machine actually is rather than by a number somebody
 * guessed, it returns immediately on an idle one, and a real hang throws here
 * naming what never arrived.
 */
async function waitForDom(window: Window, what: string, done: () => boolean, timeoutMs = 5_000) {
  const frame = () => new Promise<void>((resolve) => { window.requestAnimationFrame(() => resolve()); });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (done()) {
      // One more turn of the loop, so anything appended in the same batch as
      // the thing we were waiting for is also in place before we return.
      await frame();
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`the harness never rendered ${what} within ${timeoutMs}ms`);
    }
    await frame();
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  }
}

/** Text present anywhere in the rendered transcript. */
function transcriptHas(window: Window, text: string) {
  const nodes = [...window.document.querySelectorAll(".msg, .thought, .tool-item")];
  return nodes.some((el) => (el.textContent || "").includes(text));
}

async function playTurn(window: Window, user: string, agent: string, thought?: string) {
  dispatch(window, { type: "userMessage", text: user, chips: [] });
  dispatch(window, { type: "agentStart" });
  if (thought) dispatch(window, { type: "thoughtChunk", text: thought });
  dispatch(window, { type: "messageChunk", text: agent });
  dispatch(window, { type: "agentEnd" });
  // Both halves, because the user bubble and the agent bubble are appended by
  // different paths and the agent's is the later one.
  await waitForDom(
    window,
    `the turn ${JSON.stringify(user)} -> ${JSON.stringify(agent)}`,
    () => transcriptHas(window, user) && transcriptHas(window, agent),
  );
}

function exec(id: string, command: string) {
  return {
    type: "toolCall" as const,
    call: {
      toolCallId: id,
      kind: "execute",
      title: `Run ${command.slice(0, 20)}`,
      rawInput: { command },
    },
  };
}

function out(command: string, output: string) {
  return {
    type: "commandOutput" as const,
    command,
    output,
    exitCode: 0,
    truncated: false,
  };
}

function key(window: Window, init: Record<string, unknown>) {
  return new (window as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
}

function firstTextNode(root: Element): Text | null {
  const stack: ChildNode[] = [...root.childNodes];
  while (stack.length) {
    const node = stack.shift()!;
    if (node.nodeType === 3 && node.nodeValue) return node as Text;
    if (node.childNodes?.length) stack.unshift(...node.childNodes);
  }
  return null;
}

function openOverflow(window: Window, doc: Document, slotId: string) {
  const btn = doc.querySelector(`#${slotId} .rail-menu-btn`) as HTMLButtonElement | null;
  expect(btn, slotId + " ⋯").toBeTruthy();
  click(window, btn!);
  return [...doc.querySelectorAll(".rail-menu-item")].map((el) => (el.textContent || "").trim());
}

function coding(window: Window) {
  dispatch(window, {
    type: "initialState",
    effort: "",
    cwd: "/w",
    useCtrlEnter: false,
    extVersion: "0",
    showThinking: false,
    expandCommandOutputs: false,
    appPurpose: "coding",
    capabilities: {},
  });
}

describe("find in conversation (#99)", () => {
  it("does not invent a Highlight API in this environment", () => {
    const { window } = bootWebview();
    expect(api(window).hasHighlightApi()).toBe(false);
    expect((window as unknown as { CSS?: { highlights?: unknown } }).CSS?.highlights).toBeUndefined();
  });

  it("offers Find in conversation in the desktop/remote ⋯ menu beside Export", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "sessionName", sessionId: "s1", name: "Live", cwd: "/w" });
    const labels = openOverflow(h.window, h.doc, "session-head-actions");
    const exportAt = labels.indexOf("Export as Markdown");
    const findAt = labels.indexOf("Find in conversation");
    expect(exportAt).toBeGreaterThanOrEqual(0);
    expect(findAt).toBe(exportAt + 1);
  });

  it("offers Find in conversation in the VS Code session menu beside Export", () => {
    const h = bootWebview({ vscode: true });
    dispatch(h.window, { type: "sessionName", sessionId: "s1", name: "Live", cwd: "/w" });
    const labels = openOverflow(h.window, h.doc, "vscode-session-actions");
    expect(labels).toEqual([
      "Continue in a new chat",
      "Export conversation as Markdown",
      "Find in conversation",
    ]);
  });

  it("matches message text and tool row labels, never the IN/OUT payload", async () => {
    // Owner call, 2026-08-19: searching inside tool/command/MCP IN-OUT bodies and
    // file-edit diffs made results chaotic — ordinary words matched dozens of
    // times in command output, burying the prose hits, and a diff hit is little
    // use when the full diff is not on screen. Labels stay searchable so "find
    // the command I ran" still works.
    const { window, doc } = bootWebview();
    coding(window);
    await playTurn(window, "please inspect unique-user-token", "unique-agent-reply");
    dispatch(window, exec("t1", "node unique-command-token.js"));
    dispatch(window, { type: "messageChunk", text: "ran it" });
    dispatch(window, out("node unique-command-token.js", "unique-output-token\nok"));

    const details = doc.querySelector(".tool-item-details") as HTMLElement;
    expect(details).toBeTruthy();
    expect(details.textContent).toContain("unique-output-token");

    api(window).open();
    api(window).setQuery("unique-user-token");
    expect(api(window).matchCount()).toBe(1);

    api(window).setQuery("unique-agent-reply");
    expect(api(window).matchCount()).toBe(1);

    // In the row's title (`Run node unique-command-`), so still findable — and
    // present in the payload too, which must NOT add a second hit.
    api(window).setQuery("unique-command-");
    expect(api(window).matchCount()).toBe(1);

    // Output body only. Not searched at all.
    api(window).setQuery("unique-output-token");
    expect(api(window).matchCount()).toBe(0);
  });

  it("counts preference-hidden thinking but excludes it from navigation", async () => {
    const { window, doc } = bootWebview();
    coding(window);
    await playTurn(window, "ask about hidden-thought-xyz", "visible-reply-xyz", "hidden-thought-xyz in the trace");
    await vi.waitFor(() => {
      expect(doc.querySelector(".thinking-body")?.textContent).toContain("hidden-thought-xyz");
    });

    expect(doc.body.classList.contains("thinking-hidden")).toBe(true);
    expect(doc.querySelector(".msg.thinking")).toBeTruthy();

    api(window).open();
    api(window).setQuery("hidden-thought-xyz");
    expect(api(window).totalCount()).toBeGreaterThanOrEqual(2);
    expect(api(window).hiddenCount()).toBeGreaterThanOrEqual(1);
    expect(api(window).matchCount()).toBe(api(window).totalCount() - api(window).hiddenCount());

    const hint = doc.querySelector(".find-hidden-hint") as HTMLButtonElement;
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toMatch(/hidden thinking traces/);

    api(window).includeHidden(true);
    expect(api(window).matchCount()).toBe(api(window).totalCount());
  });

  it("wraps next/previous and updates the count as the query changes", async () => {
    const { window, doc } = bootWebview();
    await playTurn(window, "alpha one", "alpha two alpha three");
    api(window).open();
    api(window).setQuery("alpha");
    expect(api(window).matchCount()).toBe(3);
    expect(doc.querySelector(".find-count")!.textContent).toBe("1/3");

    api(window).next();
    expect(api(window).index()).toBe(1);
    expect(doc.querySelector(".find-count")!.textContent).toBe("2/3");
    api(window).next();
    expect(api(window).index()).toBe(2);
    api(window).next();
    expect(api(window).index()).toBe(0);
    api(window).prev();
    expect(api(window).index()).toBe(2);

    api(window).setQuery("alpha t");
    expect(api(window).matchCount()).toBe(2);
    expect(doc.querySelector(".find-count")!.textContent).toMatch(/\/2$/);
  });

  it("regex mode matches and an invalid regex does not throw", async () => {
    const { window, doc } = bootWebview();
    await playTurn(window, "needle-line", "done");
    await playTurn(window, "zzbuild", "ok");
    dispatch(window, exec("rx", "echo"));
    dispatch(window, out("echo", "__build\nnext"));
    api(window).open();
    api(window).setRegex(true);
    expect(() => api(window).setQuery("^needle-line$")).not.toThrow();
    expect(api(window).invalid()).toBe(false);
    expect(api(window).matchCount()).toBe(1);
    // Anchors are per text node (the `m` flag), which is what makes the
    // issue's `^_+build$` shape work at all.
    expect(() => api(window).setQuery("^z+build$")).not.toThrow();
    expect(api(window).invalid()).toBe(false);
    expect(api(window).matchCount()).toBe(1);
    // The issue's own example targeted BUILD OUTPUT. That is a payload body, so
    // it is no longer searched (owner, 2026-08-19) — a real narrowing of what
    // #99 asked for, pinned here so it cannot regress silently either way.
    api(window).setQuery("^_+build$");
    expect(api(window).matchCount()).toBe(0);

    expect(() => api(window).setQuery("(")).not.toThrow();
    expect(api(window).invalid()).toBe(true);
    expect(api(window).matchCount()).toBe(0);
    expect(doc.getElementById("find-input")!.classList.contains("find-input-invalid")).toBe(true);
    expect(doc.querySelector(".find-count")!.textContent).toBe("—");
  });

  it("Escape closes and restores focus", () => {
    const { window, doc } = bootWebview();
    const history = doc.getElementById("history-btn") as HTMLElement;
    history.focus();
    expect(doc.activeElement).toBe(history);

    api(window).open();
    expect(api(window).isOpen()).toBe(true);
    expect(doc.getElementById("find-bar")!.hidden).toBe(false);
    expect(doc.activeElement).toBe(doc.getElementById("find-input"));

    doc.getElementById("find-input")!.dispatchEvent(key(window, { key: "Escape" }));
    expect(api(window).isOpen()).toBe(false);
    expect(doc.getElementById("find-bar")!.hidden).toBe(true);
    expect(doc.activeElement).toBe(history);
  });

  it("IS_REMOTE does not bind Ctrl/Cmd+F", async () => {
    const { window, doc } = bootWebview({ remote: true });
    await playTurn(window, "hello", "world");
    doc.dispatchEvent(key(window, { key: "f", ctrlKey: true }));
    expect(api(window).isOpen()).toBe(false);
    doc.dispatchEvent(key(window, { key: "f", metaKey: true }));
    expect(api(window).isOpen()).toBe(false);
    expect(doc.getElementById("find-bar")).toBeNull();
  });

  it("desk/VS Code Cmd+F and the host message open find", async () => {
    const { window, doc } = bootWebview();
    await playTurn(window, "hello", "world");
    const ev = key(window, { key: "f", metaKey: true });
    doc.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(api(window).isOpen()).toBe(true);

    api(window).close();
    expect(api(window).isOpen()).toBe(false);
    dispatch(window, { type: "findInSession" });
    expect(api(window).isOpen()).toBe(true);
  });

  it("reopening remembers the last query for the session", async () => {
    const { window } = bootWebview();
    await playTurn(window, "remember-me-token", "ok");
    dispatch(window, { type: "session", sessionId: "s1", models: [], currentModelId: "grok-build" });
    api(window).open();
    api(window).setQuery("remember-me-token");
    api(window).close();
    api(window).open();
    expect(api(window).query()).toBe("remember-me-token");
    expect(api(window).matchCount()).toBe(1);
  });

  it("opening with a transcript selection pre-fills that text", async () => {
    const { window, doc } = bootWebview();
    await playTurn(window, "select-this-token please", "ok");
    const user = [...doc.querySelectorAll(".msg.user")].pop() as HTMLElement;
    expect(user).toBeTruthy();
    const text = firstTextNode(user);
    expect(text && text.data).toContain("select-this-token");
    const start = text!.data.indexOf("select-this-token");
    const range = doc.createRange();
    range.setStart(text!, start);
    range.setEnd(text!, start + "select-this-token".length);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    api(window).open();
    expect(api(window).query()).toBe("select-this-token");
    expect(api(window).matchCount()).toBeGreaterThanOrEqual(1);
  });

  it("does not re-arm stick-to-bottom when scrolling to a match", async () => {
    const { window, doc } = bootWebview();
    await playTurn(window, "pin-token", "later pin-token");
    const messages = doc.getElementById("messages") as HTMLElement;
    expect(messages.classList.contains("stick-to-bottom")).toBe(true);
    api(window).open();
    api(window).setQuery("pin-token");
    api(window).next();
    expect(messages.classList.contains("stick-to-bottom")).toBe(false);
  });

  it("⋯ Find in conversation opens the bar", async () => {
    const h = bootWebview();
    dispatch(h.window, { type: "sessionName", sessionId: "s1", name: "Live", cwd: "/w" });
    await playTurn(h.window, "hi", "there");
    click(h.window, h.doc.querySelector("#session-head-actions .rail-menu-btn")!);
    const item = [...h.doc.querySelectorAll(".rail-menu-item")].find((el) =>
      (el.textContent || "").includes("Find in conversation"),
    ) as HTMLElement;
    click(h.window, item);
    expect(api(h.window).isOpen()).toBe(true);
  });
});

describe("find in conversation — large transcript", () => {
  it("searches a multi-hundred-bubble transcript without throwing", async () => {
    const { window, doc } = bootWebview();
    const n = 80;
    for (let i = 0; i < n; i++) {
      dispatch(window, { type: "userMessage", text: `user line ${i} needle-${i % 7}`, chips: [] });
      dispatch(window, { type: "agentStart" });
      dispatch(window, { type: "messageChunk", text: `agent line ${i} extra needle-${i % 7}` });
      dispatch(window, { type: "agentEnd" });
    }
    await waitForDom(
      window,
      `all ${n} turns`,
      () => transcriptHas(window, `agent line ${n - 1} `),
    );
    api(window).open();
    const t0 = Date.now();
    api(window).setQuery("needle-3");
    const ms = Date.now() - t0;
    expect(api(window).matchCount()).toBeGreaterThan(0);
    expect(doc.querySelectorAll("mark").length).toBe(0);
    expect(ms, `find over ${n * 2} bubbles took ${ms}ms`).toBeLessThan(1000);
  });

  // The harness's own contract, because the previous version of it silently
  // reported success on an EMPTY page and the cost landed on whichever test ran
  // next. Two properties, and the second matters as much as the first: it has
  // to fail rather than return, and it has to name what never arrived, or the
  // next person reads a blank-page assertion and goes looking in the feature.
  it("fails loudly, and by name, when the transcript never renders", async () => {
    const { window } = bootWebview();
    await expect(waitForDom(window, "a turn that is never dispatched", () => false, 50))
      .rejects.toThrow(/never rendered a turn that is never dispatched/);
  });

  // The exact shape that used to pass: nothing dispatched, so the node count is
  // stable at zero from the first frame. Stability alone cannot tell that from
  // a finished render; the content predicate can.
  it("does not mistake an empty transcript for a settled one", async () => {
    const { window } = bootWebview();
    await expect(waitForDom(window, "an unsent message", () => transcriptHas(window, "never-sent"), 50))
      .rejects.toThrow();
    await playTurn(window, "never-sent", "reply");
    expect(transcriptHas(window, "never-sent")).toBe(true);
  });
});
