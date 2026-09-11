import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch, type Harness, type Posted } from "./webview-harness";

async function settle() {
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function button(h: Harness, text: string, root: ParentNode = h.doc): HTMLButtonElement {
  const found = [...root.querySelectorAll("button")].find((el) => el.textContent?.trim() === text || el.getAttribute("aria-label") === text);
  expect(found, text).toBeTruthy();
  return found as HTMLButtonElement;
}

const surfaces = ["vscode", "desktop", "remote", "phone"] as const;
const mounts = new WeakMap<Harness, { surface: typeof surfaces[number]; capabilities: Record<string, boolean> }>();
function boot(surface: typeof surfaces[number], capabilities: Record<string, boolean>): Harness {
  const h = bootWebview({
    remote: surface === "remote" || surface === "phone", vscode: surface === "vscode",
    beforeScripts: (win) => {
      if (surface === "phone") Object.defineProperty(win, "innerWidth", { value: 390 });
      if (surface !== "vscode") {
        const rail = win.document.createElement("aside");
        rail.id = "projects-rail";
        rail.innerHTML = '<div class="rail-foot"></div>';
        win.document.body.appendChild(rail);
      }
    },
  });
  dispatch(h.window, { type: "initialState", cwd: "/repo", capabilities: { settingsEditor: surface === "vscode", ...capabilities } });
  dispatch(h.window, { type: "providerState", providers: [{ id: "grok", connected: true }, { id: "codex", connected: true }, { id: "claude", connected: true }] });
  if (surface !== "vscode") dispatch(h.window, { type: "repos", entries: [{ cwd: "/repo", label: "Project", available: true }], selectedCwd: "/repo", activeCwd: "/repo" });
  mounts.set(h, { surface, capabilities });
  return h;
}

function session(h: Harness, provider = "grok", id = "session-1") {
  dispatch(h.window, { type: "session", provider, sessionId: id, models: [] });
  dispatch(h.window, { type: "sessionName", sessionId: id, name: "Current", cwd: "/repo" });
  dispatch(h.window, { type: "setBusy", value: false });
}

function settings(h: Harness) {
  const { surface, capabilities } = mounts.get(h)!;
  click(h.window, (h.doc.getElementById("rail-gear-btn") || h.doc.getElementById("gear-btn"))!);
  expect(h.doc.getElementById("gear-popover")?.textContent).not.toContain("Provider config files");
  const entry = [...h.doc.querySelectorAll(".toolbar-popover-item")].find((el) => el.textContent === "Settings");
  expect(entry).toBeTruthy();
  click(h.window, entry!);
  if (surface === "vscode") {
    expect(h.posted).toContainEqual({ type: "openSettingsSurface" });
    // The separate webview loads settings.js without chat.js or an onLocal callback.
    const container = h.doc.createElement("div");
    container.id = "standalone-settings";
    h.doc.body.appendChild(container);
    (h.window as any).GrokSettings.mount(container, {
      standalone: true, category: "providers", env: { hostCaps: capabilities },
      post: (message: Posted) => h.posted.push(message),
    });
  } else {
    const nav = h.doc.querySelector('[data-category="providers"]');
    expect(nav).toBeTruthy();
    click(h.window, nav!);
  }
  return h.doc.getElementById(surface === "vscode" ? "standalone-settings" : "settings-overlay")!;
}

async function open(h: Harness) {
  const root = settings(h);
  const configs = root.querySelector('[data-id="providerConfigFiles"]')!;
  expect(configs).toBeTruthy();
  click(h.window, configs.querySelector("summary")!);
  click(h.window, configs.querySelector('[data-provider="grok"]')!);
  await settle();
}

function latest(h: Harness, type: string): Posted {
  const message = h.posted.filter((m) => m.type === type).at(-1);
  expect(message, type).toBeTruthy();
  return message!;
}

async function read(h: Harness, provider = "grok", relPath = ".grok/config.toml") {
  if (provider !== "grok") {
    const row = [...h.doc.querySelectorAll("#provider-config-panel .gfp-row")].find((el) => el.textContent?.includes("~/" + relPath));
    expect(row).toBeTruthy();
    click(h.window, row!);
  }
  await settle();
  const request = latest(h, "readProviderConfig");
  expect(request).toMatchObject({ provider });
  expect(request).not.toHaveProperty("cwd");
  expect(request).not.toHaveProperty("relPath");
  dispatch(h.window, { type: "providerConfigContent", provider, relPath, requestId: request.requestId,
    ok: true, kind: "text", text: "original = true\n", stamp: { mtimeMs: 1, size: 16 }, absPath: "/home/user/" + relPath });
  await settle();
}

describe.each(surfaces)("provider config files on %s", (surface) => {
  it("offers no entry point to an old host, even if project editing works", () => {
    const h = boot(surface, { browseProjectFiles: true, editProjectFiles: true });
    expect(settings(h).querySelector('[data-id="providerConfigFiles"]')).toBeNull();
    expect(h.doc.getElementById("provider-config-panel")).toBeNull();
    expect(h.posted.some((m) => /ProviderConfig/.test(m.type))).toBe(false);
    h.window.happyDOM.abort();
  });

  it("puts the three paths last in Providers and removes only the global Advanced row", () => {
    const h = boot(surface, { editProjectFiles: true, editProviderConfigFiles: true });
    const root = settings(h);
    const rows = [...root.querySelectorAll(".settings-row")];
    expect(rows.at(-1)?.getAttribute("data-id")).toBe("providerConfigFiles");
    const configs = rows.at(-1)!;
    click(h.window, configs.querySelector("summary")!);
    expect(configs.getAttribute("open")).not.toBeNull();
    expect([...configs.querySelectorAll(".settings-row-desc")].map((el) => el.textContent)).toEqual([
      "~/.grok/config.toml", "~/.codex/config.toml", "~/.claude/settings.json",
    ]);
    click(h.window, root.querySelector('[data-category="advanced"]')!);
    expect(root.textContent).not.toContain("Open global config");
    expect(!!root.querySelector('[data-id="openProjectConfig"]')).toBe(surface === "vscode" || surface === "desktop");
    h.window.happyDOM.abort();
  });

  it("routes each native row to the editor, and overlay rows to the shared panel", async () => {
    const h = boot(surface, { editProjectFiles: true, editProviderConfigFiles: true });
    session(h);
    if (surface === "vscode") {
      const root = settings(h);
      h.posted.length = 0;
      for (const provider of ["grok", "codex", "claude"]) click(h.window, root.querySelector(`[data-provider="${provider}"]`)!);
      expect(h.posted).toEqual(["grok", "codex", "claude"].map((provider) => ({ type: "openProviderConfig", provider })));
      expect(h.doc.getElementById("provider-config-panel")).toBeNull();
      h.window.happyDOM.abort();
      return;
    }
    await open(h);
    expect(h.doc.querySelectorAll("#provider-config-panel .gfp-row")).toHaveLength(3);
    expect(h.posted.some((m) => ["openProviderConfig", "openSettingsSurface", "listProjectDir", "readProjectFile", "writeProjectFile"].includes(m.type))).toBe(false);
    await read(h);
    const panel = h.doc.getElementById("provider-config-panel")!;
    expect(panel.textContent).toContain("reads this file at startup");
    expect(panel.textContent).toContain("Saved changes apply after restarting a session");
    click(h.window, button(h, "Edit file", panel));
    const editor = panel.querySelector("textarea")!;
    editor.value = "edited = true\n";
    editor.dispatchEvent(new (h.window as any).Event("input", { bubbles: true }));
    expect(button(h, "Restart current Grok session", panel).disabled).toBe(true);
    click(h.window, button(h, "Save", panel));
    await settle();
    const save = latest(h, "writeProviderConfig");
    expect(save).toEqual({ type: "writeProviderConfig", provider: "grok", text: "edited = true\n",
      stamp: { mtimeMs: 1, size: 16 }, expectedAbsPath: "/home/user/.grok/config.toml", requestId: expect.any(String) });
    dispatch(h.window, { type: "providerConfigWriteResult", provider: "grok", relPath: ".grok/config.toml", requestId: save.requestId,
      ok: true, stamp: { mtimeMs: 2, size: 14 } });
    await settle();
    expect(h.posted.some((m) => m.type === "restartProviderSession")).toBe(false);
    expect(button(h, "Restart current Grok session", panel).disabled).toBe(false);
    click(h.window, button(h, "Restart current Grok session", panel));
    expect(latest(h, "restartProviderSession")).toEqual({ type: "restartProviderSession", provider: "grok", sessionId: "session-1" });
    expect(panel.hidden).toBe(true); // Show the conversation's restart progress/errors.
    h.window.happyDOM.abort();
  });
});

describe("config editor decisions", () => {
  it("is a layer Back can close, and ANNOUNCES itself so the page takes an entry", async () => {
    // The layer list used to NAME the panels it knew about, and this editor
    // shipped in the same release without being added to it. Back saw nothing
    // open, let the navigation stand, and left the conversation -- with the
    // config file's unsaved edits going with the document. The same hole that
    // was closed for the image lightbox one commit earlier, on the overlay
    // this release added.
    //
    // Both halves are asserted, because counting alone would not have fixed
    // it: the shell holds one history entry PER OPEN LAYER and takes it when
    // the `afkpilot-layers` event tells it to. A panel that opens silently has
    // no entry to spend, so Back walks off the page however correct the count.
    const h = boot("phone", { editProjectFiles: true, editProviderConfigFiles: true });
    const layers = (h.window as any).afkpilotLayers;
    const announced: number[] = [];
    h.window.addEventListener("afkpilot-layers", () => announced.push(layers.depth));
    await open(h);
    const panel = h.doc.getElementById("provider-config-panel")!;
    expect(panel.hidden).toBe(false);
    expect(layers.depth).toBe(1);
    expect(announced.at(-1)).toBe(1);
    expect(layers.dismissTop()).toBe(true);
    expect(panel.hidden).toBe(true);
    expect(layers.depth).toBe(0);
    expect(announced.at(-1)).toBe(0);
    h.window.happyDOM.abort();
  });

  it("counts a second overlay rather than hiding it behind the first", async () => {
    // Project files open, then Settings raises the config editor over them. Two
    // overlays, so two entries: one Back may not close both, or the person
    // loses a panel they never dismissed.
    const h = boot("phone", { browseProjectFiles: true, editProjectFiles: true, editProviderConfigFiles: true });
    click(h.window, h.doc.getElementById("files-browse-btn")!);
    expect((h.window as any).afkpilotLayers.depth).toBe(1);
    await open(h);
    const layers = (h.window as any).afkpilotLayers;
    expect(layers.depth).toBe(2);
    expect(layers.dismissTop()).toBe(true);
    expect(layers.depth).toBe(1);
    expect(h.doc.getElementById("files-browse-panel")?.hidden).toBe(false);
    h.window.happyDOM.abort();
  });

  it("uses the browser panel even when the connected host advertises a VS Code editor", async () => {
    const h = boot("remote", { settingsEditor: true, editProjectFiles: true, editProviderConfigFiles: true });
    await open(h);
    expect(h.doc.getElementById("provider-config-panel")).toBeTruthy();
    expect(h.posted.some((m) => m.type === "openProviderConfig" || m.type === "openSettingsSurface")).toBe(false);
    expect(latest(h, "readProviderConfig")).toMatchObject({ provider: "grok" });
    h.window.happyDOM.abort();
  });

  it.each([
    ["grok", ".grok/config.toml", "# Grok global configuration\n"],
    ["codex", ".codex/config.toml", ""],
    ["claude", ".claude/settings.json", "{}"],
  ].flatMap(([provider, relPath, stub]) => [true, false].map((withPath) => ({ provider, relPath, stub, withPath }))))(
    "opens a missing $provider config as an editable draft only with the host path (path=$withPath)", async ({ provider, relPath, stub, withPath }) => {
    const h = boot("remote", { editProjectFiles: true, editProviderConfigFiles: true });
    await open(h);
    if (provider !== "grok") {
      const row = [...h.doc.querySelectorAll("#provider-config-panel .gfp-row")].find((el) => el.textContent?.includes("~/" + relPath));
      click(h.window, row!);
      await settle();
    }
    const request = latest(h, "readProviderConfig");
    dispatch(h.window, { type: "providerConfigContent", provider, relPath, requestId: request.requestId,
      ok: false, reason: "not found", ...(withPath ? { absPath: "/home/user/" + relPath, text: stub } : {}) });
    await settle();
    const panel = h.doc.getElementById("provider-config-panel")!;
    const editor = panel.querySelector("textarea");
    if (withPath) {
      expect(editor).toBeTruthy();
      expect(editor!.readOnly).toBe(false);
      expect(editor!.value).toBe(stub);
      expect(panel.textContent).toContain("This file does not exist yet. Save to create it.");
      expect(button(h, "Save", panel).disabled).toBe(false);
      click(h.window, button(h, "Save", panel));
      await settle();
      const save = latest(h, "writeProviderConfig");
      expect(save).toMatchObject({ text: editor!.value, stamp: { mtimeMs: 0, size: -1 }, expectedAbsPath: "/home/user/" + relPath });
      dispatch(h.window, { type: "providerConfigWriteResult", provider, relPath, requestId: save.requestId,
        ok: true, stamp: { mtimeMs: 2, size: 28 } });
      await settle();
      expect(panel.textContent).not.toContain("does not exist yet");
      expect(button(h, "Save", panel).disabled).toBe(true);
    } else {
      expect(editor).toBeNull();
      expect(panel.textContent).toContain("not found");
      expect(h.posted.some((m) => m.type === "writeProviderConfig")).toBe(false);
    }
    h.window.happyDOM.abort();
  });

  it("requires the existing file edit gate as well as the new capability", () => {
    const h = boot("remote", { editProviderConfigFiles: true });
    expect(settings(h).querySelector('[data-id="providerConfigFiles"]')).toBeNull();
    h.window.happyDOM.abort();
  });

  it.each([ ["grok", ".grok/config.toml", "Grok"], ["codex", ".codex/config.toml", "Codex"], ["claude", ".claude/settings.json", "Claude"] ])(
    "only offers restart for the current idle %s conversation", async (provider, relPath, name) => {
      const h = boot("desktop", { editProjectFiles: true, editProviderConfigFiles: true });
      session(h, provider, "same-session");
      await open(h);
      await read(h, provider, relPath);
      const label = "Restart current " + name + " session";
      expect(button(h, label).disabled).toBe(false);
      dispatch(h.window, { type: "setBusy", value: true });
      expect(button(h, label).disabled).toBe(true);
      session(h, provider === "grok" ? "codex" : "grok", "other-session");
      expect(button(h, label).disabled).toBe(true);
      expect(h.doc.getElementById("provider-config-panel")?.textContent).toContain("Open a " + name + " conversation to restart it.");
      expect(h.posted.some((m) => m.type === "restartProviderSession")).toBe(false);
      h.window.happyDOM.abort();
    },
  );

  it("keeps a draft on stale-stamp refusal and rejects replies for another provider", async () => {
    const h = boot("remote", { editProjectFiles: true, editProviderConfigFiles: true });
    await open(h);
    await read(h);
    click(h.window, button(h, "Edit file"));
    const editor = h.doc.querySelector("#provider-config-panel textarea") as HTMLTextAreaElement;
    editor.value = "my draft";
    editor.dispatchEvent(new (h.window as any).Event("input", { bubbles: true }));
    click(h.window, button(h, "Save"));
    await settle();
    const request = latest(h, "writeProviderConfig");
    const response = { type: "providerConfigWriteResult", requestId: request.requestId, relPath: ".grok/config.toml", ok: false, reason: "changed" };
    dispatch(h.window, { ...response, provider: "codex" });
    await settle();
    expect(h.doc.getElementById("provider-config-panel")?.textContent).not.toContain("File changed on disk");
    dispatch(h.window, { ...response, provider: "grok" });
    await settle();
    expect((h.doc.querySelector("#provider-config-panel textarea") as HTMLTextAreaElement).value).toBe("my draft");
    expect(h.doc.getElementById("provider-config-panel")?.textContent).toContain("File changed on disk");
    expect(button(h, "Reload")).toBeTruthy();
    expect(button(h, "Overwrite")).toBeTruthy();
    h.window.happyDOM.abort();
  });
});
