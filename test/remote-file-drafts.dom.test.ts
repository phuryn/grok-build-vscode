/**
 * Remote integration coverage for the shared file panel.
 *
 * These tests deliberately drive the relay message boundary instead of calling
 * GrokFilePanel directly. A response is only delivered after the browser has
 * emitted the matching request, and (except for the explicit released-host
 * compatibility case) it echoes that request's requestId. This is the layer
 * that protects a draft from a late answer belonging to another repo or read.
 *
 * Drafts are memory-only and scoped by cwd inside the shared component. Hiding
 * or navigating to the tree keeps them; Cancel and closing a dirty tab ask;
 * page unload still warns while any scope owns dirty text.
 */
import { describe, expect, it, vi } from "vitest";
import { bootWebview, click, dispatch, type Harness, type Posted } from "./webview-harness";

const CWD_A = "/work/app";
const CWD_B = "/work/relay";

type FileRequest = Posted & {
  cwd: string;
  relPath?: string;
  requestId: string;
};

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function remoteHost(edit = true): Harness {
  const h = bootWebview({ remote: true });
  dispatch(h.window, {
    type: "initialState",
    cwd: CWD_A,
    capabilities: { browseProjectFiles: true, ...(edit ? { editProjectFiles: true } : {}) },
  });
  dispatch(h.window, {
    type: "repos",
    entries: [
      { cwd: CWD_A, label: "app", available: true, pinned: false, updatedAt: 2 },
      { cwd: CWD_B, label: "relay", available: true, pinned: false, updatedAt: 1 },
    ],
    selectedCwd: CWD_A,
    activeCwd: CWD_A,
  });
  return h;
}

function requests(h: Harness, type: string): FileRequest[] {
  return h.posted.filter((message) => message.type === type) as FileRequest[];
}

function requestAt(h: Harness, type: string, index: number): FileRequest {
  const request = requests(h, type)[index];
  expect(request, `missing ${type} request ${index}`).toBeTruthy();
  expect(request.requestId).toMatch(/^file-\d+$/);
  return request;
}

async function reply(
  h: Harness,
  request: FileRequest,
  data: Posted,
  options: { legacy?: boolean } = {},
): Promise<void> {
  dispatch(h.window, {
    ...data,
    cwd: request.cwd,
    relPath: request.relPath || "",
    ...(options.legacy ? {} : { requestId: request.requestId }),
  });
  await settle();
}

async function listRoot(
  h: Harness,
  names: Array<string | { name: string; kind: "file" | "dir" }>,
  requestIndex = requests(h, "listProjectDir").length - 1,
  legacy = false,
): Promise<FileRequest> {
  const request = requestAt(h, "listProjectDir", requestIndex);
  await reply(h, request, {
    type: "projectDirListing",
    ok: true,
    entries: names.map((entry) => {
      const item = typeof entry === "string" ? { name: entry, kind: "file" as const } : entry;
      return {
        name: item.name,
        kind: item.kind,
        relPath: request.relPath ? `${request.relPath}/${item.name}` : item.name,
      };
    }),
    truncated: false,
  }, { legacy });
  return request;
}

async function openPanel(h: Harness, names: Array<string | { name: string; kind: "file" | "dir" }>): Promise<void> {
  await settle();
  const before = requests(h, "listProjectDir").length;
  click(h.window, h.doc.getElementById("files-browse-btn")!);
  await settle();
  expect(requests(h, "listProjectDir")).toHaveLength(before + 1);
  await listRoot(h, names, before);
}

async function openFile(
  h: Harness,
  relPath: string,
  text: string,
  options: {
    kind?: "text" | "markdown" | "json";
    stamp?: { mtimeMs: number; size: number };
    absPath?: string;
    legacy?: boolean;
  } = {},
): Promise<FileRequest | null> {
  const row = [...h.doc.querySelectorAll(".files-browse-row")].find(
    (candidate) => (candidate.textContent || "").includes(relPath.split("/").at(-1)!),
  );
  expect(row, `no row for ${relPath}`).toBeTruthy();
  const before = requests(h, "readProjectFile").length;
  click(h.window, row!);
  await settle();
  // Clicking a file that already has a tab activates it without re-reading.
  if (requests(h, "readProjectFile").length === before) return null;
  const request = requestAt(h, "readProjectFile", before);
  expect(request.relPath).toBe(relPath);
  await reply(h, request, {
    type: "projectFileContent",
    ok: true,
    kind: options.kind || "text",
    text,
    stamp: options.stamp || { mtimeMs: 1, size: text.length },
    absPath: options.absPath || `/abs/${request.cwd}${relPath}`,
  }, { legacy: options.legacy });
  return request;
}

function editor(h: Harness): HTMLTextAreaElement {
  const element = h.doc.querySelector(".files-browse-editor") as HTMLTextAreaElement | null;
  expect(element).toBeTruthy();
  return element!;
}

function viewerText(h: Harness): string {
  return h.doc.querySelector(".gfp-viewer-body")?.textContent || "";
}

function setEditor(h: Harness, value: string): void {
  const element = editor(h);
  element.value = value;
  element.dispatchEvent(new (h.window as never as { Event: typeof Event }).Event("input", { bubbles: true }));
}

function button(h: Harness, label: string, within = h.doc): Element {
  const found = [...within.querySelectorAll("button")].find((item) => item.textContent === label);
  expect(found, `no ${label} button`).toBeTruthy();
  return found!;
}

function beginEdit(h: Harness, value: string): void {
  const edit = h.doc.querySelector(".gfp-edit");
  expect(edit, "no Edit button").toBeTruthy();
  click(h.window, edit!);
  setEditor(h, value);
}

function backToTree(h: Harness): void {
  // The project title is the way back to the tree. The viewer's own back
  // chevron was removed: with the tab strip naming the file and the title
  // beside it, the breadcrumb row was a third copy of the same two facts.
  click(h.window, h.doc.querySelector(".gfp-title")!);
}

async function choose(h: Harness, label: string): Promise<void> {
  const overlay = h.doc.querySelector(".confirm-overlay");
  expect(overlay).toBeTruthy();
  click(h.window, button(h, label, overlay!));
  await settle();
}

async function switchRepo(h: Harness, cwd: string): Promise<void> {
  dispatch(h.window, {
    type: "repos",
    entries: [
      { cwd: CWD_A, label: "app", available: true, pinned: false, updatedAt: 2 },
      { cwd: CWD_B, label: "relay", available: true, pinned: false, updatedAt: 1 },
    ],
    selectedCwd: cwd,
    activeCwd: CWD_A,
  });
  await settle();
}

function beforeUnload(h: Harness): Event {
  const event = new (h.window as never as { Event: typeof Event }).Event("beforeunload", {
    cancelable: true,
  });
  h.window.dispatchEvent(event as never);
  return event;
}

describe("remote shared file panel request boundary", () => {
  it("correlates list and read replies with additive requestIds", async () => {
    const h = remoteHost();
    await openPanel(h, ["notes.txt"]);
    const read = await openFile(h, "notes.txt", "one");

    expect(read?.requestId).toMatch(/^file-\d+$/);
    expect(viewerText(h)).toBe("one");
  });

  it("still accepts released-host replies that do not echo requestId", async () => {
    const h = remoteHost();
    await settle();
    const before = requests(h, "listProjectDir").length;
    click(h.window, h.doc.getElementById("files-browse-btn")!);
    await settle();
    await listRoot(h, ["legacy.txt"], before, true);
    await openFile(h, "legacy.txt", "old host", { legacy: true });

    expect(viewerText(h)).toBe("old host");
  });

  it("ignores an answer carrying an unknown requestId", async () => {
    const h = remoteHost();
    await openPanel(h, ["notes.txt"]);
    const before = requests(h, "readProjectFile").length;
    click(h.window, h.doc.querySelector(".files-browse-row")!);
    await settle();
    const read = requestAt(h, "readProjectFile", before);

    dispatch(h.window, {
      type: "projectFileContent",
      ok: true,
      cwd: read.cwd,
      relPath: read.relPath,
      requestId: "file-not-this-request",
      kind: "text",
      text: "wrong",
      stamp: { mtimeMs: 1, size: 5 },
      absPath: "/abs/wrong",
    });
    await settle();
    expect(h.doc.querySelector(".files-browse-editor")).toBeNull();

    await reply(h, read, {
      type: "projectFileContent",
      ok: true,
      kind: "text",
      text: "right",
      stamp: { mtimeMs: 1, size: 5 },
      absPath: "/abs/right",
    });
    expect(viewerText(h)).toBe("right");
  });

  it("ignores the right requestId when the response names another repo", async () => {
    const h = remoteHost();
    await openPanel(h, ["notes.txt"]);
    const before = requests(h, "readProjectFile").length;
    click(h.window, h.doc.querySelector(".files-browse-row")!);
    await settle();
    const read = requestAt(h, "readProjectFile", before);
    dispatch(h.window, {
      type: "projectFileContent",
      ok: true,
      cwd: CWD_B,
      relPath: read.relPath,
      requestId: read.requestId,
      kind: "text",
      text: "OTHER PROJECT",
      stamp: { mtimeMs: 1, size: 13 },
      absPath: "/abs/other",
    });
    await settle();
    expect(h.doc.body.textContent).not.toContain("OTHER PROJECT");

    await reply(h, read, {
      type: "projectFileContent",
      ok: true,
      kind: "text",
      text: "this project",
      stamp: { mtimeMs: 1, size: 12 },
      absPath: "/abs/right",
    });
    expect(viewerText(h)).toBe("this project");
  });

  it("sends nested-directory reads with the path the user expanded", async () => {
    const h = remoteHost();
    await openPanel(h, [{ name: "src", kind: "dir" }]);
    const before = requests(h, "listProjectDir").length;
    click(h.window, h.doc.querySelector(".files-browse-row")!);
    await settle();
    const nested = requestAt(h, "listProjectDir", before);
    expect(nested.relPath).toBe("src");
    await reply(h, nested, {
      type: "projectDirListing",
      ok: true,
      entries: [{ name: "index.ts", kind: "file", relPath: "src/index.ts" }],
      truncated: false,
    });

    expect(h.doc.querySelector("[data-rel='src/index.ts']")).toBeTruthy();
  });
});

describe("remote drafts and scope identity", () => {
  it("keeps a draft when returning to the tree and supports multiple tabs", async () => {
    const h = remoteHost();
    await openPanel(h, ["a.txt", "b.txt"]);
    await openFile(h, "a.txt", "A");
    beginEdit(h, "A edited");
    backToTree(h);
    await openFile(h, "b.txt", "B");

    expect(h.doc.querySelectorAll(".gfp-tab")).toHaveLength(2);
    click(h.window, [...h.doc.querySelectorAll(".gfp-tab")].find((tab) => tab.textContent!.includes("a.txt"))!);
    expect(editor(h).value).toBe("A edited");
    expect(h.doc.querySelector(".gfp-tab-dirty")?.textContent).toContain("•");
  });

  it("does not leak same-named content or drafts between projects", async () => {
    const h = remoteHost();
    await openPanel(h, ["notes.txt"]);
    await openFile(h, "notes.txt", "A disk");
    beginEdit(h, "SECRET FROM A");

    const listCount = requests(h, "listProjectDir").length;
    await switchRepo(h, CWD_B);
    expect(requests(h, "listProjectDir")).toHaveLength(listCount + 1);
    await listRoot(h, ["notes.txt"], listCount);
    await openFile(h, "notes.txt", "B disk");
    expect(viewerText(h)).toBe("B disk");

    await switchRepo(h, CWD_A);
    expect(editor(h).value).toBe("SECRET FROM A");
  });

  it("binds a read result to the requesting scope, not the latest successful read", async () => {
    const h = remoteHost();
    await openPanel(h, ["notes.txt"]);
    const beforeRead = requests(h, "readProjectFile").length;
    click(h.window, h.doc.querySelector(".files-browse-row")!);
    await settle();
    const readA = requestAt(h, "readProjectFile", beforeRead);

    const beforeList = requests(h, "listProjectDir").length;
    await switchRepo(h, CWD_B);
    await listRoot(h, ["notes.txt"], beforeList);
    await reply(h, readA, {
      type: "projectFileContent",
      ok: true,
      kind: "text",
      text: "PROJECT A CONTENTS",
      stamp: { mtimeMs: 1, size: 18 },
      absPath: "/abs/a/notes.txt",
    });

    expect(h.doc.body.textContent).not.toContain("PROJECT A CONTENTS");
    await openFile(h, "notes.txt", "PROJECT B CONTENTS", { absPath: "/abs/b/notes.txt" });
    expect(viewerText(h)).toBe("PROJECT B CONTENTS");
  });

  it("uses the original version stamp after a draft has been out of view", async () => {
    const h = remoteHost();
    await openPanel(h, ["notes.txt"]);
    await openFile(h, "notes.txt", "one", { stamp: { mtimeMs: 7, size: 3 } });
    beginEdit(h, "one two");
    backToTree(h);
    click(h.window, h.doc.querySelector(".files-browse-row")!);

    const before = requests(h, "writeProjectFile").length;
    click(h.window, h.doc.querySelector(".gfp-save")!);
    await settle();
    const write = requestAt(h, "writeProjectFile", before);
    expect(write.text).toBe("one two");
    expect(write.stamp).toEqual({ mtimeMs: 7, size: 3 });
  });

  it("keeps every abandoned draft rather than evicting older text", async () => {
    const names = Array.from({ length: 12 }, (_, index) => `note-${index}.txt`);
    const h = remoteHost();
    await openPanel(h, names);
    for (const name of names) {
      await openFile(h, name, "base");
      beginEdit(h, `edited ${name}`);
      backToTree(h);
    }
    click(h.window, [...h.doc.querySelectorAll(".files-browse-row")].find((row) => row.textContent!.includes(names[0]))!);
    expect(editor(h).value).toBe(`edited ${names[0]}`);
  });

  it("does not persist a draft into a separately booted browser tab", async () => {
    const first = remoteHost();
    await openPanel(first, ["notes.txt"]);
    await openFile(first, "notes.txt", "disk");
    beginEdit(first, "SECRET FROM TAB A");

    const second = remoteHost();
    await openPanel(second, ["notes.txt"]);
    await openFile(second, "notes.txt", "disk");
    expect(viewerText(second)).toBe("disk");
    expect(second.doc.body.textContent).not.toContain("SECRET FROM TAB A");
  });
});

describe("remote save state", () => {
  it("does not claim keystrokes typed after Save were saved", async () => {
    const h = remoteHost();
    await openPanel(h, ["notes.txt"]);
    await openFile(h, "notes.txt", "one");
    beginEdit(h, "one two");
    const before = requests(h, "writeProjectFile").length;
    click(h.window, h.doc.querySelector(".gfp-save")!);
    await settle();
    const write = requestAt(h, "writeProjectFile", before);
    setEditor(h, "one two three");

    await reply(h, write, {
      type: "projectFileWriteResult",
      ok: true,
      stamp: { mtimeMs: 2, size: 7 },
      absPath: String(write.expectedAbsPath),
    });
    expect(editor(h).value).toBe("one two three");
    expect((h.doc.querySelector(".gfp-save") as HTMLButtonElement).disabled).toBe(false);
    expect(h.doc.querySelector(".gfp-tab-dirty")?.textContent).toBe("•");
  });

  it("settles clean when the successful result covers the current text", async () => {
    const h = remoteHost();
    await openPanel(h, ["notes.txt"]);
    await openFile(h, "notes.txt", "one");
    beginEdit(h, "one two");
    const before = requests(h, "writeProjectFile").length;
    click(h.window, h.doc.querySelector(".gfp-save")!);
    await settle();
    const write = requestAt(h, "writeProjectFile", before);
    await reply(h, write, {
      type: "projectFileWriteResult",
      ok: true,
      stamp: { mtimeMs: 2, size: 7 },
      absPath: String(write.expectedAbsPath),
    });

    // A successful save now keeps you in edit mode, so Save is still on screen —
    // disabled, because there is nothing left to write. It used to disappear,
    // which is the same thing as being thrown back to the read view mid-edit.
    expect((h.doc.querySelector(".gfp-save") as HTMLButtonElement).disabled).toBe(true);
    expect(h.doc.querySelector(".gfp-tab-dirty")?.textContent).toBe("");
  });

  it("refreshes the stamp for Overwrite without adopting another identity", async () => {
    const h = remoteHost();
    await openPanel(h, ["notes.txt"]);
    await openFile(h, "notes.txt", "one", { absPath: "/abs/original" });
    beginEdit(h, "mine");
    click(h.window, h.doc.querySelector(".gfp-save")!);
    await settle();
    const firstWrite = requestAt(h, "writeProjectFile", 0);
    await reply(h, firstWrite, {
      type: "projectFileWriteResult",
      ok: false,
      reason: "changed",
    });
    expect(h.doc.querySelector(".files-browse-conflict-actions")).toBeTruthy();

    click(h.window, button(h, "Overwrite"));
    await settle();
    const reread = requestAt(h, "readProjectFile", 1);
    await reply(h, reread, {
      type: "projectFileContent",
      ok: true,
      kind: "text",
      text: "desk",
      stamp: { mtimeMs: 99, size: 4 },
      absPath: "/abs/original",
    });
    const overwrite = requestAt(h, "writeProjectFile", 1);
    expect(overwrite.stamp).toEqual({ mtimeMs: 99, size: 4 });
    expect(overwrite.expectedAbsPath).toBe("/abs/original");
    expect(overwrite.text).toBe("mine");
  });

  it("refuses Overwrite when the fresh read resolves to another file", async () => {
    const h = remoteHost();
    await openPanel(h, ["notes.txt"]);
    await openFile(h, "notes.txt", "one", { absPath: "/abs/original" });
    beginEdit(h, "mine");
    click(h.window, h.doc.querySelector(".gfp-save")!);
    await settle();
    await reply(h, requestAt(h, "writeProjectFile", 0), {
      type: "projectFileWriteResult",
      ok: false,
      reason: "changed",
    });
    click(h.window, button(h, "Overwrite"));
    await settle();
    await reply(h, requestAt(h, "readProjectFile", 1), {
      type: "projectFileContent",
      ok: true,
      kind: "text",
      text: "other",
      stamp: { mtimeMs: 99, size: 5 },
      absPath: "/abs/replaced",
    });

    expect(requests(h, "writeProjectFile")).toHaveLength(1);
    expect(h.doc.querySelector(".files-browse-notice")?.textContent).toContain("no longer the one you opened");
    expect(editor(h).value).toBe("mine");
  });
});

describe("remote discard and close semantics", () => {
  it("hiding asks nothing and preserves the draft", async () => {
    const h = remoteHost();
    await openPanel(h, ["notes.txt"]);
    await openFile(h, "notes.txt", "one");
    beginEdit(h, "one two");
    click(h.window, h.doc.querySelector(".gfp-close")!);

    expect(h.doc.querySelector(".confirm-overlay")).toBeNull();
    click(h.window, h.doc.getElementById("files-browse-btn")!);
    expect(editor(h).value).toBe("one two");
  });

  it("Cancel asks and keeps the draft when the answer is Cancel", async () => {
    const h = remoteHost();
    await openPanel(h, ["notes.txt"]);
    await openFile(h, "notes.txt", "one");
    beginEdit(h, "one two");
    click(h.window, h.doc.querySelector(".gfp-cancel")!);
    expect(h.doc.querySelector(".confirm-title")?.textContent).toBe("Cancel changes?");
    await choose(h, "Cancel");
    expect(editor(h).value).toBe("one two");
  });

  it("Cancel discards only after the explicit Discard choice", async () => {
    const h = remoteHost();
    await openPanel(h, ["notes.txt"]);
    await openFile(h, "notes.txt", "one");
    beginEdit(h, "one two");
    click(h.window, h.doc.querySelector(".gfp-cancel")!);
    await choose(h, "Discard");

    expect(viewerText(h)).toBe("one");
    expect(h.doc.querySelector(".gfp-editor")).toBeNull();
  });

  it("closing a dirty tab asks before removing it", async () => {
    const h = remoteHost();
    await openPanel(h, ["notes.txt"]);
    await openFile(h, "notes.txt", "one");
    beginEdit(h, "one two");
    click(h.window, h.doc.querySelector(".gfp-tab-close")!);
    expect(h.doc.querySelector(".confirm-title")?.textContent).toBe("Discard changes?");
    await choose(h, "Discard");
    expect(h.doc.querySelectorAll(".gfp-tab")).toHaveLength(0);
  });

  it("warns on page unload for on-screen or out-of-view dirty tabs", async () => {
    const h = remoteHost();
    await openPanel(h, ["notes.txt"]);
    await openFile(h, "notes.txt", "one");
    beginEdit(h, "one two");
    backToTree(h);

    expect(beforeUnload(h).defaultPrevented).toBe(true);
  });

  it("does not warn when the open file is clean", async () => {
    const h = remoteHost();
    await openPanel(h, ["notes.txt"]);
    await openFile(h, "notes.txt", "one");
    expect(beforeUnload(h).defaultPrevented).toBe(false);
  });

  it("offers no edit or write path to a browse-only host", async () => {
    const h = remoteHost(false);
    await openPanel(h, ["notes.txt"]);
    await openFile(h, "notes.txt", "one");

    expect([...h.doc.querySelectorAll("button")].some((item) => item.textContent === "Edit")).toBe(false);
    expect(requests(h, "writeProjectFile")).toHaveLength(0);
  });

  /*
   * A cloud machine suspends about a minute after the last frame, which is one
   * paragraph of reading, so the Changes view meets a sleeping host constantly
   * and its read simply gets no answer.
   *
   * Silence must not convict that host of being a released build too old to
   * echo requestIds. The poison set exists to stop a late legacy answer landing
   * in a different request's tab, and applying it on a timeout made every later
   * read answer "Request state is stale. Refresh this page and try again." from
   * memory, without ever reaching the wire — so the view stayed dead after the
   * machine woke, and reloading the page was the only cure. The owner hit that
   * repeatedly. A reply WITHOUT a requestId is what proves an old host, and
   * that case is covered above.
   */
  it("still reads after a silent host, so a woken machine fills the view in", async () => {
    const caps = { browseProjectFiles: true, editProjectFiles: true, gitChanges: true };
    const h = bootWebview({ remote: true });

    // The harness window owns its own timers, so hold the request timeout here
    // and fire it by hand rather than waiting thirty real seconds.
    const expiries: Array<() => void> = [];
    const realTimeout = h.window.setTimeout.bind(h.window);
    (h.window as unknown as { setTimeout: unknown }).setTimeout = (fn: () => void, ms: number) => {
      if (ms >= 20_000) {
        expiries.push(fn);
        return 0;
      }
      return realTimeout(fn, ms);
    };
    const boot = () => dispatch(h.window, {
      type: "initialState", cwd: CWD_A, capabilities: caps, appPurpose: "coding",
    });
    boot();
    dispatch(h.window, {
      type: "repos",
      entries: [{ cwd: CWD_A, label: "app", available: true, pinned: false, updatedAt: 2 }],
      selectedCwd: CWD_A,
    });
    await settle();
    click(h.window, h.doc.getElementById("files-browse-btn")!);
    await settle();
    const changesBtn = h.doc.querySelector(".gfp-changes-btn") as HTMLElement | null;
    expect(changesBtn, "no Changes control").toBeTruthy();
    click(h.window, changesBtn!);
    await settle();

    // Asleep: the read goes out and nothing at all comes back.
    const asked = requests(h, "gitStatus").length;
    expect(asked).toBeGreaterThan(0);
    expect(expiries.length).toBeGreaterThan(0);
    for (const expire of expiries.splice(0)) expire();
    await settle();

    // It wakes and dials back in. The next read must reach the WIRE.
    boot();
    await settle();
    expect(requests(h, "gitStatus").length).toBeGreaterThan(asked);
  });
});
