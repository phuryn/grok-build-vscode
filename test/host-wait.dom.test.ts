import { afterEach, describe, expect, it, vi } from "vitest";
import { bootWebview, click, dispatch, type Harness, type Posted } from "./webview-harness";

const opened: Harness[] = [];
const sleepLink = (connection = 1) => ({ reachable: false, phase: "waking", since: Date.now(), restored: false, connection });
const upLink = (connection = 1) => ({ reachable: true, phase: "up", since: Date.now(), restored: true, connection });
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function boot(link: object | null = sleepLink()) {
  const h = bootWebview({ remote: true, beforeScripts: (win) => { (win as any).afkpilotHostLink = link; } });
  opened.push(h);
  dispatch(h.window, { type: "initialState", cwd: "/repo", appPurpose: "knowledge",
    capabilities: { browseProjectFiles: true, editProjectFiles: true, editProviderConfigFiles: true, gitChanges: true } });
  return h;
}
function link(h: Harness, value: object) {
  (h.window as any).afkpilotHostLink = value;
  dispatch(h.window, { type: "hostLink", link: value });
}
function requests(h: Harness, type: string) { return h.posted.filter((m) => m.type === type); }
function latest(h: Harness, type: string) {
  const value = requests(h, type).at(-1);
  expect(value, type).toBeTruthy();
  return value!;
}
function strip(h: Harness) { return h.doc.getElementById("host-wait-strip")!; }
function button(h: Harness, label: string, root: ParentNode = h.doc) {
  const el = [...root.querySelectorAll("button")].find((el) => el.textContent?.trim() === label || el.getAttribute("aria-label") === label);
  expect(el, label).toBeTruthy(); return el!;
}
function settings(h: Harness, category = "general") {
  (h.window as any).__grokFilePanelOpenSettings();
  const nav = h.doc.querySelector(`[data-category="${category}"]`);
  if (nav) click(h.window, nav);
}
function purpose(h: Harness, value: string) {
  const select = h.doc.querySelector('[data-id="appPurpose"] select') as HTMLSelectElement;
  expect(select).toBeTruthy(); select.value = value;
  select.dispatchEvent(new h.window.Event("change", { bubbles: true }) as never);
}
async function config(h: Harness, provider = "codex") {
  settings(h, "providers");
  const row = h.doc.querySelector('[data-id="providerConfigFiles"]')!;
  click(h.window, row.querySelector("summary")!);
  click(h.window, row.querySelector(`[data-provider="${provider}"]`)!);
  await settle();
  return latest(h, "readProviderConfig");
}
async function configReply(h: Harness, request: Posted, fields: Posted = {}) {
  const provider = request.provider as string;
  const relPath = provider === "claude" ? ".claude/settings.json" : `.${provider}/config.toml`;
  dispatch(h.window, { type: "providerConfigContent", provider, relPath, requestId: request.requestId,
    ok: true, kind: "text", text: "original = true", stamp: { mtimeMs: 1, size: 15 }, absPath: "/home/" + relPath, ...fields });
  await settle();
}
function expireResult(h: Harness) {
  const now = h.window.Date.now();
  vi.spyOn(h.window.Date, "now").mockReturnValue(now + 4000);
  // A shell event paints the clock too; no wall-clock sleeps in these tests.
  dispatch(h.window, { type: "hostLink", link: (h.window as any).afkpilotHostLink });
  expect(strip(h).hidden).toBe(true);
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const h of opened.splice(0)) await h.window.happyDOM.abort();
});

describe("one page-local waiting strip", () => {
  it("reads the snapshot at mount, opens a pending config tab, and lets the shell flush exactly once", async () => {
    const h = boot();
    const request = await config(h);
    expect(h.doc.querySelector('.gfp-tab[data-rel=".codex/config.toml"]')).toBeTruthy();
    expect(h.doc.querySelector(".gfp-viewer-body")?.textContent).toContain("Opening ~/.codex/config.toml");
    expect(strip(h).textContent).toContain("Waking your machine. Opening ~/.codex/config.toml");
    expect(strip(h).parentElement).toBe(h.doc.body);
    expect(strip(h).closest("#messages, #settings-overlay, .gfp-panel")).toBeNull();
    link(h, { ...upLink(), restored: false });
    expect(strip(h).textContent).toContain("Opening ~/.codex/config.toml");
    expect(strip(h).textContent).not.toContain("Waking");
    link(h, upLink());
    await settle();
    expect(requests(h, "readProviderConfig")).toHaveLength(1);
    await configReply(h, request);
    expect(h.doc.querySelector(".gfp-viewer-body")?.textContent).toContain("original = true");
    expect(strip(h).textContent).toBe("Opened ~/.codex/config.toml.");
    expireResult(h);
  });

  it("keeps a long wait pending, and describes the operation after wake rather than a boot failure", async () => {
    const h = boot();
    const request = await config(h);
    const now = h.window.Date.now();
    vi.spyOn(h.window.Date, "now").mockReturnValue(now + 64000);
    link(h, { ...sleepLink(), since: now });
    expect(strip(h).textContent).toContain("Still starting… 1:04 so far.");
    link(h, upLink());
    expect(strip(h).textContent).not.toContain("starting");
    await configReply(h, request, { ok: false, reason: "permission denied" });
    expect(strip(h).textContent).toContain("Couldn't open ~/.codex/config.toml.");
    expect(strip(h).textContent).not.toContain("Couldn't start");
    expect(button(h, "Try again", strip(h))).toBeTruthy();
  });

  it("retries a shell refusal without a path using fresh correlation and the original provider", async () => {
    const h = boot();
    const first = await config(h, "claude");
    dispatch(h.window, { type: "providerConfigContent", provider: "claude", requestId: first.requestId,
      ok: false, reason: "This page lost its connection. The view fills in when it reconnects." });
    await settle();
    link(h, upLink());
    await settle();
    const second = latest(h, "readProviderConfig");
    expect(requests(h, "readProviderConfig")).toHaveLength(2);
    expect(second.provider).toBe("claude");
    expect(second.requestId).not.toBe(first.requestId);
    await configReply(h, first, { text: "obsolete" });
    expect(h.doc.querySelector(".gfp-viewer-body")?.textContent).not.toContain("obsolete");
    await configReply(h, second);
    expect(h.doc.querySelector(".gfp-viewer-body")?.textContent).toContain("original = true");
  });

  it("retries a live read lost with its socket, but does not duplicate a shell-held read", async () => {
    const h = boot(upLink());
    const first = await config(h);
    link(h, sleepLink());
    link(h, { ...upLink(), restored: false });
    expect(requests(h, "readProviderConfig")).toHaveLength(1);
    link(h, upLink()); await settle();
    const next = latest(h, "readProviderConfig");
    expect(next.requestId).not.toBe(first.requestId);
    await configReply(h, first, { text: "obsolete" });
    await configReply(h, next);
    expect(strip(h).textContent).toContain("Opened");
  });

  it.each(["tab", "panel"])("stops a pending read when its %s closes and ignores late success", async (what) => {
    const h = boot();
    const request = await config(h);
    const close = h.doc.querySelector(what === "tab" ? "#provider-config-panel .gfp-tab-close" : "#provider-config-panel .gfp-close");
    expect(close).toBeTruthy(); click(h.window, close!);
    await settle();
    link(h, upLink()); await settle();
    expect(requests(h, "readProviderConfig")).toHaveLength(1);
    await configReply(h, request, { text: "late" });
    expect(strip(h).hidden).toBe(true);
    if (what === "tab") expect(h.doc.querySelector("#provider-config-panel .gfp-tab")).toBeNull();
    else expect((h.doc.getElementById("provider-config-panel") as HTMLElement).hidden).toBe(true);
  });

  it("keeps a failed file retryable and replaces it on reconnect without another tap", async () => {
    const h = boot(upLink());
    const request = await config(h);
    await configReply(h, request, { ok: false, reason: "permission denied" });
    expect(button(h, "Try again", h.doc.querySelector(".gfp-viewer-body")!)).toBeTruthy();
    link(h, sleepLink()); link(h, upLink()); await settle();
    const next = latest(h, "readProviderConfig");
    expect(next.requestId).not.toBe(request.requestId);
    await configReply(h, next);
    expect(h.doc.querySelector(".gfp-viewer-body")?.textContent).toContain("original = true");
    expect(strip(h).textContent).toBe("Opened ~/.codex/config.toml.");
  });

  it("shows an offline setting as pending, coalesces it, and waits for the right host field and value", async () => {
    const h = boot(); settings(h);
    purpose(h, "coding");
    expect((h.doc.querySelector('[data-id="appPurpose"] select') as HTMLSelectElement).value).toBe("knowledge");
    expect(h.doc.querySelector('[data-id="appPurpose"]')?.getAttribute("aria-busy")).toBe("true");
    expect(strip(h).textContent).toContain("Setting this app to Coding");
    expect(requests(h, "setAppPurpose")).toHaveLength(0);
    purpose(h, "knowledge"); purpose(h, "coding");
    link(h, upLink());
    expect(requests(h, "setAppPurpose")).toEqual([{ type: "setAppPurpose", value: "coding" }]);
    dispatch(h.window, { type: "thumbsFeedback", value: true });
    expect(strip(h).dataset.state).toBe("pending");
    dispatch(h.window, { type: "appPurpose", value: "coding" });
    expect(strip(h).textContent).toBe("Set this app to Coding.");
    expect((h.doc.querySelector('[data-id="appPurpose"] select') as HTMLSelectElement).value).toBe("coding");
    expect(h.doc.querySelector('[data-id="appPurpose"]')?.hasAttribute("aria-busy")).toBe(false);
    expireResult(h);
  });

  it("does not replay a possibly-applied preference over a newer desk value", () => {
    const h = boot(upLink()); settings(h); purpose(h, "coding");
    link(h, sleepLink());
    link(h, { ...upLink(), restored: false });
    dispatch(h.window, { type: "initialState", cwd: "/repo", appPurpose: "knowledge" });
    link(h, upLink());
    expect(requests(h, "setAppPurpose")).toHaveLength(1);
    expect(strip(h).textContent).toContain("Your change is not confirmed");
    expect((h.doc.querySelector('[data-id="appPurpose"] select') as HTMLSelectElement).value).toBe("knowledge");
    click(h.window, button(h, "Try again", strip(h)));
    expect(requests(h, "setAppPurpose")).toHaveLength(2);
  });

  it("does not make silence a preference success, including on an old host", () => {
    const h = boot(upLink()); settings(h); purpose(h, "coding");
    const now = h.window.Date.now(); vi.spyOn(h.window.Date, "now").mockReturnValue(now + 120000);
    link(h, upLink());
    expect(strip(h).dataset.state).toBe("pending");
    expect(strip(h).textContent).toContain("Waiting for confirmation");
    expect(requests(h, "setAppPurpose")).toHaveLength(1);
  });

  it("keeps the strip interactive when Settings mounts over an existing wait", async () => {
    const h = boot(); await config(h); settings(h);
    expect(strip(h).hasAttribute("inert")).toBe(false);
    expect(strip(h).getAttribute("aria-hidden")).not.toBe("true");
    expect(h.doc.getElementById("settings-overlay")).toBeTruthy();
  });

  it("keeps automatic Changes reads quiet but joins them when the person opens Changes", async () => {
    const h = boot(); await settle();
    expect(h.doc.getElementById("host-wait-strip")).toBeNull();
    const before = requests(h, "gitStatus").length;
    click(h.window, h.doc.querySelector(".gfp-changes-btn")!);
    expect(strip(h).textContent).toContain("Reading what changed");
    expect(requests(h, "gitStatus")).toHaveLength(before);
    link(h, upLink()); await settle();
    const request = latest(h, "gitStatus");
    dispatch(h.window, { type: "gitStatusResult", cwd: "/repo", requestId: request.requestId, ok: true,
      snapshot: { branch: "main", files: [] } });
    await settle();
    expect(strip(h).textContent).toBe("Changes loaded."); expireResult(h);
  });

  it("tracks a sleeping chat send until its own host echo, without replaying it", () => {
    const h = boot();
    dispatch(h.window, { type: "setBusy", value: false });
    const input = h.doc.getElementById("input") as HTMLTextAreaElement;
    input.value = "my message"; click(h.window, h.doc.getElementById("send-btn")!);
    const request = latest(h, "send");
    expect(strip(h).textContent).toContain("Sending your message");
    link(h, upLink());
    dispatch(h.window, { type: "userMessage", text: "another device", submissionId: "someone-else" });
    expect(strip(h).dataset.state).toBe("pending");
    dispatch(h.window, { type: "userMessage", text: "my message", submissionId: request.submissionId });
    expect(strip(h).textContent).toBe("Message sent.");
    expect(requests(h, "send")).toHaveLength(1); expireResult(h);
  });

  it("tracks a config save through a quiet machine without replaying bytes or losing edits", async () => {
    const h = boot(upLink()); const read = await config(h); await configReply(h, read);
    click(h.window, h.doc.querySelector("#provider-config-panel .gfp-edit")!);
    const editor = h.doc.querySelector(".gfp-editor") as HTMLTextAreaElement;
    editor.value = "edited = true"; editor.dispatchEvent(new h.window.Event("input", { bubbles: true }) as never);
    click(h.window, button(h, "Save", h.doc.getElementById("provider-config-panel")!));
    const write = latest(h, "writeProviderConfig");
    link(h, sleepLink());
    expect(strip(h).textContent).toContain("Waking your machine. Saving ~/.codex/config.toml");
    link(h, upLink()); await settle();
    expect(requests(h, "writeProviderConfig")).toHaveLength(1);
    dispatch(h.window, { type: "providerConfigWriteResult", provider: "codex", relPath: ".codex/config.toml", requestId: write.requestId,
      ok: true, stamp: { mtimeMs: 2, size: 13 }, absPath: "/home/.codex/config.toml" });
    await settle();
    expect(strip(h).textContent).toBe("Saved ~/.codex/config.toml."); expireResult(h);
  });

  it("ends a save whose socket was replaced, instead of waiting for an answer that cannot arrive", async () => {
    // The relay addresses a host's reply to the client id that asked, and a
    // reconnecting tab is issued a new one -- so this write is not slow, it is
    // unanswerable. Waiting leaves "Saving…" on screen for as long as the tab
    // stays open, on the one view whose job is to say whether the work is
    // saved. Replaying it is the other wrong answer: the bytes may already be
    // on disk. Say so once and let the person decide.
    const h = boot(upLink(1)); const read = await config(h); await configReply(h, read);
    click(h.window, h.doc.querySelector("#provider-config-panel .gfp-edit")!);
    const editor = h.doc.querySelector(".gfp-editor") as HTMLTextAreaElement;
    editor.value = "edited = true"; editor.dispatchEvent(new h.window.Event("input", { bubbles: true }) as never);
    click(h.window, button(h, "Save", h.doc.getElementById("provider-config-panel")!));
    expect(requests(h, "writeProviderConfig")).toHaveLength(1);
    link(h, sleepLink(1));
    link(h, upLink(2));
    await settle();
    expect(strip(h).dataset.state).toBe("failure");
    expect(strip(h).textContent).toContain("Couldn't save ~/.codex/config.toml.");
    expect(strip(h).textContent).toContain("may already have been applied");
    expect(requests(h, "writeProviderConfig")).toHaveLength(1);
    expect((h.doc.querySelector(".gfp-editor") as HTMLTextAreaElement).value).toBe("edited = true");
    click(h.window, button(h, "Try again", strip(h)));
    expect(latest(h, "writeProviderConfig").text).toBe("edited = true");
  });

  it("leaves a read alone when the socket is replaced -- asking twice costs nothing, saving twice does not", async () => {
    const h = boot(upLink(1)); const first = await config(h);
    link(h, sleepLink(1));
    link(h, upLink(2)); await settle();
    const next = latest(h, "readProviderConfig");
    expect(requests(h, "readProviderConfig")).toHaveLength(2);
    expect(next.requestId).not.toBe(first.requestId);
    await configReply(h, next);
    expect(strip(h).textContent).toBe("Opened ~/.codex/config.toml.");
  });

  it("never mounts the strip without the global capability", async () => {
    const h = boot(null);
    delete (h.window as any).afkpilotHostLink;
    const request = await config(h); await configReply(h, request);
    expect(h.doc.getElementById("host-wait-strip")).toBeNull();
  });

  it("preserves a dirty draft across reconnect but refreshes an untouched missing-file draft", async () => {
    const h = boot(upLink()); let request = await config(h);
    await configReply(h, request, { ok: false, reason: "not found", text: "", absPath: "/home/.codex/config.toml" });
    link(h, sleepLink()); link(h, upLink()); await settle();
    expect(requests(h, "readProviderConfig")).toHaveLength(2);
    request = latest(h, "readProviderConfig"); await configReply(h, request);
    click(h.window, h.doc.querySelector(".gfp-edit")!);
    const editor = h.doc.querySelector(".gfp-editor") as HTMLTextAreaElement;
    editor.value = "keep these words"; editor.dispatchEvent(new h.window.Event("input", { bubbles: true }) as never);
    link(h, sleepLink()); link(h, upLink()); await settle();
    expect(requests(h, "readProviderConfig")).toHaveLength(2);
    expect((h.doc.querySelector(".gfp-editor") as HTMLTextAreaElement).value).toBe("keep these words");
  });

  it("refuses an offline save explicitly, keeps the buffer, and never automatically sends it later", async () => {
    const h = boot(upLink()); const request = await config(h); await configReply(h, request);
    click(h.window, h.doc.querySelector(".gfp-edit")!);
    const editor = h.doc.querySelector(".gfp-editor") as HTMLTextAreaElement;
    editor.value = "offline edit"; editor.dispatchEvent(new h.window.Event("input", { bubbles: true }) as never);
    link(h, sleepLink());
    click(h.window, button(h, "Save", h.doc.getElementById("provider-config-panel")!));
    expect(strip(h).textContent).toContain("Waking your machine. Saving ~/.codex/config.toml");
    await settle();
    expect(strip(h).textContent).toContain("Couldn't save ~/.codex/config.toml.");
    expect((h.doc.querySelector(".gfp-editor") as HTMLTextAreaElement).value).toBe("offline edit");
    link(h, upLink()); await settle();
    expect(requests(h, "writeProviderConfig")).toHaveLength(0);
    click(h.window, button(h, "Try again", strip(h)));
    expect(latest(h, "writeProviderConfig").text).toBe("offline edit");
  });

  it("retains a routine pause and reconciles the right routine's paused field", () => {
    const h = boot();
    const routine = { id: "r1", title: "Brief", prompt: "Read changes", cwd: "/repo", provider: "grok", model: "grok-build",
      cadence: { every: 6, unit: "hours" }, createdAt: 1, paused: false, runs: [], nextRunAt: Date.now() + 100000 };
    dispatch(h.window, { type: "routines", entries: [routine], projects: [], models: [] });
    settings(h, "routines");
    click(h.window, h.doc.querySelector(".settings-routine-toggle")!);
    click(h.window, h.doc.querySelector(".settings-routine-pause")!);
    expect(requests(h, "setRoutinePaused")).toHaveLength(0);
    expect(strip(h).textContent).toContain("Setting routine r1 to paused");
    link(h, upLink());
    expect(latest(h, "setRoutinePaused")).toEqual({ type: "setRoutinePaused", id: "r1", paused: true });
    dispatch(h.window, { type: "routines", entries: [{ ...routine, id: "r2", paused: true }] });
    expect(strip(h).dataset.state).toBe("pending");
    dispatch(h.window, { type: "routines", entries: [{ ...routine, paused: true }] });
    expect(strip(h).dataset.state).toBe("success");
  });

  it("does not auto-retry mode, model or effort selections after waking", () => {
    const h = boot();
    dispatch(h.window, { type: "session", sessionId: "s1", currentModelId: "grok-build", models: [
      { modelId: "grok-build", name: "Grok Build", reasoningEfforts: ["low", "high"] },
      { modelId: "another-model", name: "Another model" },
    ] });
    dispatch(h.window, { type: "setBusy", value: false });
    click(h.window, h.doc.getElementById("mode-btn")!);
    const mode = [...h.doc.querySelectorAll(".mode-popover-item")].find((el) => el.textContent?.includes("Auto accept"));
    click(h.window, mode!);
    expect(latest(h, "setMode").modeId).toBe("yolo");
    click(h.window, h.doc.getElementById("gear-btn")!);
    click(h.window, h.doc.querySelector(".effort-dot")!);
    expect(requests(h, "setEffort")).toHaveLength(1);
    click(h.window, h.doc.querySelector(".model-name-btn")!);
    const model = [...h.doc.querySelectorAll(".toolbar-popover-item")].find((el) => el.getAttribute("title") === "another-model");
    click(h.window, model!);
    expect(requests(h, "setModel")).toHaveLength(1);
    link(h, upLink()); link(h, sleepLink()); link(h, upLink());
    for (const type of ["setMode", "setModel", "setEffort"]) expect(requests(h, type)).toHaveLength(1);
  });

  it("coalesces project colour and archive intentions separately and confirms only the named repo", () => {
    const h = boot();
    const rail = h.doc.createElement("aside"); rail.id = "projects-rail"; h.doc.body.appendChild(rail);
    const entries = [{ cwd: "/repo", label: "Project", available: true, pinned: false, updatedAt: Date.now(), archived: false, color: "" }];
    const repos = (rows = entries) => dispatch(h.window, { type: "repos", entries: rows, selectedCwd: "/repo", activeCwd: "/repo" });
    repos();
    const menu = (label: string) => {
      click(h.window, h.doc.querySelector(".rail-repo-head .rail-menu-btn")!);
      const item = [...h.doc.querySelectorAll(".rail-menu-item")].find((el) => el.textContent?.includes(label));
      expect(item).toBeTruthy(); click(h.window, item!);
    };
    menu("Set color"); click(h.window, h.doc.querySelector('.rail-color-swatch[data-repo-color="blue"]')!);
    menu("Set color"); click(h.window, h.doc.querySelector('.rail-color-swatch[data-repo-color="teal"]')!);
    expect(h.doc.querySelector(".rail-twisty")?.getAttribute("data-repo-color")).toBeNull();
    menu("Archive project");
    expect(requests(h, "setRepoColor")).toHaveLength(0);
    expect(requests(h, "setRepoArchived")).toHaveLength(0);
    link(h, upLink());
    expect(requests(h, "setRepoColor")).toEqual([{ type: "setRepoColor", cwd: "/repo", color: "teal" }]);
    expect(requests(h, "setRepoArchived")).toEqual([{ type: "setRepoArchived", cwd: "/repo", archived: true }]);
    repos([{ ...entries[0], cwd: "/unrelated", color: "teal", archived: true }]);
    expect(strip(h).dataset.state).toBe("pending");
    repos([{ ...entries[0], color: "teal", archived: true }]);
    expect(strip(h).dataset.state).toBe("success");
  });

  it("shows a busy-session send until the host actually holds that contribution", () => {
    const h = boot();
    dispatch(h.window, { type: "session", sessionId: "s1", models: [] });
    dispatch(h.window, { type: "setBusy", value: true });
    const input = h.doc.getElementById("input") as HTMLTextAreaElement;
    input.value = "next thing"; click(h.window, h.doc.getElementById("send-btn")!);
    expect(latest(h, "queueSend").text).toBe("next thing");
    expect(strip(h).textContent).toContain("Sending your message");
    link(h, upLink());
    dispatch(h.window, { type: "queuedSends", items: ["unrelated"] });
    expect(strip(h).dataset.state).toBe("pending");
    dispatch(h.window, { type: "queuedSends", items: ["next thing"] });
    expect(strip(h).textContent).toBe("Message queued.");
    expect(requests(h, "queueSend")).toHaveLength(1);
  });

  it("cancels a superseded diff read and does not reissue it on reconnect", async () => {
    const h = boot(upLink()); await settle();
    const status = latest(h, "gitStatus");
    dispatch(h.window, { type: "gitStatusResult", cwd: "/repo", requestId: status.requestId, ok: true,
      snapshot: { branch: "main", files: [{ path: "a.ts", status: "M", added: 1, deleted: 0 }] } });
    await settle(); click(h.window, h.doc.querySelector(".gfp-changes-btn")!);
    const row = h.doc.querySelector('.gfp-change-row');
    expect(row).toBeTruthy(); click(h.window, row!); await settle();
    expect(requests(h, "gitFileDiff")).toHaveLength(1);
    const back = h.doc.querySelector('.gfp-changes-back');
    expect(back).toBeTruthy(); click(h.window, back!); await settle();
    link(h, sleepLink()); link(h, upLink()); await settle();
    expect(requests(h, "gitFileDiff")).toHaveLength(1);
  });
});
