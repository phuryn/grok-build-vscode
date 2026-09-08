// Real-layout pin check for #92. happy-dom has no layout, so both prior
// "fixes" stayed green while the reporter still unpinned. This drives the
// shipped renderer through host messages the way a live turn does: zoomed
// chat, expanded tool details, a permission-card resolve, then a tall
// command OUT block. The view must stay pinned and the floating button
// hidden. Instrument the unpin so a failure names the event, not a guess.

/** Deliver one host→webview frame the same way the desktop preload does. */
export async function hostMsg(page, data) {
  await page.evaluate((msg) => {
    window.dispatchEvent(new MessageEvent("message", { data: msg }));
  }, data);
}

const TALL_OUT = Array.from({ length: 80 }, (_, i) =>
  `line ${String(i).padStart(3, "0")} ${"x".repeat(72)}`,
).join("\n");

const TALL_PROSE = Array.from({ length: 24 }, (_, i) =>
  `Streaming paragraph ${i + 1}. The agent keeps writing so the transcript is taller than the viewport.`,
).join("\n\n");

/**
 * @param {import("playwright").Page} page
 * @param {{ log?: (m: string) => void, shot?: (name: string) => Promise<void> }} [opts]
 */
export async function assertPinnedAfterZoomedExpandedTurn(page, opts = {}) {
  const log = opts.log || ((m) => console.log(`[stick] ${m}`));

  await page.waitForSelector("#messages", { timeout: 45000 });
  await page.waitForSelector("#scroll-bottom-btn", { state: "attached", timeout: 15000 });

  // VS Code sidebar geometry: hide desktop chrome that would steal the
  // column, then shrink to a zoomed-sidebar size. Cmd+= is CSS --chat-zoom
  // (Chromium zoomFactor stays 1).
  await page.evaluate(() => {
    document.body.classList.add("desk-rail-collapsed");
    const tree = document.getElementById("desk-ft-panel");
    const toggle = document.getElementById("desk-ft-top-toggle");
    if (tree && toggle && getComputedStyle(tree).display !== "none" && tree.offsetParent !== null) {
      toggle.click();
    }
    const api = window.__grokFontScale;
    if (api && typeof api.set === "function") api.set(1.6);
    else document.body.style.setProperty("--chat-zoom", "1.6");
  });
  await page.setViewportSize({ width: 400, height: 760 });
  const zoom = await page.evaluate(() =>
    document.body.style.getPropertyValue("--chat-zoom") || getComputedStyle(document.body).getPropertyValue("--chat-zoom"),
  );
  log(`chat zoom → ${zoom}`);

  await hostMsg(page, { type: "appPurpose", value: "coding" });
  await hostMsg(page, { type: "expandCommandOutputs", value: true });

  // The race unit tests cannot see: grow the live scrollport, then fire the
  // same `scroll` the UA emits for focus / programmatic follow / anchoring.
  // Before the gesture-only pin, this unpinned (dist >> 40px) and the rAF
  // follow stopped. Must stay pinned here or round 4 ships green again.
  const race = await page.evaluate(() => {
    const messages = document.getElementById("messages");
    const btn = document.getElementById("scroll-bottom-btn");
    messages.scrollTop = messages.scrollHeight;
    const before = {
      pinned: messages.classList.contains("stick-to-bottom"),
      dist: messages.scrollHeight - (messages.scrollTop + messages.clientHeight),
    };
    const grow = document.createElement("div");
    grow.setAttribute("data-stick-race", "1");
    grow.style.minHeight = "480px";
    grow.textContent = "pin-race filler";
    messages.appendChild(grow);
    const afterGrow = messages.scrollHeight - (messages.scrollTop + messages.clientHeight);
    messages.dispatchEvent(new Event("scroll"));
    const after = {
      pinned: messages.classList.contains("stick-to-bottom"),
      btn: btn.classList.contains("visible"),
      dist: messages.scrollHeight - (messages.scrollTop + messages.clientHeight),
      afterGrow,
    };
    grow.remove();
    return { before, after };
  });
  log(`growth-scroll race: ${JSON.stringify(race)}`);
  {
    const assert = (await import("node:assert/strict")).strict;
    assert.equal(race.before.pinned, true, "stick-to-bottom: race probe must start pinned");
    assert.ok(
      race.after.afterGrow > 40,
      `stick-to-bottom: race probe did not grow past the old 40px threshold (dist=${race.after.afterGrow})`,
    );
    assert.equal(race.after.pinned, true, "stick-to-bottom: a non-gesture scroll after growth must not unpin");
    assert.equal(race.after.btn, false, "stick-to-bottom: growth-scroll race must not reveal the button");
  }

  // Capture-phase scroll log + post-listener pin flips. The product listener
  // is bubble-phase; we sample after it by registering ours second.
  await page.evaluate(() => {
    const messages = document.getElementById("messages");
    const btn = document.getElementById("scroll-bottom-btn");
    const snap = (why) => {
      const dist = messages.scrollHeight - (messages.scrollTop + messages.clientHeight);
      return {
        why,
        t: Date.now(),
        pinned: messages.classList.contains("stick-to-bottom"),
        btn: btn.classList.contains("visible"),
        dist,
        scrollTop: messages.scrollTop,
        scrollHeight: messages.scrollHeight,
        clientHeight: messages.clientHeight,
        zoom: getComputedStyle(document.body).zoom,
        chatZoom: document.body.style.getPropertyValue("--chat-zoom"),
      };
    };
    window.__stickLog = { events: [snap("start")], flips: [] };
    let lastPinned = messages.classList.contains("stick-to-bottom");
    messages.addEventListener("scroll", () => {
      const now = snap("scroll");
      window.__stickLog.events.push(now);
      if (lastPinned && !now.pinned) window.__stickLog.flips.push(now);
      lastPinned = now.pinned;
    });
    new MutationObserver(() => {
      const now = snap("class");
      if (lastPinned && !now.pinned) window.__stickLog.flips.push(now);
      lastPinned = now.pinned;
    }).observe(messages, { attributes: true, attributeFilter: ["class"] });
  });

  await hostMsg(page, { type: "userMessage", text: "run the long command" });
  await hostMsg(page, { type: "agentStart" });
  await hostMsg(page, { type: "messageChunk", text: TALL_PROSE });
  await hostMsg(page, {
    type: "toolCall",
    call: {
      toolCallId: "stick-cmd-1",
      kind: "execute",
      title: "Run node",
      rawInput: { command: "node -e \"for (let i = 0; i < 80; i++) console.log(i)\"" },
    },
  });
  await hostMsg(page, {
    type: "permissionRequest",
    req: {
      id: "stick-perm-1",
      toolCall: { toolCallId: "stick-cmd-1", kind: "execute", title: "Run node" },
      options: [
        { optionId: "allow", name: "Yes", kind: "allow_once" },
        { optionId: "rej", name: "No", kind: "reject_once" },
      ],
    },
  });

  await page.waitForSelector(".card.permission:not(.resolved) .card-actions button.primary", { timeout: 10000 });
  if (opts.shot) await opts.shot("stick-1-permission");

  const afterCard = await page.evaluate(() => {
    const messages = document.getElementById("messages");
    const btn = document.getElementById("scroll-bottom-btn");
    const active = document.activeElement;
    return {
      pinned: messages.classList.contains("stick-to-bottom"),
      btn: btn.classList.contains("visible"),
      dist: messages.scrollHeight - (messages.scrollTop + messages.clientHeight),
      scrollTop: messages.scrollTop,
      scrollHeight: messages.scrollHeight,
      clientHeight: messages.clientHeight,
      focus: active ? `${active.tagName}.${active.className} ${active.textContent}` : null,
      flips: (window.__stickLog?.flips || []).slice(),
    };
  });
  log(`after permission card: ${JSON.stringify(afterCard)}`);

  // Click through the element's own handler so Playwright cannot invent a
  // scroll-into-view on the messages port (that would look like the bug).
  await page.evaluate(() => {
    const btn = document.querySelector(".card.permission:not(.resolved) .card-actions button.primary");
    if (!btn) throw new Error("no permission Yes button");
    btn.click();
  });
  await page.waitForFunction(() =>
    !!document.querySelector(".card.permission.resolved, .card.permission.perm-resolved"),
  { timeout: 10000 });

  await hostMsg(page, {
    type: "commandOutput",
    command: "node -e \"for (let i = 0; i < 80; i++) console.log(i)\"",
    output: TALL_OUT,
    exitCode: 0,
    truncated: false,
  });
  await hostMsg(page, { type: "messageChunk", text: "Command finished. Here is a closing paragraph so the transcript grows again after the OUT block." });
  await hostMsg(page, { type: "agentEnd" });

  // Let MutationObserver rAF + any late layout (preview cap, zoom) settle.
  await page.waitForTimeout(400);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  if (opts.shot) await opts.shot("stick-2-after-turn");

  const result = await page.evaluate(() => {
    const messages = document.getElementById("messages");
    const btn = document.getElementById("scroll-bottom-btn");
    const dist = messages.scrollHeight - (messages.scrollTop + messages.clientHeight);
    return {
      pinned: messages.classList.contains("stick-to-bottom"),
      btnVisible: btn.classList.contains("visible"),
      dist,
      scrollTop: messages.scrollTop,
      scrollHeight: messages.scrollHeight,
      clientHeight: messages.clientHeight,
      zoom: getComputedStyle(document.body).zoom,
      flips: window.__stickLog?.flips || [],
      lastEvents: (window.__stickLog?.events || []).slice(-8),
    };
  });

  log(`after turn: pinned=${result.pinned} btn=${result.btnVisible} dist=${result.dist} ` +
    `top=${result.scrollTop} h=${result.scrollHeight} ch=${result.clientHeight} zoom=${result.zoom} ` +
    `flips=${result.flips.length}`);
  if (result.flips.length) {
    log(`UNPIN flips: ${JSON.stringify(result.flips, null, 2)}`);
  }
  if (!result.pinned || result.btnVisible) {
    log(`last events: ${JSON.stringify(result.lastEvents, null, 2)}`);
  }

  const assert = (await import("node:assert/strict")).strict;
  assert.equal(
    result.flips.length,
    0,
    `stick-to-bottom: a programmatic turn unpinned the reader (${result.flips.length} flip(s)) — ${JSON.stringify(result.flips)}`,
  );
  assert.equal(result.pinned, true, "stick-to-bottom: class must remain pinned after the turn");
  assert.equal(result.btnVisible, false, "stick-to-bottom: Scroll to bottom must stay hidden");
  assert.ok(
    result.scrollHeight > result.clientHeight + 80,
    `stick-to-bottom: transcript was not taller than the viewport (h=${result.scrollHeight} ch=${result.clientHeight}) — the check cannot be skipped silently`,
  );
  // Allow a zoom-rounding remainder, but the last line must still be in view.
  assert.ok(
    result.dist <= Math.max(8, result.clientHeight * 0.08),
    `stick-to-bottom: viewport is not at the bottom (dist=${result.dist}, ch=${result.clientHeight})`,
  );
  log("pinned after zoomed expanded turn");
}
