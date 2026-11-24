import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";
import { rewindConfirmMessage } from "../src/rewind";
import { webviewHtmlText } from "../src/webview-l10n";
import { bootWebview, click, dispatch, press, type Posted } from "./webview-harness";

const { collect } = createRequire(import.meta.url)("../scripts/l10n-extract.cjs") as {
  collect(): { keys: string[] };
};
const pseudo = (text: string) => `⟦${text}⟧`;
const strings = Object.fromEntries(collect().keys.map((key) => [key, pseudo(key)]));
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const sidebar = read("../src/sidebar.ts");
const htmlText = webviewHtmlText(strings);

function localizeStaticHtml(html: string): string {
  return html.replace(/\$\{l10n\((".*?")\)(?:\.replace\("\{0\}", (".*?")\))?\}/g, (_, key, name) => {
    const text = htmlText(JSON.parse(key));
    return name ? text.replace("{0}", JSON.parse(name)) : text;
  });
}

const windows: Window[] = [];
afterEach(async () => {
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.close()));
});

function chat() {
  const h = bootWebview({
    vscode: true,
    strings,
    beforeScripts(window) {
      const doc = window.document;
      // The shared harness normally mirrors getHtml. Use its real static controls here.
      doc.querySelector(".composer")!.outerHTML = localizeStaticHtml(
        sidebar.match(/<footer class="composer">[\s\S]*?<\/footer>/)![0],
      );
      for (const id of ["history-btn", "new-btn", "repo-btn", "remote-btn"]) {
        doc.getElementById(id)!.outerHTML = localizeStaticHtml(
          sidebar.match(new RegExp(`<button id="${id}"[^>]*></button>`))![0],
        );
      }
    },
  });
  windows.push(h.window);
  return h;
}

function rail(bundle = strings) {
  const window = new Window({ url: "https://localhost/" });
  windows.push(window);
  const doc = window.document as unknown as Document;
  const posted: Posted[] = [];
  Object.assign(window, {
    __grokL10n: bundle,
    acquireVsCodeApi: () => ({
      postMessage: (message: Posted) => posted.push(message),
      getState: () => ({}),
      setState: () => {},
    }),
  });
  const railHtml = sidebar.slice(sidebar.indexOf("private getProjectsRailHtml("));
  doc.body.innerHTML = localizeStaticHtml(railHtml.match(/<aside id="projects-rail"[\s\S]*?<\/aside>/)![0]);
  for (const file of ["webview-helpers.js", "repo-icons.js", "repo-icon-picker.js", "projects-rail.js"]) {
    window.eval(read(`../media/${file}`));
  }
  return { window, doc, posted };
}

function element(root: ParentNode, selector: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(selector);
  expect(el, selector).not.toBeNull();
  return el!;
}

// Fixture/provider content and copy explicitly kept outside the translation pass.
const english = new Set([
  // Provider and model names, plus the model's advertised description.
  "Grok", "Codex", "Antigravity", "Muse Code", "Pilot Model", "pilot-model",
  "An advertised model description",
  // Project/session names and paths supplied by the host.
  "Alpha Project", "Archived Project", "/work/alpha", "/work/archive",
  "Current conversation", "Untitled",
  // User-authored content, including the quoted host dialog preview.
  "First prompt", "Second prompt", "Queued user text", "Agent answer",
  '"Keep <this> & the exact user copy."',
  // Host-supplied disabled-mode prose.
  "The host disabled this mode.",
  // The match-case glyph, the same in every language.
  "Aa",
  // Status, excluded from scope.
  "Queued", "Loading…",
]);

function expectLocalized(el: HTMLElement) {
  expect(el.closest("[hidden]"), `surface is hidden: ${el.id || el.className}`).toBeNull();
  const untranslated: string[] = [];
  function check(value: string, node: Element, field: string) {
    const label = value.trim();
    if (english.has(label)) return;
    // Message timestamps use the existing locale time formatter.
    if (node.matches(".msg-timestamp") && /^\d{1,2}:\d{2}(?:\s*[AP]M)?$/i.test(label)) return;
    // Context usage belongs to the excluded context controls.
    if (node.closest("#donut")) return;
    let remaining = label;
    while (/⟦[^⟦⟧]*⟧/.test(remaining)) remaining = remaining.replace(/⟦[^⟦⟧]*⟧/g, "");
    for (const line of remaining.split("\n").map(part => part.trim())) {
      if (/[A-Za-z]/.test(line) && !english.has(line)) {
        untranslated.push(`${node.tagName}.${node.className} ${field}: ${line}`);
      }
    }
  }
  function visit(node: Element) {
    if (node.hasAttribute("hidden") || (node as HTMLElement).style?.display === "none") return;
    for (const attr of ["title", "aria-label", "placeholder"]) check(node.getAttribute(attr) || "", node, attr);
    for (const child of node.childNodes) {
      if (child.nodeType === 1) visit(child as Element);
      if (child.nodeType === 3) check(child.textContent || "", node, "text");
    }
  }
  visit(el);
  expect.soft(untranslated, el.id || el.className).toEqual([]);
}

const active = "current";
const alpha = "/work/alpha";
const old = "/work/archive";
const clockSkew = 5 * 60_000;
function session(h: ReturnType<typeof chat>, provider = "grok", extra: Record<string, unknown> = {}) {
  dispatch(h.window, { type: "providerState", providers: [{ id: provider, connected: true }] });
  dispatch(h.window, {
    type: "session", sessionId: active, provider, currentModelId: "pilot-model", effort: "medium",
    models: [{
      modelId: "pilot-model", name: "Pilot Model", description: "An advertised model description",
      supportsReasoningEffort: true, reasoningEfforts: ["low", "medium", "high"],
    }],
    ...extra,
  });
  dispatch(h.window, { type: "sessionName", sessionId: active, name: "Current conversation", cwd: alpha });
}

function row(id: string, cwd: string, displayName: string, daysAgo = 0) {
  return { id, cwd, displayName, rawSummary: "", provider: "grok", numMessages: 2,
    updatedAt: Date.now() - clockSkew - daysAgo * 86_400_000 };
}

function catalog(h: ReturnType<typeof rail> | ReturnType<typeof chat>) {
  dispatch(h.window, {
    type: "repos", selectedCwd: alpha, activeCwd: alpha, workspaceCwd: alpha,
    canAddProject: true, canCreateProject: true, canCloneProject: true,
    entries: [
      { cwd: alpha, label: "Alpha Project", available: true, archived: false, color: "", icon: "", updatedAt: Date.now() },
      { cwd: old, label: "Archived Project", available: true, archived: true, color: "", icon: "", updatedAt: Date.now() },
    ],
  });
  dispatch(h.window, {
    type: "sessions", cwd: alpha, activeId: active, dots: {}, offset: 0, total: 2, hasMore: false, query: "",
    entries: [row(active, alpha, "Current conversation"), row("other", alpha, "Untitled")],
  });
}

describe("chat panel pseudo-locale", () => {
  it("paints composer controls, the gear menu and effort strip during idle, running and queued states", () => {
    const h = chat();
    const { window, doc, posted } = h;
    dispatch(window, { type: "initialized", info: { provider: "grok", steeringSupported: true, init: {} } });
    session(h);
    dispatch(window, { type: "voiceState", configured: true });
    const toolbar = element(doc, ".composer-card");
    const input = element(doc, "#input") as HTMLTextAreaElement;
    const send = element(doc, "#send-btn");
    expect(input.placeholder).toBe(pseudo("Ask Grok…"));
    expect(send.title).toBe(pseudo("Send"));
    expectLocalized(toolbar);
    dispatch(window, { type: "voiceState", status: "listening" });
    expect(element(doc, "#mic-btn").title).toBe(pseudo("Listening — say 'grok send' to submit, or click to stop"));
    dispatch(window, { type: "voiceState", status: "idle" });

    click(window, element(doc, "#add-btn"));
    const add = element(doc, "#add-popover");
    expect(add.textContent).toContain(pseudo("Settings"));
    expectLocalized(add);

    click(window, element(doc, "#gear-btn"));
    const picker = element(doc, "#gear-popover");
    expect(picker.textContent).toContain(pseudo("Manage providers"));
    expect(picker.textContent).toContain(pseudo("Reset"));
    expectLocalized(picker);
    const high = element(picker, `[aria-label="${pseudo("High")}"]`);
    click(window, high);
    click(window, element(doc, "#gear-btn"));
    expect(posted).toContainEqual({ type: "setEffort", level: "high" });

    dispatch(window, { type: "setBusy", value: true });
    expect(send.title).toBe(pseudo("Stop"));
    expectLocalized(toolbar);
    input.value = "Queued user text";
    input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    expect(send.title).toBe(pseudo("Queue — sends when Grok finishes"));
    click(window, send);
    expect(posted).toContainEqual(expect.objectContaining({ type: "queueSend", text: "Queued user text" }));
    dispatch(window, { type: "queuedSends", items: ["Queued user text"] });
    expectLocalized(toolbar);
    const queued = element(doc, ".msg.queued");
    expectLocalized(queued);
    press(window, element(queued, ".queued-steer"));
    expect(posted).toContainEqual(expect.objectContaining({ type: "steerSend", text: "Queued user text" }));
  });

  it.each([
    ["grok", "Grok", ["agent", "plan", "yolo"]],
    ["codex", "Codex", ["agent", "askApproval", "plan", "yolo"]],
    ["agy", "Antigravity", ["auto", "plan", "yolo"]],
    ["muse", "Muse", ["yolo", "agent", "onRequest", "denyUnmatched"]],
  ])("translates the %s modes while posting the original mode id", (provider, name, modes) => {
    const h = chat();
    session(h, provider);
    dispatch(h.window, { type: "modeChanged", modeId: modes[0], modes,
      disabledModes: { [modes[1]]: "The host disabled this mode." } });
    expect(element(h.doc, "#input").getAttribute("placeholder")).toBe(pseudo(`Ask ${name}…`));
    const button = element(h.doc, "#mode-btn");
    expectLocalized(button);
    click(h.window, button);
    const menu = element(h.doc, "#mode-popover");
    const items = menu.querySelectorAll(".mode-popover-item");
    expect(items).toHaveLength(modes.length);
    expect(menu.querySelector(".mode-item-disabled-note")?.textContent).toBe("The host disabled this mode.");
    expectLocalized(menu);
    click(h.window, items[modes.length - 1]);
    expect(h.posted).toContainEqual({ type: "setMode", modeId: modes[modes.length - 1] });

    if (provider === "grok") {
      dispatch(h.window, { type: "modeChanged", modeId: "agent", modes });
      dispatch(h.window, { type: "planModeAvailability", available: false });
      click(h.window, button);
      expect(menu.querySelector(".mode-item-disabled-note")?.textContent).toBe(pseudo("Plan mode is unavailable."));
      expectLocalized(menu);
    }
  });

  it("paints the session menu, find bar and history and keeps a deleted session's name on the wire", async () => {
    const h = chat();
    session(h);
    catalog(h);
    const { window, doc, posted } = h;
    const action = element(doc, "#vscode-session-actions .rail-menu-btn");
    expectLocalized(action);
    click(window, action);
    const menu = element(doc, ".rail-menu");
    expect(menu.textContent).toContain(pseudo("Export conversation as Markdown"));
    expectLocalized(menu);
    const find = [...menu.querySelectorAll("button")].find((button) => button.textContent?.trim() === pseudo("Find in conversation"))!;
    click(window, find);
    expectLocalized(element(doc, "#find-bar"));
    click(window, element(doc, '[title="⟦Close find⟧"]'));

    const history = element(doc, "#history-btn");
    expectLocalized(history);
    click(window, history);
    catalog(h);
    const popover = element(doc, "#history-popover");
    expect(popover.textContent).toContain(pseudo("5m ago"));
    expectLocalized(popover);
    click(window, element(popover, '[data-session-id="other"] .history-action-danger'));
    const confirmation = element(doc, ".confirm-overlay");
    expect(confirmation.textContent).toContain(pseudo('Delete "Untitled"?'));
    expectLocalized(confirmation);
    click(window, element(confirmation, ".confirm-danger"));
    await Promise.resolve();
    expect(posted).toContainEqual({ type: "deleteSession", id: "other", name: "Untitled" });
  });

  it("paints message actions and translates the real host rewind dialog around the original preview", async () => {
    const { window, doc, posted } = chat();
    dispatch(window, { type: "userMessage", text: "First prompt" });
    dispatch(window, { type: "messageChunk", text: "Agent answer" });
    dispatch(window, { type: "promptComplete" });
    dispatch(window, { type: "userMessage", text: "Second prompt" });
    expect(element(doc, ".msg-rewind-btn").title).toBe(pseudo("Rewind to this message"));
    expect(element(doc, ".msg-edit-btn:not([hidden])").title).toBe(pseudo("Edit and send again"));
    for (const actions of doc.querySelectorAll<HTMLElement>(".msg-actions:not([hidden])")) expectLocalized(actions);
    expectLocalized(element(doc, "#scroll-bottom-btn"));
    expect(element(doc, "#prompt-prev-btn").title).toBe(pseudo("Previous prompt"));

    const body = rewindConfirmMessage({
      promptIndex: 0, promptPreview: "Keep <this> & the exact user copy.",
      createdAt: "", hasFileChanges: true, numFileSnapshots: 1,
    });
    dispatch(window, { type: "uiConfirmRequest", id: "rewind-1", title: "Rewind past this message?",
      body, confirmLabel: "Rewind", danger: true });
    const confirmation = element(doc, ".confirm-overlay");
    const paintedBody = element(confirmation, ".confirm-body");
    expect(paintedBody.textContent?.split("\n").filter(Boolean)).toEqual(
      body.split("\n").filter(Boolean).map((line) => line.startsWith('"') ? line : pseudo(line)),
    );
    expectLocalized(confirmation);
    click(window, element(confirmation, ".confirm-danger"));
    await Promise.resolve();
    expect(posted).toContainEqual({ type: "uiConfirmAnswer", id: "rewind-1", ok: true });
  });
});

describe("Projects webview pseudo-locale", () => {
  it("paints projects, recent sessions and archive, and preserves menu values", () => {
    const h = rail();
    const { window, doc, posted } = h;
    catalog(h);
    dispatch(window, { type: "pinnedSessions", entries: [], authoritative: true });
    dispatch(window, { type: "recentSessions", entries: [row(active, alpha, "Current conversation")] });
    const view = element(doc, "#projects-rail");
    for (const label of ["Recent", "Projects", "Project Archive", "Your IDE"]) {
      expect(view.textContent).toContain(pseudo(label));
    }
    expectLocalized(view);

    const project = () => element(view, '.rail-repo[data-cwd="/work/alpha"]');
    const projectActions = element(project(), `[title="${pseudo("Project actions")}"]`);
    click(window, projectActions);
    let menu = element(doc, ".rail-menu");
    expectLocalized(menu);
    const choose = (label: string) => {
      const button = [...menu.querySelectorAll("button")].find(
        (item) => item.textContent?.trim().startsWith(pseudo(label)),
      );
      expect(button, label).toBeDefined();
      click(window, button!);
    };
    choose("Set color");
    const colors = element(doc, ".rail-color-picker");
    expectLocalized(colors);
    click(window, element(colors, '[data-repo-color="blue"]'));
    expect(posted).toContainEqual({ type: "setRepoColor", cwd: alpha, color: "blue" });

    click(window, element(project(), `[title="${pseudo("Project actions")}"]`));
    menu = element(doc, ".rail-menu");
    choose("Set icon");
    const icons = element(doc, ".repo-icon-picker");
    expect(element(icons, '[data-group="shapes"]').textContent).toBe(pseudo("Shapes"));
    const search = element(icons, ".repo-icon-search") as HTMLInputElement;
    search.value = "Default folder";
    search.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    expect(icons.querySelectorAll(".repo-icon-cell:not([hidden])")).toHaveLength(1);
    expectLocalized(icons);
    search.value = pseudo("Default folder");
    search.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    expect(icons.querySelectorAll(".repo-icon-cell:not([hidden])")).toHaveLength(1);
    click(window, element(icons, ".repo-icon-cell.is-default"));

    click(window, element(project(), '[title="⟦Project actions⟧"]'));
    menu = element(doc, ".rail-menu");
    choose("Archive project");
    expect(posted).toContainEqual({ type: "setRepoArchived", cwd: alpha, archived: true });

    click(window, element(view, '[title="⟦Show archived projects⟧"]'));
    const archived = element(view, '.rail-archived [data-cwd="/work/archive"]');
    click(window, element(archived, '[title="⟦Project actions⟧"]'));
    menu = element(doc, ".rail-menu");
    expectLocalized(menu);
    choose("Move to Projects");
    expect(posted).toContainEqual({ type: "setRepoArchived", cwd: old, archived: false });

    const rowActions = element(view, `[data-session-id="other"] [title="${pseudo("Session actions")}"]`);
    click(window, rowActions);
    menu = element(doc, ".rail-menu");
    expectLocalized(menu);
    choose("Pin conversation");
    expect(posted).toContainEqual(expect.objectContaining({ type: "toggleSessionPin", id: "other" }));

    click(window, element(view, ".rail-add-project"));
    menu = element(doc, ".rail-menu");
    expectLocalized(menu);
    choose("New project");
    expectLocalized(element(doc, ".add-project-form"));
    click(window, element(doc, ".add-project-btn:not(.add-project-primary)"));

    const filter = element(view, "#rail-search") as HTMLInputElement;
    filter.value = "unmatched";
    filter.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    expect(view.textContent).toContain(pseudo("No matches."));
    expectLocalized(view);
  });

  it("finds the default icon by its translated label and its English source", () => {
    const label = "Standard mark";
    const h = rail({ ...strings, "Default folder": label });
    catalog(h);
    const { doc, window } = h;
    click(window, element(doc, '[data-cwd="/work/alpha"] [title="⟦Project actions⟧"]'));
    const item = [...element(doc, ".rail-menu").querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === pseudo("Set icon"))!;
    click(window, item);

    const icons = element(doc, ".repo-icon-picker");
    const search = element(icons, ".repo-icon-search") as HTMLInputElement;
    for (const query of [label, "Default folder"]) {
      search.value = query;
      search.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
      expect([...icons.querySelectorAll(".repo-icon-cell:not([hidden])")]).toEqual([
        element(icons, ".repo-icon-cell.is-default"),
      ]);
    }
  });
});
