import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
// @ts-expect-error Plain-JS webview module intentionally has no TS build step.
import {
  applyDraft,
  applySaveSuccess,
  createFilePanel,
  resolveMarkdownLink,
  makeTab,
  stripShrinkState,
  planStrip,
  STRIP_COMPACT_MAX,
  STRIP_EXTREME_MAX,
  relativeCopyPath,
  scopeCwd,
  joinHostPath,
} from "../media/file-panel.js";
import { chatZoomFactor, unzoomClientPx } from "../media/webview-helpers.js";

const filePanelCss = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "file-panel.css"),
  "utf8",
);

function injectPanelCss(document: Document) {
  const style = document.createElement("style");
  // The touch block always lays the ⋯ out; these tests are the pointer/keyboard
  // reveal rules, so strip that media query or happy-dom's hover:none matches it.
  style.textContent = filePanelCss.replace(
    /@media \(hover: none\) and \(pointer: coarse\) \{[\s\S]*?^\}\s*/m,
    "",
  );
  document.head.appendChild(style);
}

function rowActions(row: Element): HTMLElement {
  const actions = row.querySelector(".gfp-row-actions") as HTMLElement | null;
  expect(actions).toBeTruthy();
  return actions!;
}

function actionsDisplay(row: Element): string {
  return row.ownerDocument.defaultView!.getComputedStyle(rowActions(row)).display;
}

type Scope = { id: string; label: string; title?: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function harness(options?: {
  write?: (scopeId: string, request: Record<string, unknown>) => Promise<unknown>;
  read?: (scopeId: string, relPath: string) => Promise<unknown>;
  list?: (scopeId: string, relPath: string) => Promise<unknown>;
  confirm?: (request: { title: string }) => Promise<string>;
  mount?: Record<string, unknown>;
  fileIcons?: { baseUrl: string };
  onMaximizedChanged?: (max: boolean) => void;
}) {
  const window = new Window({ url: "https://example.test/" });
  const document = window.document;
  const scopes = {
    a: { id: "scope-a", label: "app", title: "/work/app" },
    b: { id: "scope-b", label: "relay", title: "/work/relay" },
  } satisfies Record<string, Scope>;
  let current = scopes.a;
  let scopeListener: ((scope: Scope) => void) | null = null;
  const reads: Array<{ scopeId: string; relPath: string }> = [];
  const writes: Array<{ scopeId: string; request: Record<string, unknown> }> = [];
  const files: Record<string, Record<string, { text: string; stamp: { mtimeMs: number; size: number }; absPath: string }>> = {
    "scope-a": {
      "notes.md": { text: "one", stamp: { mtimeMs: 1, size: 3 }, absPath: "/work/app/notes.md" },
      "src/a.ts": { text: "a", stamp: { mtimeMs: 1, size: 1 }, absPath: "/work/app/src/a.ts" },
      "src/b.ts": { text: "b", stamp: { mtimeMs: 1, size: 1 }, absPath: "/work/app/src/b.ts" },
      "readme.md": { text: "hi", stamp: { mtimeMs: 1, size: 2 }, absPath: "/work/app/readme.md" },
    },
    "scope-b": {
      "notes.md": { text: "other", stamp: { mtimeMs: 1, size: 5 }, absPath: "/work/relay/notes.md" },
    },
  };
  const access = {
    currentScope: async () => current,
    onScopeChanged: (listener: (scope: Scope) => void) => {
      scopeListener = listener;
      return () => { scopeListener = null; };
    },
    list: async (scopeId: string, relPath: string) => {
      if (options?.list) return options.list(scopeId, relPath);
      if (!relPath) {
        return {
          ok: true,
          entries: [
            { name: "src", kind: "dir", relPath: "src" },
            { name: "notes.md", kind: "file", relPath: "notes.md" },
          ],
          truncated: false,
        };
      }
      return {
        ok: true,
        entries: [{ name: "a.ts", kind: "file", relPath: "src/a.ts" }],
        truncated: false,
      };
    },
    read: async (scopeId: string, relPath: string) => {
      reads.push({ scopeId, relPath });
      if (options?.read) return options.read(scopeId, relPath);
      const file = files[scopeId]?.[relPath];
      return file
        ? { ok: true, kind: relPath.endsWith(".md") ? "markdown" : "text", relPath, ...file }
        : { ok: false, reason: "not found" };
    },
    write: async (scopeId: string, request: Record<string, unknown>) => {
      writes.push({ scopeId, request });
      if (options?.write) return options.write(scopeId, request);
      const text = String(request.text || "");
      return { ok: true, relPath: request.relPath, stamp: { mtimeMs: 2, size: text.length } };
    },
  };
  const panel = createFilePanel({
    access,
    document,
    window,
    mount: { panelHost: document.body, toggleHost: document.body, presentation: "overlay", ...options?.mount },
    ui: {
      confirm: options?.confirm || (async () => "discard"),
      renderMarkdown: (source: string) => `<p>${source}</p>`,
      fileIcons: options?.fileIcons,
    },
    onMaximizedChanged: options?.onMaximizedChanged,
  });
  return {
    window,
    document,
    panel,
    access,
    reads,
    writes,
    scopes,
    async switchScope(scope: Scope) {
      current = scope;
      scopeListener?.(scope);
      await settle();
    },
  };
}

function click(window: Window, target: Element | null) {
  expect(target).toBeTruthy();
  target!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

function type(window: Window, document: Document, text: string) {
  const editor = document.querySelector(".gfp-editor") as HTMLTextAreaElement | null;
  expect(editor).toBeTruthy();
  editor!.value = text;
  editor!.dispatchEvent(new window.Event("input", { bubbles: true }));
}

async function openAndEdit(h: ReturnType<typeof harness>, relPath: string, draft: string) {
  await h.panel.openPath(relPath);
  click(h.window, h.document.querySelector(".gfp-edit"));
  type(h.window, h.document, draft);
}

describe("shared file-panel model", () => {
  it("advances the saved baseline only to the payload that was sent", () => {
    const tab = makeTab("a", {
      relPath: "notes.md",
      kind: "text",
      text: "one",
      stamp: { mtimeMs: 1, size: 3 },
      absPath: "/work/app/notes.md",
    });
    applyDraft(tab, "one two");
    const sent = tab.draftText;
    applyDraft(tab, "one two three");
    applySaveSuccess(tab, sent, { stamp: { mtimeMs: 2, size: 7 } });

    expect(tab.baselineText).toBe("one two");
    expect(tab.draftText).toBe("one two three");
    expect(tab.dirty).toBe(true);
    expect(tab.editing).toBe(true);
  });

  it("stays in edit mode after a save that covered everything", () => {
    // Saving is not "I am done with this file". Dropping to the read view on
    // every successful save threw you out mid-thought and made you click Edit
    // again — for the ordinary habit of saving as you work.
    const tab = makeTab("a", {
      relPath: "notes.md", kind: "text", text: "one",
      stamp: { mtimeMs: 1, size: 3 }, absPath: "/work/app/notes.md",
    });
    applyDraft(tab, "one two");
    applySaveSuccess(tab, "one two", { stamp: { mtimeMs: 2, size: 7 } });

    expect(tab.dirty).toBe(false);
    expect(tab.editing).toBe(true);
  });
});

describe("copy-path helpers", () => {
  it("keeps the listing's forward-slash relative form", () => {
    expect(relativeCopyPath("src/a.ts")).toBe("src/a.ts");
    expect(relativeCopyPath("src\\a.ts")).toBe("src/a.ts");
    expect(relativeCopyPath("notes.md")).toBe("notes.md");
  });

  it("reads the host cwd from a path-shaped scope id, else title", () => {
    expect(scopeCwd({ id: "C:\\repo", title: "repo" })).toBe("C:\\repo");
    expect(scopeCwd({ id: "/work/app", title: "app" })).toBe("/work/app");
    expect(scopeCwd({ id: "scope-a", title: "/work/app" })).toBe("/work/app");
    expect(scopeCwd({ id: "scope-a", label: "app" })).toBe("scope-a");
    expect(scopeCwd(null)).toBe("");
  });

  it("joins with the desk's separator, never a mix", () => {
    expect(joinHostPath("C:\\repo", "src/foo.ts")).toBe("C:\\repo\\src\\foo.ts");
    expect(joinHostPath("C:\\repo\\", "src/foo.ts")).toBe("C:\\repo\\src\\foo.ts");
    expect(joinHostPath("\\\\server\\share", "src/foo.ts")).toBe("\\\\server\\share\\src\\foo.ts");
    expect(joinHostPath("/work/app", "src/foo.ts")).toBe("/work/app/src/foo.ts");
    expect(joinHostPath("/work/app/", "src/foo.ts")).toBe("/work/app/src/foo.ts");
    expect(joinHostPath("/", "foo.ts")).toBe("/foo.ts");
    expect(joinHostPath("C:\\repo", "notes.md")).toBe("C:\\repo\\notes.md");
    expect(joinHostPath("C:\\repo", "src")).toBe("C:\\repo\\src");
    expect(joinHostPath("/work/app", "")).toBe("/work/app");
    expect(joinHostPath("C:\\repo", "src/foo.ts")).not.toContain("/");
  });
});

describe("shared file-panel component", () => {
  it("renders a nested tree and opens multiple tabs in click order", async () => {
    const h = harness();
    h.panel.setOpen(true);
    await settle();
    click(h.window, [...h.document.querySelectorAll(".gfp-row")].find((row) => row.textContent?.includes("src")) || null);
    await settle();
    click(h.window, [...h.document.querySelectorAll(".gfp-row")].find((row) => row.textContent?.includes("a.ts")) || null);
    await settle();
    h.panel.element.querySelector(".gfp-title")?.dispatchEvent(new h.window.MouseEvent("click", { bubbles: true }));
    click(h.window, [...h.document.querySelectorAll(".gfp-row")].find((row) => row.textContent?.includes("notes.md")) || null);
    await settle();

    expect([...h.document.querySelectorAll(".gfp-tab-name")].map((node) => node.textContent)).toEqual(["a.ts", "notes.md"]);
  });

  it("keeps drafts in memory by scope and never surfaces one in another project", async () => {
    const h = harness();
    await settle();
    await openAndEdit(h, "notes.md", "draft from app");
    await h.switchScope(h.scopes.b);
    await h.panel.openPath("notes.md", true);
    click(h.window, h.document.querySelector(".gfp-edit"));
    expect((h.document.querySelector(".gfp-editor") as HTMLTextAreaElement).value).toBe("other");

    await h.switchScope(h.scopes.a);
    expect((h.document.querySelector(".gfp-editor") as HTMLTextAreaElement).value).toBe("draft from app");
    expect(h.panel.hasDirty()).toBe(true);
  });

  it("a Discard dialog left open across a scope switch closes its OWN scope's tab", async () => {
    // closeTab awaits the confirm; switching projects meanwhile swaps
    // currentState, and the same relPath exists in both scopes. Confirming
    // must discard scope A's draft, never scope B's. (Review find 2026-08-14 —
    // the identifier-stale-after-await class.)
    let resolveConfirm: ((answer: string) => void) | null = null;
    const h = harness({
      confirm: () => new Promise<string>((resolve) => { resolveConfirm = resolve; }),
    });
    await settle();
    await openAndEdit(h, "notes.md", "draft from app");

    // Close A's dirty tab — the Discard dialog is now pending.
    click(h.window, h.document.querySelector(".gfp-tab-close"));
    await settle();
    expect(resolveConfirm).toBeTruthy();

    // Swap to scope B and give it its own dirty notes.md.
    await h.switchScope(h.scopes.b);
    await h.panel.openPath("notes.md", true);
    click(h.window, h.document.querySelector(".gfp-edit"));
    type(h.window, h.document, "draft from relay");

    resolveConfirm!("discard");
    await settle();

    // B's tab and draft survive untouched.
    expect([...h.document.querySelectorAll(".gfp-tab-name")].map((n) => n.textContent)).toEqual(["notes.md"]);
    expect((h.document.querySelector(".gfp-editor") as HTMLTextAreaElement).value).toBe("draft from relay");

    // A's tab is the one that closed.
    await h.switchScope(h.scopes.a);
    expect([...h.document.querySelectorAll(".gfp-tab-name")]).toEqual([]);
  });

  it("hides without confirming or discarding", async () => {
    let confirms = 0;
    const h = harness({ confirm: async () => { confirms++; return "discard"; } });
    await settle();
    await openAndEdit(h, "notes.md", "draft");
    h.panel.setOpen(false);
    h.panel.setOpen(true);

    expect(confirms).toBe(0);
    expect((h.document.querySelector(".gfp-editor") as HTMLTextAreaElement).value).toBe("draft");
  });

  it("keeps keystrokes typed while Save is in flight dirty", async () => {
    const pending = deferred<unknown>();
    const h = harness({ write: async () => pending.promise });
    await settle();
    await openAndEdit(h, "notes.md", "one two");
    click(h.window, h.document.querySelector(".gfp-save"));
    type(h.window, h.document, "one two three");
    pending.resolve({ ok: true, relPath: "notes.md", stamp: { mtimeMs: 2, size: 7 } });
    await settle();

    expect((h.document.querySelector(".gfp-editor") as HTMLTextAreaElement).value).toBe("one two three");
    expect(h.document.querySelector(".gfp-tab-dirty")?.textContent).toBe("•");
    expect(h.document.querySelector(".gfp-notice")?.textContent).toContain("typed more");
  });

  it("reloads a conflicted tab into the scope that owns it after a scope switch", async () => {
    const reload = deferred<unknown>();
    let appReads = 0;
    const h = harness({
      read: async (scopeId, relPath) => {
        if (scopeId === "scope-a") {
          appReads++;
          if (appReads === 2) return reload.promise;
          return {
            ok: true, kind: "markdown", relPath, text: "one",
            stamp: { mtimeMs: 1, size: 3 }, absPath: "/work/app/notes.md",
          };
        }
        return {
          ok: true, kind: "markdown", relPath, text: "other",
          stamp: { mtimeMs: 1, size: 5 }, absPath: "/work/relay/notes.md",
        };
      },
      write: async () => ({ ok: false, reason: "changed" }),
    });
    await settle();
    await openAndEdit(h, "notes.md", "app draft");
    click(h.window, h.document.querySelector(".gfp-save"));
    await settle();
    click(h.window, [...h.document.querySelectorAll(".gfp-conflict-actions .gfp-action")]
      .find((node) => node.textContent === "Reload") || null);

    await h.switchScope(h.scopes.b);
    await h.panel.openPath("notes.md", true);
    // Markdown's modes are a pair: [Preview, Edit source]. The second enters
    // edit mode; the first is already active on open and would be a no-op.
    click(h.window, h.document.querySelectorAll(".gfp-mode")[1]);
    type(h.window, h.document, "relay draft");
    reload.resolve({
      ok: true, kind: "markdown", relPath: "notes.md", text: "fresh app",
      stamp: { mtimeMs: 2, size: 9 }, absPath: "/work/app/notes.md",
    });
    await settle();

    const relayTab = h.panel._scopes.get("scope-b")?.tabs.get("notes.md");
    expect(relayTab?.scopeId).toBe("scope-b");
    expect(relayTab?.draftText).toBe("relay draft");
    expect(h.panel._scopes.get("scope-a")?.tabs.get("notes.md")?.baselineText).toBe("fresh app");
    await h.switchScope(h.scopes.a);
    expect(h.document.querySelector(".gfp-markdown")?.textContent).toContain("fresh app");
  });

  it("overwrites the latest text typed while the stamp refresh is in flight", async () => {
    const refresh = deferred<unknown>();
    let reads = 0;
    let writes = 0;
    const h = harness({
      read: async (_scopeId, relPath) => {
        reads++;
        if (reads === 2) return refresh.promise;
        return {
          ok: true, kind: "markdown", relPath, text: "one",
          stamp: { mtimeMs: 1, size: 3 }, absPath: "/work/app/notes.md",
        };
      },
      write: async (_scopeId, request) => {
        writes++;
        return writes === 1
          ? { ok: false, reason: "changed" }
          : { ok: true, relPath: request.relPath, stamp: { mtimeMs: 3, size: String(request.text).length } };
      },
    });
    await settle();
    await openAndEdit(h, "notes.md", "draft before overwrite");
    click(h.window, h.document.querySelector(".gfp-save"));
    await settle();
    click(h.window, [...h.document.querySelectorAll(".gfp-conflict-actions .gfp-action")]
      .find((node) => node.textContent === "Overwrite") || null);
    type(h.window, h.document, "draft typed during refresh");
    refresh.resolve({
      ok: true, kind: "markdown", relPath: "notes.md", text: "host version",
      stamp: { mtimeMs: 2, size: 12 }, absPath: "/work/app/notes.md",
    });
    await settle();

    expect(h.writes).toHaveLength(2);
    expect(h.writes[1].request.text).toBe("draft typed during refresh");
    expect(h.panel._scopes.get("scope-a")?.tabs.get("notes.md")?.baselineText).toBe("draft typed during refresh");
    // A successful save now leaves you in edit mode, so the surviving text is in
    // the textarea rather than the read-only <pre> this used to look at.
    expect((h.document.querySelector(".gfp-editor") as HTMLTextAreaElement).value)
      .toBe("draft typed during refresh");
  });

  it("renders the cached tree when returning to a previous scope", async () => {
    const h = harness({
      list: async (scopeId) => ({
        ok: true,
        entries: [{
          name: scopeId === "scope-a" ? "app-only.txt" : "relay-only.txt",
          kind: "file",
          relPath: scopeId === "scope-a" ? "app-only.txt" : "relay-only.txt",
        }],
        truncated: false,
      }),
    });
    h.panel.setOpen(true);
    await settle();
    expect(h.document.querySelector(".gfp-tree")?.textContent).toContain("app-only.txt");
    await h.switchScope(h.scopes.b);
    expect(h.document.querySelector(".gfp-tree")?.textContent).toContain("relay-only.txt");
    await h.switchScope(h.scopes.a);

    expect(h.document.querySelector(".gfp-tree")?.textContent).toContain("app-only.txt");
    expect(h.document.querySelector(".gfp-tree")?.textContent).not.toContain("relay-only.txt");
  });

  it("finishes an in-flight tree load when the same scope id is reasserted with a fresh object", async () => {
    const root = deferred<unknown>();
    const h = harness({ list: async () => root.promise });
    h.panel.setOpen(true);
    await settle();
    const sameProject = { ...h.scopes.a };
    const reassigned = h.panel.setScope(sameProject);
    root.resolve({
      ok: true,
      entries: [{ name: "loaded.txt", kind: "file", relPath: "loaded.txt" }],
      truncated: false,
    });
    await reassigned;
    await settle();

    expect(h.document.querySelector(".gfp-tree")?.textContent).toContain("loaded.txt");
    expect(h.document.querySelector(".gfp-tree")?.textContent).not.toContain("Loading");
  });

  it("leaves clean edit mode when Cancel is clicked", async () => {
    const h = harness();
    await settle();
    await h.panel.openPath("src/a.ts");
    click(h.window, h.document.querySelector(".gfp-edit"));
    expect(h.document.querySelector(".gfp-editor")).toBeTruthy();
    click(h.window, h.document.querySelector(".gfp-cancel"));
    await settle();

    expect(h.document.querySelector(".gfp-editor")).toBeNull();
    expect(h.document.querySelector(".gfp-edit")).toBeTruthy();
  });

  it("shows Markdown Preview after source editing has started", async () => {
    const h = harness();
    await settle();
    await h.panel.openPath("notes.md");
    // Markdown's modes are a pair: [Preview, Edit source]. Edit, then back.
    click(h.window, h.document.querySelectorAll(".gfp-mode")[1]);
    type(h.window, h.document, "preview this draft");
    click(h.window, h.document.querySelectorAll(".gfp-mode")[0]);

    expect(h.document.querySelector(".gfp-editor")).toBeNull();
    expect(h.document.querySelector(".gfp-markdown")?.textContent).toContain("preview this draft");
  });

  it("uses overlay presentation while the responsive dock host is display-none", async () => {
    const window = new Window({ url: "https://example.test/" });
    const document = window.document;
    const panelHost = document.createElement("main");
    const dockHost = document.createElement("aside");
    dockHost.style.display = "none";
    document.body.append(panelHost, dockHost);
    const panel = createFilePanel({
      access: { currentScope: async () => null, list: async () => ({ ok: true, entries: [] }) },
      document,
      window,
      mount: { panelHost, dockHost, presentation: "responsive" },
    });

    panel.setOpen(true);
    await settle();
    expect(panel.element.classList.contains("gfp-overlay")).toBe(true);
    expect(panel.element.parentElement).toBe(panelHost);

    dockHost.style.display = "block";
    window.dispatchEvent(new window.Event("resize"));
    expect(panel.element.classList.contains("gfp-docked")).toBe(true);
    expect(panel.element.parentElement).toBe(dockHost);
  });

  it("refreshes a stamp for Overwrite but refuses a different file identity", async () => {
    let reads = 0;
    const h = harness({
      read: async (_scopeId, relPath) => {
        reads++;
        return {
          ok: true,
          kind: "text",
          relPath,
          text: reads === 1 ? "one" : "replacement",
          stamp: { mtimeMs: reads, size: reads === 1 ? 3 : 11 },
          absPath: reads === 1 ? "/work/app/notes.md" : "/work/app/other.md",
        };
      },
      write: async () => ({ ok: false, reason: "changed" }),
    });
    await settle();
    await openAndEdit(h, "notes.md", "draft");
    click(h.window, h.document.querySelector(".gfp-save"));
    await settle();
    click(h.window, [...h.document.querySelectorAll(".gfp-conflict-actions .gfp-action")].find((node) => node.textContent === "Overwrite") || null);
    await settle();

    expect(h.writes).toHaveLength(1);
    expect(h.document.querySelector(".gfp-notice")?.textContent).toContain("no longer the one you opened");
    expect((h.document.querySelector(".gfp-editor") as HTMLTextAreaElement).value).toBe("draft");
  });

  it("holds the editor while a Reload is in flight instead of dropping what you type", async () => {
    // Reload replaces the whole tab with the host's version. On a phone that
    // round trip is long enough to type into, and those keystrokes used to
    // vanish without a word when the answer arrived.
    const pending = deferred<unknown>();
    let reads = 0;
    const h = harness({
      read: async (_scopeId, relPath) => {
        reads++;
        if (reads === 2) return pending.promise;
        return { ok: true, kind: "text", relPath, text: "one", stamp: { mtimeMs: 1, size: 3 }, absPath: "/work/app/notes.md" };
      },
      write: async () => ({ ok: false, reason: "changed" }),
    });
    await settle();
    await openAndEdit(h, "src/a.ts", "mine");
    click(h.window, h.document.querySelector(".gfp-save"));
    await settle();
    click(h.window, [...h.document.querySelectorAll(".gfp-conflict-actions .gfp-action")].find((n) => n.textContent === "Reload") || null);
    await settle();

    expect((h.document.querySelector(".gfp-editor") as HTMLTextAreaElement)?.readOnly).toBe(true);
    // Reload and Overwrite resolve the same conflict in opposite directions.
    // Running both leaves the panel showing one outcome over a file holding the
    // other, with no warning on close.
    expect(
      [...h.document.querySelectorAll(".gfp-conflict-actions .gfp-action")]
        .map((n) => (n as HTMLButtonElement).disabled),
    ).toEqual([true, true]);
    pending.resolve({ ok: true, kind: "text", relPath: "src/a.ts", text: "host version", stamp: { mtimeMs: 2, size: 12 }, absPath: "/work/app/src/a.ts" });
    await settle();
    expect(h.document.querySelector(".gfp-viewer-body")?.textContent).toContain("host version");
  });

  it("measures Overwrite's dirtiness against the bytes now on disk", async () => {
    // Overwrite exists because the file moved underneath us, so the version the
    // tab was OPENED at is the one value certain to be stale. Comparing against
    // it meant typing your way back to the opened text during the refresh made
    // the tab read clean, the write was skipped, and the panel then showed the
    // older content as saved while the disk kept the newer bytes.
    let reads = 0;
    const writes: string[] = [];
    const h = harness({
      read: async (_scopeId, relPath) => {
        reads++;
        return {
          ok: true, kind: "text", relPath,
          text: reads === 1 ? "opened" : "newer on disk",
          stamp: { mtimeMs: reads, size: 6 }, absPath: "/work/app/src/a.ts",
        };
      },
      write: async (_scopeId, request) => {
        writes.push(String(request.text));
        return { ok: writes.length > 1, reason: "changed", relPath: request.relPath, stamp: { mtimeMs: 9, size: 6 } };
      },
    });
    await settle();
    await openAndEdit(h, "src/a.ts", "mine");
    click(h.window, h.document.querySelector(".gfp-save"));
    await settle();
    // Type back to exactly what the tab was opened at, then Overwrite.
    type(h.window, h.document, "opened");
    click(h.window, [...h.document.querySelectorAll(".gfp-conflict-actions .gfp-action")].find((n) => n.textContent === "Overwrite") || null);
    await settle();

    expect(writes).toEqual(["mine", "opened"]);
  });

  it("keeps the caret where it was when a save repaints the editor", async () => {
    // renderViewer() rebuilds the textarea, so saving mid-sentence sent the
    // cursor back to position 0 and lost the selection — on every save.
    const h = harness();
    await settle();
    await openAndEdit(h, "src/a.ts", "one two three");
    const editor = h.document.querySelector(".gfp-editor") as HTMLTextAreaElement;
    editor.setSelectionRange(4, 7);
    click(h.window, h.document.querySelector(".gfp-save"));
    await settle();

    const after = h.document.querySelector(".gfp-editor") as HTMLTextAreaElement;
    expect(after).toBeTruthy();
    expect([after.selectionStart, after.selectionEnd]).toEqual([4, 7]);
  });

  it("finishes an Overwrite the disk has already satisfied", async () => {
    // If the refresh proves the file already holds exactly this text there is
    // nothing to write — but saveTab refuses a clean tab and returns silently,
    // which left "Refreshing version…" on screen forever.
    let reads = 0;
    const writes: string[] = [];
    const h = harness({
      read: async (_scopeId, relPath) => {
        reads++;
        return {
          ok: true, kind: "text", relPath,
          text: reads === 1 ? "opened" : "mine",
          stamp: { mtimeMs: reads, size: 4 }, absPath: "/work/app/src/a.ts",
        };
      },
      write: async (_scopeId, request) => {
        writes.push(String(request.text));
        return { ok: false, reason: "changed" };
      },
    });
    await settle();
    await openAndEdit(h, "src/a.ts", "mine");
    click(h.window, h.document.querySelector(".gfp-save"));
    await settle();
    click(h.window, [...h.document.querySelectorAll(".gfp-conflict-actions .gfp-action")].find((n) => n.textContent === "Overwrite") || null);
    await settle();

    expect(writes).toEqual(["mine"]);
    const notice = h.document.querySelector(".gfp-notice")?.textContent || "";
    expect(notice).toContain("Already matches");
    expect(notice).not.toContain("Refreshing");
  });

  it("does not rebuild the visible editor when a background save lands", async () => {
    // renderViewer() recreates the textarea, taking the caret, the selection and
    // any in-progress IME composition with it. A save finishing in another
    // project must not disturb what you are typing here.
    const pending = deferred<unknown>();
    const h = harness({ write: async () => pending.promise });
    await settle();
    await openAndEdit(h, "notes.md", "app draft");
    click(h.window, h.document.querySelector(".gfp-save"));

    await h.switchScope(h.scopes.b);
    await h.panel.openPath("notes.md", true);
    click(h.window, h.document.querySelectorAll(".gfp-mode")[1]);
    const editorBefore = h.document.querySelector(".gfp-editor");
    pending.resolve({ ok: true, relPath: "notes.md", stamp: { mtimeMs: 2, size: 9 } });
    await settle();

    expect(h.document.querySelector(".gfp-editor")).toBe(editorBefore);
  });

  it("gives Markdown a segmented mode control, with exactly one segment selected", async () => {
    // Modes are a grouped segmented control, not bar-icons with an underline.
    // The group, the on-class, and moving the selection are the contract.
    const h = harness();
    await settle();
    await h.panel.openPath("notes.md");

    const group = h.document.querySelector(".gfp-viewer .gfp-seg");
    expect(group, "markdown must render a .gfp-seg group").toBeTruthy();
    const modes = [...h.document.querySelectorAll(".gfp-mode")];
    expect(modes.map((m) => m.getAttribute("title"))).toEqual(["Preview", "Edit source"]);
    expect(modes.every((m) => !m.textContent?.trim())).toBe(true);
    expect(modes.every((m) => m.classList.contains("gfp-seg-btn"))).toBe(true);
    expect(group!.querySelectorAll(".gfp-seg-on")).toHaveLength(1);
    expect(modes[0].classList.contains("gfp-seg-on")).toBe(true);
    expect(modes[1].classList.contains("gfp-seg-on")).toBe(false);

    click(h.window, modes[1]);
    await settle();
    const after = [...h.document.querySelectorAll(".gfp-mode")];
    expect(h.document.querySelectorAll(".gfp-seg-on")).toHaveLength(1);
    expect(after[1].classList.contains("gfp-seg-on")).toBe(true);
    expect(after[0].classList.contains("gfp-seg-on")).toBe(false);
    expect(h.document.querySelector(".gfp-editor")).toBeTruthy();
  });

  it("marks the panel as viewing only while a file is open", async () => {
    // The filter searches the tree, so it is hidden with a file open — by CSS,
    // keyed on this class. The class is the contract worth pinning here.
    const h = harness();
    await settle();
    expect(h.panel.element.classList.contains("gfp-viewing")).toBe(false);
    await h.panel.openPath("notes.md");
    expect(h.panel.element.classList.contains("gfp-viewing")).toBe(true);
    h.panel.element.querySelector(".gfp-title")?.dispatchEvent(new h.window.MouseEvent("click", { bubbles: true }));
    await settle();
    expect(h.panel.element.classList.contains("gfp-viewing")).toBe(false);
  });

  it("sizes a drag against the shared row, not its own shrink-wrapped column", () => {
    // The relay docks the panel into a `flex: 0 0 auto` host, so that host's
    // width IS the panel's width. Measuring it collapses the computed maximum
    // to the minimum, and one drag strands the panel at 200px with no way to
    // widen it again.
    const window = new Window({ url: "https://example.test/" });
    const document = window.document;
    // happy-dom has no layout engine; these are the only measurements
    // setPanelWidth reads.
    const width = (el: unknown, px: number) => {
      (el as { getBoundingClientRect: () => { width: number } }).getBoundingClientRect =
        () => ({ width: px });
    };

    const row = document.createElement("div");
    const dock = document.createElement("div");
    row.appendChild(dock);
    document.body.appendChild(row);
    width(row, 1400);
    // The shrink-wrapped column reports only what the panel already occupies.
    width(dock, 200);

    const panel = createFilePanel({
      access: {
        currentScope: async () => null,
        list: async () => ({ ok: true, entries: [], truncated: false }),
        read: async () => ({ ok: false, reason: "none" }),
      },
      document,
      window,
      mount: {
        panelHost: document.body,
        dockHost: dock,
        toggleHost: document.body,
        presentation: "docked",
        widthBasis: row,
      },
      ui: { confirm: async () => "discard", renderMarkdown: (s: string) => s },
    });

    expect(panel.setWidth(520, false)).toBe(520);
  });
});

describe("file panel resize drag", () => {
  function widthOf(el: unknown, px: number) {
    (el as { getBoundingClientRect: () => { width: number } }).getBoundingClientRect =
      () => ({ width: px });
  }

  function drag(window: Window, resizer: Element, fromX: number, toX: number) {
    const ev = (type: string, clientX: number) =>
      new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX });
    resizer.dispatchEvent(Object.assign(ev("pointerdown", fromX), { pointerId: 1 }));
    resizer.dispatchEvent(Object.assign(ev("pointermove", toX), { pointerId: 1 }));
    resizer.dispatchEvent(Object.assign(ev("pointerup", toX), { pointerId: 1 }));
  }

  function dockedPanel(zoom: string) {
    const window = new Window({ url: "https://example.test/" });
    const document = window.document;
    document.body.style.setProperty("--chat-zoom", zoom);
    (window as unknown as { GrokWebviewHelpers: { chatZoomFactor: typeof chatZoomFactor; unzoomClientPx: typeof unzoomClientPx } }).GrokWebviewHelpers = {
      chatZoomFactor,
      unzoomClientPx,
    };

    const row = document.createElement("div");
    const dock = document.createElement("div");
    row.appendChild(dock);
    document.body.appendChild(row);
    widthOf(row, 1400);

    const panel = createFilePanel({
      access: {
        currentScope: async () => null,
        list: async () => ({ ok: true, entries: [], truncated: false }),
        read: async () => ({ ok: false, reason: "none" }),
      },
      document,
      window,
      mount: {
        panelHost: document.body,
        dockHost: dock,
        toggleHost: document.body,
        presentation: "dock",
        widthBasis: row,
      },
      ui: { confirm: async () => "discard", renderMarkdown: (s: string) => s },
    });
    panel.setOpen(true);
    return { window, document, panel };
  }

  it("dragging at zoom 1 matches the cursor delta", () => {
    const h = dockedPanel("1");
    widthOf(h.panel.element, 280);
    // Panel is on the right: drag left (smaller X) → wider.
    drag(h.window, h.panel.resizer, 1000, 900);
    expect((h.panel.element as HTMLElement).style.getPropertyValue("--gfp-width")).toBe("380px");
  });

  it("dragging at a non-1 zoom tracks the cursor in layout px", () => {
    // getBoundingClientRect / clientX are visual; --gfp-width is layout.
    // A 280px panel at 1.5× reports 420 visual; 150 visual px is 100 layout px.
    const h = dockedPanel("1.5");
    widthOf(h.panel.element, 420);
    drag(h.window, h.panel.resizer, 1000, 850);
    expect((h.panel.element as HTMLElement).style.getPropertyValue("--gfp-width")).toBe("380px");
  });
});

// Syntax highlighting. The panel reads the highlighter off the global the way a
// browser sets it via <script>; these tests install it explicitly and restore
// it afterwards, so the rest of the file keeps exercising the no-highlighter
// path — which is a real deployment (VS Code ships no panel, and a stale relay
// page can predate the script).
describe("file panel syntax highlighting", () => {
  const require = createRequire(import.meta.url);
  const api = require("../media/syntax-highlight.js");

  beforeEach(() => { (globalThis as any).GrokSyntaxHighlight = api; });
  afterEach(() => { delete (globalThis as any).GrokSyntaxHighlight; });

  const SOURCE = 'const x = "hi"; // note\n';
  const sourceHarness = () => harness({
    read: async (_scopeId: string, relPath: string) => ({
      ok: true,
      kind: "text",
      relPath,
      absPath: `/work/app/${relPath}`,
      text: SOURCE,
      stamp: { mtimeMs: 1, size: SOURCE.length },
    }),
  });

  it("paints tokens in read mode", async () => {
    const h = sourceHarness();
    await settle();
    await h.panel.openPath("src/a.ts");
    const pre = h.document.querySelector(".gfp-viewer-body pre");
    expect(pre).toBeTruthy();
    expect(pre!.querySelector(".hl-kw")?.textContent).toBe("const");
    expect(pre!.querySelector(".hl-str")?.textContent).toBe('"hi"');
    expect(pre!.querySelector(".hl-com")?.textContent).toBe("// note");
  });

  it("shows the same text whether or not it is highlighted", async () => {
    // Colour is the only difference the user should ever see.
    const h = sourceHarness();
    await settle();
    await h.panel.openPath("src/a.ts");
    expect(h.document.querySelector(".gfp-viewer-body pre")!.textContent).toBe(SOURCE);
  });

  it("builds the overlay for a language it knows", async () => {
    const h = harness();
    await settle();
    await h.panel.openPath("src/a.ts");
    click(h.window, h.document.querySelector(".gfp-edit"));

    const wrap = h.document.querySelector(".gfp-code-edit");
    expect(wrap).toBeTruthy();
    const editor = wrap!.querySelector(".gfp-editor") as HTMLTextAreaElement;
    const under = wrap!.querySelector(".gfp-code-underlay");
    expect(editor).toBeTruthy();
    expect(under).toBeTruthy();
    // The textarea still holds the real text — the underlay is decoration.
    expect(editor.value).toBe("a");
    expect(under!.getAttribute("aria-hidden")).toBe("true");
    // …and the underlay is BEHIND the textarea in document order, so the
    // textarea takes the clicks.
    expect(wrap!.firstElementChild).toBe(under);
  });

  it("repaints the underlay as you type", async () => {
    const h = harness();
    await settle();
    await h.panel.openPath("src/a.ts");
    click(h.window, h.document.querySelector(".gfp-edit"));
    type(h.window, h.document, 'const x = "hi";');
    await settle();

    const under = h.document.querySelector(".gfp-code-underlay")!;
    expect(under.querySelector(".hl-kw")?.textContent).toBe("const");
    expect(under.textContent).toContain('const x = "hi";');
  });

  it("keeps a trailing newline visible on the underlay", async () => {
    // A textarea draws the empty last line; a <pre> does not, so without a
    // sentinel the two layers drift by one line on almost every real file.
    const h = harness();
    await settle();
    await h.panel.openPath("src/a.ts");
    click(h.window, h.document.querySelector(".gfp-edit"));
    type(h.window, h.document, "a\n");
    await settle();

    const under = h.document.querySelector(".gfp-code-underlay")!;
    expect(under.textContent!.endsWith("\n")).toBe(false);
    expect(under.textContent).toBe("a\n ");
  });

  it("never lets file contents become markup", async () => {
    const h = harness();
    await settle();
    await h.panel.openPath("src/a.ts");
    click(h.window, h.document.querySelector(".gfp-edit"));
    type(h.window, h.document, '<img src=x onerror="boom()">');
    await settle();

    const under = h.document.querySelector(".gfp-code-underlay")!;
    expect(under.querySelector("img")).toBeNull();
    expect(under.textContent).toContain('<img src=x onerror="boom()">');
  });

  it("degrades to a bare textarea when the highlighter is absent", async () => {
    // The kill switch. Deleting the global must leave exactly the editor this
    // replaced — no wrapper, no transparent text, nothing to misalign.
    delete (globalThis as any).GrokSyntaxHighlight;
    const h = harness();
    await settle();
    await h.panel.openPath("src/a.ts");
    click(h.window, h.document.querySelector(".gfp-edit"));

    expect(h.document.querySelector(".gfp-code-edit")).toBeNull();
    expect(h.document.querySelector(".gfp-code-underlay")).toBeNull();
    const editor = h.document.querySelector(".gfp-editor") as HTMLTextAreaElement;
    expect(editor).toBeTruthy();
    expect(editor.classList.contains("gfp-editor-overlaid")).toBe(false);
  });

  it("degrades for a file type it has no ruleset for", async () => {
    const h = harness();
    await settle();
    await h.panel.openPath("notes.md");
    // Markdown opens in preview; switch to source editing.
    click(h.window, h.document.querySelectorAll(".gfp-mode")[1]);

    expect(h.document.querySelector(".gfp-code-edit")).toBeNull();
    expect(h.document.querySelector(".gfp-editor")).toBeTruthy();
  });

  it("still sends what the textarea holds, highlighted or not", async () => {
    // The save payload comes off the textarea; the underlay must not touch it.
    const h = harness();
    await settle();
    await openAndEdit(h, "src/a.ts", "const saved = 1;\n");
    click(h.window, h.document.querySelector(".gfp-save"));
    await settle();

    const write = h.writes.at(-1);
    expect(write?.request.text).toBe("const saved = 1;\n");
  });
});

// A relative link in a rendered README points at a file in this workspace, not
// at a URL. Left as a plain <a href> the browser resolves it against the PAGE —
// on a remote client that is the relay, so `_shared/auth.ts` navigated to
// https://<relay>/_shared/auth.ts and the user lost the app.
describe("markdown links open workspace files", () => {
  it("resolves a link against the file it was written in", () => {
    expect(resolveMarkdownLink("docs/README.md", "_shared/auth.ts")).toBe("docs/_shared/auth.ts");
    expect(resolveMarkdownLink("README.md", "_shared/auth.ts")).toBe("_shared/auth.ts");
    expect(resolveMarkdownLink("docs/README.md", "./auth.ts")).toBe("docs/auth.ts");
    expect(resolveMarkdownLink("docs/a/b.md", "../../src/x.ts")).toBe("src/x.ts");
  });

  it("treats a leading slash as the workspace root, not the filesystem root", () => {
    expect(resolveMarkdownLink("docs/deep/x.md", "/src/root.ts")).toBe("src/root.ts");
  });

  it("drops a query or fragment, which a repo link often carries", () => {
    expect(resolveMarkdownLink("docs/README.md", "auth.ts#usage")).toBe("docs/auth.ts");
    expect(resolveMarkdownLink("docs/README.md", "auth.ts?plain=1")).toBe("docs/auth.ts");
  });

  it("decodes percent-escapes so a spaced filename resolves", () => {
    expect(resolveMarkdownLink("docs/README.md", "my%20file.ts")).toBe("docs/my file.ts");
  });

  it("leaves genuinely external links to the browser", () => {
    for (const href of [
      "https://example.com/x",
      "http://example.com/x",
      "mailto:someone@example.com",
      "//cdn.example.com/x",
      "#heading",
      "",
      "   ",
    ]) {
      expect(resolveMarkdownLink("docs/README.md", href), href).toBeNull();
    }
    expect(resolveMarkdownLink("docs/README.md", undefined as any)).toBeNull();
  });

  it("refuses to climb above the workspace root", () => {
    // The host re-checks containment regardless; a link should not be the thing
    // that asks for a path outside the workspace.
    expect(resolveMarkdownLink("README.md", "../escape.ts")).toBeNull();
    expect(resolveMarkdownLink("docs/a.md", "../../../etc/passwd")).toBeNull();
  });

  it("opens the linked file instead of navigating, when clicked", async () => {
    const md = '<a href="_shared/auth.ts">auth</a>';
    const h = harness({
      read: async (_scopeId: string, relPath: string) => ({
        ok: true,
        kind: relPath.endsWith(".md") ? "markdown" : "text",
        relPath,
        absPath: `/work/app/${relPath}`,
        text: md,
        stamp: { mtimeMs: 1, size: md.length },
      }),
    });
    await settle();
    await h.panel.openPath("README.md");
    const link = h.document.querySelector(".gfp-markdown a[href]") as HTMLAnchorElement;
    expect(link).toBeTruthy();

    const event = new h.window.MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    await settle();

    // The browser must not be allowed to follow it…
    expect(event.defaultPrevented).toBe(true);
    // …and the panel must have asked the host for that file.
    expect(h.reads.map((r) => r.relPath)).toContain("_shared/auth.ts");
  });

  it("does not intercept an external link", async () => {
    const md = '<a href="https://example.com/docs">docs</a>';
    const h = harness({
      read: async (_scopeId: string, relPath: string) => ({
        ok: true, kind: "markdown", relPath, absPath: `/work/app/${relPath}`,
        text: md, stamp: { mtimeMs: 1, size: md.length },
      }),
    });
    await settle();
    await h.panel.openPath("README.md");
    const link = h.document.querySelector(".gfp-markdown a[href]") as HTMLAnchorElement;
    const event = new h.window.MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    await settle();

    expect(event.defaultPrevented).toBe(false);
    expect(h.reads.map((r) => r.relPath)).not.toContain("https://example.com/docs");
  });
});

// A file that cannot be opened used to paint its message OVER THE TREE: no tab,
// so nothing named the file that failed, and the tree's filter box stayed on
// screen above a message about a file you could no longer see.
describe("a file that cannot be opened gets a tab", () => {
  const failing = () => harness({
    read: async (_scopeId: string, relPath: string) =>
      (relPath === "app.bin"
        ? { ok: false, reason: "file type not previewable" }
        : { ok: true, kind: "text", relPath, absPath: `/work/app/${relPath}`, text: "x", stamp: { mtimeMs: 1, size: 1 } }),
  });

  it("names the file in a tab of its own", async () => {
    const h = failing();
    await settle();
    await h.panel.openPath("app.bin");
    expect([...h.document.querySelectorAll(".gfp-tab-name")].map((n) => n.textContent))
      .toContain("app.bin");
  });

  it("puts the reason inside the tab, not over the tree", async () => {
    const h = failing();
    await settle();
    await h.panel.openPath("app.bin");
    const body = h.document.querySelector(".gfp-viewer-body");
    expect(body?.textContent).toContain("file type not previewable");
    // The tree is not what you are looking at any more.
    expect(h.document.querySelector(".gfp-tree")?.hasAttribute("hidden")).toBe(true);
  });

  it("hides the tree's filter box, which searches a tree you are not in", async () => {
    const h = failing();
    await settle();
    await h.panel.openPath("app.bin");
    expect(h.panel.element.classList.contains("gfp-viewing")).toBe(true);
  });

  it("offers no Edit for something it could not read", async () => {
    const h = failing();
    await settle();
    await h.panel.openPath("app.bin");
    expect(h.document.querySelector(".gfp-edit")).toBeNull();
  });

  it("leaves the failed tab behind when you open something that works", async () => {
    // It behaves like any other tab: still there, still named, still closable.
    const h = failing();
    await settle();
    await h.panel.openPath("app.bin");
    await h.panel.openPath("notes.md");
    await settle();
    expect([...h.document.querySelectorAll(".gfp-tab-name")].map((n) => n.textContent))
      .toEqual(["app.bin", "notes.md"]);
  });
});

// The viewer's "More actions" button did nothing at all on the desktop, and did
// it silently: the document-level dismiss handler ran on the BUBBLE phase, so
// the same click that opened the menu reached it and closed the menu again. The
// tree's own more-button had been papered over with stopPropagation, which
// fixes one button and leaves the trap set for the next.
describe("the overflow menu opens from every button that offers it", () => {
  const withOsAccess = () => harness({
    read: async (_scopeId: string, relPath: string) => ({
      ok: true, kind: "text", relPath, absPath: `/work/app/${relPath}`,
      text: "x", stamp: { mtimeMs: 1, size: 1 },
    }),
  });

  it("opens from the viewer's More actions, and survives its own click", async () => {
    const h = withOsAccess();
    (h.access as any).openExternal = async () => ({ ok: true });
    (h.access as any).reveal = async () => ({ ok: true });
    await settle();
    await h.panel.openPath("src/a.ts");

    const more = h.document.querySelector(".gfp-viewer .gfp-more");
    expect(more, "the viewer must offer More actions when the host can open/reveal").toBeTruthy();
    click(h.window, more);
    await settle();

    const menu = h.document.querySelector(".gfp-menu");
    expect(menu, "the menu must still be open after the click that opened it").toBeTruthy();
    expect(menu!.textContent).toContain("Open in default app");
  });

  it("still closes on a click somewhere else", async () => {
    const h = withOsAccess();
    (h.access as any).openExternal = async () => ({ ok: true });
    await settle();
    await h.panel.openPath("src/a.ts");
    click(h.window, h.document.querySelector(".gfp-viewer .gfp-more"));
    await settle();
    expect(h.document.querySelector(".gfp-menu")).toBeTruthy();

    click(h.window, h.document.body);
    await settle();
    expect(h.document.querySelector(".gfp-menu")).toBeNull();
  });

  it("toggles closed on a second click of the same More-actions button", async () => {
    // Capture-phase outside-click used to null the menu BEFORE the button's
    // own handler ran, so the same click reopened it. A true toggle must
    // leave the menu gone.
    const h = withOsAccess();
    (h.access as any).openExternal = async () => ({ ok: true });
    await settle();
    await h.panel.openPath("src/a.ts");
    const more = h.document.querySelector(".gfp-viewer .gfp-more");
    click(h.window, more);
    await settle();
    expect(h.document.querySelector(".gfp-menu")).toBeTruthy();

    click(h.window, h.document.querySelector(".gfp-viewer .gfp-more"));
    await settle();
    expect(h.document.querySelector(".gfp-menu")).toBeNull();
  });
});

function mockClipboard(window: Window): { value: string; writes: number; fail: boolean } {
  const box = { value: "", writes: 0, fail: false };
  Object.defineProperty((window as unknown as { navigator: Navigator }).navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (text: string) => {
        box.writes += 1;
        if (box.fail) return Promise.reject(new Error("denied"));
        box.value = text;
        return Promise.resolve();
      },
    },
  });
  return box;
}

function menuLabels(document: Document): string[] {
  return [...document.querySelectorAll(".gfp-menu-item")].map((el) => el.textContent || "");
}

function menuItem(document: Document, label: string): Element | null {
  return [...document.querySelectorAll(".gfp-menu-item")].find((el) => el.textContent === label) || null;
}

function treeRow(document: Document, name: string): Element | null {
  return [...document.querySelectorAll(".gfp-row")].find((row) => row.textContent?.includes(name)) || null;
}

describe("copy path on the file-panel row menu", () => {
  it("offers copy items only on a client with no OS access, with no leading gap", async () => {
    const h = harness();
    h.panel.setOpen(true);
    await settle();

    const fileRow = treeRow(h.document, "notes.md");
    expect(fileRow?.querySelector(".gfp-icon-button"), "remote rows must still have ⋯").toBeTruthy();
    expect(treeRow(h.document, "src")?.querySelector(".gfp-icon-button"), "directories have paths too").toBeTruthy();

    fileRow!.dispatchEvent(new h.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await settle();
    expect(menuLabels(h.document)).toEqual(["Copy relative path", "Copy path"]);
    expect(h.document.querySelector(".gfp-menu-sep, .gfp-sep")).toBeNull();
  });

  it("copies the listing-relative path and the desk-joined absolute path", async () => {
    const h = harness();
    const copied = mockClipboard(h.window);
    h.panel.setOpen(true);
    await settle();
    click(h.window, treeRow(h.document, "src"));
    await settle();

    const fileRow = treeRow(h.document, "a.ts");
    fileRow!.dispatchEvent(new h.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await settle();
    click(h.window, menuItem(h.document, "Copy relative path"));
    await settle();
    expect(copied.value).toBe("src/a.ts");

    fileRow!.dispatchEvent(new h.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await settle();
    click(h.window, menuItem(h.document, "Copy path"));
    await settle();
    expect(copied.value).toBe("/work/app/src/a.ts");
    h.panel.destroy();
  });

  it("joins a Windows cwd with the desk separator, not the client's", async () => {
    const h = harness();
    const copied = mockClipboard(h.window);
    await settle();
    await h.panel.setScope({ id: "C:\\GitHub\\repo", label: "repo", title: "C:\\GitHub\\repo" });
    h.panel.setOpen(true);
    await settle();
    click(h.window, treeRow(h.document, "src"));
    await settle();

    treeRow(h.document, "a.ts")!.dispatchEvent(new h.window.MouseEvent("contextmenu", {
      bubbles: true, cancelable: true,
    }));
    await settle();
    click(h.window, menuItem(h.document, "Copy path"));
    await settle();
    expect(copied.value).toBe("C:\\GitHub\\repo\\src\\a.ts");
    expect(copied.value).not.toMatch(/\//);
    h.panel.destroy();
  });

  it("copies a directory path the same way", async () => {
    const h = harness();
    const copied = mockClipboard(h.window);
    h.panel.setOpen(true);
    await settle();
    treeRow(h.document, "src")!.dispatchEvent(new h.window.MouseEvent("contextmenu", {
      bubbles: true, cancelable: true,
    }));
    await settle();
    expect(menuLabels(h.document)).toEqual(["Refresh this folder", "Copy relative path", "Copy path"]);
    click(h.window, menuItem(h.document, "Copy relative path"));
    await settle();
    expect(copied.value).toBe("src");

    treeRow(h.document, "src")!.dispatchEvent(new h.window.MouseEvent("contextmenu", {
      bubbles: true, cancelable: true,
    }));
    await settle();
    click(h.window, menuItem(h.document, "Copy path"));
    await settle();
    expect(copied.value).toBe("/work/app/src");
    h.panel.destroy();
  });

  it("puts Open / Reveal above the copy items when the host can act", async () => {
    const h = harness();
    (h.access as { openExternal?: unknown; reveal?: unknown }).openExternal = async () => ({ ok: true });
    (h.access as { reveal?: unknown }).reveal = async () => ({ ok: true });
    h.panel.setOpen(true);
    await settle();
    treeRow(h.document, "notes.md")!.dispatchEvent(new h.window.MouseEvent("contextmenu", {
      bubbles: true, cancelable: true,
    }));
    await settle();
    expect(menuLabels(h.document)).toEqual([
      "Open in default app",
      "Reveal in file manager",
      "Copy relative path",
      "Copy path",
    ]);

    h.document.querySelector(".gfp-menu")?.remove();
    treeRow(h.document, "src")!.dispatchEvent(new h.window.MouseEvent("contextmenu", {
      bubbles: true, cancelable: true,
    }));
    await settle();
    // Re-listing is a folder's action, so it leads a directory menu and is
    // absent from the file menu above.
    expect(menuLabels(h.document)).toEqual([
      "Refresh this folder",
      "Reveal in file manager",
      "Copy relative path",
      "Copy path",
    ]);
  });

  it("copies from the viewer's More actions and flashes the chat checkmark", async () => {
    const h = harness();
    const copied = mockClipboard(h.window);
    await settle();
    await h.panel.openPath("src/a.ts");
    const more = h.document.querySelector(".gfp-viewer .gfp-more");
    expect(more, "the viewer ⋯ is not gated on OS access").toBeTruthy();
    click(h.window, more);
    await settle();
    click(h.window, menuItem(h.document, "Copy relative path"));
    await settle();
    expect(copied.value).toBe("src/a.ts");
    expect(more!.classList.contains("copied")).toBe(true);
    expect(more!.querySelector("svg")).toBeTruthy();
    h.panel.destroy();
  });

  it("swallows a rejected clipboard write", async () => {
    const h = harness();
    const copied = mockClipboard(h.window);
    copied.fail = true;
    h.panel.setOpen(true);
    await settle();
    treeRow(h.document, "notes.md")!.dispatchEvent(new h.window.MouseEvent("contextmenu", {
      bubbles: true, cancelable: true,
    }));
    await settle();
    click(h.window, menuItem(h.document, "Copy relative path"));
    await settle();
    expect(copied.writes).toBe(1);
    expect(copied.value).toBe("");
    expect(h.document.querySelector(".gfp-icon-button.copied")).toBeNull();
    h.panel.destroy();
  });
});

// A non-previewable file used to be handed straight to the OS on the desktop,
// so the same click meant different things on different clients: a tab with a
// message in the browser, a silently launched external app on the desktop.
describe("a non-previewable file behaves the same on every client", () => {
  const unopenable = () => harness({
    read: async () => ({ ok: false, reason: "file type not previewable", openExternal: true }),
  });

  it("opens a tab instead of launching an app behind your back", async () => {
    const h = unopenable();
    let launched = 0;
    (h.access as any).openExternal = async () => { launched += 1; return { ok: true }; };
    await settle();
    await h.panel.openPath("app.bin");

    expect(launched, "the OS must not be handed the file uninvited").toBe(0);
    expect([...h.document.querySelectorAll(".gfp-tab-name")].map((n) => n.textContent))
      .toContain("app.bin");
    expect(h.document.querySelector(".gfp-viewer-body")?.textContent)
      .toContain("file type not previewable");
  });

  it("offers the OS route inside that tab, where you can see what it applies to", async () => {
    const h = unopenable();
    let launched: string[] = [];
    (h.access as any).openExternal = async (_s: string, relPath: string) => {
      launched.push(relPath);
      return { ok: true };
    };
    await settle();
    await h.panel.openPath("app.bin");

    const open = h.document.querySelector(".gfp-open-external");
    expect(open, "the desktop must still offer Open in default app").toBeTruthy();
    click(h.window, open);
    await settle();
    expect(launched).toEqual(["app.bin"]);
  });

  it("offers nothing to open with when the host has no OS access", async () => {
    // The browser client: there is no default app to hand it to.
    const h = unopenable();
    await settle();
    await h.panel.openPath("app.bin");
    expect(h.document.querySelector(".gfp-open-external")).toBeNull();
    expect(h.document.querySelector(".gfp-viewer-body")?.textContent)
      .toContain("file type not previewable");
  });
});

// Copy path is always in the ⋯ menu, so a failed open still keeps the bar.
describe("the error tab's action row appears only when it has actions", () => {
  const unopenable = (withOs: boolean) => {
    const h = harness({
      read: async () => ({ ok: false, reason: "file type not previewable", openExternal: true }),
    });
    if (withOs) (h.access as any).openExternal = async () => ({ ok: true });
    return h;
  };

  it("keeps the bar so you can still copy the path", async () => {
    const h = unopenable(false);
    await settle();
    await h.panel.openPath("app.bin");
    expect(h.document.querySelector(".gfp-viewer-head")).toBeTruthy();
    expect(h.document.querySelector(".gfp-more")).toBeTruthy();
    expect(h.document.querySelector(".gfp-viewer-body")?.textContent)
      .toContain("file type not previewable");
  });

  it("keeps the bar where the host can still act on the file", async () => {
    const h = unopenable(true);
    await settle();
    await h.panel.openPath("app.bin");
    expect(h.document.querySelector(".gfp-viewer-head")).toBeTruthy();
    expect(h.document.querySelector(".gfp-more")).toBeTruthy();
  });
});

describe("title strip is a folder label plus file-type tabs", () => {
  it("renders the project root as a folder icon and a normal-weight name", async () => {
    const h = harness();
    await settle();
    const title = h.document.querySelector(".gfp-title");
    expect(title).toBeTruthy();
    expect(title!.querySelector(".gfp-title-icon")).toBeTruthy();
    expect(title!.querySelector(".gfp-title-icon svg, .gfp-title-icon img, .gfp-title-icon .gfp-file-icon-mono")).toBeTruthy();
    expect(title!.querySelector(".gfp-title-label")?.textContent).toBe("app");
    expect(title!.classList.contains("gfp-tab-active")).toBe(false);
    expect(title!.classList.contains("gfp-title-selected")).toBe(true);
  });

  it("puts a file-type icon on every tab via the shared fileIcons path", async () => {
    const h = harness({ fileIcons: { baseUrl: "https://icons.test/file-icons/" } });
    await settle();
    await h.panel.openPath("src/a.ts");
    await h.panel.openPath("notes.md");
    const tabs = [...h.document.querySelectorAll(".gfp-tab")];
    expect(tabs).toHaveLength(2);
    const srcs = tabs.map((tab) => {
      const img = tab.querySelector(".gfp-tab-icon img") as HTMLImageElement | null;
      const mono = tab.querySelector(".gfp-tab-icon .gfp-file-icon-mono") as HTMLElement | null;
      return img?.src || mono?.style.getPropertyValue("--gfp-icon-url") || "";
    });
    expect(srcs[0]).toMatch(/typescript\.svg/);
    expect(srcs[1]).toMatch(/markdown\.svg/);
    expect(h.document.querySelector(".gfp-title-icon img, .gfp-title-icon .gfp-file-icon-mono")).toBeTruthy();
  });

  it("stripShrinkState is compact at the default split and extreme near min width", () => {
    expect(STRIP_COMPACT_MAX).toBe(360);
    expect(STRIP_EXTREME_MAX).toBe(240);
    expect(stripShrinkState(280, 0)).toEqual({ compact: false, extreme: false });
    expect(stripShrinkState(280, 1)).toEqual({ compact: true, extreme: false });
    expect(stripShrinkState(361, 2)).toEqual({ compact: false, extreme: false });
    expect(stripShrinkState(360, 2)).toEqual({ compact: true, extreme: false });
    expect(stripShrinkState(240, 1)).toEqual({ compact: true, extreme: true });
    expect(stripShrinkState(0, 3)).toEqual({ compact: false, extreme: false });
  });

  it("stamps gfp-strip-compact and gfp-strip-extreme from the panel width", async () => {
    const h = harness();
    await settle();
    await h.panel.openPath("notes.md");
    const el = h.panel.element as HTMLElement & { getBoundingClientRect: () => DOMRect };
    el.getBoundingClientRect = () => ({ width: 280, height: 40, top: 0, left: 0, right: 280, bottom: 40, x: 0, y: 0, toJSON() { return {}; } }) as DOMRect;
    h.panel._applyStripShrink();
    expect(el.classList.contains("gfp-strip-compact")).toBe(true);
    expect(el.classList.contains("gfp-strip-extreme")).toBe(false);
    el.getBoundingClientRect = () => ({ width: 220, height: 40, top: 0, left: 0, right: 220, bottom: 40, x: 0, y: 0, toJSON() { return {}; } }) as DOMRect;
    h.panel._applyStripShrink();
    expect(el.classList.contains("gfp-strip-compact")).toBe(true);
    expect(el.classList.contains("gfp-strip-extreme")).toBe(true);
    el.getBoundingClientRect = () => ({ width: 480, height: 40, top: 0, left: 0, right: 480, bottom: 40, x: 0, y: 0, toJSON() { return {}; } }) as DOMRect;
    h.panel._applyStripShrink();
    expect(el.classList.contains("gfp-strip-compact")).toBe(false);
    expect(el.classList.contains("gfp-strip-extreme")).toBe(false);
  });
});

describe("desktop maximize is opt-in on the mount", () => {
  it("does not render the control unless the mount asks for it", async () => {
    const h = harness();
    await settle();
    expect(h.document.querySelector(".gfp-maximize")).toBeNull();
    expect(h.panel.isMaximized()).toBe(false);
    expect(h.panel.setMaximized(true)).toBe(false);
  });

  it("toggles the maximized class and restores on Escape", async () => {
    const seen: boolean[] = [];
    const h = harness({
      mount: { maximize: true, presentation: "dock" },
      onMaximizedChanged: (max) => { seen.push(max); },
    });
    await settle();
    h.panel.setOpen(true);
    const btn = h.document.querySelector(".gfp-maximize") as HTMLButtonElement | null;
    expect(btn).toBeTruthy();
    expect(btn!.getAttribute("aria-label")).toBe("Maximize file panel");
    click(h.window, btn);
    expect(h.panel.isMaximized()).toBe(true);
    expect(h.panel.element.classList.contains("gfp-maximized")).toBe(true);
    expect(h.document.body.classList.contains("desk-ft-maximized")).toBe(true);
    expect(btn!.getAttribute("aria-pressed")).toBe("true");
    expect(btn!.getAttribute("aria-label")).toBe("Restore file panel");
    expect(seen).toEqual([true]);

    h.window.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(h.panel.isMaximized()).toBe(false);
    expect(h.panel.element.classList.contains("gfp-maximized")).toBe(false);
    expect(h.document.body.classList.contains("desk-ft-maximized")).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it("closing the panel drops maximize so the next open is the split", async () => {
    const h = harness({ mount: { maximize: true, presentation: "dock" } });
    await settle();
    h.panel.setOpen(true);
    h.panel.setMaximized(true);
    expect(h.panel.isMaximized()).toBe(true);
    h.panel.setOpen(false);
    expect(h.panel.isMaximized()).toBe(false);
    h.panel.setOpen(true);
    expect(h.panel.isMaximized()).toBe(false);
    expect(h.panel.element.classList.contains("gfp-maximized")).toBe(false);
  });

  it("hides the control and drops maximize when the panel is an overlay", async () => {
    const seen: boolean[] = [];
    const window = new Window({ url: "https://example.test/" });
    const document = window.document;
    const panelHost = document.createElement("main");
    const dockHost = document.createElement("aside");
    dockHost.style.display = "block";
    document.body.append(panelHost, dockHost);
    const panel = createFilePanel({
      access: { currentScope: async () => null, list: async () => ({ ok: true, entries: [] }) },
      document,
      window,
      mount: { panelHost, dockHost, presentation: "responsive", maximize: true },
      onMaximizedChanged: (max) => { seen.push(max); },
    });
    panel.setOpen(true);
    await settle();
    expect(document.querySelector(".gfp-maximize")).toBeTruthy();
    expect((document.querySelector(".gfp-maximize") as HTMLButtonElement).hidden).toBe(false);
    panel.setMaximized(true);
    expect(panel.isMaximized()).toBe(true);

    dockHost.style.display = "none";
    window.dispatchEvent(new window.Event("resize"));
    expect(panel.element.classList.contains("gfp-overlay")).toBe(true);
    expect(panel.isMaximized()).toBe(false);
    expect((document.querySelector(".gfp-maximize") as HTMLButtonElement).hidden).toBe(true);
    expect(seen).toEqual([true, false]);
  });
});

describe("planStrip three-state layout", () => {
  const widths = (n: number, full: number, icon: number) => ({
    tabFullWidths: Array.from({ length: n }, () => full),
    tabIconWidths: Array.from({ length: n }, () => icon),
  });

  // Nothing selected means the Changes list or the tree is what you are
  // looking at. B's whole idea is "name the current file, demote the rest", so
  // with no current file it demotes ALL of them: a row of anonymous glyphs
  // with no names and — because an icon-only tab hides its close — no way to
  // shut any of them either. C is the honest answer at that width: one … chip
  // whose menu lists every file by name with its own X.
  it("never picks B when nothing is selected, however much room there is", () => {
    const base = {
      stripWidth: 400,
      titleWidth: 80,
      titleIconWidth: 24,
      trailingWidth: 32,
      tabCount: 3,
      ...widths(3, 160, 32),
      chipWidth: 36,
    };
    // Same width, same tabs: with a selection B is right and is chosen.
    expect(planStrip({ ...base, activeIndex: 1 }).state).toBe("b");
    const none = planStrip({ ...base, activeIndex: -1 });
    expect(none.state).toBe("c");
    // And C with no active tab shows the chip alone rather than a bare strip.
    expect(none.visible).toEqual([]);
    expect(none.overflow).toEqual([0, 1, 2]);
  });

  it("picks A when named tabs plus the title fit", () => {
    const plan = planStrip({
      stripWidth: 500,
      titleWidth: 80,
      titleIconWidth: 24,
      trailingWidth: 32,
      tabCount: 2,
      activeIndex: 0,
      ...widths(2, 120, 32),
      chipWidth: 36,
    });
    expect(plan.state).toBe("a");
    expect(plan.title).toBe("full");
    expect(plan.visible).toEqual([0, 1]);
    expect(plan.overflow).toEqual([]);
    expect(plan.tabModes).toEqual(["full", "full"]);
  });

  it("demotes inactive tabs to icon-only (B) before overflowing (C)", () => {
    const base = {
      titleWidth: 80,
      titleIconWidth: 24,
      trailingWidth: 32,
      tabCount: 3,
      activeIndex: 1,
      ...widths(3, 120, 32),
      chipWidth: 36,
    };
    // 80 + 3*120 = 440 > 330-32=298 → not A
    // 80 + 32 + 120 + 32 = 264 <= 298 → B, title kept; leftover 34 < gain 88
    // so no idle earns its name back — all-icon B.
    const tight = planStrip({ ...base, stripWidth: 330 });
    expect(tight.state).toBe("b");
    expect(tight.title).toBe("full");
    expect(tight.visible).toEqual([0, 1, 2]);
    expect(tight.overflow).toEqual([]);
    expect(tight.tabModes).toEqual(["icon", "full", "icon"]);

    // At 400 the leftover (368-264=104) covers one idle's gain (120-32=88):
    // the MOST RECENT idle gets its name back first (owner: with room, show
    // 2-3 names including the current one; icons for the rest).
    const roomy = planStrip({ ...base, stripWidth: 400 });
    expect(roomy.state).toBe("b");
    expect(roomy.tabModes).toEqual(["icon", "full", "full"]);

    // Title name no longer fits: 80 + 264-80 wait, bTabs=184, title 80 → 264
    // avail = 220-32 = 188. 80+184=264 > 188; 24+184=208 > 188 → C
    const squeezed = planStrip({ ...base, stripWidth: 220 });
    expect(squeezed.state).toBe("c");
    expect(squeezed.title).toBe("icon");
    expect(squeezed.visible).toEqual([1]);
    expect(squeezed.overflow).toEqual([0, 2]);
    expect(squeezed.tabModes).toEqual(["icon", "full", "icon"]);
  });

  it("skips B entirely on a touch screen, where an icon-only tab is anonymous", () => {
    // Same widths that produced an all-icon B above. A finger gets the chip
    // instead: three files became three identical glyphs, and the strip grew a
    // second ✕ beside the one that closes the panel.
    const base = {
      titleWidth: 80,
      titleIconWidth: 24,
      trailingWidth: 32,
      tabCount: 3,
      activeIndex: 1,
      ...widths(3, 120, 32),
      chipWidth: 36,
      stripWidth: 330,
    };
    expect(planStrip(base).state).toBe("b");

    const touch = planStrip({ ...base, preferChip: true });
    expect(touch.state).toBe("c");
    expect(touch.visible).toEqual([1]);
    expect(touch.overflow).toEqual([0, 2]);
    // 80 + 120 + 36 = 236 <= 298, so the project keeps its name — C is now
    // reached with room to spare and must not give the name up for nothing.
    expect(touch.title).toBe("full");

    // A fits on its own; preferChip is about B, not about hiding what fits.
    expect(planStrip({ ...base, preferChip: true, stripWidth: 600 }).state).toBe("a");
  });

  it("hides every tab in C when nothing is active, rather than picking one", () => {
    // The Changes list is showing: no file is being viewed, so the chip holds
    // all of them and the strip has exactly one selected thing in it.
    const plan = planStrip({
      titleWidth: 80,
      titleIconWidth: 24,
      trailingWidth: 32,
      tabCount: 3,
      activeIndex: -1,
      ...widths(3, 120, 32),
      chipWidth: 36,
      stripWidth: 330,
      preferChip: true,
    });
    expect(plan.state).toBe("c");
    expect(plan.visible).toEqual([]);
    expect(plan.overflow).toEqual([0, 1, 2]);
  });

  it("keeps the active tab visible when overflowing and updates membership as it changes", () => {
    const input = {
      stripWidth: 160,
      titleWidth: 80,
      titleIconWidth: 24,
      trailingWidth: 32,
      tabCount: 4,
      ...widths(4, 130, 36),
      chipWidth: 36,
    };
    const first = planStrip({ ...input, activeIndex: 0 });
    expect(first.state).toBe("c");
    expect(first.visible).toEqual([0]);
    expect(first.overflow).toEqual([1, 2, 3]);

    const last = planStrip({ ...input, activeIndex: 3 });
    expect(last.state).toBe("c");
    expect(last.visible).toEqual([3]);
    expect(last.overflow).toEqual([0, 1, 2]);

    const tree = planStrip({ ...input, activeIndex: -1 });
    expect(tree.state).toBe("c");
    expect(tree.visible).toEqual([]);
    expect(tree.overflow).toEqual([0, 1, 2, 3]);
  });

  it("honors slack so a barely-fitting A becomes B", () => {
    const input = {
      stripWidth: 300,
      titleWidth: 80,
      titleIconWidth: 24,
      trailingWidth: 20,
      tabCount: 1,
      activeIndex: 0,
      tabFullWidths: [200],
      tabIconWidths: [32],
      chipWidth: 36,
    };
    expect(planStrip(input).state).toBe("a");
    expect(planStrip({ ...input, slack: 1 }).state).toBe("b");
  });

  it("stays on A when there is no layout (happy-dom zeros) so DOM tests still see names", () => {
    const plan = planStrip({
      stripWidth: 0,
      titleWidth: 0,
      titleIconWidth: 0,
      trailingWidth: 0,
      tabCount: 5,
      activeIndex: 2,
      ...widths(5, 0, 0),
      chipWidth: 36,
    });
    expect(plan.state).toBe("a");
    expect(plan.visible).toEqual([0, 1, 2, 3, 4]);
    expect(plan.overflow).toEqual([]);
  });
});

describe("tab strip structure follows the overflow design", () => {
  it("renders a close button on every named tab, active or not", async () => {
    const h = harness();
    await settle();
    await h.panel.openPath("src/a.ts");
    await h.panel.openPath("notes.md");
    const tabs = [...h.document.querySelectorAll(".gfp-tab")];
    expect(tabs).toHaveLength(2);
    // Closing a file must not require opening it first — the phone case, where
    // State C shows one tab and the rest live in the … menu.
    expect(tabs[0].classList.contains("gfp-tab-active")).toBe(false);
    expect(tabs[0].querySelector(".gfp-tab-close")).toBeTruthy();
    expect(tabs[1].classList.contains("gfp-tab-active")).toBe(true);
    expect(tabs[1].querySelector(".gfp-tab-close")).toBeTruthy();
    expect(tabs.every((tab) => tab.querySelector(".gfp-tab-icon"))).toBe(true);
  });

  it("a forced C plan paints the chip, lists the other tabs, and activates on click", async () => {
    const h = harness({ fileIcons: { baseUrl: "https://icons.test/file-icons/" } });
    await settle();
    await openAndEdit(h, "notes.md", "draft");
    await h.panel.openPath("src/a.ts");
    await h.panel.openPath("src/b.ts");
    const tabs = [...h.document.querySelectorAll(".gfp-tab")];
    expect(tabs).toHaveLength(3);
    const activeIndex = tabs.findIndex((tab) => tab.classList.contains("gfp-tab-active"));
    expect(activeIndex).toBe(2);

    h.panel._forceStripPlan(planStrip({
      stripWidth: 80,
      titleWidth: 80,
      titleIconWidth: 24,
      trailingWidth: 0,
      tabCount: 3,
      activeIndex,
      tabFullWidths: [120, 120, 120],
      tabIconWidths: [32, 32, 32],
      chipWidth: 36,
    }));

    const chip = h.document.querySelector(".gfp-overflow-chip") as HTMLButtonElement | null;
    expect(chip).toBeTruthy();
    expect(chip!.textContent).toBe("…");
    expect(chip!.title).toContain("notes.md");
    expect(chip!.title).toContain("a.ts");
    expect(chip!.title).not.toContain("b.ts");

    const visible = [...h.document.querySelectorAll(".gfp-tab")].filter((tab) => !(tab as HTMLElement).hidden);
    expect(visible).toHaveLength(1);
    expect(visible[0].querySelector(".gfp-tab-icon")).toBeTruthy();
    expect(visible[0].querySelector(".gfp-tab-close")).toBeTruthy();
    const hiddenTabs = [...h.document.querySelectorAll(".gfp-tab")].filter((tab) => (tab as HTMLElement).hidden);
    expect(hiddenTabs).toHaveLength(2);

    click(h.window, chip);
    await settle();
    const menu = h.document.querySelector(".gfp-overflow-menu");
    expect(menu).toBeTruthy();
    click(h.window, h.document.querySelector(".gfp-overflow-chip"));
    await settle();
    expect(h.document.querySelector(".gfp-overflow-menu")).toBeNull();
    click(h.window, h.document.querySelector(".gfp-overflow-chip"));
    await settle();
    const reopened = h.document.querySelector(".gfp-overflow-menu");
    expect(reopened).toBeTruthy();
    const rows = [...reopened!.querySelectorAll(".gfp-overflow-item")];
    expect(rows.map((row) => row.querySelector(".gfp-overflow-name")?.textContent)).toEqual(["notes.md", "a.ts"]);
    expect(rows.every((row) => row.querySelector(".gfp-tab-icon"))).toBe(true);
    expect(rows[0].querySelector(".gfp-overflow-dirty")?.textContent).toBe("•");
    expect(rows[1].querySelector(".gfp-overflow-dirty")).toBeNull();

    click(h.window, rows[0]);
    await settle();
    expect(h.document.querySelector(".gfp-tab-active .gfp-tab-name")?.textContent).toBe("notes.md");
    expect((h.document.querySelector(".gfp-editor") as HTMLTextAreaElement).value).toBe("draft");
  });

  it("closes a file from the overflow menu, which is the only strip a phone has", async () => {
    // In State C every file but the active one lives in this menu. Without a
    // close here, shutting five files meant opening five files first.
    const h = harness();
    await settle();
    await h.panel.openPath("notes.md");
    await h.panel.openPath("src/a.ts");
    await h.panel.openPath("src/b.ts");
    h.panel._forceStripPlan(planStrip({
      stripWidth: 80,
      titleWidth: 80,
      titleIconWidth: 24,
      trailingWidth: 0,
      tabCount: 3,
      activeIndex: 2,
      tabFullWidths: [120, 120, 120],
      tabIconWidths: [32, 32, 32],
      chipWidth: 36,
    }));
    click(h.window, h.document.querySelector(".gfp-overflow-chip"));
    await settle();
    const rows = [...h.document.querySelectorAll(".gfp-overflow-row")];
    expect(rows).toHaveLength(2);

    click(h.window, rows[0].querySelector(".gfp-overflow-close"));
    await settle();
    await settle();
    // The file is gone, the one that was open is still the one open, and the
    // menu — a list of tabs, now stale — has dismissed itself.
    const names = [...h.document.querySelectorAll(".gfp-tab-name")].map((el) => el.textContent);
    expect(names).toEqual(["a.ts", "b.ts"]);
    expect(h.document.querySelector(".gfp-tab-active .gfp-tab-name")?.textContent).toBe("b.ts");
    expect(h.document.querySelector(".gfp-overflow-menu")).toBeNull();
  });

  it("marks the title as selected in treeMode and not while a file is showing", async () => {
    const h = harness();
    await settle();
    const title = h.document.querySelector(".gfp-title")!;
    expect(title.classList.contains("gfp-title-selected")).toBe(true);
    await h.panel.openPath("notes.md");
    expect(title.classList.contains("gfp-title-selected")).toBe(false);
    title.dispatchEvent(new h.window.MouseEvent("click", { bubbles: true }));
    await settle();
    expect(title.classList.contains("gfp-title-selected")).toBe(true);
  });
});

describe("file-tree row actions stay on hover / keyboard / open menu, not a mouse click", () => {
  async function openTree() {
    const h = harness();
    injectPanelCss(h.document);
    h.panel.setOpen(true);
    await settle();
    const row = treeRow(h.document, "notes.md");
    expect(row).toBeTruthy();
    const more = row!.querySelector(".gfp-icon-button") as HTMLButtonElement | null;
    expect(more).toBeTruthy();
    return { h, row: row as HTMLElement, more: more! };
  }

  it("a mouse click on a row does not leave its actions visible once the pointer leaves", async () => {
    const { h, row, more } = await openTree();
    expect(actionsDisplay(row)).toBe("none");
    click(h.window, row);
    await settle();
    expect(more.getAttribute("aria-expanded")).toBe("false");
    row.dispatchEvent(new h.window.MouseEvent("mouseleave", { bubbles: true }));
    // A mouse click must not pin the ⋯ via :focus-within. happy-dom does not
    // focus a tabindex row on click; if it starts treating click as
    // :focus-visible, the CSS source test is the remaining contract.
    if (row.matches(":focus-visible") || row.querySelector(":focus-visible")) {
      expect(filePanelCss).not.toMatch(/\.gfp-row:focus-within\s+\.gfp-row-actions/);
    } else {
      expect(actionsDisplay(row)).toBe("none");
    }
    h.panel.destroy();
  });

  it("a keyboard-focused row shows its actions", async () => {
    const { h, row, more } = await openTree();
    row.focus();
    expect(h.document.activeElement).toBe(row);
    if (!row.matches(":focus-visible")) more.focus();
    if (row.matches(":focus-visible") || more.matches(":focus-visible")) {
      expect(actionsDisplay(row)).toBe("flex");
    } else {
      expect(filePanelCss).toMatch(/\.gfp-row:focus-visible \.gfp-row-actions/);
      expect(filePanelCss).toMatch(/\.gfp-row:has\(:focus-visible\) \.gfp-row-actions/);
    }
    h.panel.destroy();
  });

  it("an open overflow menu keeps its row's actions visible", async () => {
    const { h, row, more } = await openTree();
    expect(actionsDisplay(row)).toBe("none");
    row.classList.add("gfp-menu-open");
    expect(actionsDisplay(row)).toBe("flex");
    row.classList.remove("gfp-menu-open");
    expect(actionsDisplay(row)).toBe("none");

    click(h.window, more);
    await settle();
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(row.classList.contains("gfp-menu-open")).toBe(true);
    expect(h.document.querySelector(".gfp-menu")).toBeTruthy();
    more.blur();
    expect(actionsDisplay(row)).toBe("flex");

    h.document.body.dispatchEvent(new h.window.MouseEvent("click", { bubbles: true }));
    await settle();
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(row.classList.contains("gfp-menu-open")).toBe(false);
    expect(h.document.querySelector(".gfp-menu")).toBeNull();
    h.panel.destroy();
  });
});

/**
 * A listing is cached for the lifetime of the scope and nothing invalidates it,
 * so a file the agent wrote while you were reading is invisible until somebody
 * asks for the folder again (#134). These cover the asking.
 */
function refreshButton(document: Document): HTMLButtonElement {
  const button = document.querySelector(".gfp-refresh") as HTMLButtonElement | null;
  expect(button).toBeTruthy();
  return button!;
}

type Entry = { name: string; kind: string; relPath: string };

function listingHarness(options?: { truncated?: string[] }) {
  const calls: string[] = [];
  const gates = new Map<string, ReturnType<typeof deferred<void>>>();
  const dirs: Record<string, Entry[]> = {
    "": [
      { name: "src", kind: "dir", relPath: "src" },
      { name: "notes.md", kind: "file", relPath: "notes.md" },
    ],
    src: [{ name: "a.ts", kind: "file", relPath: "src/a.ts" }],
  };
  const failing = new Set<string>();
  const h = harness({
    list: async (_scopeId: string, relPath: string) => {
      calls.push(relPath);
      const gate = gates.get(relPath);
      if (gate) await gate.promise;
      if (failing.has(relPath)) return { ok: false, reason: "listing failed" };
      const entries = dirs[relPath];
      if (!entries) return { ok: false, reason: "not found" };
      return { ok: true, entries, truncated: !!options?.truncated?.includes(relPath) };
    },
  });
  return {
    ...h,
    calls,
    dirs,
    fail: (relPath: string) => failing.add(relPath),
    /** Hold a listing open so the in-flight state can be observed. */
    hold(relPath: string) {
      const gate = deferred<void>();
      gates.set(relPath, gate);
      return () => { gates.delete(relPath); gate.resolve(); };
    },
  };
}

describe("refreshing the file tree", () => {
  it("picks up what was written since, and leaves your folders open", async () => {
    const h = listingHarness();
    h.panel.setOpen(true);
    await settle();
    click(h.window, treeRow(h.document, "src"));
    await settle();
    expect(treeRow(h.document, "a.ts")).toBeTruthy();

    // The agent writes at the root and inside the folder you are looking at.
    h.dirs[""].push({ name: "Card.tsx", kind: "file", relPath: "Card.tsx" });
    h.dirs.src.push({ name: "b.ts", kind: "file", relPath: "src/b.ts" });
    expect(treeRow(h.document, "Card.tsx")).toBeFalsy();

    click(h.window, refreshButton(h.document));
    await settle();

    expect(treeRow(h.document, "Card.tsx")).toBeTruthy();
    // Both halves matter: an expanded folder that came back collapsed, or came
    // back open but stale, would make the button not worth pressing.
    const src = h.document.querySelector('.gfp-node[data-rel="src"]')!;
    expect(src.classList.contains("gfp-expanded")).toBe(true);
    expect(treeRow(h.document, "b.ts")).toBeTruthy();
    h.panel.destroy();
  });

  it("keeps open tabs and the filter you typed", async () => {
    const h = listingHarness();
    h.panel.setOpen(true);
    await settle();
    await h.panel.openPath("notes.md");
    await settle();
    h.panel.element.querySelector(".gfp-title")?.dispatchEvent(new h.window.MouseEvent("click", { bubbles: true }));
    await settle();
    const filter = h.document.querySelector(".gfp-filter") as HTMLInputElement;
    filter.value = "note";
    filter.dispatchEvent(new h.window.Event("input", { bubbles: true }));
    await settle();

    click(h.window, refreshButton(h.document));
    await settle();

    expect(h.document.querySelector(".gfp-tab")).toBeTruthy();
    expect((h.document.querySelector(".gfp-filter") as HTMLInputElement).value).toBe("note");
    // The filter is still doing its job on the rebuilt rows, not just sitting
    // in the input.
    expect((h.document.querySelector('.gfp-node[data-rel="src"]') as HTMLElement).hidden).toBe(true);
    h.panel.destroy();
  });

  it("goes away in the viewer, where the file's own Reload is the answer", async () => {
    const h = listingHarness();
    h.panel.setOpen(true);
    await settle();
    expect(refreshButton(h.document).hidden).toBe(false);

    await h.panel.openPath("notes.md");
    await settle();
    expect(refreshButton(h.document).hidden).toBe(true);

    h.panel.element.querySelector(".gfp-title")?.dispatchEvent(new h.window.MouseEvent("click", { bubbles: true }));
    await settle();
    expect(refreshButton(h.document).hidden).toBe(false);
    h.panel.destroy();
  });

  it("dims the listing it is replacing and refuses a second press meanwhile", async () => {
    const h = listingHarness();
    h.panel.setOpen(true);
    await settle();
    const release = h.hold("");
    const before = h.calls.length;

    click(h.window, refreshButton(h.document));
    await settle();
    expect(h.panel.element.classList.contains("gfp-refreshing")).toBe(true);
    expect(refreshButton(h.document).disabled).toBe(true);
    // The old rows are still there — dimmed, not wiped to "Loading…".
    expect(treeRow(h.document, "notes.md")).toBeTruthy();

    click(h.window, refreshButton(h.document));
    await settle();
    expect(h.calls.length).toBe(before + 1);

    release();
    await settle();
    expect(h.panel.element.classList.contains("gfp-refreshing")).toBe(false);
    expect(refreshButton(h.document).disabled).toBe(false);
    h.panel.destroy();
  });

  it("keeps the tree it had when the refresh fails", async () => {
    const h = listingHarness();
    h.panel.setOpen(true);
    await settle();
    h.fail("");

    click(h.window, refreshButton(h.document));
    await settle();

    // A failed refresh is a failed refresh, not a reason to lose a listing that
    // was working.
    expect(treeRow(h.document, "notes.md")).toBeTruthy();
    expect(h.document.querySelector(".gfp-error")?.textContent).toBe("listing failed");
    h.panel.destroy();
  });

  it("re-lists one folder from its row menu", async () => {
    const h = listingHarness();
    h.panel.setOpen(true);
    await settle();
    click(h.window, treeRow(h.document, "src"));
    await settle();
    h.dirs.src.push({ name: "b.ts", kind: "file", relPath: "src/b.ts" });

    treeRow(h.document, "src")!.dispatchEvent(new h.window.MouseEvent("contextmenu", {
      bubbles: true, cancelable: true,
    }));
    await settle();
    click(h.window, menuItem(h.document, "Refresh this folder"));
    await settle();

    expect(treeRow(h.document, "b.ts")).toBeTruthy();
    // Re-listing a folder never closes it.
    expect(h.document.querySelector('.gfp-node[data-rel="src"]')!.classList.contains("gfp-expanded")).toBe(true);
    h.panel.destroy();
  });

  it("offers the cure inside an empty folder, where the doubt is", async () => {
    const h = listingHarness();
    h.dirs.src = [];
    h.panel.setOpen(true);
    await settle();
    click(h.window, treeRow(h.document, "src"));
    await settle();
    const children = h.document.querySelector('.gfp-node[data-rel="src"] > .gfp-children')!;
    expect(children.textContent).toContain("Empty folder");

    h.dirs.src = [{ name: "b.ts", kind: "file", relPath: "src/b.ts" }];
    click(h.window, children.querySelector(".gfp-status-actions .gfp-action"));
    await settle();

    expect(treeRow(h.document, "b.ts")).toBeTruthy();
    h.panel.destroy();
  });

  it("stops asking for a folder its parent no longer lists", async () => {
    const h = listingHarness();
    h.panel.setOpen(true);
    await settle();
    click(h.window, treeRow(h.document, "src"));
    await settle();

    h.dirs[""] = [{ name: "notes.md", kind: "file", relPath: "notes.md" }];
    click(h.window, refreshButton(h.document));
    await settle();
    expect(treeRow(h.document, "src")).toBeFalsy();

    // A deleted folder would otherwise cost a request on every refresh from
    // here on.
    const before = h.calls.length;
    click(h.window, refreshButton(h.document));
    await settle();
    expect(h.calls.slice(before)).toEqual([""]);
    h.panel.destroy();
  });

  it("refreshes a nested folder that a collapse-and-reopen left open", async () => {
    // Reopening a still-loaded parent does not rebuild its children, so the
    // folder inside it comes back visibly open. What is on screen open must be
    // what gets refreshed — otherwise refresh quietly closes it and throws away
    // the very listing the user was looking at.
    const h = listingHarness();
    h.dirs.src = [{ name: "deep", kind: "dir", relPath: "src/deep" }];
    h.dirs["src/deep"] = [{ name: "x.ts", kind: "file", relPath: "src/deep/x.ts" }];
    h.panel.setOpen(true);
    await settle();
    click(h.window, treeRow(h.document, "src"));
    await settle();
    click(h.window, treeRow(h.document, "deep"));
    await settle();
    click(h.window, treeRow(h.document, "src")); // collapse
    await settle();
    click(h.window, treeRow(h.document, "src")); // and reopen
    await settle();

    const before = h.calls.length;
    click(h.window, refreshButton(h.document));
    await settle();

    expect(h.calls.slice(before)).toEqual(["", "src", "src/deep"]);
    expect(h.document.querySelector('.gfp-node[data-rel="src/deep"]')!.classList.contains("gfp-expanded")).toBe(true);
    expect(treeRow(h.document, "x.ts")).toBeTruthy();
    h.panel.destroy();
  });
});

describe("a refresh left running on a project you left", () => {
  it("never dims or freezes the project you switched to", async () => {
    // The panel element is shared between scopes, so a class parked on it by
    // A's refresh lands on B's tree — and it carries pointer-events: none, so
    // B becomes untappable. The adapters ignore the abort signal, which makes
    // that wait 30s on a remote and open-ended on the desk.
    const h = listingHarness();
    h.panel.setOpen(true);
    await settle();
    click(h.window, treeRow(h.document, "src"));
    await settle();
    const release = h.hold("src");

    click(h.window, refreshButton(h.document));
    await settle();
    expect(h.panel.element.classList.contains("gfp-refreshing")).toBe(true);

    await h.switchScope(h.scopes.b);
    expect(h.panel.element.classList.contains("gfp-refreshing")).toBe(false);

    release();
    await settle();
    // And the straggler must not reach back and re-dim the scope on screen.
    expect(h.panel.element.classList.contains("gfp-refreshing")).toBe(false);
    h.panel.destroy();
  });
});

describe("forgetting a deleted subtree", () => {
  it("drops the children of a folder that is gone, not just the folder", async () => {
    // Pruning the parent removes the listing that would have proved the child
    // gone, so judging children after parents — without carrying the verdict
    // down — leaves them remembered and re-requested on every later refresh.
    const h = listingHarness();
    h.dirs.src = [{ name: "deep", kind: "dir", relPath: "src/deep" }];
    h.dirs["src/deep"] = [{ name: "x.ts", kind: "file", relPath: "src/deep/x.ts" }];
    h.panel.setOpen(true);
    await settle();
    click(h.window, treeRow(h.document, "src"));
    await settle();
    click(h.window, treeRow(h.document, "deep"));
    await settle();

    h.dirs[""] = [{ name: "notes.md", kind: "file", relPath: "notes.md" }];
    click(h.window, refreshButton(h.document));
    await settle();
    expect(treeRow(h.document, "src")).toBeFalsy();

    const before = h.calls.length;
    click(h.window, refreshButton(h.document));
    await settle();
    expect(h.calls.slice(before)).toEqual([""]);
    h.panel.destroy();
  });
});

describe("collapsing a folder", () => {
  it("stops remembering what was open inside it", async () => {
    // Otherwise a descendant outlives its parent in `expanded`, and once the
    // parent is collapsed no refresh ever fetches the listing that would prove
    // the child gone — so a deleted subtree is re-requested for ever.
    const h = listingHarness();
    h.dirs.src = [{ name: "deep", kind: "dir", relPath: "src/deep" }];
    h.dirs["src/deep"] = [{ name: "x.ts", kind: "file", relPath: "src/deep/x.ts" }];
    h.panel.setOpen(true);
    await settle();
    click(h.window, treeRow(h.document, "src"));
    await settle();
    click(h.window, treeRow(h.document, "deep"));
    await settle();

    click(h.window, treeRow(h.document, "src")); // collapse the parent
    await settle();

    const before = h.calls.length;
    click(h.window, refreshButton(h.document));
    await settle();
    // Only the root: neither the collapsed folder nor anything under it.
    expect(h.calls.slice(before)).toEqual([""]);
    h.panel.destroy();
  });
});
