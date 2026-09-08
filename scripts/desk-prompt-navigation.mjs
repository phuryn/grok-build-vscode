import assert from "node:assert/strict";
import { hostMsg } from "./desk-stick-to-bottom.mjs";

/** Real geometry, including CSS chat zoom: DOM tests cannot detect a jump that
 *  overshoots because viewport pixels were assigned directly to scrollTop, and
 *  they cannot see whether the control sits clear of the prompts it marks. */
export async function assertPromptNavigation(page, shot) {
  await hostMsg(page, { type: "clearMessages" });
  for (let i = 1; i <= 3; i++) {
    await hostMsg(page, { type: "userMessage", text: `Navigation prompt ${i}` });
    await hostMsg(page, { type: "messageChunk", text: "A long answer with room to read.\n\n".repeat(45) });
    await hostMsg(page, { type: "promptComplete" });
  }
  await page.waitForFunction(() => document.querySelectorAll("#messages .msg.user").length === 3);

  // Off by default: everyone keeps the plain scroll-to-bottom pill, standing on
  // its own in the composer, with the label it has always had.
  const off = await page.evaluate(() => {
    const bottom = document.getElementById("scroll-bottom-btn");
    return {
      prev: document.getElementById("prompt-prev-btn").classList.contains("visible"),
      standalone: !!document.querySelector(".composer > #scroll-bottom-btn"),
      label: bottom.textContent.trim(),
      copies: document.querySelectorAll("#scroll-bottom-btn").length,
    };
  });
  assert.deepEqual(off, { prev: false, standalone: true, label: "Scroll to bottom", copies: 1 });

  // Turning it on goes through the real Settings row, because a client-local
  // preference has no other door - no host message, no config key. That makes
  // this the only place the row itself is exercised end to end.
  await page.click("#gear-btn");
  await page.waitForSelector("#settings-overlay", { timeout: 5000 });
  await page.click('.settings-nav-item[data-category="advanced"]');
  await page.click('.settings-row[data-id="promptNav"] .settings-switch');
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.getElementById("settings-overlay"));

  // At the bottom of the transcript the scroll pill has nothing to say and this
  // one does - the reason they are two controls rather than one group. And the
  // circle has to be clear of the prompts, or it would cover the bubble it just
  // marked: they are `align-self: flex-end` at 77%, it sits on the left edge.
  await page.evaluate(() => {
    const m = document.getElementById("messages");
    m.scrollTop = m.scrollHeight;
    m.dispatchEvent(new Event("scroll"));
  });
  const atBottom = await page.evaluate(() => {
    const prev = document.getElementById("prompt-prev-btn");
    const rect = prev.getBoundingClientRect();
    return {
      prev: prev.classList.contains("visible"),
      bottom: document.getElementById("scroll-bottom-btn").classList.contains("visible"),
      onScreen: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
      round: Math.abs(rect.width - rect.height) < 2,
      clearOfPrompts: [...document.querySelectorAll("#messages .msg.user")]
        .map((p) => p.getBoundingClientRect())
        .filter((r) => r.bottom > rect.top && r.top < rect.bottom)
        .every((r) => r.left >= rect.right),
    };
  });
  assert.deepEqual(atBottom, { prev: true, bottom: false, onScreen: true, round: true, clearOfPrompts: true });
  await shot("desk-prompt-navigation");

  await page.evaluate(() => {
    const m = document.getElementById("messages");
    const p = m.querySelectorAll(".msg.user")[1];
    const scale = m.getBoundingClientRect().height / m.offsetHeight;
    const top = m.scrollTop + (p.getBoundingClientRect().top - m.getBoundingClientRect().top) / scale;
    m.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    m.scrollTop = top + 500;
    m.dispatchEvent(new Event("scroll"));
  });
  await page.click("#prompt-prev-btn");
  const alignment = await page.evaluate(() => {
    const m = document.getElementById("messages");
    const scale = m.getBoundingClientRect().height / m.offsetHeight;
    return (m.querySelectorAll(".msg.user")[1].getBoundingClientRect().top - m.getBoundingClientRect().top) / scale
      - parseFloat(getComputedStyle(m).paddingTop);
  });
  assert.ok(Math.abs(alignment) < 3, `Previous must land on the answer's own prompt: delta=${alignment}`);
  // The mark is what joins a tap at the bottom to a prompt at the top.
  assert.equal(await page.locator(".msg.user.prompt-nav-target").count(), 1);
  // Walking back to the first prompt leaves nothing earlier, which is the only
  // thing that retires the control.
  await page.click("#prompt-prev-btn");
  await page.waitForFunction(() => !document.getElementById("prompt-prev-btn").classList.contains("visible"));
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
