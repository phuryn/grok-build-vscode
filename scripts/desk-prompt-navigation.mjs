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
    // agentEnd, not just promptComplete: agentEnd is what calls
    // revealTurnFooter, so without it the LAST turn keeps its Copy/thumbs row
    // hidden and the transcript never reaches the settled state this control
    // is used in. That omission is why the overlap check below could not fail.
    await hostMsg(page, { type: "agentEnd" });
  }
  await page.waitForFunction(() => document.querySelectorAll("#messages .msg.user").length === 3);

  // On by default since 4.5.0 (#150): the control left the experiment, so a
  // desk that never expressed an opinion now gets it. What did NOT change is
  // the pill beside it - the plain scroll-to-bottom, standing on its own in
  // the composer, with the label it has always had.
  const initial = await page.evaluate(() => {
    const bottom = document.getElementById("scroll-bottom-btn");
    return {
      prev: document.getElementById("prompt-prev-btn").classList.contains("visible"),
      standalone: !!document.querySelector(".composer > #scroll-bottom-btn"),
      label: bottom.textContent.trim(),
      copies: document.querySelectorAll("#scroll-bottom-btn").length,
    };
  });
  assert.deepEqual(initial, { prev: true, standalone: true, label: "Scroll to bottom", copies: 1 });

  // Drive it the way a DESK actually receives it: the settings page posts
  // `setPromptNav`, the host writes `grok.promptNav`, and its config listener
  // posts this frame back to the chat webview. This is that frame, not a stand
  // in for it - on a desk the chat page has no other way to learn the value.
  //
  // Driving the Settings UI here instead was tried and abandoned. Settings is
  // not on the composer gear in this window: with the model/effort split on,
  // that gear carries only "Model and Effort" and app-level panels move to the
  // rail gear, which is not visible at this viewport. The row's own contract -
  // local-only on a remote, a host message off it, visible everywhere - is
  // asserted in test/settings-surface.dom.test.ts, which is where it belongs;
  // what needs a real browser is the geometry below.
  // A settle, not a waitForFunction: the webview's CSP has no 'unsafe-eval',
  // and Playwright's polling path compiles its predicate with eval - so a
  // predicate that is false on its first synchronous try throws instead of
  // waiting.
  //
  // OFF first, and that ordering is the point now the default is on. Asserting
  // `prev: true` after a `value: true` frame would pass whether or not the
  // frame arrived - the same shape as the empty-list overlap check below,
  // which guarded nothing while reading green. Retiring the control is the
  // only assertion here that still fails if the frame is dropped.
  await hostMsg(page, { type: "promptNav", value: false });
  await page.waitForTimeout(250);
  assert.equal(
    await page.evaluate(() => document.getElementById("prompt-prev-btn").classList.contains("visible")),
    false,
    "a promptNav:false frame must retire the control",
  );

  // ...and back on, which is the state the geometry below is about.
  await hostMsg(page, { type: "promptNav", value: true });
  await page.waitForTimeout(250);

  // At the bottom of the transcript the scroll pill has nothing to say and this
  // one does - the reason they are two controls rather than one group.
  //
  // `coversNoAction` is the assertion this gate was missing. It used to check
  // the circle against the PROMPT BUBBLES, which are `align-self: flex-end` at
  // 77% and therefore never near it - a test that could not fail, guarding
  // nothing. What the circle floats over is the last message's `.msg-actions`
  // icons, and on the left it sat squarely on an agent reply's Copy button.
  //
  // The icons, not the row: `.msg-actions` is a block-level flex container, so
  // its rect spans the whole message however far left the icons sit inside it.
  // Testing the row would fail on geometry that looks perfect.
  await page.evaluate(() => {
    const m = document.getElementById("messages");
    m.scrollTop = m.scrollHeight;
    m.dispatchEvent(new Event("scroll"));
  });
  const atBottom = await page.evaluate(() => {
    const prev = document.getElementById("prompt-prev-btn");
    const bottomBtn = document.getElementById("scroll-bottom-btn");
    const rect = prev.getBoundingClientRect();
    return {
      prev: prev.classList.contains("visible"),
      bottom: bottomBtn.classList.contains("visible"),
      onScreen: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
      round: Math.abs(rect.width - rect.height) < 2,
      // One shared --float-ctl-h. They sit side by side above the same
      // composer, so any drift between them reads as a mistake.
      sameHeight: Math.abs(rect.height - bottomBtn.getBoundingClientRect().height) < 1,
      ...(() => {
        const icons = [...document.querySelectorAll("#messages .msg-actions")]
          .flatMap((row) => [...row.children])
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width > 0 && r.height > 0);
        return {
          // Counted, because the check it replaces passed by testing nothing.
          // An overlap assertion with an empty list is not a weaker test, it
          // is no test, and it reads identically in a green log.
          actionsSeen: icons.length > 0,
          coversNoAction: icons.every((r) => r.right <= rect.left || r.left >= rect.right
            || r.bottom <= rect.top || r.top >= rect.bottom),
        };
      })(),
    };
  });
  assert.deepEqual(atBottom, {
    prev: true, bottom: false, onScreen: true, round: true,
    sameHeight: true, actionsSeen: true, coversNoAction: true,
  });
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
    // Windows gives each window station its own clipboard, and an agent-run or
    // service session has none: OpenClipboard fails, every write "succeeds"
    // into nothing, and the read-back below would fail on a correct product.
    // A 1x1 canary the main process writes and reads back itself tells the two
    // apart. The paste, the preview, the Copy click and the "Image copied"
    // status are asserted either way; only the bytes on the clipboard need a
    // clipboard to read them from.
    const canary = await app.evaluate(({ clipboard, nativeImage }) => {
      clipboard.writeImage(nativeImage.createFromDataURL(
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
      ));
      return clipboard.readImage().getSize();
    });
    const clipboardReadable = canary.width === 1 && canary.height === 1;
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
    if (clipboardReadable) {
      const pixels = await app.evaluate(({ clipboard }) => {
        const img = clipboard.readImage();
        return { size: img.getSize(), first: [...img.toBitmap().subarray(0, 4)] };
      });
      assert.deepEqual(pixels.size, { width: 3200, height: 64 });
      assert.deepEqual(pixels.first, [0, 0, 255, 255]);
    } else {
      console.log(`[desk-screens] the clipboard is not readable in this session (a 1x1 canary read back as ${canary.width}x${canary.height}) — the copied bytes were not asserted; run e2e:screens from an interactive desktop session to cover them`);
    }
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
