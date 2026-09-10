// DOM-level tests for the two v1.4.0 webview render paths that the pure-helper
// suites can't reach: generated-media inlining (addGeneratedMedia) and the
// subagent card (addSubagentCard). These drive the REAL media/chat.js so the
// host→webview contract for `{type:"media"}` and a subagent `{type:"toolCall"}`
// is exercised end-to-end, not just the classifiers in webview-helpers.
//
//   1. /imagine  -> {media:"image", src:<data: URI>, path} renders a clickable <img>
//   2. /imagine-video -> {media:"video", src:<data: URI>} renders <video controls>
//   3. remote link (no src, just url) renders an "open ↗" button, not an <img>
//   4. a spawn_subagent tool call renders a "Subagent: <type>" card and is
//      diverted away from the generic tool group
//   5. openInEditor capability routes image click: editor host → openFile,
//      desktop/remote → in-app lightbox (no openFile)
import { describe, it, expect, vi } from "vitest";
import { bootWebview, dispatch, click, type Harness } from "./webview-harness";

const messages = (doc: Document) => doc.getElementById("messages") as HTMLElement;

const IMG_DATA = "data:image/jpeg;base64,/9j/AAAQSkZJRg==";
const VIDEO_DATA = "data:video/mp4;base64,AAAAIGZ0eXBpc29t";
const IMG_PATH = "/sessions/abc/images/cat.jpg";

type Caps = Record<string, boolean>;

function bootWithCaps(
  capabilities: Caps,
  opts: { remote?: boolean; beforeScripts?: (window: any) => void } = {},
): Harness {
  const h = bootWebview({ ready: true, remote: opts.remote, beforeScripts: opts.beforeScripts });
  dispatch(h.window, {
    type: "initialState",
    effort: "",
    cwd: "/w",
    useCtrlEnter: false,
    extVersion: "9.9.9",
    showThinking: false,
    expandCommandOutputs: false,
    steerByDefault: false,
    soundNotifications: false,
    processingSound: false,
    readRepliesAloud: false,
    capabilities: { uploadFile: true, remoteVoice: true, ...capabilities },
  });
  return h;
}

function postGeneratedImage(h: Harness, extra: Record<string, unknown> = {}): void {
  dispatch(h.window, {
    type: "media",
    media: "image",
    src: IMG_DATA,
    path: IMG_PATH,
    ...extra,
  });
}

function imagePreviewOverlay(doc: Document): HTMLElement | null {
  return doc.querySelector(".image-preview-overlay") as HTMLElement | null;
}

function openFilePosts(posted: Harness["posted"]) {
  return posted.filter((m) => m.type === "openFile");
}

describe("addGeneratedMedia (/imagine image)", () => {
  it("inlines a generated image as a clickable <img> with the data: src", () => {
    const { window, posted, doc } = bootWebview();
    dispatch(window, {
      type: "media",
      media: "image",
      src: IMG_DATA,
      path: IMG_PATH,
    });

    const wrap = messages(doc).querySelector(".generated-image");
    expect(wrap).not.toBeNull();
    expect(wrap!.classList.contains("generated-video")).toBe(false);

    const img = wrap!.querySelector("img") as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.getAttribute("src")).toBe(IMG_DATA);

    // clicking the inlined image opens its source file in VS Code
    // (absent openInEditor = opt-out true → editor host)
    click(window, img);
    expect(posted).toContainEqual({ type: "openFile", path: IMG_PATH });
  });
});

describe("addGeneratedMedia image click by surface (openInEditor)", () => {
  it("VS Code caps → click posts openFile and opens no lightbox overlay", () => {
    // openInEditor absent OR true: editor tab via openFile. No overlay.
    const h = bootWithCaps({ openInEditor: true });
    postGeneratedImage(h);
    const img = messages(h.doc).querySelector(".generated-image img") as HTMLImageElement;
    expect(img).not.toBeNull();

    click(h.window, img);

    expect(openFilePosts(h.posted)).toEqual([{ type: "openFile", path: IMG_PATH }]);
    const overlay = imagePreviewOverlay(h.doc);
    expect(overlay === null || overlay.hidden).toBe(true);
  });

  it("desktop caps (openInEditor: false) → click opens lightbox with src, posts no openFile", () => {
    const h = bootWithCaps({ openInEditor: false });
    postGeneratedImage(h);
    const img = messages(h.doc).querySelector(".generated-image img") as HTMLImageElement;

    click(h.window, img);

    expect(openFilePosts(h.posted)).toEqual([]);
    const overlay = imagePreviewOverlay(h.doc);
    expect(overlay).not.toBeNull();
    expect(overlay!.hidden).toBe(false);
    const previewImg = overlay!.querySelector("img") as HTMLImageElement;
    expect(previewImg.getAttribute("src")).toBe(IMG_DATA);
    expect(previewImg.getAttribute("alt")).toBe("cat.jpg");
    // No handle was supplied here, and the src is already the original.
    expect(h.posted.filter((m) => m.type === "requestImageFull")).toEqual([]);
  });

  it("remote → click opens lightbox even when desk caps say the host has an editor", () => {
    // Phone receives the desk machine's capabilities. A tap must never open
    // an editor on that desk, so remote forces the lightbox.
    const h = bootWithCaps({ openInEditor: true }, { remote: true });
    postGeneratedImage(h);
    const img = messages(h.doc).querySelector(".generated-image img") as HTMLImageElement;
    expect(img).not.toBeNull();

    click(h.window, img);

    expect(openFilePosts(h.posted)).toEqual([]);
    const overlay = imagePreviewOverlay(h.doc);
    expect(overlay).not.toBeNull();
    expect(overlay!.hidden).toBe(false);
    expect((overlay!.querySelector("img") as HTMLImageElement).getAttribute("src")).toBe(IMG_DATA);
    expect(h.posted.filter((m) => m.type === "requestImageFull")).toEqual([]);
  });

  // A served app-resource:// URI is displayable but its pixels are NOT readable
  // back out of the webview, which is why Copy image needed a handle and why
  // generated media — unlike attachments — never carried one. The handle is now
  // minted, and these two cases are the reason it has to be ignored on the
  // surface that already holds the bytes.
  describe("Copy image on generated media, by what the surface actually holds", () => {
    const SERVED_SRC = "https://file.vscode-resource.test/cat.jpg";
    const clipboard = () => {
      const write = vi.fn(async (items: any[]) => { await items[0].data["image/png"]; });
      return { write, beforeScripts(window: any) {
        window.ClipboardItem = class { constructor(public data: any) {} };
        Object.defineProperty(window.navigator, "clipboard", { value: { write } });
      } };
    };

    it("desk: a served URI has no readable pixels, so the handle is what makes Copy work", () => {
      const { write, beforeScripts } = clipboard();
      const h = bootWithCaps({ openInEditor: false }, { beforeScripts });
      postGeneratedImage(h, { src: SERVED_SRC, fullId: "gen-1" });
      click(h.window, messages(h.doc).querySelector(".generated-image img") as HTMLImageElement);

      const copy = h.doc.querySelector<HTMLButtonElement>(".image-preview-copy")!;
      expect(copy.disabled).toBe(false);
      expect(h.doc.querySelector(".image-preview-status")!.textContent).toBe("");
      copy.click();
      expect(write).toHaveBeenCalledTimes(1);
      expect(h.posted.filter((m) => m.type === "requestImageOriginal"))
        .toMatchObject([{ fullId: "gen-1" }]);
      // Not a remote, so the capped render is never asked for either way.
      expect(h.posted.filter((m) => m.type === "requestImageFull")).toEqual([]);
    });

    it("remote: already holding the whole file, it ignores the handle rather than trading down", () => {
      const { write, beforeScripts } = clipboard();
      const h = bootWithCaps({ openInEditor: true }, { remote: true, beforeScripts });
      postGeneratedImage(h, { fullId: "gen-1" });
      click(h.window, messages(h.doc).querySelector(".generated-image img") as HTMLImageElement);

      // `imageFull` is capped at 1600px, so fetching it would swap the original
      // the phone already has for a smaller one — a regression on a surface
      // where Copy has always worked, to fix a button on a different surface.
      expect(h.posted.filter((m) => m.type === "requestImageFull")).toEqual([]);
      expect((h.doc.querySelector(".image-preview-overlay img") as HTMLImageElement)
        .getAttribute("src")).toBe(IMG_DATA);

      const copy = h.doc.querySelector<HTMLButtonElement>(".image-preview-copy")!;
      expect(copy.disabled).toBe(false);
      copy.click();
      expect(write).toHaveBeenCalledTimes(1);
      // And no round trip for bytes that are already in the page — that request
      // can time out where reading the src cannot.
      expect(h.posted.filter((m) => m.type === "requestImageOriginal")).toEqual([]);
    });
  });

  it("video stays a non-clickable <video> under every surface", () => {
    for (const opts of [
      { caps: { openInEditor: true } as Caps, remote: false },
      { caps: { openInEditor: false } as Caps, remote: false },
      { caps: { openInEditor: true } as Caps, remote: true },
    ]) {
      const h = bootWithCaps(opts.caps, { remote: opts.remote });
      dispatch(h.window, {
        type: "media",
        media: "video",
        src: VIDEO_DATA,
        path: "/sessions/abc/videos/clip.mp4",
      });
      const wrap = messages(h.doc).querySelector(".generated-image.generated-video")!;
      const video = wrap.querySelector("video") as HTMLVideoElement;
      expect(video).not.toBeNull();
      expect(video.controls).toBe(true);
      expect(wrap.querySelector("img")).toBeNull();
      // No click handler that would open a lightbox or post openFile.
      expect(typeof (video as any).onclick === "function" ? (video as any).onclick : null).toBeNull();
      click(h.window, video);
      expect(openFilePosts(h.posted)).toEqual([]);
      const overlay = imagePreviewOverlay(h.doc);
      expect(overlay === null || overlay.hidden).toBe(true);
    }
  });

  it("clearMessages closes an open lightbox and clears its pending full-size state", async () => {
    // openImagePreview attaches to document.body; resetForNewSession only
    // cleared the transcript — a session swap with the lightbox open left the
    // previous session's image over the next one. Routing generated-media
    // clicks to the lightbox (desktop + remote) makes that reachable for
    // transcript content.
    // Mutation: drop closeImagePreview() from resetForNewSession and this
    // test fails (overlay stays visible with the prior src after clearMessages).
    const h = bootWithCaps({ openInEditor: false });
    postGeneratedImage(h);
    const img = messages(h.doc).querySelector(".generated-image img") as HTMLImageElement;
    click(h.window, img);

    const overlay = imagePreviewOverlay(h.doc);
    expect(overlay).not.toBeNull();
    expect(overlay!.hidden).toBe(false);
    expect((overlay!.querySelector("img") as HTMLImageElement).getAttribute("src")).toBe(IMG_DATA);

    dispatch(h.window, { type: "clearMessages" });

    expect(overlay!.hidden).toBe(true);
    const previewImg = overlay!.querySelector("img") as HTMLImageElement;
    expect(previewImg.getAttribute("src")).toBeNull();
    // Transcript wipe is deferred to the next frame when no replacement arrives.
    await new Promise<void>((resolve) => h.window.requestAnimationFrame(() => resolve()));
    expect(messages(h.doc).querySelector(".generated-image")).toBeNull();
  });

  it("clearMessages closes a remote lightbox opened from generated media", () => {
    // Same body-attached overlay path as desktop; remote forces the lightbox
    // even when desk caps claim an editor.
    const h = bootWithCaps({ openInEditor: true }, { remote: true });
    postGeneratedImage(h);
    click(h.window, messages(h.doc).querySelector(".generated-image img") as HTMLImageElement);

    const overlay = imagePreviewOverlay(h.doc)!;
    expect(overlay.hidden).toBe(false);

    dispatch(h.window, { type: "clearMessages" });

    expect(overlay.hidden).toBe(true);
    expect((overlay.querySelector("img") as HTMLImageElement).getAttribute("src")).toBeNull();
  });
});

describe("addGeneratedMedia (/imagine-video video)", () => {
  it("inlines a generated video as <video controls>, not an <img>", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "media",
      media: "video",
      src: VIDEO_DATA,
      path: "/sessions/abc/videos/clip.mp4",
    });

    const wrap = messages(doc).querySelector(".generated-image.generated-video");
    expect(wrap).not.toBeNull();

    const video = wrap!.querySelector("video") as HTMLVideoElement;
    expect(video).not.toBeNull();
    expect(video.getAttribute("src")).toBe(VIDEO_DATA);
    expect(video.controls).toBe(true);
    // Drop Chromium's overflow (⋯) — Download + PiP; keep play/scrub/fullscreen.
    // Mutation: remove controlsList / disablePictureInPicture → this fails.
    const list = String(video.controlsList || video.getAttribute("controlslist") || "");
    expect(list).toMatch(/nodownload/);
    expect(list).toMatch(/noremoteplayback/);
    expect(list).toMatch(/noplaybackrate/);
    expect(list).not.toMatch(/nofullscreen/);
    expect(video.disablePictureInPicture).toBe(true);
    // a video must NOT also render an <img>
    expect(wrap!.querySelector("img")).toBeNull();
  });

  it("uses preload=metadata when the host advertises honest media ranges", () => {
    const h = bootWithCaps({ servesMediaRanges: true });
    dispatch(h.window, {
      type: "media",
      media: "video",
      src: VIDEO_DATA,
      path: "/sessions/abc/videos/clip.mp4",
    });
    const video = messages(h.doc).querySelector(
      ".generated-image.generated-video video",
    ) as HTMLVideoElement;
    expect(video.preload).toBe("metadata");
    expect(video.getAttribute("preload")).toBe("metadata");
  });

  it("uses preload=none when the host does not advertise honest media ranges", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "media",
      media: "video",
      src: VIDEO_DATA,
      path: "/sessions/abc/videos/clip.mp4",
    });
    const video = messages(doc).querySelector(
      ".generated-image.generated-video video",
    ) as HTMLVideoElement;
    expect(video).not.toBeNull();
    expect(video.preload).toBe("none");
    expect(video.getAttribute("preload")).toBe("none");
  });
});

describe("addGeneratedMedia hover actions (copy path / open)", () => {
  const btnByTitle = (wrap: Element, title: string) =>
    [...wrap.querySelectorAll(".generated-media-btn")].find(
      (b) => b.getAttribute("title") === title,
    ) as HTMLButtonElement | undefined;

  it("an image reveals in its folder when the host advertises it", () => {
    const h = bootWithCaps({ showInFolder: true });
    const { window, posted, doc } = h;
    dispatch(window, { type: "media", media: "image", src: IMG_DATA, path: IMG_PATH });
    const wrap = messages(doc).querySelector(".generated-image")!;

    expect(btnByTitle(wrap, "Copy path")).toBeTruthy();
    const openBtn = btnByTitle(wrap, "Show in folder")!;
    expect(openBtn).toBeTruthy();

    click(window, openBtn);
    expect(posted).toContainEqual({ type: "showInFolder", path: IMG_PATH });
    // Reveal REPLACES open — a host that can do both must not offer both.
    expect(btnByTitle(wrap, "Open in VS Code")).toBeUndefined();
    expect(btnByTitle(wrap, "Open file")).toBeUndefined();
  });

  it("an image keeps Open where the host cannot reveal", () => {
    const h = bootWithCaps({ openInEditor: false });
    const { window, posted, doc } = h;
    dispatch(window, { type: "media", media: "image", src: IMG_DATA, path: IMG_PATH });
    const wrap = messages(doc).querySelector(".generated-image")!;

    const openBtn = btnByTitle(wrap, "Open file")!;
    expect(openBtn).toBeTruthy();
    click(window, openBtn);
    expect(posted).toContainEqual({ type: "openFile", path: IMG_PATH });
  });

  it("hover open label is 'Open in VS Code' when openInEditor is true", () => {
    const h = bootWithCaps({ openInEditor: true });
    postGeneratedImage(h);
    const wrap = messages(h.doc).querySelector(".generated-image")!;
    expect(btnByTitle(wrap, "Open in VS Code")).toBeTruthy();
    expect(btnByTitle(wrap, "Open file")).toBeUndefined();
  });

  it("hover open label is 'Open file' when openInEditor is false (desktop)", () => {
    const h = bootWithCaps({ openInEditor: false });
    postGeneratedImage(h);
    const wrap = messages(h.doc).querySelector(".generated-image")!;
    const openBtn = btnByTitle(wrap, "Open file")!;
    expect(openBtn).toBeTruthy();
    expect(btnByTitle(wrap, "Open in VS Code")).toBeUndefined();
    // Action is still openFile — the escape hatch to the real file on disk.
    click(h.window, openBtn);
    expect(h.posted).toContainEqual({ type: "openFile", path: IMG_PATH });
  });

  it("a video uses Show in folder when the host advertises it", () => {
    const h = bootWithCaps({ showInFolder: true });
    const { window, posted, doc } = h;
    dispatch(window, { type: "media", media: "video", src: VIDEO_DATA, path: "/sessions/abc/videos/clip.mp4" });
    const wrap = messages(doc).querySelector(".generated-image.generated-video")!;

    const openBtn = btnByTitle(wrap, "Show in folder")!;
    expect(openBtn).toBeTruthy();
    click(window, openBtn);
    expect(posted).toContainEqual({ type: "showInFolder", path: "/sessions/abc/videos/clip.mp4" });
    expect(btnByTitle(wrap, "Open in VS Code")).toBeUndefined();
  });

  it("a video keeps Open file when the host does not advertise Show in folder", () => {
    const { window, posted, doc } = bootWebview();
    dispatch(window, { type: "media", media: "video", src: VIDEO_DATA, path: "/sessions/abc/videos/clip.mp4" });
    const wrap = messages(doc).querySelector(".generated-image.generated-video")!;

    const openBtn = btnByTitle(wrap, "Open in VS Code")!;
    expect(openBtn).toBeTruthy();
    click(window, openBtn);
    expect(posted).toContainEqual({ type: "openFile", path: "/sessions/abc/videos/clip.mp4" });
  });

  it("copy-path writes the on-disk path to the clipboard", () => {
    const { window, doc } = bootWebview();
    let copied = "";
    Object.defineProperty((window as any).navigator, "clipboard", {
      value: { writeText: (t: string) => { copied = t; return Promise.resolve(); } },
      configurable: true,
    });
    dispatch(window, { type: "media", media: "image", src: IMG_DATA, path: IMG_PATH });
    const wrap = messages(doc).querySelector(".generated-image")!;

    click(window, btnByTitle(wrap, "Copy path")!);
    expect(copied).toBe(IMG_PATH);
  });

  it("the remote-link fallback (no on-disk path) has no hover actions", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "media", media: "image", url: "https://x.ai/generated/cat.jpg" });
    const wrap = messages(doc).querySelector(".generated-image")!;
    expect(wrap.querySelector(".generated-media-actions")).toBeNull();
  });
});

describe("captured Codex image-generation parity by surface", () => {
  const captured = {
    toolCallId: "exec-imagegen-1",
    kind: "other",
    title: "Image generation",
    rawInput: { id: "exec-imagegen-1" },
  };
  const render = (h: Harness) => {
    dispatch(h.window, { type: "session", sessionId: "codex-live-1", provider: "codex", models: [] });
    dispatch(h.window, { type: "toolCall", call: captured });
    dispatch(h.window, { type: "toolCallUpdate", call: {
      toolCallId: captured.toolCallId,
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "Revised prompt: cat" } }],
    } });
    postGeneratedImage(h, { path: "/home/me/.codex/generated_images/codex-live-1/exec-imagegen-1.png" });
    return messages(h.doc).querySelector(".generated-image")!;
  };

  it("VS Code renders Copy path plus Open in VS Code", () => {
    const h = bootWithCaps({ openInEditor: true });
    const wrap = render(h);
    expect(wrap.querySelector('[title="Copy path"]')).toBeTruthy();
    expect(wrap.querySelector('[title="Open in VS Code"]')).toBeTruthy();
  });

  it("desktop renders Copy path plus Show in folder", () => {
    const h = bootWithCaps({ openInEditor: false, showInFolder: true });
    const wrap = render(h);
    expect(wrap.querySelector('[title="Copy path"]')).toBeTruthy();
    expect(wrap.querySelector('[title="Show in folder"]')).toBeTruthy();
  });

  it("remote renders only the served-image download action", () => {
    const h = bootWithCaps({}, { remote: true });
    const wrap = render(h);
    expect(wrap.querySelector('[title="Download image"]')).toBeTruthy();
    expect(wrap.querySelector('[title="Copy path"]')).toBeNull();
    expect(wrap.querySelector('[title="Open in VS Code"]')).toBeNull();
  });
});

describe("addGeneratedMedia (remote link fallback)", () => {
  it("renders an open-link button (not an <img>) when only a url is supplied", () => {
    const { window, posted, doc } = bootWebview();
    dispatch(window, { type: "media", media: "image", url: "https://x.ai/generated/cat.jpg" });

    const wrap = messages(doc).querySelector(".generated-image")!;
    expect(wrap.querySelector("img")).toBeNull();
    const link = wrap.querySelector(".preview-link") as HTMLButtonElement;
    expect(link).not.toBeNull();

    click(window, link);
    expect(posted).toContainEqual({ type: "openUrl", url: "https://x.ai/generated/cat.jpg" });
  });
});

describe("subagent row (spawn_subagent tool call, grok 0.2.93 wire shape)", () => {
  // Real spawn shape captured over ACP (research/signals-refresh-probe run +
  // research/subagents.md): rawInput carries the task description + type.
  const SPAWN = {
    toolCallId: "sa-1",
    title: "spawn_subagent",
    rawInput: {
      prompt: "Read the file math.js and report back in one sentence",
      description: "Read math.js and summarize add() in one sentence",
      subagent_type: "general-purpose",
      background: false,
    },
  };
  // Real completed update: re-titled to the description, structured rawOutput.
  const COMPLETED = {
    toolCallId: "sa-1",
    status: "completed",
    title: "Read math.js and summarize add() in one sentence",
    content: [{ type: "content", content: { type: "text", text: "The add() function returns the sum.\n\n<subagent_meta>id=x, type=general-purpose</subagent_meta>" } }],
    rawOutput: {
      type: "SubagentCompleted",
      output: "The add() function returns the sum.",
      subagent_type: "general-purpose",
      tool_calls: 2,
      turns: 1,
      duration_ms: 7343,
    },
  };

  it("renders the task description with running dots, diverted from the tool group", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "toolCall", call: SPAWN });

    const card = messages(doc).querySelector(".subagent-card")!;
    expect(card).not.toBeNull();
    expect(card.textContent).toContain("Subagent");
    expect(card.textContent).toContain("Read math.js and summarize add() in one sentence");
    expect(card.querySelector(".blink-dots")).not.toBeNull();
    expect(messages(doc).querySelector(".tool-group")).toBeNull();
  });

  it("the completed update stops the dots, stamps the duration, and offers the result on click", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "toolCall", call: SPAWN });
    dispatch(window, { type: "toolCallUpdate", call: COMPLETED });

    const card = messages(doc).querySelector(".subagent-card")!;
    expect(card.classList.contains("subagent-done")).toBe(true);
    expect(card.querySelector(".blink-dots")).toBeNull();
    expect(card.querySelector(".subagent-time")!.textContent).toBe("· 7s");
    // the update must NOT leak into the generic tool group
    expect(messages(doc).querySelector(".tool-group")).toBeNull();

    const body = card.querySelector(".subagent-result") as HTMLElement;
    expect(body.hidden).toBe(true);
    // Rendered as markdown; the <subagent_meta> plumbing is stripped.
    expect(body.textContent).toContain("The add() function returns the sum.");
    expect(body.textContent).not.toContain("subagent_meta");
    click(window, card.querySelector(".subagent-row")!);
    expect(body.hidden).toBe(false);
  });

  it("a generic 'Subagent' title is noise — the first prompt line stands in", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "toolCall",
      call: {
        toolCallId: "sa-3",
        title: "Subagent",
        rawInput: { subagent_type: "general-purpose", prompt: "List the repo root and count .ts files under src/\nThen report back." },
      },
    });
    const card = messages(doc).querySelector(".subagent-card")!;
    expect(card.textContent).toContain("List the repo root and count .ts files under src/");
    // no "Subagent · Subagent" duplication
    expect(card.querySelector(".subagent-title")!.textContent).not.toBe("Subagent");
  });

  it("a replayed one-shot tool_call that is already completed renders done immediately", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "toolCall", call: { ...SPAWN, ...COMPLETED } });

    const card = messages(doc).querySelector(".subagent-card")!;
    expect(card.classList.contains("subagent-done")).toBe(true);
    expect(card.querySelector(".blink-dots")).toBeNull();
    expect(card.querySelector(".subagent-result")!.textContent).toContain("returns the sum");
  });

  it("falls back to the prompt's first line, then the subagent type", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "toolCall",
      call: {
        toolCallId: "sa-2",
        title: "spawn_subagent",
        rawInput: { subagent_type: "general-purpose", prompt: "investigate the parser" },
      },
    });
    expect(messages(doc).querySelector(".subagent-card")!.textContent).toContain("investigate the parser");

    // Neither description nor prompt → the type is the last resort.
    dispatch(window, {
      type: "toolCall",
      call: { toolCallId: "sa-2b", title: "spawn_subagent", rawInput: { subagent_type: "general-purpose" } },
    });
    const cards = messages(doc).querySelectorAll(".subagent-card");
    expect(cards[cards.length - 1].textContent).toContain("general-purpose");
  });

  it("still cards grok's legacy background-task delegation, labeled by its command", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "toolCall",
      call: {
        toolCallId: "bg-1",
        title: "run_terminal_command",
        rawInput: { variant: "Bash", command: "investigate the parser", is_background: true },
      },
    });

    const card = messages(doc).querySelector(".subagent-card")!;
    expect(card.textContent).toContain("Subagent");
    expect(card.textContent).toContain("investigate the parser");
    expect(messages(doc).querySelector(".tool-group")).toBeNull();
  });

  it("an ordinary (foreground) tool call still goes to the tool group, not a subagent card", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "toolCall",
      call: { toolCallId: "t-1", title: "read_file", kind: "read", rawInput: { path: "a.ts" } },
    });

    expect(messages(doc).querySelector(".tool-group")).not.toBeNull();
    expect(messages(doc).querySelector(".subagent-card")).toBeNull();
  });
});
