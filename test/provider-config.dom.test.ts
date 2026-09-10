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
  if (surface !== "vscode") dispatch(h.window, { type: "repos", entries: [{ cwd: "/repo", label: "Project", available: true }], selectedCwd: "/repo", activeCwd: "/repo" });
  return h;
}

function session(h: Harness, provider = "grok", id = "session-1") {
  dispatch(h.window, { type: "session", provider, sessionId: id, models: [] });
  dispatch(h.window, { type: "sessionName", sessionId: id, name: "Current", cwd: "/repo" });
  dispatch(h.window, { type: "setBusy", value: false });
}

async function open(h: Harness) {
  click(h.window, (h.doc.getElementById("rail-gear-btn") || h.doc.getElementById("gear-btn"))!);
  const entry = [...h.doc.querySelectorAll(".toolbar-popover-item")].find((el) => el.textContent === "Provider config files");
  expect(entry).toBeTruthy();
  click(h.window, entry!);
  await settle();
}

function latest(h: Harness, type: string): Posted {
  const message = h.posted.filter((m) => m.type === type).at(-1);
  expect(message, type).toBeTruthy();
  return message!;
}

async function read(h: Harness, provider = "grok", relPath = ".grok/config.toml") {
  const row = [...h.doc.querySelectorAll("#provider-config-panel .gfp-row")].find((el) => el.textContent?.includes("~/" + relPath));
  expect(row).toBeTruthy();
  click(h.window, row!);
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
    click(h.window, (h.doc.getElementById("rail-gear-btn") || h.doc.getElementById("gear-btn"))!);
    expect(h.doc.getElementById("gear-popover")?.textContent).not.toContain("Provider config files");
    expect(h.doc.getElementById("provider-config-panel")).toBeNull();
    expect(h.posted.some((m) => /ProviderConfig/.test(m.type))).toBe(false);
    h.window.happyDOM.abort();
  });

  it("opens exactly three config files from chat and saves through the shared panel", async () => {
    const h = boot(surface, { editProjectFiles: true, editProviderConfigFiles: true });
    session(h);
    await open(h);
    expect(h.doc.querySelectorAll("#provider-config-panel .gfp-row")).toHaveLength(3);
    expect(h.posted.some((m) => ["openSettingsSurface", "listProjectDir", "readProjectFile", "writeProjectFile"].includes(m.type))).toBe(false);
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
  it("requires the existing file edit gate as well as the new capability", () => {
    const h = boot("remote", { editProviderConfigFiles: true });
    click(h.window, (h.doc.getElementById("rail-gear-btn") || h.doc.getElementById("gear-btn"))!);
    expect(h.doc.getElementById("gear-popover")?.textContent).not.toContain("Provider config files");
    h.window.happyDOM.abort();
  });

  it.each([ ["grok", ".grok/config.toml", "Grok"], ["codex", ".codex/config.toml", "Codex"], ["claude", ".claude/settings.json", "Claude"] ])(
    "only offers restart for the current idle %s conversation", async (provider, relPath, name) => {
      const h = boot("vscode", { editProjectFiles: true, editProviderConfigFiles: true });
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
