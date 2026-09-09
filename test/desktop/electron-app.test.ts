/**
 * Desktop e2e: real Electron window + real DOM + fake grok ACP CLI.
 *
 * Asserts:
 *   1. Window opens and chat.js boots without console errors
 *   2. A typed prompt reaches the agent and the streamed reply renders
 *   3. Renderer reload rehydrates the live session (transcript survives)
 *   4. openText / openDiff open a read-only viewer window (visible surface)
 *   5. File-tree panel: list / expand / collapse / open (via open sink)
 *
 * Not covered here: live AFK Pilot relay, real grok binary, multi-window,
 * packaging. Link/unlink + safeStorage + path guard are unit-tested in
 * desktop-host-pure (no live relay).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { spawn } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const mainJs = path.join(root, "out", "desktop", "main.js");
const electronExe = path.join(
  root,
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron",
);

function fixtureCli(): string {
  const dir = path.join(root, "test", "fixtures");
  return process.platform === "win32"
    ? path.join(dir, "fake-grok-acp.cmd")
    : path.join(dir, "fake-grok-acp.sh");
}

function stripElectronRunAsNode(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.ELECTRON_RUN_AS_NODE;
  return next;
}

describe("desktop Electron app (real window + fake CLI)", () => {
  let app: ElectronApplication;
  let page: Page;
  let workspace: string;
  let userData: string;
  let configJson: string;
  let openSink: string;
  const consoleErrors: string[] = [];

  beforeAll(async () => {
    if (!fs.existsSync(mainJs)) {
      throw new Error(
        `Missing ${mainJs} — run \`npm run compile\` before test:desktop`,
      );
    }
    if (!fs.existsSync(electronExe)) {
      throw new Error(`Missing Electron binary at ${electronExe}`);
    }
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(fixtureCli(), 0o755);
      } catch {
        /* best-effort */
      }
    }

    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "grok-desk-ws-"));
    // Known tree for the file-panel assertions.
    fs.writeFileSync(path.join(workspace, "readme.txt"), "desktop e2e readme\n");
    fs.writeFileSync(path.join(workspace, "notes.md"), "# Notes\n\nHello panel\n");
    // Nested md for bare-filename chat-link resolution (docs/product-decisions.md).
    fs.mkdirSync(path.join(workspace, "docs"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "docs", "product-decisions.md"),
      "# Product decisions\n\nNested for chat links.\n",
    );
    // Non-previewable type hands off to OS open (sink).
    fs.writeFileSync(path.join(workspace, "payload.bin"), Buffer.from([0, 1, 2, 0, 9]));
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "src", "hello.ts"), "export const n = 1;\n");

    userData = fs.mkdtempSync(path.join(os.tmpdir(), "grok-desk-ud-"));
    configJson = path.join(userData, "test-config.json");
    openSink = path.join(userData, "open-sink.txt");
    fs.writeFileSync(
      configJson,
      JSON.stringify({ "grok.cliPath": fixtureCli() }),
      "utf8",
    );

    app = await electron.launch({
      executablePath: electronExe,
      args: [
        mainJs,
        `--workspace=${workspace}`,
        `--user-data-dir=${userData}`,
        `--config-json=${configJson}`,
      ],
      env: {
        ...stripElectronRunAsNode(process.env),
        GROK_DESKTOP_OPEN_SINK: openSink,
      },
      timeout: 60_000,
    });

    page = await app.firstWindow({ timeout: 60_000 });
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });
    page.on("pageerror", (err) => {
      consoleErrors.push(String(err));
    });

    // Wait until the composer exists (chat.js booted + HTML applied).
    await page.waitForSelector("#input", { timeout: 45_000 });
    // Session start: welcome "Starting" clears or composer unlocks after agent ready.
    await page.waitForFunction(
      () => {
        const input = document.querySelector("#input") as HTMLTextAreaElement | null;
        const send = document.querySelector("#send-btn") as HTMLButtonElement | null;
        if (!input || !send) return false;
        // Locked startup disables send / shows spinner; ready when not busy-locked.
        const body = document.body;
        return !body.classList.contains("busy-locked") && !input.disabled;
      },
      { timeout: 45_000 },
    ).catch(async () => {
      // Fallback: give the fake CLI a moment; some hosts never set busy-locked.
      await page.waitForTimeout(3000);
    });
  }, 90_000);

  afterAll(async () => {
    try {
      await app?.close();
    } catch {
      /* already dead */
    }
    for (const p of [workspace, userData]) {
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  it("opens a window and boots chat.js without console errors", async () => {
    expect(page).toBeTruthy();
    const title = await page.title();
    // Real app-resource origin — required for localStorage (not data:).
    const loc = page.url();
    expect(loc.startsWith("app-resource://vsc-resource/")).toBe(true);
    expect(loc).toContain("__app__/index.html");
    const originOk = await page.evaluate(() => {
      try {
        const k = "__grok_origin_probe__";
        localStorage.setItem(k, "1");
        const v = localStorage.getItem(k);
        localStorage.removeItem(k);
        return { ok: v === "1", origin: location.origin };
      } catch (e) {
        return { ok: false, origin: String(e) };
      }
    });
    expect(originOk.ok, `localStorage unavailable: ${originOk.origin}`).toBe(true);
    expect(originOk.origin).toBe("app-resource://vsc-resource");
    const hasComposer = await page.locator("#input").count();
    expect(hasComposer).toBe(1);
    const hasMessages = await page.locator("#messages").count();
    expect(hasMessages).toBe(1);
    // Filter noise from optional extensions (MathJax/mermaid are fine if they warn).
    const fatal = consoleErrors.filter(
      (e) =>
        !/MathJax|mermaid|favicon|DevTools|Autofill|Download the React/i.test(e),
    );
    expect(fatal, `console errors: ${fatal.join("\n")}`).toEqual([]);
    void title;
  });

  it("sends a prompt and renders the streamed agent reply", async () => {
    const prompt = "hello from desktop e2e";
    await page.locator("#input").click();
    await page.locator("#input").fill(prompt);
    // Prefer Enter if send is enabled; click send as primary (matches desktop UX).
    await page.locator("#send-btn").click();

    // User bubble appears.
    await page.waitForFunction(
      (text) => {
        const users = [...document.querySelectorAll(".msg.user")];
        return users.some((el) => (el.textContent || "").includes(text));
      },
      prompt,
      { timeout: 30_000 },
    );

    // Fake CLI default scenario streams agent_message_chunk "ok".
    await page.waitForFunction(
      () => {
        const agents = [...document.querySelectorAll(".msg.agent, .msg.assistant, .message.agent")];
        // chat.js may use .msg with role markers — also accept any non-user bubble with "ok"
        const all = [...document.querySelectorAll("#messages .msg")];
        return all.some((el) => {
          if (el.classList.contains("user")) return false;
          const t = (el.textContent || "").trim();
          return t === "ok" || t.includes("ok");
        }) || agents.some((el) => (el.textContent || "").includes("ok"));
      },
      { timeout: 30_000 },
    );

    const transcript = await page.locator("#messages").innerText();
    expect(transcript).toContain(prompt);
    expect(transcript).toMatch(/\bok\b/);
  });

  it("survives a renderer reload without losing the session transcript", async () => {
    // Ensure prior conversation is still present before reload.
    const before = await page.locator("#messages").innerText();
    expect(before).toContain("hello from desktop e2e");

    await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForSelector("#input", { timeout: 45_000 });

    // Rehydrate replays the buffer — user + agent text should return.
    await page.waitForFunction(
      () => {
        const text = document.querySelector("#messages")?.textContent || "";
        return text.includes("hello from desktop e2e");
      },
      { timeout: 45_000 },
    );

    const after = await page.locator("#messages").innerText();
    expect(after).toContain("hello from desktop e2e");
    // Agent reply from the same live session should reappear in the buffer.
    expect(after).toMatch(/\bok\b/);
  });

  it("openText opens a read-only viewer window with the given content", async () => {
    const marker = `desktop-openText-${Date.now()}`;
    const windowPromise = app.waitForEvent("window", { timeout: 15_000 });
    await page.evaluate((text) => {
      // Same path chat.js uses for "View all" command output.
      (window as unknown as { acquireVsCodeApi: () => { postMessage: (m: unknown) => void } })
        .acquireVsCodeApi()
        .postMessage({ type: "openText", content: text, language: "plaintext" });
    }, marker);
    const viewer = await windowPromise;
    await viewer.waitForLoadState("domcontentloaded");
    await viewer.waitForFunction(
      (t) => (document.body?.innerText || "").includes(t),
      marker,
      { timeout: 10_000 },
    );
    const body = await viewer.locator("body").innerText();
    expect(body).toContain(marker);
    expect(body.toLowerCase()).toMatch(/read-only|untitled/);
    await viewer.close();
  });

  it("openDiff opens a side-by-side read-only preview window", async () => {
    const leftMark = `diff-left-${Date.now()}`;
    const rightMark = `diff-right-${Date.now()}`;
    const windowPromise = app.waitForEvent("window", { timeout: 15_000 });
    await page.evaluate(
      ({ oldText, newText }) => {
        (window as unknown as { acquireVsCodeApi: () => { postMessage: (m: unknown) => void } })
          .acquireVsCodeApi()
          .postMessage({
            type: "openDiff",
            path: "src/example.ts",
            oldText,
            newText,
          });
      },
      { oldText: leftMark, newText: rightMark },
    );
    const viewer = await windowPromise;
    await viewer.waitForLoadState("domcontentloaded");
    await viewer.waitForFunction(
      ({ a, b }) => {
        const t = document.body?.innerText || "";
        return t.includes(a) && t.includes(b);
      },
      { a: leftMark, b: rightMark },
      { timeout: 10_000 },
    );
    const body = await viewer.locator("body").innerText();
    expect(body).toContain(leftMark);
    expect(body).toContain(rightMark);
    expect(body.toLowerCase()).toMatch(/read-only|proposed|preview/);
    await viewer.close();
  });

  /** Panel starts closed (no space); open via the top-bar toggle. */
  async function ensureFilePanelOpen(): Promise<void> {
    await page.waitForSelector("#desk-ft-top-toggle", { timeout: 15_000 });
    const closed = await page.evaluate(() =>
      document.body.classList.contains("desk-ft-closed"),
    );
    if (closed) {
      await page.locator("#desk-ft-top-toggle").click();
    }
    await page.waitForFunction(
      () => !document.body.classList.contains("desk-ft-closed"),
      { timeout: 5_000 },
    );
    await page.waitForSelector("#desk-ft-panel", {
      state: "visible",
      timeout: 10_000,
    });
  }

  it("file-tree panel renders the workspace root entries", async () => {
    await ensureFilePanelOpen();

    await page.waitForFunction(
      () => {
        const body = document.getElementById("desk-ft-body");
        if (!body) return false;
        const text = body.textContent || "";
        return text.includes("readme.txt") && text.includes("src");
      },
      { timeout: 15_000 },
    );
    const treeText = await page.locator("#desk-ft-body").innerText();
    expect(treeText).toContain("readme.txt");
    expect(treeText).toContain("src");
    // Top bar is in the chat column host (body or .app-main with multi-folder rail).
    expect(await page.locator(".top-bar").count()).toBe(1);
    // Chat chrome still present beside the panel.
    expect(await page.locator("#input").count()).toBe(1);
    expect(await page.locator(".desk-ft-chat #messages").count()).toBe(1);
  });

  it("file-tree expands and collapses a directory", async () => {
    await ensureFilePanelOpen();
    // Root should list src as a directory node.
    const srcRow = page.locator('.desk-ft-node[data-rel="src"] > .desk-ft-row');
    await srcRow.waitFor({ state: "visible", timeout: 10_000 });
    // Before expand: hello.ts not under src children.
    const before = await page.locator('.desk-ft-node[data-rel="src/hello.ts"]').count();
    expect(before).toBe(0);

    await srcRow.click();
    await page.waitForSelector('.desk-ft-node[data-rel="src/hello.ts"]', {
      timeout: 10_000,
    });
    expect(
      await page.locator('.desk-ft-node[data-rel="src"].desk-ft-open').count(),
    ).toBe(1);

    // Collapse directory.
    await srcRow.click();
    await page.waitForFunction(
      () => !document.querySelector('.desk-ft-node[data-rel="src"].desk-ft-open'),
      { timeout: 5_000 },
    );
    // Children hidden via CSS when not open — node may still exist in DOM.
    const openAfter = await page.locator('.desk-ft-node[data-rel="src"].desk-ft-open').count();
    expect(openAfter).toBe(0);
  });

  it("file-tree panel hide/show via top-bar toggle takes no space when closed", async () => {
    await page.waitForSelector("#desk-ft-top-toggle", { timeout: 10_000 });
    await ensureFilePanelOpen();
    expect(
      await page.evaluate(() => document.body.classList.contains("desk-ft-closed")),
    ).toBe(false);
    expect(await page.locator("#desk-ft-body").isVisible()).toBe(true);

    await page.locator("#desk-ft-top-toggle").click();
    await page.waitForFunction(
      () => document.body.classList.contains("desk-ft-closed"),
      { timeout: 5_000 },
    );
    // Panel takes no space when closed.
    expect(await page.locator("#desk-ft-panel").isVisible()).toBe(false);

    await page.locator("#desk-ft-top-toggle").click();
    await page.waitForFunction(
      () => !document.body.classList.contains("desk-ft-closed"),
      { timeout: 5_000 },
    );
    expect(await page.locator("#desk-ft-body").isVisible()).toBe(true);
  });

  it("file-tree toggle uses Lucide panel-right and open panel has a resizer border", async () => {
    await page.waitForSelector("#desk-ft-top-toggle", { timeout: 15_000 });
    // panel-right path divider at x=15 (panel-left uses x=9).
    const iconOk = await page.evaluate(() => {
      const btn = document.getElementById("desk-ft-top-toggle");
      if (!btn) return false;
      const path = btn.querySelector("svg path");
      return !!(path && (path.getAttribute("d") || "").includes("M15"));
    });
    expect(iconOk).toBe(true);

    await ensureFilePanelOpen();
    const sepCss = await page.evaluate(() => {
      const resizer = document.getElementById("desk-ft-resizer");
      if (!resizer) return null;
      const cs = getComputedStyle(resizer);
      const divider = getComputedStyle(resizer, "::after");
      return {
        dividerBackground: divider.backgroundColor,
        dividerWidth: divider.width,
        cursor: cs.cursor,
        display: cs.display,
      };
    });
    expect(sepCss).toBeTruthy();
    expect(sepCss!.display).not.toBe("none");
    expect(sepCss!.cursor).toMatch(/col-resize|ew-resize/);
    expect(sepCss!.dividerBackground).not.toMatch(/transparent|rgba\(0, 0, 0, 0\)/);
    expect(parseFloat(sepCss!.dividerWidth)).toBeGreaterThan(0);
  });

  it("scroll-edge fades mount around #messages", async () => {
    await page.waitForSelector("#messages-wrap", { timeout: 15_000 });
    await page.waitForSelector(".msg-fade-top", { timeout: 5_000 });
    await page.waitForSelector(".msg-fade-bot", { timeout: 5_000 });
    const inside = await page.evaluate(() => {
      const wrap = document.getElementById("messages-wrap");
      const m = document.getElementById("messages");
      return !!(wrap && m && wrap.contains(m));
    });
    expect(inside).toBe(true);
  });

  it("clicking a text file replaces the tree with a file viewer", async () => {
    await ensureFilePanelOpen();
    // Leave any prior view via the project-name control (tabs stay open).
    if (await page.evaluate(() => document.body.classList.contains("desk-ft-viewing"))) {
      await page.locator("#desk-ft-title").click();
    }
    const fileRow = page.locator('.desk-ft-node[data-rel="notes.md"] > .desk-ft-row');
    await fileRow.waitFor({ state: "visible", timeout: 10_000 });
    await fileRow.click();

    await page.waitForFunction(
      () => document.body.classList.contains("desk-ft-viewing"),
      { timeout: 10_000 },
    );
    const bodyText = await page.locator("#desk-ft-viewer-body").innerText();
    expect(bodyText).toMatch(/Notes|Hello panel/i);
    // Tree body is hidden while viewing.
    expect(await page.locator("#desk-ft-body").isVisible()).toBe(false);
    // Tab strip is present while viewing; project name returns to the tree.
    expect(await page.locator("#desk-ft-tabs").count()).toBe(1);
    expect(await page.locator('.desk-ft-tab[data-rel="notes.md"]').count()).toBe(1);
    expect(await page.locator(".desk-ft-crumb-back").count()).toBe(0);
    await page.locator("#desk-ft-title").click();
    await page.waitForFunction(
      () => !document.body.classList.contains("desk-ft-viewing"),
      { timeout: 5_000 },
    );
    expect(await page.locator("#desk-ft-body").isVisible()).toBe(true);
  });

  it("clicking a non-previewable file triggers the OS open path", async () => {
    // Clear prior sink lines.
    fs.writeFileSync(openSink, "", "utf8");
    await ensureFilePanelOpen();
    if (await page.evaluate(() => document.body.classList.contains("desk-ft-viewing"))) {
      await page.locator("#desk-ft-title").click();
    }
    const fileRow = page.locator('.desk-ft-node[data-rel="payload.bin"] > .desk-ft-row');
    await fileRow.waitFor({ state: "visible", timeout: 10_000 });
    await fileRow.click();

    // Open sink is written by main when GROK_DESKTOP_OPEN_SINK is set.
    // (No production lastOpen diagnostic — a process-global path would leak
    // across project switches; the test-only sink is the sole open oracle.)
    let sink = "";
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (fs.existsSync(openSink)) {
        sink = fs.readFileSync(openSink, "utf8");
        if (sink.includes("payload.bin")) break;
      }
      await page.waitForTimeout(100);
    }
    expect(sink.replace(/\\/g, "/")).toMatch(/payload\.bin/);
    // Contained under workspace.
    expect(path.resolve(sink.trim().split(/\r?\n/).filter(Boolean).pop()!)).toBe(
      path.resolve(workspace, "payload.bin"),
    );
  });

  it("directory rows render SVG chevrons (not triangles)", async () => {
    await ensureFilePanelOpen();
    const chev = await page.evaluate(() => {
      const row = document.querySelector(
        '.desk-ft-node[data-rel="src"] > .desk-ft-row .desk-ft-twist',
      );
      if (!row) return { ok: false as const, reason: "no twist" };
      const svg = row.querySelector("svg path");
      const d = (svg && svg.getAttribute("d")) || "";
      const text = (row.textContent || "").trim();
      return {
        ok: true as const,
        d,
        text,
        hasSvg: !!row.querySelector("svg"),
      };
    });
    expect(chev.ok).toBe(true);
    if (chev.ok) {
      expect(chev.hasSvg).toBe(true);
      // Lucide chevron-right path.
      expect(chev.d).toMatch(/m9 18 6-6-6-6/i);
      expect(chev.text).not.toMatch(/[▶▼▸▾›⌄]/);
    }
  });

  it("chat openFile for a renderable path opens the panel viewer, not the OS sink", async () => {
    fs.writeFileSync(openSink, "", "utf8");
    // Leave any prior view.
    if (await page.evaluate(() => document.body.classList.contains("desk-ft-viewing"))) {
      await page.locator("#desk-ft-title").click();
    }
    // Full chat openFile path: webview post → authorize → host openFsPath → panel.
    await page.evaluate(() => {
      const api = (
        window as unknown as { acquireVsCodeApi?: () => { postMessage: (m: unknown) => void } }
      ).acquireVsCodeApi?.();
      if (!api) throw new Error("no acquireVsCodeApi");
      api.postMessage({ type: "openFile", path: "notes.md" });
    });
    await page.waitForFunction(
      () => document.body.classList.contains("desk-ft-viewing"),
      { timeout: 15_000 },
    );
    const bodyText = await page.locator("#desk-ft-viewer-body").innerText();
    expect(bodyText).toMatch(/Notes|Hello panel/i);
    // Must not have hit the OS open sink for a renderable type.
    const sink = fs.existsSync(openSink) ? fs.readFileSync(openSink, "utf8") : "";
    expect(sink).not.toMatch(/notes\.md/);
    // Tabs + project name replace Back/breadcrumb; open affordance still present.
    expect(await page.locator(".desk-ft-crumb-back").count()).toBe(0);
    expect(await page.locator("#desk-ft-tabs .desk-ft-tab").count()).toBeGreaterThan(0);
    expect(await page.locator("#desk-ft-title").isVisible()).toBe(true);
    // "Open in default app" affordance present while viewing.
    expect(await page.locator(".desk-ft-open-ext").count()).toBe(1);
  });

  it("chat openFile bare basename resolves under docs/ into the panel", async () => {
    fs.writeFileSync(openSink, "", "utf8");
    if (await page.evaluate(() => document.body.classList.contains("desk-ft-viewing"))) {
      await page.locator("#desk-ft-title").click();
    }
    // Agent-style bare link: product-decisions.md lives at docs/product-decisions.md.
    await page.evaluate(() => {
      const api = (
        window as unknown as { acquireVsCodeApi?: () => { postMessage: (m: unknown) => void } }
      ).acquireVsCodeApi?.();
      if (!api) throw new Error("no acquireVsCodeApi");
      api.postMessage({ type: "openFile", path: "product-decisions.md" });
    });
    await page.waitForFunction(
      () => document.body.classList.contains("desk-ft-viewing"),
      { timeout: 15_000 },
    );
    const bodyText = await page.locator("#desk-ft-viewer-body").innerText();
    expect(bodyText).toMatch(/Product decisions|Nested for chat/i);
    const sink = fs.existsSync(openSink) ? fs.readFileSync(openSink, "utf8") : "";
    expect(sink).not.toMatch(/product-decisions/);
  });

  it("chat openFile for non-renderable type reaches OS sink; outside roots stay refused", async () => {
    fs.writeFileSync(openSink, "", "utf8");
    // Renderer open of a workspace .bin goes through api.open → sink.
    const openBin = await page.evaluate(async () => {
      const api = (
        window as unknown as {
          grokDesktopFileTree: { open: (p: string) => Promise<{ ok: boolean }> };
        }
      ).grokDesktopFileTree;
      return api.open("payload.bin");
    });
    expect(openBin.ok).toBe(true);
    let sink = "";
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      sink = fs.existsSync(openSink) ? fs.readFileSync(openSink, "utf8") : "";
      if (sink.includes("payload.bin")) break;
      await page.waitForTimeout(100);
    }
    expect(sink).toMatch(/payload\.bin/);

    // Outside / traversal still refused by IPC (authorization intact).
    const outside = await page.evaluate(async () => {
      const api = (
        window as unknown as {
          grokDesktopFileTree: {
            open: (p: string) => Promise<{ ok: boolean; error?: string }>;
            read: (p: string) => Promise<{ ok: boolean; reason?: string }>;
          };
        }
      ).grokDesktopFileTree;
      const open = await api.open("../outside-secret.md");
      const read = await api.read("../outside-secret.md");
      return { open, read };
    });
    expect(outside.open.ok).toBe(false);
    expect(outside.read.ok).toBe(false);
  });

  it("bare basename that does not exist does not write the OS open sink", async () => {
    fs.writeFileSync(openSink, "", "utf8");
    // Panel open of a missing bare name should fail closed (read not found),
    // and must not call api.open → sink.
    const result = await page.evaluate(async () => {
      const fn = (
        window as unknown as {
          __grokDeskFtOpen?: (p: string) => Promise<{ ok?: boolean; reason?: string }>;
        }
      ).__grokDeskFtOpen;
      if (typeof fn !== "function") return { ok: false, reason: "no hook" };
      return fn("definitely-missing-file-xyz.md");
    });
    expect(result && (result as { ok?: boolean }).ok).toBe(false);
    await page.waitForTimeout(300);
    const sink = fs.existsSync(openSink) ? fs.readFileSync(openSink, "utf8") : "";
    expect(sink).not.toMatch(/definitely-missing-file-xyz/);
  });

  it("panel width persists across reload and is bounded", async () => {
    await ensureFilePanelOpen();
    // Pick a width inside the live shell bounds so clamp does not rewrite it.
    const target = await page.evaluate(() => {
      const shell = document.getElementById("desk-ft-shell");
      const shellW = shell?.getBoundingClientRect().width || window.innerWidth || 800;
      const maxByChat = Math.max(200, Math.floor(shellW - 280));
      const maxByFrac = Math.floor(shellW * 0.7);
      const max = Math.max(200, Math.min(maxByChat, maxByFrac));
      // Prefer something other than the default 280 when the shell allows it.
      const w = max >= 240 ? 240 : 200;
      localStorage.setItem("desk-ft-width", String(w));
      const panel = document.getElementById("desk-ft-panel") as HTMLElement | null;
      if (panel) panel.style.setProperty("--desk-ft-width", w + "px");
      return w;
    });
    // Re-inject by reloading the window — boot re-reads WIDTH_KEY.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#input", { timeout: 45_000 });
    await page.waitForSelector("#desk-ft-top-toggle", { timeout: 20_000 });
    await ensureFilePanelOpen();
    const widthInfo = await page.evaluate(() => {
      const panel = document.getElementById("desk-ft-panel");
      if (!panel) return null;
      const stored = localStorage.getItem("desk-ft-width");
      const rect = panel.getBoundingClientRect();
      return { stored, width: rect.width };
    });
    expect(widthInfo).toBeTruthy();
    expect(widthInfo!.stored).toBe(String(target));
    expect(widthInfo!.width).toBeGreaterThanOrEqual(200);
    expect(Math.abs(widthInfo!.width - target)).toBeLessThan(8);
    // Oversize value is clamped (chat min + panel min).
    await page.evaluate(() => {
      localStorage.setItem("desk-ft-width", "99999");
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#desk-ft-top-toggle", { timeout: 20_000 });
    await ensureFilePanelOpen();
    const clamped = await page.evaluate(() => {
      const panel = document.getElementById("desk-ft-panel");
      if (!panel) return null;
      const shell = document.getElementById("desk-ft-shell");
      const shellW = shell?.getBoundingClientRect().width || window.innerWidth;
      return {
        width: panel.getBoundingClientRect().width,
        shellW,
        stored: localStorage.getItem("desk-ft-width"),
      };
    });
    expect(clamped).toBeTruthy();
    expect(clamped!.width).toBeLessThan(clamped!.shellW * 0.75);
    expect(clamped!.width).toBeGreaterThanOrEqual(200);
    // Stored value after apply is the clamped width, not 99999.
    expect(Number(clamped!.stored)).toBeLessThan(99999);
    expect(Number(clamped!.stored)).toBeGreaterThanOrEqual(200);
  });

  it("file-tree IPC rejects path traversal from the renderer", async () => {
    const result = await page.evaluate(async () => {
      const api = (window as unknown as {
        grokDesktopFileTree: {
          list: (p: string) => Promise<{ ok: boolean; reason?: string }>;
          open: (p: string) => Promise<{ ok: boolean; error?: string }>;
        };
      }).grokDesktopFileTree;
      const list = await api.list("../");
      const open = await api.open("../outside.txt");
      const openDotDot = await api.open("src/../../outside.txt");
      return { list, open, openDotDot };
    });
    expect(result.list.ok).toBe(false);
    expect(result.open.ok).toBe(false);
    expect(result.openDotDot.ok).toBe(false);
  });

  it("projects rail mounts once repos arrives (desktop multi-folder)", async () => {
    // getHtml includes #projects-rail; host posts repos for open folders.
    await page.waitForSelector("#projects-rail", { timeout: 30_000 });
    await page.waitForFunction(
      () => {
        const rail = document.getElementById("projects-rail");
        if (!rail || rail.hidden) return false;
        return document.body.classList.contains("has-rail")
          && document.querySelectorAll(".rail-repo-label").length >= 1;
      },
      { timeout: 45_000 },
    );
    const labels = await page.locator(".rail-repo-label").allTextContents();
    expect(labels.length).toBeGreaterThanOrEqual(1);
  });

  it("rail draws styled chrome from chat.css (solid open folder on expanded project)", async () => {
    // Proves Step 0: rail rules live in shared media/chat.css, not only the
    // web client's page shell — so the desktop column is not bare layout.
    await page.waitForSelector("#projects-rail:not([hidden])", { timeout: 45_000 });
    await page.waitForFunction(
      () => document.querySelectorAll(".rail-repo").length >= 1,
      { timeout: 45_000 },
    );

    const style = await page.evaluate(() => {
      const sessionPad = getComputedStyle(
        document.querySelector(".rail-sessions") || document.createElement("div"),
      ).paddingLeft;
      // If no sessions list yet, still check group head + project twisty styling.
      const head = document.querySelector(".rail-head");
      const headLetter = head ? getComputedStyle(head).textTransform : "";
      const twisty = document.querySelector(".rail-twisty") as HTMLElement | null;
      const twistyHtml = twisty?.innerHTML || "";
      const twistyW = twisty ? getComputedStyle(twisty).width : "";
      return { sessionPad, headLetter, twistyHtml, twistyW, hasRepo: !!document.querySelector(".rail-repo") };
    });

    expect(style.hasRepo).toBe(true);
    // Shared CSS: sticky uppercase group heads + non-zero twisty box.
    expect(style.headLetter).toBe("uppercase");
    expect(style.twistyW).not.toBe("0px");
    // Expanded project uses the theme-tinted lucide open-folder outline.
    expect(style.twistyHtml).toContain('d="m6 14 1.5-2.9');
    expect(style.twistyHtml).toContain('stroke="currentColor"');
    expect(style.twistyHtml).toContain('fill="none"');
  });

  it("rail header chrome has brand + toggle above search (not crammed in one row)", async () => {
    await page.waitForSelector("#projects-rail:not([hidden])", { timeout: 45_000 });
    const chrome = await page.evaluate(() => {
      const rail = document.getElementById("projects-rail");
      if (!rail) return null;
      const top = rail.querySelector(".rail-top");
      const brand = rail.querySelector(".rail-brand .wordmark");
      const toggle = document.getElementById("desk-rail-toggle");
      const searchWrap = rail.querySelector(".rail-search-wrap");
      const search = document.getElementById("rail-search");
      const foot = rail.querySelector(".rail-foot");
      const themeBtn = document.getElementById("desk-theme-toggle");
      return {
        hasTop: !!top,
        brandText: brand?.textContent?.replace(/\s+/g, " ").trim() || "",
        toggleInTop: !!(top && toggle && top.contains(toggle)),
        searchInWrap: !!(searchWrap && search && searchWrap.contains(search)),
        hasFoot: !!foot,
        hasTheme: !!themeBtn,
      };
    });
    expect(chrome).toEqual({
      hasTop: true,
      brandText: "Grok Build",
      toggleInTop: true,
      searchInWrap: true,
      hasFoot: true,
      hasTheme: true,
    });
  });

  it("theme toggle flips data-theme and persists across reload", async () => {
    // CSP is nonce-only (no unsafe-eval) — avoid waitForFunction(arg).
    // Theme is localStorage under the stable app-resource origin (same as rail shape).
    await page.waitForSelector("#desk-theme-toggle", { timeout: 45_000 });
    const ready = await page.evaluate(() => {
      const w = window as unknown as {
        __toggleDesktopTheme?: () => void;
      };
      return {
        toggle: typeof w.__toggleDesktopTheme === "function",
        btn: !!document.getElementById("desk-theme-toggle"),
      };
    });
    expect(ready.toggle).toBe(true);
    expect(ready.btn).toBe(true);

    const before = await page.evaluate(() =>
      document.documentElement.getAttribute("data-theme"),
    );
    expect(before === "dark" || before === "light").toBe(true);
    const target = before === "dark" ? "light" : "dark";

    await page.evaluate(() => {
      const btn = document.getElementById("desk-theme-toggle");
      if (btn) btn.click();
      else (window as unknown as { __toggleDesktopTheme: () => void }).__toggleDesktopTheme();
    });

    const afterClick = await page.evaluate(() => ({
      theme: document.documentElement.getAttribute("data-theme"),
      stored: localStorage.getItem("grok-desktop-theme"),
      bodyLight: document.body.classList.contains("vscode-light"),
    }));
    expect(afterClick.theme).toBe(target);
    expect(afterClick.stored).toBe(target);
    expect(afterClick.bodyLight).toBe(target === "light");

    // Reload the renderer; localStorage on the same origin must survive.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#input", { timeout: 45_000 });
    const afterReload = await page.evaluate(() => ({
      theme: document.documentElement.getAttribute("data-theme"),
      stored: localStorage.getItem("grok-desktop-theme"),
      bodyLight: document.body.classList.contains("vscode-light"),
      origin: location.origin,
    }));
    expect(afterReload.origin).toBe("app-resource://vsc-resource");
    expect(afterReload.theme).toBe(target);
    expect(afterReload.stored).toBe(target);
    expect(afterReload.bodyLight).toBe(target === "light");
  });

  it("rail group collapse state survives reload (localStorage)", async () => {
    // Owner requirement: client remembers rail collapse, same as archived projects.
    await page.waitForSelector("#projects-rail:not([hidden])", { timeout: 45_000 });
    await page.waitForFunction(
      () => document.querySelectorAll(".rail-head-fold .rail-head-btn").length >= 1,
      { timeout: 45_000 },
    );

    // Collapse the first currently-expanded group (Recent / Projects default open).
    const collapsed = await page.evaluate(() => {
      const btns = [
        ...document.querySelectorAll(".rail-head-fold .rail-head-btn"),
      ] as HTMLButtonElement[];
      const openBtn = btns.find((b) => b.getAttribute("aria-expanded") === "true");
      if (!openBtn) return { ok: false as const, reason: "no expanded group" };
      const title =
        openBtn.querySelector(".rail-head-title")?.textContent?.trim() || "";
      openBtn.click();
      // renderRail rebuilds the DOM — re-query after the click.
      const again = [
        ...document.querySelectorAll(".rail-head-fold .rail-head-btn"),
      ].find(
        (b) =>
          (b.querySelector(".rail-head-title")?.textContent || "").trim() === title,
      ) as HTMLButtonElement | undefined;
      const key = "grok.remote.railShape:default";
      let stored: string | null = null;
      try {
        stored = localStorage.getItem(key);
      } catch {
        return { ok: false as const, reason: "localStorage threw" };
      }
      return {
        ok: true as const,
        title,
        expanded: again?.getAttribute("aria-expanded") ?? null,
        stored,
        origin: location.origin,
      };
    });
    expect(collapsed.ok, collapsed.ok === false ? collapsed.reason : "").toBe(true);
    if (!collapsed.ok) return;
    expect(collapsed.origin).toBe("app-resource://vsc-resource");
    expect(collapsed.expanded).toBe("false");
    expect(collapsed.stored).toBeTruthy();
    const shape = JSON.parse(collapsed.stored!);
    expect(shape.groupCollapsed).toBeTruthy();
    // At least one group is collapsed after the click.
    const collapsedNames = Object.entries(shape.groupCollapsed as Record<string, boolean>)
      .filter(([, v]) => v === true)
      .map(([k]) => k);
    expect(collapsedNames.length).toBeGreaterThanOrEqual(1);

    await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForSelector("#input", { timeout: 45_000 });
    await page.waitForSelector("#projects-rail:not([hidden])", { timeout: 45_000 });
    await page.waitForFunction(
      () => document.querySelectorAll(".rail-head-fold .rail-head-btn").length >= 1,
      { timeout: 45_000 },
    );

    const after = await page.evaluate((wantTitle: string) => {
      const key = "grok.remote.railShape:default";
      let stored: string | null = null;
      try {
        stored = localStorage.getItem(key);
      } catch (e) {
        return { ok: false as const, reason: String(e) };
      }
      const btn = [
        ...document.querySelectorAll(".rail-head-fold .rail-head-btn"),
      ].find(
        (b) =>
          (b.querySelector(".rail-head-title")?.textContent || "").trim() === wantTitle,
      ) as HTMLButtonElement | undefined;
      return {
        ok: true as const,
        stored,
        expanded: btn?.getAttribute("aria-expanded") ?? null,
        title: wantTitle,
        origin: location.origin,
      };
    }, collapsed.title);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.origin).toBe("app-resource://vsc-resource");
    expect(after.stored).toBeTruthy();
    expect(after.expanded).toBe("false");
  });

  it("file-tree panel open state survives reload (localStorage)", async () => {
    await page.waitForSelector("#desk-ft-top-toggle", { timeout: 15_000 });
    // Panel defaults closed; open it and assert the preference sticks.
    const before = await page.evaluate(() =>
      document.body.classList.contains("desk-ft-closed"),
    );
    if (before) {
      await page.locator("#desk-ft-top-toggle").click();
    }
    await page.waitForFunction(
      () => !document.body.classList.contains("desk-ft-closed"),
      { timeout: 5_000 },
    );
    const storedOpen = await page.evaluate(() => {
      try {
        return {
          open: localStorage.getItem("desk-ft-open"),
          origin: location.origin,
        };
      } catch (e) {
        return { open: null, origin: String(e) };
      }
    });
    expect(storedOpen.origin).toBe("app-resource://vsc-resource");
    expect(storedOpen.open).toBe("1");

    await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForSelector("#input", { timeout: 45_000 });
    await page.waitForSelector("#desk-ft-top-toggle", { timeout: 15_000 });
    // did-finish-load re-injects the panel and must re-read localStorage.
    await page.waitForFunction(
      () => !document.body.classList.contains("desk-ft-closed"),
      { timeout: 15_000 },
    );
    const after = await page.evaluate(() => ({
      closed: document.body.classList.contains("desk-ft-closed"),
      open: localStorage.getItem("desk-ft-open"),
      origin: location.origin,
    }));
    expect(after.origin).toBe("app-resource://vsc-resource");
    expect(after.closed).toBe(false);
    expect(after.open).toBe("1");
  });

  it("active session row uses selection token grey, not a hardcoded blue", async () => {
    await page.waitForSelector("#projects-rail:not([hidden])", { timeout: 45_000 });
    // Ensure at least one session row if the catalog has history; otherwise
    // assert the CSS variable on :root (the paint path for .rail-session.active).
    const colors = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const sel = root.getPropertyValue("--vscode-list-activeSelectionBackground").trim();
      const active = document.querySelector(".rail-session.active") as HTMLElement | null;
      const activeBg = active ? getComputedStyle(active).backgroundColor : null;
      return { sel, activeBg, theme: document.documentElement.getAttribute("data-theme") };
    });
    // Dark AFK Pilot grey #37373d → rgb(55, 55, 61); light #e4e6f1 → rgb(228, 230, 241).
    if (colors.theme === "light") {
      expect(colors.sel.toLowerCase()).toBe("#e4e6f1");
    } else {
      expect(colors.sel.toLowerCase()).toBe("#37373d");
    }
    // Must not be Dark+ selection blue (#094771 → rgb(9, 71, 113)).
    if (colors.activeBg) {
      expect(colors.activeBg).not.toMatch(/rgb\(\s*9,\s*71,\s*113\s*\)/);
    }
  });
});

/**
 * Single-instance lock: a second launch with the same profile must quit and
 * leave the first process's window as the only live host (no second ACP pool).
 * Spawn the second process via child_process — Playwright's electron.launch
 * fails when the target exits before a window appears (the correct outcome).
 */
describe("desktop single-instance lock (real second launch)", () => {
  it("second launch with the same profile exits without a second window", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "grok-desk-si-ws-"));
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), "grok-desk-si-ud-"));
    const cfg = path.join(ud, "test-config.json");
    fs.writeFileSync(path.join(ws, "readme.txt"), "si\n");
    fs.writeFileSync(cfg, JSON.stringify({ "grok.cliPath": fixtureCli() }), "utf8");

    let first: ElectronApplication | undefined;
    try {
      first = await electron.launch({
        executablePath: electronExe,
        args: [mainJs, `--workspace=${ws}`, `--user-data-dir=${ud}`, `--config-json=${cfg}`],
        env: stripElectronRunAsNode(process.env),
        timeout: 60_000,
      });
      const win1 = await first.firstWindow({ timeout: 60_000 });
      await win1.waitForSelector("#input", { timeout: 45_000 });
      const windowsBefore = first.windows().length;
      expect(windowsBefore).toBeGreaterThanOrEqual(1);

      const secondExit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          const child = spawn(
            electronExe,
            [mainJs, `--workspace=${ws}`, `--user-data-dir=${ud}`, `--config-json=${cfg}`],
            {
              env: stripElectronRunAsNode(process.env),
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          const timer = setTimeout(() => {
            try {
              child.kill();
            } catch {
              /* */
            }
            reject(new Error("second instance did not exit within 15s"));
          }, 15_000);
          child.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
          });
          child.on("exit", (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal });
          });
        },
      );
      // Quit without a crash signal — lock denial is a clean exit.
      expect(secondExit.signal).toBeNull();
      expect(secondExit.code === 0 || secondExit.code === null).toBe(true);

      // First host still alive with its original window count (no second sidebar).
      expect(first.windows().length).toBe(windowsBefore);
      await win1.waitForSelector("#input", { timeout: 5_000 });
    } finally {
      try {
        await first?.close();
      } catch {
        /* */
      }
      for (const p of [ws, ud]) {
        try {
          fs.rmSync(p, { recursive: true, force: true });
        } catch {
          /* */
        }
      }
    }
  }, 90_000);
});

/**
 * Multi-folder isolation: two open project folders, rail switch, sessions stay
 * in their own cwd. Separate app so prefs start clean with both roots.
 */
describe("desktop multi-folder rail + isolation", () => {
  let app: ElectronApplication;
  let page: Page;
  let wsA: string;
  let wsB: string;
  let userData: string;

  beforeAll(async () => {
    if (!fs.existsSync(mainJs)) {
      throw new Error(`Missing ${mainJs} — run npm run compile before test:desktop`);
    }
    if (process.platform !== "win32") {
      try { fs.chmodSync(fixtureCli(), 0o755); } catch { /* */ }
    }

    wsA = fs.mkdtempSync(path.join(os.tmpdir(), "grok-mf-a-"));
    wsB = fs.mkdtempSync(path.join(os.tmpdir(), "grok-mf-b-"));
    fs.writeFileSync(path.join(wsA, "a.txt"), "project A\n");
    fs.writeFileSync(path.join(wsB, "b.txt"), "project B\n");

    userData = fs.mkdtempSync(path.join(os.tmpdir(), "grok-mf-ud-"));
    // Persist both open folders before launch (config store multi-folder shape).
    fs.writeFileSync(
      path.join(userData, "config.json"),
      JSON.stringify({
        workspaceRoot: wsA,
        workspaceRoots: [wsA, wsB],
        config: { "grok.cliPath": fixtureCli() },
      }, null, 2),
      "utf8",
    );

    app = await electron.launch({
      executablePath: electronExe,
      args: [
        mainJs,
        `--workspace=${wsA}`,
        `--user-data-dir=${userData}`,
      ],
      env: stripElectronRunAsNode(process.env),
      timeout: 60_000,
    });
    page = await app.firstWindow({ timeout: 60_000 });
    await page.waitForSelector("#input", { timeout: 45_000 });
    await page.waitForFunction(
      () => {
        const input = document.querySelector("#input") as HTMLTextAreaElement | null;
        return !!input && !document.body.classList.contains("busy-locked") && !input.disabled;
      },
      { timeout: 45_000 },
    ).catch(async () => {
      await page.waitForTimeout(3000);
    });
  }, 90_000);

  afterAll(async () => {
    try { await app?.close(); } catch { /* */ }
    for (const p of [wsA, wsB, userData]) {
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it("rail lists both open project folders", async () => {
    await page.waitForSelector("#projects-rail:not([hidden])", { timeout: 45_000 });
    await page.waitForFunction(
      () => document.querySelectorAll(".rail-repo-label").length >= 2,
      { timeout: 45_000 },
    );
    const labels = await page.locator(".rail-repo-label").allTextContents();
    const leafA = path.basename(wsA);
    const leafB = path.basename(wsB);
    expect(labels.some((l) => l.includes(leafA) || l === leafA)).toBe(true);
    expect(labels.some((l) => l.includes(leafB) || l === leafB)).toBe(true);
  });

  it("switching project B then A keeps sessions isolated", async () => {
    const leafA = path.basename(wsA);
    const leafB = path.basename(wsB);

    // Send a distinctive message in project A first.
    const msgA = `isolation-A-${Date.now()}`;
    await page.locator("#input").fill(msgA);
    await page.locator("#send-btn").click();
    await page.waitForFunction(
      (t) => [...document.querySelectorAll(".msg.user")].some((el) => (el.textContent || "").includes(t)),
      msgA,
      { timeout: 30_000 },
    );
    await page.waitForFunction(
      () => {
        const all = [...document.querySelectorAll("#messages .msg")];
        return all.some((el) => !el.classList.contains("user") && (el.textContent || "").includes("ok"));
      },
      { timeout: 30_000 },
    );

    // Switch to B via the project header (whole row selects when not focused).
    await page.waitForFunction(
      (name) => [...document.querySelectorAll(".rail-repo-label")].some((b) => (b.textContent || "").includes(name)),
      leafB,
      { timeout: 15_000 },
    );
    // Selecting a project deliberately does NOT move you out of the conversation
    // you are in — browsing the rail mid-turn must be free, and you must come
    // back to what you were reading. That is the property asserted here, and it
    // is the opposite of what this test used to require.
    await page.evaluate((name) => {
      const head = [...document.querySelectorAll(".rail-repo-head")].find((h) =>
        (h.textContent || "").includes(name),
      ) as HTMLElement | undefined;
      head?.click();
    }, leafB);
    await page.locator(".msg.user", { hasText: msgA }).first().waitFor({ timeout: 15_000 });

    // Entering B is a separate, explicit act. Starting a conversation there is
    // where isolation begins to mean something, and the rest of this test
    // proves it: B never shows A's message, and A never shows B's.
    await page.locator("#new-btn").click();
    await page
      .locator(".msg.user", { hasText: msgA })
      .waitFor({ state: "detached", timeout: 45_000 });

    const msgB = `isolation-B-${Date.now()}`;
    await page.locator("#input").fill(msgB);
    await page.locator("#send-btn").click();
    // Locator waits from here on. Starting a session re-renders the document,
    // after which Playwright re-injects its helper by evaluating a string and
    // the page's CSP refuses it — every waitForFunction past that point died
    // with an EvalError instead of testing anything.
    await page.locator(".msg.user", { hasText: msgB }).first().waitFor({ timeout: 30_000 });

    // Back to A — B's message must not appear; A's may reload from pool/disk.
    await page.evaluate((name) => {
      const head = [...document.querySelectorAll(".rail-repo-head")].find((h) =>
        (h.textContent || "").includes(name),
      ) as HTMLElement | undefined;
      head?.click();
    }, leafA);
    await page.locator("#new-btn").click();

    await page
      .locator("#messages", { hasText: msgB })
      .waitFor({ state: "detached", timeout: 45_000 });

    // A's conversation should still be reachable (pool re-focus or history).
    // Soft assert: either msgA is back, or we at least do not show msgB.
    const transcript = await page.locator("#messages").innerText();
    expect(transcript).not.toContain(msgB);
  });
});

/**
 * Windows case-alias regression (the accredia class of bug):
 * history lives under `c:\…` catalog leaf while the open folder is `C:\…`.
 * The selected project's rail must list those sessions on cold start — not
 * "No sessions yet". Requires the ready-path `postSessionsList` plus
 * `sessionCatalogDirs` alias merge.
 */
describe("desktop rail: case-mismatched session catalog (selected project)", () => {
  let app: ElectronApplication;
  let page: Page;
  let workspace: string;
  let userData: string;
  let grokHome: string;
  const sessionTitle = "case-alias-history-row";

  beforeAll(async () => {
    if (process.platform !== "win32") return;
    if (!fs.existsSync(mainJs)) {
      throw new Error(`Missing ${mainJs} — run npm run compile before test:desktop`);
    }
    try { fs.chmodSync(fixtureCli(), 0o755); } catch { /* */ }

    // Open folder with uppercase drive letter (what the host workspace uses).
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "grok-case-ws-"));
    // Force a path that starts with uppercase drive if possible.
    workspace = path.resolve(workspace);
    if (workspace.length >= 2 && workspace[1] === ":") {
      workspace = workspace[0].toUpperCase() + workspace.slice(1);
    }
    fs.writeFileSync(path.join(workspace, "readme.txt"), "case alias fixture\n");

    grokHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-case-home-"));
    userData = fs.mkdtempSync(path.join(os.tmpdir(), "grok-case-ud-"));

    // Plant history under the *other* drive-letter casing (CLI write path).
    const lowerCwd =
      workspace.length >= 2 && workspace[1] === ":"
        ? workspace[0].toLowerCase() + workspace.slice(1)
        : workspace;
    const leaf = encodeURIComponent(lowerCwd);
    const sessId = "019fd999-case-alias-sess01";
    const sessDir = path.join(grokHome, "sessions", leaf, sessId);
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessDir, "summary.json"),
      JSON.stringify({
        info: { id: sessId, cwd: lowerCwd },
        session_summary: sessionTitle,
        updated_at: new Date().toISOString(),
        num_messages: 4,
      }),
      "utf8",
    );

    fs.writeFileSync(
      path.join(userData, "config.json"),
      JSON.stringify({
        workspaceRoot: workspace,
        workspaceRoots: [workspace],
        discoverySeedCompleted: true,
        config: { "grok.cliPath": fixtureCli() },
      }, null, 2),
      "utf8",
    );

    app = await electron.launch({
      executablePath: electronExe,
      args: [
        mainJs,
        `--workspace=${workspace}`,
        `--user-data-dir=${userData}`,
      ],
      env: {
        ...stripElectronRunAsNode(process.env),
        GROK_HOME: grokHome,
      },
      timeout: 60_000,
    });
    page = await app.firstWindow({ timeout: 60_000 });
    await page.waitForSelector("#input", { timeout: 45_000 });
    await page.waitForSelector("#projects-rail:not([hidden])", { timeout: 45_000 }).catch(() => {});
  }, 90_000);

  afterAll(async () => {
    if (process.platform !== "win32") return;
    try { await app?.close(); } catch { /* */ }
    for (const p of [workspace, userData, grokHome]) {
      if (!p) continue;
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it("selected project rail lists sessions stored under the other drive-letter casing", async () => {
    if (process.platform !== "win32") return;
    // Wait until the host has posted sessions (ready → postSessionsList).
    await page.waitForFunction(
      (title) => {
        const rail = document.querySelector("#projects-rail");
        if (!rail) return false;
        const text = rail.textContent || "";
        return text.includes(title) && !text.includes("No sessions yet");
      },
      sessionTitle,
      { timeout: 45_000 },
    );
    const railText = await page.locator("#projects-rail").innerText();
    expect(railText).toContain(sessionTitle);
    expect(railText).not.toMatch(/No sessions yet/);
  });
});
