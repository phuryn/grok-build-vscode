import assert from "node:assert/strict";
import { hostMsg } from "./desk-stick-to-bottom.mjs";

/** Real geometry, including CSS chat zoom: DOM tests cannot detect a jump that
 *  overshoots because viewport pixels were assigned directly to scrollTop. */
export async function assertPromptNavigation(page, shot) {
  await hostMsg(page, { type: "clearMessages" });
  for (let i = 1; i <= 3; i++) {
    await hostMsg(page, { type: "userMessage", text: `Navigation prompt ${i}` });
    await hostMsg(page, { type: "messageChunk", text: "A long answer with room to read.\n\n".repeat(45) });
    await hostMsg(page, { type: "promptComplete" });
  }
  await page.waitForFunction(() => document.querySelectorAll("#messages .msg.user").length === 3);
  const atBottom = await page.locator("#prompt-nav").evaluate((el) => ({
    visible: el.classList.contains("visible"), inert: el.inert,
    standalone: !!document.querySelector(".composer > #scroll-bottom-btn"),
    latestCount: document.querySelectorAll("#scroll-bottom-btn").length,
  }));
  assert.deepEqual(atBottom, { visible: false, inert: true, standalone: false, latestCount: 1 });
  await page.evaluate(() => {
    const m = document.getElementById("messages");
    const p = m.querySelectorAll(".msg.user")[1];
    const scale = m.getBoundingClientRect().height / m.offsetHeight;
    const top = m.scrollTop + (p.getBoundingClientRect().top - m.getBoundingClientRect().top) / scale;
    m.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    m.scrollTop = top + 500;
    m.dispatchEvent(new Event("scroll"));
  });
  await page.waitForFunction(() => document.getElementById("prompt-nav").classList.contains("visible"));
  const layout = await page.locator("#prompt-nav").evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return {
      order: [...el.children].map((n) => n.id),
      weights: [...el.querySelectorAll("svg")].map((svg) => svg.getAttribute("stroke-width")),
      onScreen: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
      count: el.querySelector("#prompt-nav-count").textContent,
    };
  });
  assert.deepEqual(layout.order, ["prompt-prev-btn", "prompt-nav-count", "prompt-next-btn", "scroll-bottom-btn"]);
  assert.deepEqual(layout.weights, ["2.5", "2.5", "2.5"]);
  assert.equal(layout.onScreen, true, JSON.stringify(layout));
  assert.equal(layout.count, "Prompts 2/3");
  await shot("desk-prompt-navigation");
  await page.click("#prompt-prev-btn");
  const alignment = await page.evaluate(() => {
    const m = document.getElementById("messages");
    const scale = m.getBoundingClientRect().height / m.offsetHeight;
    return (m.querySelectorAll(".msg.user")[1].getBoundingClientRect().top - m.getBoundingClientRect().top) / scale
      - parseFloat(getComputedStyle(m).paddingTop);
  });
  assert.ok(Math.abs(alignment) < 3, `Previous must land on the answer's own prompt: delta=${alignment}`);
  await page.click("#prompt-prev-btn");
  assert.equal(await page.locator("#prompt-prev-btn").isDisabled(), true);
  await page.click("#prompt-next-btn");
  await page.click("#prompt-next-btn");
  assert.equal(await page.locator("#prompt-next-btn").isDisabled(), true);
  assert.equal(await page.locator("#prompt-nav-count").textContent(), "Prompts 3/3");
  await page.click("#scroll-bottom-btn");
  await page.waitForFunction(() => !document.getElementById("prompt-nav").classList.contains("visible"));
}

/** Exercises paste → staged host attachment → opaque handle → original bytes →
 *  renderer ClipboardItem → Electron's actual clipboard. Preserve its contents. */
export async function assertOriginalImageCopy(app, page, shot) {
  const saved = await app.evaluate(({ clipboard }) => clipboard.availableFormats().map((format) => ({
    format, bytes: [...clipboard.readBuffer(format)],
  })));
  try {
    await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 3200;
      canvas.height = 64;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ff0000";
      ctx.fillRect(0, 0, 3200, 64);
      const raw = atob(canvas.toDataURL("image/png").split(",")[1]);
      const file = new File([Uint8Array.from(raw, (c) => c.charCodeAt(0))], "original.png", { type: "image/png" });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      document.getElementById("input").dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
    });
    await page.waitForSelector(".attachment-preview", { timeout: 10000 });
    await page.click(".attachment-preview");
    await page.click(".image-preview-copy");
    try {
      await page.locator('.image-preview-status:text-is("Image copied")').waitFor({ timeout: 25000 });
    } catch (error) {
      await shot("desk-image-copy-failed");
      throw new Error(`Image copy: ${await page.locator(".image-preview-status").textContent()}`, { cause: error });
    }
    const pixels = await app.evaluate(({ clipboard }) => {
      const img = clipboard.readImage();
      return { size: img.getSize(), first: [...img.toBitmap().subarray(0, 4)] };
    });
    assert.deepEqual(pixels.size, { width: 3200, height: 64 });
    assert.deepEqual(pixels.first, [0, 0, 255, 255]);
    const nativeMenu = await page.locator(".image-preview-overlay img").evaluate((img) => {
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      img.dispatchEvent(event);
      return !event.defaultPrevented;
    });
    assert.equal(nativeMenu, true);
    await shot("desk-image-copy");
    await page.click(".image-preview-close");
  } finally {
    await app.evaluate(({ clipboard }, formats) => {
      clipboard.clear();
      for (const { format, bytes } of formats) clipboard.writeBuffer(format, Buffer.from(bytes));
    }, saved);
  }
}
