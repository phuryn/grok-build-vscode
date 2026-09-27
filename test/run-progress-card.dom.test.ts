import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { parseRunProgressUpdate } from "../src/run-progress";
import { bootWebview, dispatch, click, type Harness } from "./webview-harness";

const windows: Harness["window"][] = [];
afterEach(() => { for (const window of windows.splice(0)) window.happyDOM.abort(); });
function boot(options = {}) {
  let now = 100_000;
  const h = bootWebview({ ...options, beforeScripts: (window: Harness["window"]) => {
    (window as any).Date = class extends window.Date { static now() { return now; } };
  } });
  windows.push(h.window);
  return { ...h, advance: (ms: number) => { now += ms; } };
}
const base = {
  sessionUpdate: "workflow_updated", run_id: "r1", name: "deep-research", status: "active",
  current_phase: "Research", elapsed_ms: 728_000, agents_used: 4, agent_budget: 128,
  phases: [{ title: "Plan", state: "done" }, { title: "Research", state: "active" }, { title: "Verify", state: "pending" }, { title: "Report", state: "pending" }],
  agents: [{ agent_id: "a", label: "Researcher A", phase: "Research", state: "running", tokens_used: 0 }],
};
function send(h: Harness, over: Record<string, unknown> = {}) {
  dispatch(h.window, { type: "runProgress", update: parseRunProgressUpdate({ ...base, ...over }) });
}
const card = (h: Harness) => h.doc.querySelector(".workflow-card")!;
const pin = (h: Harness) => h.doc.querySelector(".workflow-pin")!;
const summary = (h: Harness) => pin(h).querySelector(".run-progress-row")!.textContent;
const status = (h: Harness) => pin(h).querySelector(".delegation-status")!.textContent;
const agent = (h: Harness) => pin(h).querySelector(".workflow-agent")!;
const activity = (h: Harness) => agent(h).querySelector(".workflow-agent-activity")!.textContent;
const expand = (h: Harness) => click(h.window, pin(h).querySelector(".workflow-pin-toggle")!);
const hidden = (el: Element | null) => !!el?.hasAttribute("hidden");
const outputRuns = JSON.parse(readFileSync(new URL("fixtures/workflow-output.json", import.meta.url), "utf8")).runs;

describe("workflow output", () => {
  it.each(['42', 'true', '["machine"]', '{"status":"ok","path":"scratch/a.md"}',
    '{"one":"alpha","summary":"done","two":"beta"}', '{"html":"<script>bad()</script>","fence":"```"}'])
    ("renders a JSON result as fenced code: %s", result_summary => {
      const h = boot(); send(h, { status: "complete", result_summary });
      const output = card(h).querySelector(".workflow-output-body")!;
      expect(JSON.parse(output.querySelector("pre code")!.textContent!)).toEqual(JSON.parse(result_summary));
      expect(output.querySelector("script")).toBeNull();
      expect((card(h).querySelector(".workflow-output") as any)._copyText).toBe(
        "```json\n" + JSON.stringify(JSON.parse(result_summary), null, 2).replace(/`/g, "\\u0060") + "\n```");
    });
  it.each(outputRuns)("separates summary, progress, output and roster for $run_id", (run) => {
    const h = boot(); send(h, run);
    const body = card(h).querySelector(".workflow-report-body")!;
    const output = body.querySelector(".workflow-output");
    expect({
      order: [...body.querySelectorAll(".workflow-phases, .workflow-roster, .workflow-output")].map(el => el.className),
      phase: card(h).querySelector(".delegation-status")!.textContent,
      clock: card(h).querySelector(".delegation-time")!.textContent,
      label: output?.getAttribute("aria-label") ?? null,
      strong: output?.querySelector("strong:not(.workflow-output-label)")?.textContent ?? null,
      headings: [...(output?.querySelectorAll("h3") || [])].map(el => el.textContent),
      footer: output?.querySelector("em")?.textContent ?? null,
      text: run.run_id === "json" ? output?.querySelector(".workflow-output-body")?.textContent : null,
      diagnostic: body.textContent?.includes("ignored cancelled"),
      spend: body.querySelector(".workflow-spend")!.textContent,
    }).toEqual({
      order: ["workflow-phases", "workflow-roster", ...(run.result_summary ? ["workflow-output delegation-result"] : [])],
      phase: run.run_id === "diagnostic" ? "stopped" : "done", clock: run.run_id === "markdown" ? "22:52" : run.run_id === "json" ? "0:12" : "1:50",
      label: null,
      strong: run.run_id === "markdown" ? "Status: Partial" : null,
      headings: run.run_id === "markdown" ? ["Why earlier attempts do not count", "The other flights that morning"] : [],
      footer: run.run_id === "markdown" ? "Full report: scratch/report.md" : null,
      text: run.run_id === "json" ? "The workflow finished its first step." : null,
      diagnostic: false, spend: `${run.agents_used} agents`,
    });
  });

  it.each([undefined, "", "done", "null", '{"summary":"truncated', '```json\n{"status":"ok"}\n```'])
    ("omits the output block for non-human payload %s", (result_summary) => {
      const h = boot(); send(h, { status: "complete", result_summary });
      expect(card(h).querySelector(".workflow-output")).toBeNull();
    });

  it.each(["report", "summary", "sentence"])("extracts only the human %s field from JSON", (field) => {
    const h = boot(); send(h, { status: "complete", result_summary: JSON.stringify({ [field]: "**Readable**", status: "ok", count: 7 }) });
    expect(card(h).querySelector(".workflow-output-body")?.innerHTML).toBe("<strong>Readable</strong>");
  });

  it("uses the message markdown sanitization boundary for workflow output", () => {
    const h = boot();
    const raw = '**Safe** <img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1))\n\n<script>alert(1)</script>';
    send(h, { status: "complete", result_summary: raw });
    const output = card(h).querySelector(".workflow-output-body")!;
    const event = new h.window.MouseEvent("click", { bubbles: true, cancelable: true });
    const posted = h.posted.length;
    output.querySelector("a")!.dispatchEvent(event as any);
    expect({ html: output.innerHTML, unsafe: output.querySelector("script, img, [onerror]"),
      prevented: event.defaultPrevented, posted: h.posted.slice(posted) })
      .toEqual({ html: (h.window as any).__grokRenderMarkdown(raw), unsafe: null, prevented: true, posted: [] });
  });

  it("renders underscore emphasis without changing identifiers, code or link targets", () => {
    const h = boot(); send(h, { status: "complete", result_summary: '_Readable_ snake_case_name `_literal_` [link](https://example.com/_literal_)' });
    const output = card(h).querySelector(".workflow-output-body")!;
    expect([output.querySelector("em")?.textContent, output.querySelectorAll("em").length, output.querySelector("code")?.textContent,
      output.querySelector("a")?.getAttribute("href"), output.textContent?.includes("snake_case_name")])
      .toEqual(["Readable", 1, "_literal_", "https://example.com/_literal_", true]);
  });

  it("preserves a report starting with a markdown link", () => {
    const h = boot(); send(h, { status: "complete", result_summary: '[Source](https://example.com) supports the finding.' });
    expect(card(h).querySelector(".workflow-output-body")?.textContent).toBe("Source supports the finding.");
  });

  it("keeps live summary before progress and removes a withdrawn output", () => {
    const h = boot(); send(h, { objective: "Purpose", result_summary: "Interim result", pause_message: "Review required" }); expand(h);
    const surface = pin(h).querySelector(".workflow-pin-run")!;
    const before = { order: [...surface.querySelectorAll(".workflow-phases, .workflow-roster, .workflow-output")].map(el => el.className),
      reason: surface.querySelector(".run-progress-detail")!.textContent };
    send(h);
    expect({ before, output: surface.querySelector(".workflow-output") }).toEqual({ before: {
      order: ["workflow-phases", "workflow-roster", "workflow-output delegation-result"], reason: "Review required",
    }, output: null });
  });
});

describe("one live workflow surface", () => {
  const toggle = (h: Harness) => h.doc.querySelector<HTMLButtonElement>(".workflow-pin-pref")!;
  const frame = (h: Harness) => new Promise<void>(resolve => h.window.requestAnimationFrame(() => resolve()));

  it.each([{}, { vscode: true }, { remote: true }])("moves every live run together and preserves open state, focus and scroll on %j", async options => {
    const h = boot(options);
    send(h); expand(h);
    send(h, { run_id: "r2", name: "second" });
    expect(h.doc.querySelectorAll(".workflow-heading")).toHaveLength(2);
    expect(h.doc.querySelectorAll(".workflow-trace")).toHaveLength(2);
    const scroll = h.doc.getElementById("messages")!;
    Object.defineProperty(scroll, "scrollHeight", { configurable: true, value: 10000 });
    await frame(h);
    scroll.scrollTop = 123;
    const button = toggle(h);
    button.focus();
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.title).toBe("Unpin: show it where it started");
    click(h.window, button);
    await frame(h); await frame(h); await frame(h);
    expect(scroll.scrollTop).toBe(123);
    expect(h.doc.querySelector(".workflow-pin, .workflow-trace")).toBeNull();
    expect(h.doc.querySelectorAll(".workflow-card .workflow-heading")).toHaveLength(2);
    expect(h.doc.querySelectorAll(".run-progress-btn")).toHaveLength(4);
    expect(card(h).querySelector(".delegation-header")?.getAttribute("aria-expanded")).toBe("true");
    expect(h.doc.activeElement).toBe(toggle(h));
    expect(toggle(h).getAttribute("aria-pressed")).toBe("false");
    expect(toggle(h).title).toBe("Pin above the message box");
    click(h.window, toggle(h));
    expect(h.doc.querySelectorAll(".workflow-pin-run")).toHaveLength(2);
    expect(h.doc.querySelectorAll(".workflow-card .run-progress-btn")).toHaveLength(0);
    expect(h.doc.querySelectorAll(".run-progress-btn")).toHaveLength(4);
    expect(pin(h).querySelector(".delegation-header")?.getAttribute("aria-expanded")).toBe("true");
    expect(h.doc.activeElement).toBe(toggle(h));
    expect(pin(h).querySelectorAll('[aria-expanded="false"].delegation-header')).toHaveLength(1);
    await frame(h); await frame(h); await frame(h);
    expect(scroll.scrollTop).toBe(123);
  });

  it.each([true, false])("finishes into a closed transcript report when pinned=%s", pinned => {
    const h = boot();
    dispatch(h.window, { type: "pinLiveWorkflows", value: pinned });
    send(h);
    const original = card(h);
    click(h.window, h.doc.querySelector(".delegation-header")!);
    send(h, { status: "complete", result_summary: "Report" });
    expect(card(h)).toBe(original);
    expect(h.doc.querySelector(".workflow-pin, .workflow-pin-pref, .run-progress-btn, .workflow-trace")).toBeNull();
    expect((card(h).querySelector("details") as HTMLDetailsElement).open).toBe(false);
  });

  it("posts the desk preference and accepts settings frames, with pinned as the old-host default", () => {
    const h = boot(); send(h); expand(h);
    click(h.window, toggle(h));
    expect(h.posted).toContainEqual({ type: "setPinLiveWorkflows", value: false });
    dispatch(h.window, { type: "pinLiveWorkflows", value: true });
    expect(pin(h)).not.toBeNull();
    dispatch(h.window, { type: "pinLiveWorkflows", value: false });
    expect(h.doc.querySelector(".workflow-pin")).toBeNull();
    dispatch(h.window, { type: "initialState" });
    expect(pin(h)).not.toBeNull();
    dispatch(h.window, { type: "initialState", pinLiveWorkflows: false });
    expect(h.doc.querySelector(".workflow-pin")).toBeNull();
  });

  it("stores the phone preference locally, restores it on reload and ignores desk frames", () => {
    const h = boot({ remote: true }); send(h); expand(h);
    click(h.window, toggle(h));
    expect(h.window.localStorage.getItem("grok.remote.pinLiveWorkflows")).toBe("false");
    expect(h.posted.some(m => m.type === "setPinLiveWorkflows")).toBe(false);
    dispatch(h.window, { type: "initialState", pinLiveWorkflows: true });
    dispatch(h.window, { type: "pinLiveWorkflows", value: true });
    expect(h.doc.querySelector(".workflow-pin")).toBeNull();
    const restored = bootWebview({ remote: true, beforeScripts: w => w.localStorage.setItem("grok.remote.pinLiveWorkflows", "false") });
    windows.push(restored.window); send(restored);
    expect(restored.doc.querySelector(".workflow-pin")).toBeNull();
    expect(card(restored).querySelector(".workflow-heading")).not.toBeNull();
  });

  it("keeps the toggle as the last and only control for a run without driven controls", () => {
    const h = boot();
    dispatch(h.window, { type: "runProgress", update: { id: "run", kind: "workflow", phase: "running", controlsAvailable: false } });
    expand(h);
    expect([...pin(h).querySelector(".run-progress-actions")!.children]).toEqual([toggle(h)]);
    expect(hidden(toggle(h).closest(".workflow-expanded"))).toBe(false);
    click(h.window, toggle(h));
    expect([...card(h).querySelector(".run-progress-actions")!.children]).toEqual([toggle(h)]);
  });

  it("routes Pause, Resume and Stop from the unpinned card only", () => {
    const h = boot(); send(h); expand(h);
    click(h.window, toggle(h));
    const controls = () => [...card(h).querySelectorAll<HTMLButtonElement>(".run-progress-btn")];
    click(h.window, controls()[0]);
    send(h, { status: "user_paused" });
    expect(controls().map(button => button.textContent)).toEqual(["Resume", "Stop"]);
    controls().forEach(button => click(h.window, button));
    expect(h.posted.filter(m => m.type === "workflowControl")).toEqual([
      { type: "workflowControl", action: "pause", displayName: "deep-research" },
      { type: "workflowControl", action: "resume", displayName: "deep-research" },
      { type: "workflowControl", action: "stop", displayName: "deep-research" },
    ]);
    expect(h.doc.querySelector(".workflow-pin")).toBeNull();
    expect(h.doc.querySelectorAll(".run-progress-btn")).toHaveLength(2);
    expect(card(h).querySelector(".run-progress-actions")!.lastElementChild).toBe(toggle(h));
  });

  it("uses the same markers for header, steps and agents, with arrows inside each step", () => {
    const h = boot();
    const style = h.doc.createElement("style");
    style.textContent = readFileSync(new URL("../media/chat.css", import.meta.url), "utf8");
    h.doc.head.append(style);
    const states = ["done", "active", "pending", "unknown", "failed", "cancelled", "stopped"];
    send(h, { current_phase: "active", phases: states.map(state => ({ title: state, state })),
      agents: states.map((state, i) => ({ agent_id: String(i), label: state, state })) });
    expand(h);
    const steps = [...pin(h).querySelectorAll(".workflow-phase")];
    expect(steps.map(step => step.querySelector(".workflow-state-marker")?.getAttribute("data-state"))).toEqual(states);
    expect(pin(h).querySelectorAll(".workflow-phase-arrow svg")).toHaveLength(states.length - 1);
    expect(steps.slice(0, -1).every(step => step.lastElementChild?.classList.contains("workflow-phase-arrow"))).toBe(true);
    expect(steps.at(-1)?.querySelector(".workflow-phase-arrow")).toBeNull();
    expect(h.window.getComputedStyle(steps[1].querySelector(".workflow-phase-label") as any).fontWeight).toBe("700");
    expect(steps[1].getAttribute("aria-current")).toBe("step");
    expect(steps.every(step => step.getAttribute("aria-label") === step.getAttribute("title"))).toBe(true);
    expect(pin(h).querySelector(".delegation-section-label")).toBeNull();
    expect([...pin(h).querySelectorAll(".workflow-agent-toggle")].map(row => row.firstElementChild?.getAttribute("data-state"))).toEqual(states);
    expect(pin(h).querySelector("strong.workflow-agent-name")).toBeNull();
  });
});

describe("approved workflow states", () => {
  it.each([{}, { vscode: true }, { remote: true }])("settles complete runs into history on surface %j", (options) => {
    const h = boot(options);
    send(h, { current_phase: "Report" });
    expand(h);
    const original = card(h);
    send(h, { status: "complete", current_phase: "Report", result_summary: "Partial",
      phases: base.phases.map((p) => ({ ...p, state: p.title === "Report" ? "active" : "done" })),
    });
    expect(h.doc.querySelector(".workflow-pin")).toBeNull();
    expect(card(h)).toBe(original);
    // The collapsed report is built from the live card's own parts, so a
    // finished run reports its duration and its steps WITHOUT being opened.
    // It used to be a bare string beside the browser's native <details>
    // marker: a different glyph, on the other side, from every running card.
    const summary = card(h).querySelector("summary")!;
    expect({
      name: summary.querySelector(".workflow-report-name")?.textContent,
      state: summary.querySelector(".workflow-report-state")?.textContent,
      elapsed: summary.querySelector(".workflow-report-elapsed")?.textContent,
      chevron: !!summary.querySelector(".workflow-report-chevron"),
      steps: [...summary.querySelectorAll(".workflow-report-dots .workflow-dot")]
        .map((d) => (d as HTMLElement).dataset.state),
    }).toEqual({ name: "deep-research", state: "done", elapsed: "12:08", chevron: true,
      steps: ["done", "done", "done", "done"] });
    expect(card(h).querySelector(".workflow-marker, .run-progress-btn, [aria-current]")).toBeNull();
    expect([...card(h).querySelectorAll(".workflow-phase")].map((p) => p.getAttribute("data-state")))
      .toEqual(["done", "done", "done", "done"]);
    expect(card(h).textContent).toContain("Partial");
  });

  it.each(["done", "complete", "completed"])("preserves reported %s for the retained current phase", (state) => {
    const h = boot();
    send(h, { status: "completed", phases: [{ title: "Research", state }] });
    const step = card(h).querySelector(".workflow-phase")!;
    expect(step.getAttribute("data-state")).toBe(state);
    expect(step.hasAttribute("aria-current")).toBe(false);
  });

  it.each(["failed", "cancelled"])("ends active phase styling on %s without completing pending work", (status) => {
    const h = boot(); send(h); send(h, { status });
    expect([...card(h).querySelectorAll(".workflow-phase")].map((p) => p.getAttribute("data-state")))
      .toEqual(["done", status, "pending", "pending"]);
    expect(card(h).querySelector("[aria-current]")).toBeNull();
  });

  it.each([{}, { vscode: true }, { remote: true }])("starts collapsed with reported dots on surface %j", (options) => {
    const h = boot(options);
    expect(h.doc.querySelector(".workflow-pin")).toBeNull();
    send(h);
    // Inside the composer, ahead of everything in it. The scroll-to-bottom pill
    // and the previous-prompt circle are absolutely positioned against the
    // composer's padding box, so a pin that is merely a SIBLING of the composer
    // sits underneath both of them.
    expect(pin(h).parentElement).toBe(h.doc.querySelector(".composer"));
    expect(pin(h).previousElementSibling).toBeNull();
    // The controls are the card's last row, not passengers in the heading:
    // sharing that row clipped "Stop" off the right edge of a phone.
    expect(pin(h).querySelector(".workflow-heading .run-progress-actions")).toBeNull();
    expect(pin(h).querySelector(".run-progress-actions")!.closest(".workflow-expanded")).not.toBeNull();
    expect(pin(h).querySelector(".workflow-pin-toggle")!.getAttribute("aria-expanded")).toBe("false");
    expect(summary(h)).toContain("deep-research");
    expect(summary(h)).toContain("running");
    expect(pin(h).querySelector(".run-progress-elapsed")!.textContent).toBe("12:08");
    expect(status(h)).toBe("running");
    const dots = [...pin(h).querySelectorAll(".workflow-dot")];
    expect(dots).toHaveLength(4);
    expect(dots.map((d) => d.getAttribute("data-state"))).toEqual(["done", "active", "pending", "pending"]);
    expect(dots[1].getAttribute("aria-current")).toBe("step");
    expect(dots.filter((d) => d.hasAttribute("aria-current"))).toHaveLength(1);
    expect(hidden(pin(h).querySelector(".workflow-expanded"))).toBe(true);
    expect(pin(h).querySelector(".workflow-motion, .blink-dots")).toBeNull();
    expect(card(h).textContent).toBe("Workflow deep-research started \u00b7 live below");
    expect(card(h).querySelector("svg")).not.toBeNull();
    expect(card(h).querySelector(".delegation-header, .workflow-expanded, button, .delegation-chevron")).toBeNull();
    expect(h.doc.querySelectorAll(".workflow-heading")).toHaveLength(1);
  });
  it.each([{}, { vscode: true }, { remote: true }])("keeps the header status and duration when opened on surface %j", (options) => {
    const h = boot(options);
    const style = h.doc.createElement("style");
    style.textContent = readFileSync(new URL("../media/chat.css", import.meta.url), "utf8");
    h.doc.head.append(style);
    send(h);
    const phase = () => pin(h).querySelector(".workflow-heading .run-progress-phase")!;
    expect(phase().textContent).toBe("running");
    expand(h);
    expect(phase().textContent).toBe("running");
    expect(hidden(pin(h).querySelector(".workflow-phases"))).toBe(false);
    send(h, { current_phase: "Verify", elapsed_ms: 106_000 });
    expect(phase().textContent).toBe("running");
    expect(pin(h).querySelector(".workflow-heading .run-progress-elapsed")!.textContent).toBe("1:46");
    expand(h);
    expect(phase().textContent).toBe("running");
    expect(pin(h).querySelector(".workflow-heading .run-progress-elapsed")!.textContent).toBe("1:46");
  });
  // A row printed the label AND the phase, and the label almost always already
  // contained the phase: "pick Pick", "object Object", "read:readme Read".
  // One composed name, repeating nothing.
  it.each([
    ["pick", "Pick", "Pick"],
    ["object", "Object", "Object"],
    ["read:readme", "Read", "Read / readme"],
    ["read:agents", "Read", "Read / agents"],
    ["researcher-0", "Research", "researcher-0"],
    ["research-planner", "Plan", "Plan / research-planner"],
    // A remainder beginning with s: an earlier regex class lost its backslash
    // and ate the letter, rendering "Report / ynthesizer".
    ["report-synthesizer", "Report", "Report / synthesizer"],
    ["verify:stale", "Verify", "Verify / stale"],
    ["plan:summary", "Plan", "Plan / summary"],
  ])("names agent %s in phase %s as %s", (label, phase, expected) => {
    const h = boot();
    send(h, { agents: [{ agent_id: "a", label, phase, state: "done", tokens_used: 10 }] }); expand(h);
    expect(pin(h).querySelector(".workflow-agent-name")!.textContent).toBe(expected);
  });
  it("shows one line per agent and toggles each detail independently", () => {
    const h = boot();
    const agents = [base.agents[0], { ...base.agents[0], agent_id: "b", label: "Verifier", phase: "Verify", state: "pending", tokens_used: 19638 }];
    send(h, { agents }); expand(h);
    expect(hidden(pin(h).querySelector(".workflow-expanded"))).toBe(false);
    expect(hidden(pin(h).querySelector(".workflow-dots"))).toBe(false);
    expect([...pin(h).querySelectorAll(".workflow-phase")].map((p) => p.textContent)).toEqual(base.phases.map((p) => p.title));
    const rows = [...pin(h).querySelectorAll(".workflow-agent")];
    expect(rows).toHaveLength(2);
    // The phase now lives in the composed name, not the metadata run.
    expect(rows[0].querySelector("button")!.textContent).toContain("Researcher A");
    expect(rows[0].querySelector("button")!.textContent).toContain("running");
    expect(rows[0].querySelector(".workflow-agent-state")!.textContent).not.toContain("Research");
    expect(rows[1].querySelector(".workflow-agent-toggle")!.textContent).toContain("19.64K tokens");
    expect(rows[1].querySelector("button, .workflow-agent-chevron, [aria-expanded]")).toBeNull();
    expect(hidden(rows[0].querySelector(".workflow-agent-detail"))).toBe(true);
    click(h.window, rows[0].querySelector("button")!);
    expect(hidden(rows[0].querySelector(".workflow-agent-detail"))).toBe(false);
    expect(hidden(rows[1].querySelector(".workflow-agent-detail"))).toBe(true);
    expect(activity(h)).toBe("no token activity observed");
    const button = rows[0].querySelector<HTMLButtonElement>("button")!;
    button.focus(); send(h, { agents: [...agents].reverse() });
    expect(h.doc.activeElement).toBe(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    click(h.window, button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });
  it("offers a fixed report only after completion", () => {
    const h = boot(); send(h);
    expect(card(h).querySelector("summary")).toBeNull();
    send(h, { status: "completed", result_summary: "Three sources agreed." });
    expect(h.doc.querySelector(".workflow-pin")).toBeNull();
    const report = card(h).querySelector<HTMLDetailsElement>("details")!;
    expect(report.open).toBe(false);
    click(h.window, report.querySelector("summary")!);
    expect(report.open).toBe(true);
    expect(report.textContent).toContain("Three sources agreed.");
    expect(report.textContent).toContain("12:08");
    expect(report.querySelector(".run-progress-btn")).toBeNull();
  });
  it("keeps expansion per run in memory and defaults new runs to collapsed", () => {
    const h = boot(); send(h); expand(h);
    send(h);
    expect(pin(h).querySelector(".workflow-pin-toggle")!.getAttribute("aria-expanded")).toBe("true");
    send(h, { run_id: "r2", name: "second" });
    const toggles = pin(h).querySelectorAll(".workflow-pin-toggle");
    expect([...toggles].map((t) => t.getAttribute("aria-expanded"))).toEqual(["true", "false"]);
    send(h, { status: "completed" });
    send(h, { run_id: "r2", name: "second", status: "completed" });
    send(h, { run_id: "r3", name: "third" });
    expect(pin(h).querySelector(".workflow-pin-toggle")!.getAttribute("aria-expanded")).toBe("false");
    expect(h.posted.filter((m) => /config|setting|preference/i.test(m.type))).toEqual([]);
    dispatch(h.window, { type: "clearMessages" });
    expect(h.doc.querySelector(".workflow-pin")).toBeNull();
    send(h);
    expect(pin(h).querySelector(".workflow-pin-toggle")!.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("workflow evidence", () => {
  it("caps quiet receipt and token clocks independently, and fresh evidence resets each", async () => {
    const h = boot(); send(h);
    const moved = { agents: [{ ...base.agents[0], tokens_used: 12 }] };
    send(h, moved);
    h.advance(29_000);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(status(h)).toBe("running");
    expect(activity(h)).toBe("tokens moved 29s ago");
    h.advance(1000);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect.soft(status(h)).toBe("running");
    expect.soft(activity(h)).toBe("no recent token movement (30s+)");
    h.advance(3_600_000);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect.soft(status(h)).toBe("no update for 2 min");
    expect.soft(activity(h)).toBe("no recent token movement (30s+)");
    send(h, moved);
    expect(status(h)).toBe("running");
    expect.soft(activity(h)).toBe("no recent token movement (30s+)");
    send(h, { agents: [{ ...base.agents[0], tokens_used: 13 }] });
    expect(activity(h)).toBe("tokens moved 0s ago");
  });
  it("caps state-change age without claiming token activity", () => {
    const h = boot(); send(h);
    const blocked = { agents: [{ ...base.agents[0], state: "permission_blocked" }] };
    send(h, blocked); h.advance(180_000); send(h, blocked);
    expect(activity(h)).toBe("no recent state change (30s+) · no token activity observed");
  });
  it("leaves finished receipt and activity evidence static even while another run ticks", async () => {
    const h = boot(); send(h);
    send(h, { status: "complete", agents: [{ ...base.agents[0], tokens_used: 12, state: "done" }] });
    send(h, { run_id: "other" });
    h.advance(180_000);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const report = card(h);
    expect.soft(report.querySelector(".workflow-receipt")).toBeNull();
    expect.soft(report.querySelector(".delegation-status")!.textContent).toBe("done");
    expect.soft(report.querySelector(".workflow-agent-activity")!.textContent).toBe("tokens moved");
  });
  it("does not deny token activity when the first snapshot already has a positive total", () => {
    const h = boot();
    send(h, { agents: [{ ...base.agents[0], tokens_used: 23552 }] }); expand(h);
    expect(agent(h).querySelector("button, .workflow-agent-chevron, [aria-expanded]")).toBeNull();
    expect(agent(h).querySelector(".workflow-agent-state")!.textContent).toContain("23.55K tokens");
    expect(activity(h)).toBe("");
  });
  it("adds a disclosure when evidence arrives and removes it when replay has none", () => {
    const h = boot();
    send(h, { agents: [{ ...base.agents[0], tokens_used: 20 }] }); expand(h);
    expect(agent(h).querySelector("button, .workflow-agent-chevron")).toBeNull();
    send(h, { agents: [{ ...base.agents[0], tokens_used: 21 }] });
    click(h.window, agent(h).querySelector("button")!);
    expect(hidden(agent(h).querySelector(".workflow-agent-detail"))).toBe(false);
    expect(activity(h)).toBe("tokens moved 0s ago");
    dispatch(h.window, { type: "historyReplay", active: true });
    send(h, { agents: [{ ...base.agents[0], tokens_used: 21 }] });
    dispatch(h.window, { type: "historyReplay", active: false });
    expect(agent(h).querySelector("button, .workflow-agent-chevron, [aria-expanded]")).toBeNull();
    expect(hidden(agent(h).querySelector(".workflow-agent-detail"))).toBe(true);
  });
  it("renders a done agent state without the reported prefix", () => {
    const h = boot();
    send(h, { agents: [{ ...base.agents[0], phase: "Plan", state: "done" }] });
    expect(agent(h).querySelector(".workflow-agent-state")!.textContent).toBe("done");
  });
  it.each([
    [1000, "1K"], [23552, "23.55K"], [99999, "100K"], [100000, "100K"],
    [288307, "288K"], [999500, "1M"], [1200000, "1.2M"],
  ])("formats %i agent tokens like the context window (%s)", (tokens, formatted) => {
    const h = boot();
    send(h, { agents: [{ ...base.agents[0], tokens_used: tokens }] });
    expect(agent(h).querySelector(".workflow-agent-state")!.textContent).toBe(`running · ${formatted} tokens`);
  });
  it("ages token events independently of receipts and duplicate revisions", () => {
    const h = boot(); send(h, { revision: 1 });
    const moved = { revision: 2, agents: [{ ...base.agents[0], tokens_used: 12 }] };
    h.advance(1000); send(h, moved);
    expect(activity(h)).toBe("tokens moved 0s ago");
    h.advance(12000); send(h, moved);
    expect(activity(h)).toBe("tokens moved 12s ago");
    expect(status(h)).toBe("running");
    expect(summary(h)).not.toContain("tokens moved");
    expect(summary(h)).toContain("12:21");
  });
  it("ticks elapsed while zero-token evidence stays unchanged", async () => {
    const h = boot(); send(h); h.advance(20000);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(status(h)).toBe("running");
    expect(summary(h)).toContain("12:28");
    expect(activity(h)).toBe("no token activity observed");
  });
  it("does not mistake phase changes, token resets or older revisions for work", () => {
    const h = boot(); send(h, { revision: 3 });
    send(h, { revision: 2, current_phase: "Plan", agents: [{ ...base.agents[0], state: "failed" }] });
    expect(summary(h)).toContain("running");
    expect(activity(h)).toBe("no token activity observed");
    send(h, { current_phase: "Verify", agents: [{ ...base.agents[0], phase: "Verify" }] });
    send(h, { agents: [{ ...base.agents[0], tokens_used: -1 }] });
    expect(activity(h)).toBe("no token activity observed");
  });
  it("does not assign evidence across ambiguous labels or changed identities", () => {
    const h = boot();
    const anonymous = { label: "Researcher", state: "running", tokens_used: 0 };
    send(h, { agents: [anonymous, anonymous] });
    send(h, { agents: [{ ...anonymous, tokens_used: 15 }, anonymous] });
    expect(activity(h)).toBe("");
    send(h, { agents: [{ agent_id: "new", ...anonymous, tokens_used: 20 }] });
    expect(activity(h)).toBe("");
  });
  it.each(["failed", "permission_blocked", "waiting_for_permission", "awaiting_approval"])("keeps %s on its agent row", (state) => {
    const h = boot(); send(h, { agents: [{ ...base.agents[0], state }] });
    expect(agent(h).getAttribute("data-state")).toBe(state);
    expect(agent(h).textContent).toContain(state.replaceAll("_", " "));
    expect(pin(h).querySelector(".workflow-pin-toggle")!.getAttribute("aria-expanded")).toBe("false");
  });
  // A phone joining a conversation replays the transcript, so a run that is
  // very much alive arrives with no locally observed frame. This asserted the
  // pin was ABSENT there, which is what the owner hit on a cloud machine: a
  // bare "deep-research - running" line and nothing above the composer, for as
  // long as it took the next frame to arrive -- about a dozen frames span a
  // whole deep-research run. Freshness is the receipt's job; it is not a
  // reason to withhold the run.
  it("pins a replayed live run without claiming a receipt or observed activity", () => {
    const h = boot(); dispatch(h.window, { type: "historyReplay", active: true });
    send(h); send(h, { agents: [{ ...base.agents[0], tokens_used: 30 }] });
    dispatch(h.window, { type: "historyReplay", active: false });
    expect(h.doc.querySelector(".workflow-pin")).not.toBeNull();
    // No age, because none is known -- and not a finished run's wording either.
    expect(status(h)).toBe("running");
    expect(activity(h)).toBe("");
    // The handle is what a control needs; the host owns the run either way.
    const buttons = [...pin(h).querySelectorAll<HTMLButtonElement>(".run-progress-btn")];
    expect(buttons.map(b => b.textContent)).toEqual(["Pause", "Stop"]);
    expect(buttons.every(b => b.disabled)).toBe(false);
    expect(pin(h).querySelector(".delegation-status")!.textContent).toBe("running");
    expect(card(h).querySelector("summary")).toBeNull();
    // Beside tool rows that all carry one, a bare string read as half-drawn.
    expect(card(h).querySelector(".run-progress-badge svg.tool-icon")).not.toBeNull();
  });
});

describe("reported capabilities", () => {
  it("uses reported order, ids and current phase through renames", () => {
    const h = boot(); send(h);
    const phases = [{ title: "Intake", state: "done" }, ...base.phases];
    send(h, { phases });
    expect(pin(h).querySelectorAll(".workflow-dot")).toHaveLength(5);
    expect(pin(h).querySelectorAll(".workflow-dot")[2].getAttribute("aria-current")).toBe("step");
    send(h, { current_phase_id: "p2", phases: [{ id: "p2", title: "Renamed", state: "active" }] });
    expect(pin(h).querySelector(".workflow-phase")!.textContent).toBe("Renamed");
    expect(pin(h).querySelector('.workflow-dot[aria-current="step"]')!.getAttribute("data-phase-id")).toBe("p2");
    send(h, { current_phase: "p2", phases: [{ id: "p2", title: "Research" }] });
    expect(summary(h)).toContain("running");
    expect(pin(h).querySelector('.workflow-dot[aria-current="step"]')).not.toBeNull();
  });
  it("does not guess a current step for ambiguous names or unmatched ids", () => {
    const h = boot();
    send(h, { phases: [{ title: "Research" }, { title: "Research" }] });
    expect(pin(h).querySelector('[aria-current="step"]')).toBeNull();
    send(h, { current_phase_id: "unknown" });
    expect(pin(h).querySelector('[aria-current="step"]')).toBeNull();
    send(h, { current_phase_id: "p2", phases: [{ id: "p2", title: "Research" }, { id: "p2", title: "Research" }] });
    expect(pin(h).querySelector('[aria-current="step"]')).toBeNull();
  });
  it("gates missing fields and never uses an id as a name or handle", () => {
    const h = boot();
    dispatch(h.window, { type: "runProgress", update: { kind: "workflow", id: "opaque", title: "opaque", phase: "running", done: false, progress: 0.3 } });
    expect(pin(h).querySelectorAll(".workflow-dot, .workflow-agent")).toHaveLength(0);
    for (const selector of [".workflow-phases", ".workflow-roster", ".workflow-spend"]) expect(hidden(pin(h).querySelector(selector))).toBe(true);
    expect(pin(h).querySelector(".delegation-status")!.textContent).toBe("running");
    expect(pin(h).textContent).not.toMatch(/opaque|%/);
    send(h, { phases: undefined, current_phase: undefined, elapsed_ms: undefined, agents: undefined, agents_used: undefined, agent_budget: undefined });
    expect(pin(h).querySelector('[data-run-id="r1"] .run-progress-phase')!.textContent).toBe("running");
  });
  it("formats agent and deliverable budgets with separators", () => {
    const h = boot(); send(h, { agents_used: 1234, agent_budget: 20000, agents: [{ ...base.agents[0], tokens_used: 19638 }] }); expand(h);
    expect(pin(h).textContent).toContain("1,234 agents");
    expect(agent(h).textContent).toContain("19.64K tokens");
    dispatch(h.window, { type: "runProgress", update: parseRunProgressUpdate({ sessionUpdate: "goal_updated", completed_deliverables: 1234, total_deliverables: 20000 }) });
    expect(h.doc.querySelector('.run-progress-card:not(.workflow-card):not(.workflow-pin-run)')!.textContent).toContain("1,234/20,000 deliverables");
  });
  it("retains an older host's structured budget outside its ambiguous detail", () => {
    const h = boot();
    dispatch(h.window, { type: "runProgress", update: { kind: "workflow", id: "old", title: "Existing workflow", phase: "running", done: false, agentsUsed: 1234, agentBudget: 20000, detail: "1234 of 20000 agents used" } });
    expand(h);
    expect(pin(h).querySelector(".workflow-spend")!.textContent).toBe("1,234 agents");
    expect(hidden(pin(h).querySelector(".run-progress-detail"))).toBe(true);
  });
  it("keeps long phase names complete and ordered in the expanded strip", () => {
    const h = boot();
    const phases = Array.from({ length: 12 }, (_, i) => ({ title: `Extended research phase ${i} with a long title`, state: i === 7 ? "active" : "pending" }));
    send(h, { phases, current_phase: phases[7].title }); expand(h);
    expect([...pin(h).querySelectorAll(".workflow-phase")].map((p) => p.textContent)).toEqual(phases.map((p) => p.title));
    expect(pin(h).querySelectorAll(".workflow-phase")[7].getAttribute("aria-current")).toBe("step");
  });
  it("hides affordances when the latest snapshot omits their fields", () => {
    const h = boot(); send(h); expand(h);
    send(h, { phases: undefined, agents: undefined, current_phase: undefined, elapsed_ms: undefined, agents_used: undefined, agent_budget: undefined });
    expect(pin(h).querySelectorAll(".workflow-dot, .workflow-agent")).toHaveLength(0);
    expect(hidden(pin(h).querySelector(".workflow-spend"))).toBe(true);
    expect(hidden(pin(h).querySelector(".run-progress-elapsed"))).toBe(false);
  });
  it("puts a run with a blocked agent first without opening it", () => {
    const h = boot(); send(h);
    send(h, { run_id: "blocked", name: "verify", agents: [{ ...base.agents[0], state: "permission_blocked" }] });
    expect(pin(h).querySelector(".workflow-pin-run")!.getAttribute("data-run-id")).toBe("blocked");
    expect(pin(h).querySelector(".workflow-pin-toggle")!.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps blocked and failed agent details inside the closed body", () => {
    const h = boot(); send(h, { agents: [
      { ...base.agents[0], state: "permission_blocked" },
      { agent_id: "b", label: "Researcher B", phase: "Research", state: "failed", tokens_used: 10 },
    ] });
    expect(pin(h).querySelector(".workflow-blocked")).toBeNull();
    expect(hidden(pin(h).querySelector(".workflow-expanded"))).toBe(true);
    expect(status(h)).toBe("running");
    expand(h);
    expect(pin(h).querySelector(".workflow-roster")!.textContent).toContain("permission blocked");
  });

});

describe("reachable controls and tool fallback", () => {
  it.each(["heading", "agent"])("uses decorative SVG disclosure icons for the workflow %s in both states", (target) => {
    const h = boot(); send(h); if (target === "agent") expand(h);
    const button = () => pin(h).querySelector(target === "heading" ? ".workflow-pin-toggle" : ".workflow-agent-toggle")!;
    const indicator = () => button().querySelector(target === "heading" ? ".workflow-chevron" : ".workflow-agent-chevron");
    expect.soft(indicator()?.querySelector("svg path")?.getAttribute("d")).toBe("m9 18 6-6-6-6");
    expect.soft(indicator()?.getAttribute("aria-hidden")).toBe("true");
    click(h.window, button());
    if (target === "heading") expect(indicator()?.classList.contains("is-open")).toBe(true);
    else expect.soft(indicator()?.querySelector("svg path")?.getAttribute("d")).toBe("m6 9 6 6 6-6");
    click(h.window, button());
    expect.soft(indicator()?.querySelector("svg path")?.getAttribute("d")).toBe("m9 18 6-6-6-6");
  });
  it("keeps Pause and Stop in both states and Resume follows the reported state", () => {
    const h = boot(); send(h);
    const controls = () => [...pin(h).querySelectorAll<HTMLButtonElement>(".run-progress-btn")];
    for (let i = 0; i < 2; i++) {
      expect(controls().map((b) => b.textContent)).toEqual(["Pause", "Stop"]);
      controls().forEach((b) => b.click()); expand(h);
    }
    expect(h.posted.filter((m) => m.type === "workflowControl")).toEqual([
      { type: "workflowControl", action: "pause", displayName: "deep-research" }, { type: "workflowControl", action: "stop", displayName: "deep-research" },
      { type: "workflowControl", action: "pause", displayName: "deep-research" }, { type: "workflowControl", action: "stop", displayName: "deep-research" },
    ]);
    send(h, { status: "user_paused" });
    expect(controls()[0].textContent).toBe("Resume");
    expect(pin(h).querySelector(".run-progress-phase")!.textContent).toBe("paused");
    h.advance(60000); send(h, { status: "user_paused" });
    expect(summary(h)).toContain("12:08");
    send(h, { elapsed_ms: 729000 });
    expect(summary(h)).toContain("12:09");
  });
  // A halt that is not a pause keeps Pause/Stop, so these words are the only
  // thing separating a stopped run from one that is still working.
  it.each([
    ["budget_limited", "running"],
    ["interrupted", "running"],
    ["active", "running"],
  ])("a collapsed pin reporting %s says so", (status, expected) => {
    const h = boot(); send(h, { status });
    expect(pin(h).querySelector(".run-progress-phase")!.textContent).toBe(expected);
  });
  it.each([undefined, "bad handle", " deep-research "])("offers only the pin toggle for unavailable handle %s", (name) => {
    const h = boot(); send(h, { name });
    const buttons = [...pin(h).querySelectorAll<HTMLButtonElement>(".run-progress-btn")];
    expect(buttons).toHaveLength(0);
    expect(pin(h).querySelector(".run-progress-actions")!.children).toHaveLength(1);
    expect(pin(h).querySelector(".workflow-pin-pref")).not.toBeNull();
    buttons.forEach((b) => b.click());
    expect(h.posted.filter((m) => m.type === "workflowControl")).toEqual([]);
  });
  it("preserves focused controls across duplicate frames", () => {
    const h = boot(); send(h);
    const button = pin(h).querySelector<HTMLButtonElement>(".run-progress-btn")!;
    button.focus(); send(h);
    expect(pin(h).querySelector(".run-progress-btn")).toBe(button);
    expect(h.doc.activeElement).toBe(button);
  });
  it.each([true, false])("deduplicates matching workflow tool rows in either arrival order: frame first %s", (frameFirst) => {
    const h = boot();
    if (frameFirst) send(h);
    dispatch(h.window, { type: "toolCall", call: { toolCallId: "w", title: "Workflow: deep-research", kind: "other", status: "in_progress" } });
    const tool = h.doc.querySelector(".workflow-tool-marker")!;
    expect(hidden(tool)).toBe(frameFirst);
    if (!frameFirst) send(h);
    expect(hidden(tool)).toBe(true);
    dispatch(h.window, { type: "toolCall", call: { toolCallId: "x", title: "Workflow: unrelated", kind: "other" } });
    expect([...h.doc.querySelectorAll(".workflow-tool-marker")].filter((t) => !hidden(t))).toHaveLength(1);
    dispatch(h.window, { type: "toolCallUpdate", call: { toolCallId: "w", status: "failed" } });
    expect(hidden(tool)).toBe(false);
  });
  it("keeps the pin in flow and bounded, with static dots and one-line agent summaries", () => {
    const css = readFileSync(new URL("../media/chat.css", import.meta.url), "utf8");
    expect(css.match(/\.workflow-pin \{([^}]+)\}/)![1]).not.toMatch(/position:\s*(fixed|absolute)/);
    expect(css).toMatch(/\.workflow-pin-runs\s*\{[^}]*overflow: auto/);
    expect(css).toMatch(/\.workflow-phases\s*\{[^}]*flex-wrap: wrap/);
    expect(css).toMatch(/\.workflow-agent-toggle\s*\{[^}]*white-space: nowrap/);
    expect(css.match(/\.workflow-dot[^}]+}/g)!.join("")).not.toMatch(/animation|transition/);
  });
});
