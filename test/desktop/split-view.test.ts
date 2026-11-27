import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication } from "playwright";
import { expect, it, vi } from "vitest";
import { buildQaFixture } from "../../scripts/qa-fixture.mjs";
import { desktopLaunch, parseTrace } from "../../scripts/smoke-page-driver.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const screenshots = path.join(root, ".screens", "desktop-split");
const mainPrompt = "Summarize the release notes.";
const panePrompt = "List the files to review.";
const paneReply = `Reply to ${panePrompt}`;

type TraceEvent = {
  at: string;
  direction: string;
  contentsId?: number;
  documentUrl?: string;
  clientId?: number;
  message: {
    type?: string;
    route?: string;
    binding?: number;
    name?: string;
    operation?: string;
    sessionId?: string;
    method?: string;
    params?: { prompt?: { text?: string }[]; sessionId?: string };
  };
};

async function readTrace(file: string): Promise<TraceEvent[]> {
  return parseTrace(await readFile(file, "utf8"));
}

function paneEval<T>(app: ElectronApplication, script: string, id?: number): Promise<T> {
  return app.evaluate(({ BrowserWindow, WebContentsView }, { source, id }) => {
    const pane = BrowserWindow.getAllWindows()[0].contentView.children.find(
      view => view instanceof WebContentsView && view.webContents.getURL().includes("/__app__/conversation-")
        && (id === undefined || view.webContents.id === id),
    ) as Electron.WebContentsView | undefined;
    if (!pane) throw new Error("Conversation WebContentsView missing");
    return pane.webContents.executeJavaScript(source, true);
  }, { source: script, id });
}

function nativeChats(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow, WebContentsView }) => BrowserWindow.getAllWindows()[0].contentView.children
    .filter((view): view is Electron.WebContentsView =>
      view instanceof WebContentsView && view.webContents.getURL().includes("/__app__/conversation-"))
    .map(view => ({ id: view.webContents.id, bounds: view.getBounds(), zoom: view.webContents.getZoomFactor() })));
}

async function reportSplitFailure(app: ElectronApplication | undefined, traceFile: string) {
  const trace = await readTrace(traceFile).catch(error => {
    console.error("Could not read desktop ACP trace", String(error));
    return [];
  });
  const ready = trace.filter(event => event.direction === "ipc-ready" || event.direction === "webview-ready");
  const paneIdentity = trace.filter(event => event.direction === "host-to-webview"
    && event.documentUrl?.includes("/__app__/conversation-")
    && ["editorChatBinding", "editorChatBound", "session", "sessionName"].includes(event.message.type ?? ""));
  const latestPane = trace.filter(event => event.documentUrl?.includes("/__app__/conversation-")).at(-1)?.contentsId;
  const boundId = paneIdentity.filter(event => event.contentsId === latestPane && event.message.sessionId).at(-1)?.message.sessionId;
  const acp = trace.flatMap(({ at, direction, clientId, message }) => {
    if (direction === "send" && (message.method === "session/load" || message.method === "session/new")) {
      return [{ at, clientId, call: message.method, sessionId: message.params?.sessionId }];
    }
    if (direction === "client-state" && (message.operation === "loadSession" || message.operation === "newSession")) {
      return [{ at, clientId, call: `${message.operation} acknowledged`, sessionId: message.sessionId }];
    }
    return [];
  });
  const pane = app ? await paneEval(app, `({
    label: document.querySelector("#session-name-label")?.textContent ?? null,
    editorChat: document.body.dataset.editorChat === "true",
  })`).catch(error => ({ error: String(error) })) : null;
  console.error("Desktop split failure", JSON.stringify({
    pane, boundId: boundId ?? null, ready, paneIdentity, acp,
  }, null, 2));
}

async function captureWindow(app: ElectronApplication, file: string, reply = paneReply): Promise<string> {
  const capture = await app.evaluate(async ({ BrowserWindow, WebContentsView, desktopCapturer, nativeImage, screen }, reply) => {
    const win = BrowserWindow.getAllWindows()[0];
    const panes = win.contentView.children.filter((view): view is Electron.WebContentsView =>
      view instanceof WebContentsView && view.webContents.getURL().includes("/__app__/conversation-")
        && view.getBounds().width > 0 && view.getBounds().height > 0);
    const pane = panes[0];
    if (!pane) throw new Error("Conversation WebContentsView missing");
    const rect: Electron.Rectangle = await pane.webContents.executeJavaScript(`(() => {
      const paragraph = [...document.querySelectorAll(".msg.agent .body")].find(el => el.textContent === ${JSON.stringify(reply)});
      if (!paragraph) return { missing: [...document.querySelectorAll(".msg.agent")].map(el => el.innerHTML.slice(0, 300)) };
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const box = range.getBoundingClientRect();
      return { x: Math.floor(box.left) - 2, y: Math.floor(box.top) - 2,
        width: Math.ceil(box.width) + 5, height: Math.ceil(box.height) + 5 };
    })()`);
    if ("missing" in rect) throw new Error("Child reply is missing; agent messages: " + JSON.stringify(rect.missing));
    const childBounds = pane.getBounds();
    const ink = (rgba: Buffer, offset: number, ground: number) =>
      Math.abs((rgba[offset] + rgba[offset + 1] + rgba[offset + 2]) / 3 - ground) > 45;
    let referenceGround = 0;
    let textPixels: { x: number; y: number; ink: boolean }[] = [];
    let glyphPixels = 0;
    // A view that has not painted since the last theme switch or scroll (or a
    // window Windows treats as covered) captures without text: ask it to
    // repaint and retry for a few seconds before calling it a failure.
    for (let attempt = 0; attempt < 10 && glyphPixels < 20; attempt++) {
      if (attempt > 0) {
        pane.webContents.invalidate();
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      const reference = (await pane.webContents.capturePage(rect))
        .resize({ width: rect.width, height: rect.height }).toBitmap();
      referenceGround = (reference[0] + reference[1] + reference[2]) / 3;
      textPixels = [];
      for (let y = 0; y < rect.height; y++) {
        for (let x = 0; x < rect.width; x++) {
          textPixels.push({ x, y, ink: ink(reference, (y * rect.width + x) * 4, referenceGround) });
        }
      }
      glyphPixels = textPixels.filter(p => p.ink).length;
    }
    if (glyphPixels < 20) {
      const where = await Promise.all(panes.map(async view => ({
        url: view.webContents.getURL().replace(/^.*\/__app__\//, ""),
        bounds: view.getBounds(),
        viewport: await view.webContents.executeJavaScript("innerWidth + 'x' + innerHeight"),
      })));
      throw new Error("Child renderer capture has no reply glyphs; picked " + JSON.stringify(where[0])
        + " rect " + JSON.stringify(rect) + "; panes " + JSON.stringify(where));
    }

    // Compare the actual reply's glyph mask in the composited image at the
    // native view's location. A picture of the main webContents alone fails.
    const containsReply = (image: Electron.NativeImage, x: number, y: number) => {
      if (image.isEmpty()) return false;
      const { width, height } = image.getSize();
      const pixels = image.toBitmap();
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const left = x + dx;
          const top = y + dy;
          if (left < 0 || top < 0 || left + rect.width > width || top + rect.height > height) continue;
          let matched = 0;
          let actual = 0;
          for (const pixel of textPixels) {
            if (ink(pixels, ((top + pixel.y) * width + left + pixel.x) * 4, referenceGround)) {
              actual++;
              if (pixel.ink) matched++;
            }
          }
          if (2 * matched / (glyphPixels + actual) >= 0.65) return true;
        }
      }
      return false;
    };
    const bounds = win.getBounds();
    const content = win.getContentBounds();
    const replyX = childBounds.x + rect.x;
    const replyY = childBounds.y + rect.y;
    const windowReplyX = content.x - bounds.x + replyX;
    const windowReplyY = content.y - bounds.y + replyY;
    const appShot = (await win.capturePage()).resize({ width: content.width, height: content.height });
    if (panes.length === 1 && containsReply(appShot, replyX, replyY)) {
      return { kind: "BrowserWindow.capturePage, child reply verified", png: appShot.toPNG().toString("base64") };
    }

    // Some compositors capture only the BrowserWindow's own WebContents.
    // Capture the actual desktop window when the glyph comparison finds that.
    const display = screen.getDisplayMatching(bounds);
    const sources = panes.length > 1 ? [] : await desktopCapturer.getSources({
      types: ["window", "screen"], thumbnailSize: { width: display.size.width, height: display.size.height },
    });
    const windowShot = sources.find(source => source.id === win.getMediaSourceId())?.thumbnail;
    if (windowShot && !windowShot.isEmpty()) {
      const image = windowShot.resize({ width: bounds.width, height: bounds.height });
      if (containsReply(image, windowReplyX, windowReplyY)) {
        return { kind: "desktopCapturer window, child reply verified", png: image.toPNG().toString("base64") };
      }
    }
    const displayShot = sources.find(source => source.display_id === String(display.id))?.thumbnail;
    if (displayShot && !displayShot.isEmpty()) {
      const image = displayShot.resize({ width: display.bounds.width, height: display.bounds.height }).crop({
        x: bounds.x - display.bounds.x, y: bounds.y - display.bounds.y,
        width: bounds.width, height: bounds.height,
      });
      if (containsReply(image, windowReplyX, windowReplyY)) {
        return { kind: "desktopCapturer display cropped to window, child reply verified", png: image.toPNG().toString("base64") };
      }
    }
    // A locked or covered screen yields nothing above. Composite each view's own
    // renderer pixels at the pane's real bounds instead (no screen needed).
    const base = Buffer.from(appShot.toBitmap());
    const { width: baseWidth, height: baseHeight } = appShot.getSize();
    for (const view of panes) {
      const rect = view.getBounds();
      const shot = await view.webContents.capturePage();
      if (shot.isEmpty()) throw new Error("A visible child returned an empty capture: " + view.webContents.id);
      const child = shot.resize({ width: rect.width, height: rect.height }).toBitmap();
      for (let y = 0; y < rect.height && rect.y + y < baseHeight; y++) {
        const width = Math.min(rect.width, baseWidth - rect.x);
        child.copy(base, ((rect.y + y) * baseWidth + rect.x) * 4, y * rect.width * 4, (y * rect.width + width) * 4);
      }
    }
    const composite = nativeImage.createFromBitmap(base, { width: baseWidth, height: baseHeight });
    if (containsReply(composite, replyX, replyY)) {
      return { kind: `composite of main and ${panes.length} native pane captures, child reply verified`,
        png: composite.toPNG().toString("base64") };
    }
    throw new Error("Whole-window capture did not include the native child reply. Run on an unobscured desktop with screen capture available.");
  }, reply);
  await writeFile(file, Buffer.from(capture.png, "base64"));
  return capture.kind;
}

it("routes desktop chats and keeps them usable through Files, overlays, resizing, and overflow", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "afk-desktop-split-"));
  const traceFile = path.join(temp, "desktop-wire.jsonl");
  const turnGate = path.join(temp, "finish-held-turn");
  let app: ElectronApplication | undefined;
  try {
    const qa = buildQaFixture(temp);
    // The rail lists the two newest conversations before "Show more".
    const [mainSession, paneSession] = [qa.sessions[3], qa.sessions[2]];
    const profile = path.join(temp, "profile");
    await mkdir(profile);
    const fake = path.join(root, "test", "fixtures", process.platform === "win32" ? "fake-grok-acp.cmd" : "fake-grok-acp.sh");
    await writeFile(path.join(profile, "config.json"), JSON.stringify({ "grok.cliPath": fake, "grok.desktop.tray": false }));
    await writeFile(path.join(profile, "globalState.json"), JSON.stringify({ "grok.providerConnections.v2": { grok: true } }));
    const launch = desktopLaunch(root, require("electron"), qa.project, profile, temp, {
      ...process.env, GROK_HOME: qa.grokHome, CODEX_HOME: path.join(temp, "codex"),
      FAKE_DESKTOP_SPLIT_REPLY: "1", FAKE_DESKTOP_SPLIT_TURN_GATE: turnGate, FAKE_SESSION_ID_FROM_PID: "1",
    });
    delete launch.env.GROK_RELAY_DEVICE_TOKEN;
    delete launch.env.GROK_RELAY_URL;
    delete launch.env.GROK_CLOUD_ENVIRONMENT;
    launch.env.NODE_ENV = "test";
    launch.env.GROK_DESKTOP_TEST_ALLOW_MULTIPLE = "1";
    app = await electron.launch({ ...launch, timeout: 45_000 });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const area = screen.getDisplayMatching(win.getBounds()).workArea;
      win.setBounds({ x: area.x, y: area.y, width: Math.min(1440, area.width), height: Math.min(900, area.height) });
      win.focus();
    });
    const railRow = (id: string) => page.locator(`#projects-rail .rail-session[data-session-id="${id}"]:visible`).first();
    await railRow(mainSession.id).click();
    await vi.waitFor(async () => expect(await page.locator("#session-name-label").innerText()).toContain(mainSession.title),
      { timeout: 15_000 });
    await page.locator("#messages .msg.user").filter({ hasText: mainSession.title }).waitFor({ timeout: 15_000 });
    const openBeside = async () => {
      await railRow(paneSession.id).hover();
      await railRow(paneSession.id).getByRole("button", { name: "Session actions" }).click();
      await page.getByRole("menuitem", { name: "Open to the side", exact: true }).click();
    };
    await railRow(paneSession.id).click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
    await vi.waitFor(async () => {
      expect(await paneEval(app!, 'document.querySelector("#session-name-label")?.textContent')).toContain(paneSession.title);
      expect(await paneEval(app!, 'document.querySelector("#input")?.disabled')).toBe(false);
      expect(await paneEval(app!, 'document.querySelector("#messages .msg.user")?.textContent')).toContain(paneSession.title);
    }, { timeout: 30_000 });
    expect(await page.locator("#session-name-label").innerText()).toContain(mainSession.title);
    expect(await paneEval(app, 'document.querySelectorAll("#projects-rail").length')).toBe(0);
    await vi.waitFor(async () => expect(await paneEval(app!, 'document.querySelectorAll("#desk-ft-panel").length')).toBe(1));
    const headerControls = () => [...document.querySelectorAll(".top-bar button, .top-bar #desk-ft-top-sep")]
      .filter(el => el.getBoundingClientRect().width > 0)
      .map(el => el.closest("#session-head-actions")?.id || el.id)
      .filter(id => ["session-name-label", "remote-btn", "history-btn", "new-btn", "session-head-actions",
        "desk-ft-top-sep", "desk-ft-top-toggle", "desk-conversation-close"].includes(id));
    const orderedControls = ["session-name-label", "remote-btn", "history-btn", "new-btn", "session-head-actions",
      "desk-ft-top-sep", "desk-ft-top-toggle", "desk-conversation-close"];
    await vi.waitFor(async () => {
      expect(await page.evaluate(headerControls)).toEqual(orderedControls);
      expect(await paneEval(app!, `(${headerControls.toString()})()`)).toEqual(orderedControls);
    });
    const [mainWidth, paneWidth] = await page.locator(".desk-ft-chat, #desk-conversation-slot").evaluateAll(
      elements => elements.map(element => element.getBoundingClientRect().width),
    );
    expect(mainWidth).toBeGreaterThan(360);
    expect(Math.abs(mainWidth - paneWidth)).toBeLessThanOrEqual(2);
    const headers = await page.evaluate(() => {
      const chat = document.querySelector(".desk-ft-chat")!.getBoundingClientRect();
      const header = document.querySelector(".desk-ft-chat > .top-bar")!.getBoundingClientRect();
      const slot = document.querySelector("#desk-conversation-slot")!.getBoundingClientRect();
      return { mainWidth: chat.width, headerWidth: header.width, headerTop: header.top, slotTop: slot.top };
    });
    const childHeaderTop = await paneEval<number>(app, 'document.querySelector(".top-bar").getBoundingClientRect().top');
    expect(Math.abs(headers.mainWidth - headers.headerWidth)).toBeLessThanOrEqual(1);
    expect(Math.abs(headers.headerTop - (headers.slotTop + childHeaderTop))).toBeLessThanOrEqual(2);
    const nativeWidth = async () => (await nativeChats(app!))[0]?.bounds.width ?? 0;
    await vi.waitFor(async () => expect(Math.abs(await nativeWidth() - paneWidth)).toBeLessThanOrEqual(3));
    const paneChatWidth = () => paneEval<number>(app!, 'document.querySelector(".desk-ft-chat").getBoundingClientRect().width');
    await paneEval(app, 'document.querySelector("#desk-ft-top-toggle").click()');
    await vi.waitFor(async () => expect(await paneChatWidth()).toBeLessThan(paneWidth - 50));
    await vi.waitFor(async () => {
      expect(await paneEval(app!, 'document.querySelector("#desk-ft-top-toggle").getAttribute("aria-expanded")')).toBe("true");
    });
    await page.locator("#desk-ft-panel").waitFor({ state: "hidden" });
    await paneEval(app, 'document.querySelector("#desk-ft-top-toggle").click()');
    await vi.waitFor(async () => expect(Math.abs(await nativeWidth() - paneWidth)).toBeLessThanOrEqual(3));
    const resizeWindow = (delta: number) => app!.evaluate(({ BrowserWindow }, dx) => {
      const win = BrowserWindow.getAllWindows()[0];
      const [width, height] = win.getSize();
      win.setSize(width + dx, height);
    }, delta);
    await resizeWindow(-100);
    await vi.waitFor(async () => expect(await nativeWidth()).toBeLessThan(paneWidth - 25));
    await resizeWindow(100);
    await vi.waitFor(async () => expect(Math.abs(await nativeWidth() - paneWidth)).toBeLessThanOrEqual(3));

    await page.locator("#input").fill(mainPrompt);
    await page.locator("#send-btn").click();
    const fillPane = (text: string, id?: number) => paneEval(app!, `(() => {
      const input = document.querySelector("#input");
      input.focus();
      input.select();
      document.execCommand("insertText", false, ${JSON.stringify(text)});
    })()`, id);
    const sendInPane = async (text: string) => {
      await fillPane(text);
      await vi.waitFor(async () => expect(await paneEval(app!, 'document.querySelector("#send-btn").disabled')).toBe(false));
      await paneEval(app!, 'document.querySelector("#send-btn").click()');
    };
    await sendInPane(panePrompt);
    await page.locator(".msg.agent").filter({ hasText: `Reply to ${mainPrompt}` }).waitFor();
    const transcript = 'Array.from(document.querySelectorAll(".msg.agent")).map(el => el.innerText).join("\\n")';
    await vi.waitFor(async () => expect(await paneEval(app!, transcript)).toContain(paneReply), { timeout: 15_000 });
    expect(await paneEval(app, transcript)).not.toContain(mainPrompt);
    expect(await page.locator("#messages").innerText()).not.toContain(panePrompt);
    const trace = await readTrace(traceFile);
    for (const [session, prompt] of [[mainSession, mainPrompt], [paneSession, panePrompt]] as const) {
      expect(trace.some(event => event.direction === "client-state" && event.message.operation === "loadSession"
        && event.message.sessionId === session.id)).toBe(true);
      expect(trace.filter(event => event.direction === "send" && event.message.method === "session/prompt"
        && event.message.params?.prompt?.some(part => part.text?.includes(prompt)))
        .map(event => event.message.params?.sessionId)).toEqual([session.id]);
    }

    await page.evaluate(() => (window as any).__grokFontScale.set(1.15));
    await vi.waitFor(async () => expect(await paneEval(app!, 'window.__grokFontScale.get()')).toBe(1.15));
    await page.evaluate(() => (window as any).__grokFontScale.set(1));
    await vi.waitFor(async () => expect(await paneEval(app!, 'window.__grokFontScale.get()')).toBe(1));
    await mkdir(screenshots, { recursive: true });
    for (const theme of ["light", "dark"]) {
      if (await page.locator("html").getAttribute("data-theme") !== theme) {
        await page.locator("#desk-theme-toggle").click();
      }
      await vi.waitFor(async () => expect(await paneEval(app!, 'document.documentElement.dataset.theme')).toBe(theme));
      const mainBackground = await page.locator(".desk-ft-chat").evaluate(node => getComputedStyle(node).backgroundColor);
      expect(await paneEval(app, "getComputedStyle(document.body).backgroundColor")).toBe(mainBackground);
      const file = path.join(screenshots, `split-${theme}.png`);
      console.log(`${file} (${await captureWindow(app, file)})`);
    }

    const paneUrl = await paneEval(app, "location.href");
    const paneCount = () => app!.evaluate(({ BrowserWindow, WebContentsView }) =>
      BrowserWindow.getAllWindows()[0].contentView.children.filter(
        view => view instanceof WebContentsView && view.webContents.getURL().includes("/__app__/conversation-"),
      ).length);
    const expectTarget = (active: string, other: string) => vi.waitFor(async () => {
      expect(await railRow(active).getAttribute("aria-current")).toBe("true");
      expect(await railRow(other).getAttribute("aria-description")).toBe("Open in another chat");
    });
    const expectPaneFocus = () => vi.waitFor(async () => {
      expect(await paneEval(app!, "document.activeElement?.id")).toBe("input");
    });
    await paneEval(app, 'document.querySelector("#history-btn").focus()');
    await page.locator("#input").click();
    await expectTarget(mainSession.id, paneSession.id);
    await railRow(paneSession.id).click();
    await expectPaneFocus();
    await expectTarget(paneSession.id, mainSession.id);
    expect(await paneCount()).toBe(1);
    expect(await paneEval(app, "location.href")).toBe(paneUrl);

    const replacement = qa.sessions[1];
    if (await railRow(replacement.id).count() === 0) {
      await page.locator("#projects-rail .rail-repo").filter({ hasText: qa.projectName })
        .getByRole("button", { name: "Show more", exact: true }).first().click();
    }
    await railRow(replacement.id).click();
    await vi.waitFor(async () => {
      expect(await paneEval(app!, 'document.querySelector("#session-name-label")?.textContent')).toContain(replacement.title);
    }, { timeout: 15_000 });
    await expectPaneFocus();
    await expectTarget(replacement.id, mainSession.id);
    expect(await paneEval(app, "location.href")).toBe(paneUrl);
    expect(await page.locator("#session-name-label").innerText()).toContain(mainSession.title);

    await paneEval(app, 'document.querySelector("#history-btn").focus()');
    await page.locator("#input").click();
    await expectTarget(mainSession.id, replacement.id);
    await railRow(replacement.id).press("Enter");
    await expectPaneFocus();
    await expectTarget(replacement.id, mainSession.id);
    expect(await paneCount()).toBe(1);

    const closePane = async () => {
      // Let executeJavaScript return before the click closes its renderer.
      await paneEval(app!, 'requestAnimationFrame(() => document.querySelector("#desk-conversation-close").click())');
      await page.locator("#desk-conversation-slot").waitFor({ state: "detached" });
      await vi.waitFor(async () => expect(await page.evaluate(() => document.activeElement?.id)).toBe("input"));
    };
    await closePane();
    expect(await page.locator(".app-main > .top-bar").count()).toBe(1);
    expect(await page.locator("#messages").innerText()).toContain(`Reply to ${mainPrompt}`);
    await openBeside();
    await vi.waitFor(async () => expect(await paneEval(app!, transcript)).toContain(paneReply), { timeout: 15_000 });

    await sendInPane("Link the fixture notes.");
    const notesLink = '.msg.agent a[href="docs/notes.md"]';
    await vi.waitFor(async () => expect(await paneEval(app!, `!!document.querySelector(${JSON.stringify(notesLink)})`)).toBe(true));
    await paneEval(app, `document.querySelector(${JSON.stringify(notesLink)}).click()`);
    await vi.waitFor(async () => expect(await paneEval(app!, 'document.querySelector(".desk-ft-viewer-body")?.textContent'))
      .toContain("A second Markdown file"));
    // The first chat's panel never opened a file, so it may have no viewer at all.
    expect(await page.evaluate(() => document.querySelector(".desk-ft-viewer-body")?.textContent ?? ""))
      .not.toContain("A second Markdown file");
    await page.locator("#desk-ft-top-toggle").click();
    const mainDraft = "Unsent main draft";
    const paneDraft = "Unsent pane draft";
    await page.locator("#input").fill(mainDraft);
    await fillPane(paneDraft);

    // View has no visibility getter. Record calls to the real native method
    // while retaining the original implementation, so DOM-only coverage
    // cannot satisfy the assertion or sneak a child into the Settings shot.
    const nativeVisible = (install = false) => app!.evaluate(({ BrowserWindow, WebContentsView }, wrap) => {
      const pane = BrowserWindow.getAllWindows()[0].contentView.children.find(
        view => view instanceof WebContentsView && view.webContents.getURL().includes("/__app__/conversation-"),
      ) as (Electron.WebContentsView & { visibleForTest?: boolean }) | undefined;
      if (!pane) throw new Error("Conversation WebContentsView missing");
      if (wrap) {
        const original = pane.setVisible.bind(pane);
        pane.setVisible = visible => { original(visible); pane.visibleForTest = visible; };
      }
      return pane.visibleForTest;
    }, install);
    await nativeVisible(true);
    const expectPaneVisible = (visible: boolean) => vi.waitFor(async () => expect(await nativeVisible()).toBe(visible));
    const expectDrafts = async () => {
      expect(await page.locator("#input").inputValue()).toBe(mainDraft);
      expect(await paneEval(app!, 'document.querySelector("#input").value')).toBe(paneDraft);
    };
    await page.getByRole("button", { name: "Maximize file panel" }).click();
    expect(await nativeWidth()).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Restore file panel" }).click();
    await expectDrafts();
    for (const theme of ["light", "dark"]) {
      if (await page.locator("html").getAttribute("data-theme") !== theme) {
        await page.locator("#desk-theme-toggle").click();
      }
      await vi.waitFor(async () => expect(await paneEval(app!, 'document.documentElement.dataset.theme')).toBe(theme));
      await paneEval(app, `[...document.querySelectorAll(".msg.agent .body")].find(
        el => el.textContent === ${JSON.stringify(paneReply)}).scrollIntoView({ block: "center" })`);
      const dock = path.join(screenshots, `dock-with-pane-${theme}.png`);
      console.log(`${dock} (${await captureWindow(app, dock)})`);
      await paneEval(app, "window.__grokFilePanelOpenSettings()");
      const settings = page.locator("#settings-overlay");
      await settings.waitFor();
      await expectPaneVisible(false);
      expect(await paneCount()).toBe(1);
      const overlay = path.join(screenshots, `settings-with-pane-${theme}.png`);
      await page.screenshot({ path: overlay });
      console.log(overlay);
      await page.keyboard.press("Escape");
      await settings.waitFor({ state: "detached" });
      await expectPaneVisible(true);
      await expectDrafts();
    }

    await sendInPane("Wait for the pane to close.");
    await vi.waitFor(async () => expect(await paneEval(app!, transcript)).toContain("Started the held turn."));
    const dot = railRow(paneSession.id).locator(`[data-session-dot="${paneSession.id}"]`);
    await vi.waitFor(async () => expect(await dot.getAttribute("data-dot")).toBe("working"));
    await closePane();
    await writeFile(turnGate, "finish");
    await vi.waitFor(async () => expect(await dot.getAttribute("data-dot")).toBe("unread"), { timeout: 15_000 });
    expect(await page.locator("#messages").innerText()).not.toContain("Finished after the pane closed.");
    await openBeside();
    await vi.waitFor(async () => expect(await paneEval(app!, transcript)).toContain("Finished after the pane closed."), { timeout: 15_000 });
    await closePane();
    await railRow(paneSession.id).click();
    await page.locator("#messages").getByText("Finished after the pane closed.", { exact: false }).waitFor();
    expect(await paneCount()).toBe(0);

    // Leave Files and Projects open while reducing the outer window.
    const width = () => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize()[0]);
    const setWidth = (next: number) => app!.evaluate(({ BrowserWindow }, w) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setSize(w, win.getSize()[1]);
    }, next);
    const wide = await width();
    const rail = page.locator("#projects-rail");
    const files = page.locator("#desk-ft-panel");
    await rail.waitFor();
    await files.waitFor();
    await setWidth(Math.min(wide, 1350));
    await railRow(mainSession.id).click();
    await page.locator("#session-name-label").filter({ hasText: mainSession.title }).waitFor();
    await openBeside();
    await vi.waitFor(async () => expect(await paneEval(app!, transcript)).toContain(paneReply));
    const firstId = (await nativeChats(app))[0].id;
    const resizeTarget = await width();
    const visibleIds = async () => (await nativeChats(app!)).filter(chat => chat.bounds.width > 0 && chat.bounds.height > 0)
      .map(chat => chat.id);
    await vi.waitFor(async () => expect(await visibleIds()).toEqual([firstId]));
    await rm(turnGate);
    await sendInPane("Wait for the pane to close.");
    await vi.waitFor(async () => expect(await dot.getAttribute("data-dot")).toBe("working"));

    await railRow(replacement.id).click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
    await vi.waitFor(async () => expect(await paneCount()).toBe(2));
    const thirdId = (await nativeChats(app)).find(chat => chat.id !== firstId)!.id;
    await vi.waitFor(async () => expect(await visibleIds()).toEqual([thirdId]));
    await vi.waitFor(async () =>
      expect(await paneEval(app!, 'document.querySelector("#session-name-label")?.textContent', thirdId)).toContain(replacement.title));
    expect(await width()).toBe(resizeTarget);
    const picker = page.getByLabel("Switch to an open chat");
    const draft = "Draft kept by the overflow picker";
    await fillPane(draft, thirdId);
    await writeFile(turnGate, "finish");
    await vi.waitFor(async () => {
      expect(await picker.getAttribute("data-unread")).toBe("true");
      expect(await dot.getAttribute("data-dot")).toBe("unread");
      expect(await picker.locator(`option[value="${firstId}"]`).textContent()).toContain("Unread");
    }, { timeout: 15_000 });
    await picker.selectOption(String(firstId));
    await vi.waitFor(async () => expect(await visibleIds()).toEqual([firstId]));
    await picker.selectOption(String(thirdId));
    await vi.waitFor(async () => {
      expect(await visibleIds()).toEqual([thirdId]);
      expect(await paneEval(app!, 'document.activeElement?.id', thirdId)).toBe("input");
      expect(await paneEval(app!, 'document.querySelector("#input").value', thirdId)).toBe(draft);
    });

    // Invoke the real application menu with the child focused. A timestamp
    // from each document distinguishes a child Reload from a window Reload.
    const menu = (id: string, paneId?: number) => app!.evaluate(({ BrowserWindow, Menu, WebContentsView }, args) => {
      const win = BrowserWindow.getAllWindows()[0];
      const pane = win.contentView.children.find(
        view => view instanceof WebContentsView && view.webContents.id === args.paneId,
      ) as Electron.WebContentsView | undefined;
      if (args.paneId !== undefined && !pane?.webContents.isFocused()) throw new Error("Child did not have native focus");
      const item = Menu.getApplicationMenu()?.getMenuItemById(args.id);
      if (!item) throw new Error("Missing application menu item: " + args.id);
      item.click(item, win, {} as Electron.KeyboardEvent);
    }, { id, paneId });
    const mainBoot = await page.evaluate(() => performance.timeOrigin);
    const peerBoot = await paneEval(app, "performance.timeOrigin", firstId);
    const childBoot = await paneEval<number>(app, "performance.timeOrigin", thirdId);
    await menu("desktop-reload", thirdId);
    await vi.waitFor(async () => {
      expect(await paneEval<number>(app!, "performance.timeOrigin", thirdId).catch(() => 0)).toBeGreaterThan(childBoot);
      expect(await paneEval(app!, 'document.querySelector("#input").value', thirdId)).toBe(draft);
    }, { timeout: 15_000 });
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(mainBoot);
    expect(await paneEval(app, "performance.timeOrigin", firstId)).toBe(peerBoot);

    const keyInPane = (keyCode: string) => app!.evaluate(({ BrowserWindow, WebContentsView }, { id, keyCode, mac }) => {
      const pane = BrowserWindow.getAllWindows()[0].contentView.children.find(
        view => view instanceof WebContentsView && view.webContents.id === id,
      ) as Electron.WebContentsView;
      pane.webContents.focus();
      const modifiers: Electron.KeyboardInputEvent["modifiers"] = [mac ? "meta" : "control"];
      pane.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
      pane.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    }, { id: thirdId, keyCode, mac: process.platform === "darwin" });
    await paneEval(app, 'document.querySelector("#input").focus()', thirdId);
    await keyInPane("A");
    await vi.waitFor(async () => expect(await paneEval(app!, `(() => {
      const input = document.querySelector("#input");
      return [input.selectionStart, input.selectionEnd];
    })()`, thirdId)).toEqual([0, draft.length]));
    const expectScale = (value: number) => vi.waitFor(async () => {
      expect(await page.evaluate(() => (window as any).__grokFontScale.get())).toBe(value);
      for (const chat of await nativeChats(app!)) {
        expect(chat.zoom).toBe(1);
        expect(await paneEval(app!, "window.__grokFontScale.get()", chat.id)).toBe(value);
      }
    });
    await menu("desktop-zoom-in", thirdId);
    await expectScale(1.1);
    await menu("desktop-zoom-reset");
    await expectScale(1);

    await setWidth(400);
    await vi.waitFor(async () => expect(await width()).toBe(400));
    await vi.waitFor(async () => expect(await visibleIds()).toEqual([]));
    await picker.waitFor();
    expect(await paneCount()).toBe(2);
    await rail.waitFor({ state: "hidden" });
    const filesToggle = page.locator("#desk-ft-top-toggle");
    await files.waitFor();
    await filesToggle.click();
    await files.waitFor({ state: "hidden" });
    const composerFits = `(() => {
      const input = document.querySelector("#input").getBoundingClientRect();
      const send = document.querySelector("#send-btn").getBoundingClientRect();
      const chat = (document.querySelector(".desk-ft-chat") || document.body).getBoundingClientRect();
      return input.width > 100 && send.width > 0 && send.right <= chat.right && send.bottom <= chat.bottom;
    })()`;
    expect(await page.evaluate(composerFits)).toBe(true);
    await picker.selectOption(String(thirdId));
    await vi.waitFor(async () => {
      expect(await visibleIds()).toEqual([thirdId]);
      const child = (await nativeChats(app!)).find(chat => chat.id === thirdId)!;
      const main = await page.locator(".desk-ft-chat").boundingBox();
      expect(child.bounds.y).toBeGreaterThanOrEqual(Math.floor(main!.y + main!.height));
      expect(await paneEval(app!, composerFits, thirdId)).toBe(true);
    });
    expect(await page.evaluate(composerFits)).toBe(true);
    expect(await width()).toBe(400);
    await picker.selectOption("0");
    await vi.waitFor(async () => expect(await visibleIds()).toEqual([]));
    for (const theme of ["light", "dark"]) {
      if (await page.locator("html").getAttribute("data-theme") !== theme) {
        await page.locator("#desk-rail-open-btn").click();
        await rail.waitFor();
        await page.locator("#desk-theme-toggle").click();
        await page.locator("#desk-rail-toggle").click();
      }
      await rail.waitFor({ state: "hidden" });
      await picker.waitFor();
      await page.screenshot({ path: path.join(screenshots, `narrow-picker-${theme}.png`) });
    }
    await setWidth(wide);
    await rail.waitFor();
    await filesToggle.click();
    await files.waitFor();
    // Make room for all three chats on displays with less work area.
    if (await page.locator("#desk-conversation-columns").evaluate(el => el.getBoundingClientRect().width) < 1288) {
      await page.locator("#desk-ft-top-toggle").click();
    }
    if (await page.locator("#desk-conversation-columns").evaluate(el => el.getBoundingClientRect().width) < 1082) {
      await page.locator("#desk-rail-toggle").click();
    }
    if (await page.locator("#desk-conversation-columns").evaluate(el => el.getBoundingClientRect().width) < 1082) {
      await page.evaluate(() => (window as any).__grokFontScale.set(0.8));
    }
    await vi.waitFor(async () => expect(await visibleIds()).toEqual([firstId, thirdId]));
    await picker.waitFor({ state: "hidden" });
    expect(await paneEval(app, 'document.querySelector("#input").value', thirdId)).toBe(draft);
    for (const theme of ["light", "dark"]) {
      if (await page.locator("html").getAttribute("data-theme") !== theme) {
        await page.evaluate(() => (window as any).__toggleDesktopTheme());
      }
      for (const id of [firstId, thirdId]) {
        await vi.waitFor(async () => expect(await paneEval(app!, 'document.documentElement.dataset.theme', id)).toBe(theme));
      }
      await paneEval(app, `[...document.querySelectorAll(".msg.agent .body")].find(
        el => el.textContent === ${JSON.stringify(paneReply)}).scrollIntoView({ block: "center" })`, firstId);
      const screenshot = path.join(screenshots, `restored-wide-${theme}.png`);
      console.log(`${screenshot} (${await captureWindow(app, screenshot)})`);
    }
  } catch (error) {
    await reportSplitFailure(app, traceFile);
    throw error;
  } finally {
    try { await app?.close(); }
    finally { await rm(temp, { recursive: true, force: true }); }
  }
}, 180_000);

it("docks each chat's project and restores each Files toggle independently", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "afk-desktop-files-per-chat-"));
  const profile = path.join(temp, "profile");
  let app: ElectronApplication | undefined;
  let traceDir = temp;
  try {
    const qa = buildQaFixture(temp);
    const [mainSession, paneSession] = [qa.sessions[3], qa.sessions[2]];
    const second = path.join(temp, "notes-project");
    await mkdir(path.join(second, "docs"), { recursive: true });
    const encode = require("../../out/sessions.js").encodeSessionCatalogLeaf as (cwd: string) => string;
    const catalog = (cwd: string) => path.join(qa.grokHome, "sessions", encode(cwd));
    const conversation = path.join(catalog(second), paneSession.id);
    await mkdir(catalog(second), { recursive: true });
    await rename(path.join(catalog(qa.project), paneSession.id), conversation);
    const summaryPath = path.join(conversation, "summary.json");
    const summary = JSON.parse(await readFile(summaryPath, "utf8"));
    summary.info.cwd = second;
    await writeFile(summaryPath, JSON.stringify(summary));
    await writeFile(path.join(second, "docs", "notes.md"), "# Original notes\n");

    for (const cwd of [qa.project, second]) {
      execFileSync("git", ["init", "-q"], { cwd });
      execFileSync("git", ["add", "."], { cwd });
      execFileSync("git", ["-c", "user.name=QA", "-c", "user.email=qa@example.test",
        "-c", "commit.gpgsign=false", "commit", "-qm", "Fixture"], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
    }
    await writeFile(path.join(qa.project, "main-only.txt"), "First project's only change.");
    await writeFile(path.join(second, "docs", "notes.md"), "# Notes from the second project\n");
    await writeFile(path.join(second, "peer-only.txt"), "Second project's change.");

    const fake = path.join(root, "test", "fixtures", process.platform === "win32" ? "fake-grok-acp.cmd" : "fake-grok-acp.sh");
    await mkdir(profile);
    const configPath = path.join(profile, "config.json");
    const overrides = {
      "grok.cliPath": fake, "grok.desktop.tray": false, workspaceRoot: qa.project, workspaceRoots: [qa.project, second],
    };
    await writeFile(configPath, JSON.stringify(overrides));
    await writeFile(path.join(profile, "globalState.json"), JSON.stringify({ "grok.providerConnections.v2": { grok: true } }));
    const start = () => {
      const launch = desktopLaunch(root, require("electron"), qa.project, profile, traceDir, {
        ...process.env, GROK_HOME: qa.grokHome, CODEX_HOME: path.join(temp, "codex"),
        FAKE_DESKTOP_SPLIT_REPLY: "1", FAKE_SESSION_ID_FROM_PID: "1",
      });
      delete launch.env.GROK_RELAY_DEVICE_TOKEN;
      delete launch.env.GROK_RELAY_URL;
      delete launch.env.GROK_CLOUD_ENVIRONMENT;
      launch.env.NODE_ENV = "test";
      launch.env.GROK_DESKTOP_TEST_ALLOW_MULTIPLE = "1";
      return electron.launch({ ...launch, timeout: 45_000 });
    };
    app = await start();
    let page = await app.firstWindow();
    const setWindowWidth = (target: number) => app!.evaluate(({ BrowserWindow, screen }, target) => {
      const win = BrowserWindow.getAllWindows()[0];
      const area = screen.getDisplayMatching(win.getBounds()).workArea;
      const width = Math.min(area.width, target);
      win.setBounds({ x: area.x, y: area.y, width, height: Math.min(area.height, 900) });
      win.focus();
      return width;
    }, target);
    await setWindowWidth(1920);
    await page.evaluate(() => {
      localStorage.setItem("rail-width", "300");
      document.documentElement.style.setProperty("--rail-width", "300px");
      localStorage.setItem("desk-ft-width", "290");
    });
    const row = (id: string) => page.locator(`#projects-rail .rail-session[data-session-id="${id}"]:visible`).first();
    await row(mainSession.id).click();
    await page.locator("#session-name-label").filter({ hasText: mainSession.title }).waitFor();
    await row(paneSession.id).click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
    const paneToggle = () => paneEval(app!, 'document.querySelector("#desk-ft-top-toggle")?.click()');
    const paneOpen = () => paneEval(app!, 'document.querySelector("#desk-ft-panel")?.hidden === false');
    const mainFiles = () => page.locator("#desk-ft-panel");
    const title = 'document.querySelector("#desk-ft-title .gfp-title-label")?.textContent';
    await vi.waitFor(async () => expect(await paneEval(app!, title)).toBe("notes-project"), { timeout: 15_000 });
    await page.locator("#desk-ft-top-toggle").click();
    await paneToggle();
    await mainFiles().getByText("main-only.txt", { exact: true }).waitFor();
    await vi.waitFor(async () => {
      expect(await paneEval(app!, 'document.querySelector("#desk-ft-body").textContent')).toContain("peer-only.txt");
      expect(await page.locator("#desk-ft-title .gfp-title-label").textContent()).toBe(qa.projectName);
      expect(await page.locator("#desk-ft-top-toggle .gfp-toggle-count").textContent()).toBe("1");
      expect(await paneEval(app!, 'document.querySelector("#desk-ft-top-toggle .gfp-toggle-count").textContent')).toBe("2");
    }, { timeout: 15_000 });
    const wrongRoot = await paneEval(app, `window.grokDesktopFileTree.read("main-only.txt", ${JSON.stringify(qa.project)})`);
    expect(wrongRoot).toMatchObject({ ok: false, reason: "workspace changed" });

    const send = async (text: string) => {
      await vi.waitFor(async () => expect(await paneEval(app!, 'document.querySelector("#input")?.disabled')).toBe(false),
        { timeout: 15_000 });
      await paneEval(app!, `(() => {
        const input = document.querySelector("#input");
        input.focus();
        input.select();
        document.execCommand("insertText", false, ${JSON.stringify(text)});
        document.querySelector("#send-btn").click();
      })()`);
    };
    await send(panePrompt);
    await vi.waitFor(async () => expect(await paneEval(app!, 'document.querySelector("#messages").textContent')).toContain(paneReply),
      { timeout: 15_000 });
    await send("Link the fixture notes.");
    const link = '.msg.agent a[href="docs/notes.md"]';
    await vi.waitFor(async () => expect(await paneEval(app!, `!!document.querySelector(${JSON.stringify(link)})`)).toBe(true),
      { timeout: 15_000 });
    await paneEval(app, `document.querySelector(${JSON.stringify(link)}).click()`);
    await vi.waitFor(async () => expect(await paneEval(app!, 'document.querySelector(".desk-ft-viewer-body")?.textContent'))
      .toContain("Notes from the second project"));
    expect(await mainFiles().locator(".gfp-tab").count()).toBe(0);
    await paneEval(app, "window.__grokDeskFilePanel.showChanges()");
    const changedNote = '.gfp-change-row[data-path="docs/notes.md"]';
    await vi.waitFor(async () => expect(await paneEval(app!, `!!document.querySelector(${JSON.stringify(changedNote)})`)).toBe(true));
    await paneEval(app, `document.querySelector(${JSON.stringify(changedNote)}).click()`);
    await vi.waitFor(async () => {
      expect(await paneEval(app!, 'document.querySelector(".gfp-changes-mode")?.textContent'))
        .toContain("Notes from the second project");
      expect(await mainFiles().locator(".gfp-changes-diff-name").count()).toBe(0);
    }, { timeout: 15_000 });

    const measure = `(() => {
      const zoom = Number(getComputedStyle(document.body).zoom) || 1;
      const rect = sel => document.querySelector(sel).getBoundingClientRect();
      const chat = rect(".desk-ft-chat");
      const files = rect("#desk-ft-panel");
      return { chat: chat.width / zoom, files: files.width / zoom, next: files.left >= chat.right - 2 };
    })()`;
    await mkdir(screenshots, { recursive: true });
    for (const target of [1920, 1440]) {
      const actual = await setWindowWidth(target);
      const columns = () => page.locator("#desk-conversation-columns").evaluate(el => el.getBoundingClientRect().width);
      if (await columns() < 1123) {
        const zoom = Math.floor(await columns() / 1123 * 20) / 20;
        await page.evaluate(zoom => (window as any).__grokFontScale.set(Math.max(0.8, zoom)), zoom);
      }
      await vi.waitFor(async () => {
        for (const measured of [await page.evaluate<{ chat: number; files: number; next: boolean }>(measure),
          await paneEval<{ chat: number; files: number; next: boolean }>(app!, measure)]) {
          expect(measured.chat).toBeGreaterThanOrEqual(359);
          expect(measured.files).toBeGreaterThanOrEqual(199.9);
          expect(measured.next).toBe(true);
        }
        expect(await page.getByLabel("Switch to an open chat").isVisible()).toBe(false);
      });
      for (const theme of ["light", "dark"]) {
        if (await page.locator("html").getAttribute("data-theme") !== theme) {
          await page.locator("#desk-theme-toggle").click();
        }
        await vi.waitFor(async () => expect(await paneEval(app!, 'document.documentElement.dataset.theme')).toBe(theme));
        await paneEval(app, `[...document.querySelectorAll(".msg.agent .body")].find(
          el => el.textContent === ${JSON.stringify(paneReply)}).scrollIntoView({ block: "center" })`);
        const file = path.join(screenshots, `files-per-chat-${target}-at-${actual}-${theme}.png`);
        console.log(`${file} (${await captureWindow(app, file)})`);
      }
    }

    const mainBefore = await page.evaluate(measure);
    const secondBefore = await paneEval<{ chat: number; files: number }>(app, measure);
    await paneToggle();
    await vi.waitFor(async () => {
      expect(await paneOpen()).toBe(false);
      expect(await page.evaluate(measure)).toEqual(mainBefore);
      expect((await paneEval<{ chat: number }>(app!, measure)).chat).toBeGreaterThan(secondBefore.chat + 190);
    });
    await app.close();
    app = undefined;
    await writeFile(configPath, JSON.stringify({ ...JSON.parse(await readFile(configPath, "utf8")), ...overrides }));
    traceDir = path.join(temp, "restart");
    await mkdir(traceDir);
    app = await start();
    await app.firstWindow();
    page = await vi.waitFor(() => {
      const window = app!.windows().find(win => !win.url().includes("/__app__/conversation-"));
      expect(window).toBeDefined();
      return window!;
    });
    await page.locator("#session-name-label").filter({ hasText: mainSession.title }).waitFor();
    await mainFiles().waitFor();
    await vi.waitFor(async () => {
      expect(await paneEval(app!, title)).toBe("notes-project");
      expect(await paneOpen()).toBe(false);
    });
    await paneToggle();
    await vi.waitFor(async () => expect(await paneOpen()).toBe(true));
  } catch (error) {
    await reportSplitFailure(app, path.join(traceDir, "desktop-wire.jsonl"));
    throw error;
  } finally {
    try { await app?.close(); }
    finally { await rm(temp, { recursive: true, force: true }); }
  }
}, 180_000);

it("restores the split profile, starts only visible conversations, and keeps dictation with its owner", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "afk-desktop-restore-"));
  const profile = path.join(temp, "profile");
  let traceFile = path.join(temp, "desktop-wire.jsonl");
  let app: ElectronApplication | undefined;
  try {
    const qa = buildQaFixture(temp);
    const [main, first, second] = [qa.sessions[3], qa.sessions[2], qa.sessions[1]];
    const drafts = ["Main draft before restart", "First pane draft before restart", "Second pane draft before restart"];
    const fake = path.join(root, "test", "fixtures", process.platform === "win32" ? "fake-grok-acp.cmd" : "fake-grok-acp.sh");
    await mkdir(profile);
    const overrides = {
      "grok.cliPath": fake, "grok.desktop.tray": false, "grok.voiceBackend": "openai",
      "grok.voiceStreaming": true, "grok.ffmpegPath": process.execPath, "grok.voiceInputDevice": "Test microphone",
    };
    await writeFile(path.join(profile, "config.json"), JSON.stringify(overrides));
    await writeFile(path.join(profile, "globalState.json"), JSON.stringify({ "grok.providerConnections.v2": { grok: true } }));
    const start = (traceOutput: string) => {
      const launch = desktopLaunch(root, require("electron"), qa.project, profile, traceOutput, {
        ...process.env, GROK_HOME: qa.grokHome, CODEX_HOME: path.join(temp, "codex"),
        FAKE_SESSION_ID_FROM_PID: "1", OPENAI_API_KEY: "test-dictation-key",
      });
      delete launch.env.GROK_RELAY_DEVICE_TOKEN;
      delete launch.env.GROK_RELAY_URL;
      delete launch.env.GROK_CLOUD_ENVIRONMENT;
      launch.env.NODE_ENV = "test";
      launch.env.GROK_DESKTOP_TEST_ALLOW_MULTIPLE = "1";
      // Use the same single Electron preload as desktopLaunch. The fixture
      // also installs the usual passive trace hooks.
      launch.args[1] = path.join(root, "test/fixtures/fake-desktop-voice.cjs");
      return electron.launch({ ...launch, timeout: 45_000 });
    };
    app = await start(temp);
    let page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const area = screen.getDisplayMatching(win.getBounds()).workArea;
      win.setBounds({ x: area.x, y: area.y, width: Math.min(1220, area.width), height: Math.min(840, area.height) });
      win.focus();
    });
    const railRow = (id: string) => page.locator(`#projects-rail .rail-session[data-session-id="${id}"]:visible`).first();
    const beside = (id: string) => railRow(id).click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
    const title = 'document.querySelector("#session-name-label")?.textContent';
    const value = 'document.querySelector("#input")?.value';
    const paneDraft = (id: number) => paneEval<string>(app!, value, id);
    const fillPane = (id: number, text: string) => paneEval(app!, `(() => {
      document.querySelector("#input").focus();
      document.execCommand("insertText", false, ${JSON.stringify(text)});
    })()`, id);
    const expectPane = (index: number, name: string, visible: boolean) => vi.waitFor(async () => {
      const pane = (await nativeChats(app!))[index];
      expect(pane).toBeDefined();
      expect(pane.bounds.width > 0).toBe(visible);
      expect(await paneEval(app!, title, pane.id)).toContain(name);
      return pane.id;
    }, { timeout: 15_000 });
    await railRow(main.id).click();
    await page.locator("#session-name-label").filter({ hasText: main.title }).waitFor();
    await beside(first.id);
    await fillPane(await expectPane(0, first.title, true), drafts[1]);
    if (!(await railRow(second.id).count())) {
      await page.locator("#projects-rail .rail-repo").filter({ hasText: qa.projectName })
        .getByRole("button", { name: "Show more", exact: true }).first().click();
    }
    await beside(second.id);
    const shown = await expectPane(1, second.title, true);
    await fillPane(shown, drafts[2]);
    await page.locator("#input").fill(drafts[0]);
    await railRow(second.id).click();
    await vi.waitFor(async () => expect(await railRow(second.id).getAttribute("aria-current")).toBe("true"));
    await expectPane(0, first.title, false);

    const memento = path.join(profile, "workspaceState.json");
    const snapshot = () => readFile(memento, "utf8").then(JSON.parse);
    await vi.waitFor(async () => {
      const saved = await snapshot();
      const layout = saved["grok.desktopConversationLayout"];
      expect(layout.lastUsed).toBe(layout.panes[1]);
      expect(layout.panes.map((key: string) => saved["grok.editorChatPanel." + key]?.draft?.text)).toEqual(drafts.slice(1));
      expect(saved["grok.desktopMainDraft"]).toMatchObject({ sessionId: main.id, text: drafts[0] });
    });
    const size = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize());
    await app.close();
    app = undefined;
    expect((await snapshot())["grok.desktopConversationLayout"].panes).toHaveLength(2);

    // The overrides file is the profile's own config.json, which the app
    // rewrites from its persisted store on quit; put the test's keys back.
    const persisted = JSON.parse(await readFile(path.join(profile, "config.json"), "utf8"));
    await writeFile(path.join(profile, "config.json"), JSON.stringify({ ...persisted, ...overrides }));
    const restarted = path.join(temp, "restarted");
    await mkdir(restarted);
    traceFile = path.join(restarted, "desktop-wire.jsonl");
    app = await start(restarted);
    await app.firstWindow();
    // Restored panes can load before the main chat, and Playwright lists their
    // views as windows too, so pick the main chat by its URL.
    page = await vi.waitFor(() => {
      const found = app!.windows().find(win => !win.url().includes("/__app__/conversation-"));
      expect(found).toBeDefined();
      return found!;
    }, { timeout: 15_000 });
    const firstId = await expectPane(0, first.title, false);
    const secondId = await expectPane(1, second.title, true);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize())).toEqual(size);
    await page.locator("#session-name-label").filter({ hasText: main.title }).waitFor();
    await vi.waitFor(async () => {
      expect(await page.locator("#input").inputValue()).toBe(drafts[0]);
      expect(await paneDraft(firstId)).toBe(drafts[1]);
      expect(await paneDraft(secondId)).toBe(drafts[2]);
      expect(await railRow(second.id).getAttribute("aria-current")).toBe("true");
    }, { timeout: 15_000 });
    const loads = async () => (await readTrace(traceFile)).filter(event => event.direction === "send"
      && event.message.method === "session/load").map(event => event.message.params?.sessionId);
    await vi.waitFor(async () => expect(await loads()).toEqual(expect.arrayContaining([main.id, second.id])));
    expect(await loads()).not.toContain(first.id);
    const picker = page.getByLabel("Switch to an open chat");
    await picker.selectOption(String(firstId));
    await expectPane(0, first.title, true);
    await vi.waitFor(async () => expect((await loads()).filter(id => id === first.id)).toHaveLength(1));
    await vi.waitFor(async () => expect(await paneEval(app!, 'document.querySelector("#messages").textContent', firstId)).toContain("Acknowledged."));

    // Grow into three columns for the restored captures. The docked rail can
    // yield room when running on a smaller display.
    await app.evaluate(({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setSize(Math.min(1440, screen.getDisplayMatching(win.getBounds()).workArea.width), win.getSize()[1]);
    });
    const columnsWidth = () => page.locator("#desk-conversation-columns").evaluate(el => el.getBoundingClientRect().width);
    if (await columnsWidth() < 1082) await page.locator("#desk-rail-toggle").click();
    if (await columnsWidth() < 1082) await page.evaluate(() => (window as any).__grokFontScale.set(0.8));
    await expectPane(1, second.title, true);
    await mkdir(screenshots, { recursive: true });
    for (const theme of ["light", "dark"]) {
      if (await page.locator("html").getAttribute("data-theme") !== theme) {
        await page.evaluate(() => (window as any).__toggleDesktopTheme());
      }
      for (const id of [firstId, secondId]) {
        await vi.waitFor(async () => expect(await paneEval(app!, 'document.documentElement.dataset.theme', id)).toBe(theme));
      }
      const file = path.join(screenshots, `restored-split-${theme}.png`);
      console.log(`${file} (${await captureWindow(app, file, "Acknowledged.")})`);
    }

    const mic = page.locator("#mic-btn");
    const paneMic = (id: number) => paneEval(app!, 'document.querySelector("#mic-btn").click()', id);
    const paneBusy = (id: number) => paneEval(app!, 'document.querySelector("#mic-btn").classList.contains("busy-elsewhere")', id);
    const fixtureVoice = (text: string) => app!.evaluate((_electron, words) => (globalThis as any).splitVoiceFixture.partial(words), text);
    const expectBothDrafts = async (mainText: string, firstText: string, secondText: string) => {
      expect(await page.locator("#input").inputValue()).toBe(mainText);
      expect(await paneDraft(firstId)).toBe(firstText);
      expect(await paneDraft(secondId)).toBe(secondText);
    };
    await paneMic(firstId);
    await vi.waitFor(async () => {
      expect(await paneBusy(secondId)).toBe(true);
      expect(await mic.getAttribute("class")).toContain("busy-elsewhere");
    });
    await fixtureVoice("dictated in the first pane");
    const paneResult = drafts[1] + " dictated in the first pane";
    await paneMic(firstId);
    await vi.waitFor(async () => {
      expect(await mic.isEnabled()).toBe(true);
      await expectBothDrafts(drafts[0], paneResult, drafts[2]);
    });
    await mic.click();
    await vi.waitFor(async () => {
      expect(await paneBusy(firstId)).toBe(true);
      expect(await paneBusy(secondId)).toBe(true);
    });
    await fixtureVoice("dictated in main");
    await mic.click();
    const mainResult = drafts[0] + " dictated in main";
    await vi.waitFor(async () => {
      expect(await paneBusy(firstId)).toBe(false);
      await expectBothDrafts(mainResult, paneResult, drafts[2]);
    });

    await paneMic(secondId);
    await vi.waitFor(async () => expect(await paneBusy(firstId)).toBe(true));
    await fixtureVoice("provisional speech to discard");
    await vi.waitFor(async () => expect(await paneDraft(secondId)).toContain("provisional speech to discard"));
    await paneEval(app, 'requestAnimationFrame(() => document.querySelector("#desk-conversation-close").click())', secondId);
    await vi.waitFor(async () => {
      expect(await mic.isEnabled()).toBe(true);
      expect((await nativeChats(app!)).map(pane => pane.id)).toEqual([firstId]);
    });
    expect(await app.evaluate(() => (globalThis as any).splitVoiceFixture.canceled())).toBe(1);
    await fixtureVoice("late speech after close");
    expect(await page.locator("#input").inputValue()).toBe(mainResult);
    expect(await paneDraft(firstId)).toBe(paneResult);
    const rail = page.locator("#projects-rail");
    if (!(await rail.isVisible())) await page.locator("#desk-rail-open-btn").click();
    await beside(second.id);
    const reopenedId = await expectPane(1, second.title, true);
    expect(await paneDraft(reopenedId)).toBe(drafts[2]);

    // Close the original window chat. The next chat occupies its column and
    // keeps its own transcript and draft. The third chat stays put.
    const close = page.getByRole("button", { name: "Close chat pane", exact: true });
    await close.click();
    await page.locator("#session-name-label").filter({ hasText: first.title }).waitFor();
    await vi.waitFor(async () => {
      expect((await nativeChats(app!)).map(pane => pane.id)).toEqual([reopenedId]);
      expect(await page.locator("#input").inputValue()).toBe(paneResult);
      expect(await paneDraft(reopenedId)).toBe(drafts[2]);
    });
    expect(await page.locator("#messages").innerText()).toContain("Acknowledged.");
    expect((await loads()).filter(id => id === first.id)).toHaveLength(1);
    await paneEval(app, 'requestAnimationFrame(() => document.querySelector("#desk-conversation-close").click())', reopenedId);
    await close.waitFor({ state: "hidden" });
    await vi.waitFor(async () => expect(await nativeChats(app!)).toEqual([]));

    await app.close();
    app = undefined;
    const finalConfig = JSON.parse(await readFile(path.join(profile, "config.json"), "utf8"));
    await writeFile(path.join(profile, "config.json"), JSON.stringify({ ...finalConfig, ...overrides }));
    const single = path.join(temp, "single");
    await mkdir(single);
    traceFile = path.join(single, "desktop-wire.jsonl");
    app = await start(single);
    page = await app.firstWindow();
    await page.locator("#session-name-label").filter({ hasText: first.title }).waitFor();
    await vi.waitFor(async () => expect(await page.locator("#input").inputValue()).toBe(paneResult));
    expect(await page.getByRole("button", { name: "Close chat pane", exact: true }).count()).toBe(0);
    expect(await nativeChats(app)).toEqual([]);
    if (!(await page.locator("#projects-rail").isVisible())) await page.locator("#desk-rail-open-btn").click();
    await beside(main.id);
    const restoredFormerMain = await expectPane(0, main.title, true);
    await vi.waitFor(async () => expect(await paneDraft(restoredFormerMain)).toBe(mainResult));
  } catch (error) {
    await reportSplitFailure(app, traceFile);
    throw error;
  } finally {
    try { await app?.close(); }
    finally { await rm(temp, { recursive: true, force: true }); }
  }
}, 180_000);
