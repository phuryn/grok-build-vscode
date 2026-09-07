import { afterEach, describe, expect, it, vi } from "vitest";
import { bootWebview, dispatch, click, type Harness } from "./webview-harness";

const opened: Harness[] = [];
afterEach(() => { vi.useRealTimers(); for (const h of opened.splice(0)) h.window.happyDOM.abort(); });
const original = "data:image/png;base64,b3JpZ2luYWwtcGl4ZWxz";

function preview(remote: boolean, fullId: string | undefined = "handle-1") {
  const write = vi.fn(async (items: any[]) => { await items[0].data["image/png"]; });
  const h = bootWebview({ remote, beforeScripts(window) {
    (window as any).ClipboardItem = class { constructor(public data: any) {} };
    Object.defineProperty(window.navigator, "clipboard", { value: { write } });
  } });
  opened.push(h);
  dispatch(h.window, { type: "chips", chips: [{
    id: "image-1", path: "/staged/image.png", relPath: "Image #1", imageIndex: 1, hidden: false,
    mimeType: "image/png", previewSrc: remote ? "data:image/png;base64,dGh1bWI=" : "https://file.vscode-resource.test/image.png", fullId,
  }] });
  click(h.window, h.doc.querySelector(".attachment button")!);
  return { ...h, write, copy: h.doc.querySelector<HTMLButtonElement>(".image-preview-copy")! };
}

describe("copy attached image (#150)", () => {
  it.each([false, true])("copies original bytes on the reader's device (remote=%s)", async (remote) => {
    const h = preview(remote);
    expect(h.copy).not.toBeNull();
    h.copy.click();
    // The write starts inside the click, before the host replies (WebKit gesture requirement).
    expect(h.write).toHaveBeenCalledTimes(1);
    const req = h.posted.find((m) => m.type === "requestImageOriginal")!;
    expect(req).toMatchObject({ fullId: "handle-1" });
    dispatch(h.window, { type: "imageFull", fullId: "handle-1", src: "data:image/png;base64,cHJldmlldw==" });
    dispatch(h.window, { type: "imageOriginal", fullId: req.fullId, requestId: req.requestId, src: original });
    const blob = await h.write.mock.calls[0][0][0].data["image/png"];
    expect(await blob.text()).toBe("original-pixels");
    await vi.waitFor(() => expect(h.doc.querySelector(".image-preview-status")!.textContent).toBe("Image copied"));
  });

  it("keeps native right-click on the attachment and enlarged image", () => {
    const h = preview(true);
    for (const el of h.doc.querySelectorAll(".attachment img, .image-preview-overlay img")) {
      const event = new h.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      el.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
  });

  it("does not offer thumbnail copying when an old host supplied no handle", () => {
    const h = preview(true, "");
    expect(h.copy).not.toBeNull();
    expect(h.copy.disabled).toBe(true);
    h.copy.click();
    expect(h.write).not.toHaveBeenCalled();
  });

  it("reports a missing original without copying the preview", async () => {
    const h = preview(true);
    expect(h.copy).not.toBeNull();
    h.copy.click();
    const req = h.posted.find((m) => m.type === "requestImageOriginal")!;
    dispatch(h.window, { type: "imageOriginal", fullId: req.fullId, requestId: req.requestId });
    await vi.waitFor(() => expect(h.doc.querySelector(".image-preview-status")!.textContent).toContain("Could not copy"));
    expect(h.copy.disabled).toBe(false);
  });

  it("times out an old host's unanswered request without substituting imageFull", async () => {
    const h = preview(true);
    let expire: () => void;
    vi.spyOn(h.window, "setTimeout").mockImplementation(((fn: () => void) => { expire = fn; return 1; }) as any);
    h.copy.click();
    dispatch(h.window, { type: "imageFull", fullId: "handle-1", src: original });
    expire!();
    await vi.waitFor(() => expect(h.doc.querySelector(".image-preview-status")!.textContent).toContain("Could not copy"));
  });

  it("cancels on close and ignores a late reply after reopening the same image", async () => {
    const h = preview(true);
    h.copy.click();
    const first = h.posted.find((m) => m.type === "requestImageOriginal")!;
    h.doc.querySelector<HTMLButtonElement>(".image-preview-close")!.click();
    click(h.window, h.doc.querySelector(".attachment button")!);
    h.copy.click();
    const requests = h.posted.filter((m) => m.type === "requestImageOriginal");
    const second = requests[1];
    expect(second.requestId).not.toBe(first.requestId);
    dispatch(h.window, { ...first, type: "imageOriginal", src: "data:image/png;base64,d3Jvbmc=" });
    dispatch(h.window, { ...second, type: "imageOriginal", src: original });
    const blob = await h.write.mock.calls[1][0][0].data["image/png"];
    expect(await blob.text()).toBe("original-pixels");
  });

  it("converts non-PNG pixels at their natural dimensions", async () => {
    const h = preview(true);
    let canvas: HTMLCanvasElement;
    const create = h.doc.createElement.bind(h.doc);
    vi.spyOn(h.doc, "createElement").mockImplementation((tag: any) => {
      const el = create(tag);
      if (tag === "canvas") {
        canvas = el as HTMLCanvasElement;
        canvas.getContext = vi.fn(() => ({ drawImage: vi.fn() })) as any;
        canvas.toBlob = (cb) => cb(new h.window.Blob(["pixels"], { type: "image/png" }) as any);
      }
      return el;
    });
    (h.window as any).Image = class {
      naturalWidth = 4000;
      naturalHeight = 2000;
      onload = () => {};
      set src(_: string) { this.onload(); }
    };
    h.copy.click();
    const req = h.posted.find((m) => m.type === "requestImageOriginal")!;
    dispatch(h.window, { ...req, type: "imageOriginal", src: "data:image/jpeg;base64,cGhvdG8=" });
    await h.write.mock.calls[0][0][0].data["image/png"];
    expect([canvas!.width, canvas!.height]).toEqual([4000, 2000]);
  });
});
