import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication } from "playwright";
import { expect, it, vi } from "vitest";
import { buildQaFixture } from "../../scripts/qa-fixture.mjs";
import { desktopLaunch } from "../../scripts/smoke-page-driver.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);

/**
 * Quit with unsaved Files edits: Cancel keeps the app running; Discard quits.
 * The Files panel vetoes `beforeunload` while a buffer is dirty, and Discard
 * does not clean the buffer, so the approval itself must let that unload go.
 * The dirty buffer and the Discard answer are stood in for here: the dialog is
 * the panel's own, covered by its DOM tests.
 */
it("quits after Discard even though the Files panel still holds the edit", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "afk-desktop-quit-discard-"));
  const profile = path.join(temp, "profile");
  let app: ElectronApplication | undefined;
  try {
    const qa = buildQaFixture(temp);
    const fake = path.join(root, "test", "fixtures", process.platform === "win32" ? "fake-grok-acp.cmd" : "fake-grok-acp.sh");
    await mkdir(profile);
    await writeFile(path.join(profile, "config.json"), JSON.stringify({
      "grok.cliPath": fake, "grok.desktop.tray": false, workspaceRoot: qa.project, workspaceRoots: [qa.project],
    }));
    await writeFile(path.join(profile, "globalState.json"), JSON.stringify({ "grok.providerConnections.v2": { grok: true } }));
    const launch = desktopLaunch(root, require("electron"), qa.project, profile, temp, {
      ...process.env, GROK_HOME: qa.grokHome, CODEX_HOME: path.join(temp, "codex"),
    });
    delete launch.env.GROK_RELAY_DEVICE_TOKEN;
    delete launch.env.GROK_RELAY_URL;
    delete launch.env.GROK_CLOUD_ENVIRONMENT;
    launch.env.NODE_ENV = "test";
    launch.env.GROK_DESKTOP_TEST_ALLOW_MULTIPLE = "1";
    app = await electron.launch({ ...launch, timeout: 45_000 });
    const page = await app.firstWindow();
    await vi.waitFor(async () => expect(await page.evaluate(() => typeof (window as any).__grokDeskFtBeforeClose)).toBe("function"), { timeout: 30_000, interval: 200 });
    // A real click: Chromium honours a beforeunload veto only after a gesture,
    // and typing into the editor is one.
    await page.locator("#input").click({ timeout: 15_000 });
    await page.evaluate(() => {
      const w = window as any;
      w.addEventListener("beforeunload", (event: BeforeUnloadEvent) => {
        if (!w.__qaDirty) return;
        event.preventDefault();
        event.returnValue = "";
      });
      w.__qaDirty = true;
      w.__qaAnswer = false;
      w.__qaAsked = 0;
      w.__grokDeskFtBeforeClose = () => { w.__qaAsked++; return Promise.resolve(w.__qaAnswer); };
    });
    const closed = new Promise<void>(resolve => app!.once("close", () => resolve()));
    let exited = false;
    void closed.then(() => { exited = true; });

    void app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => {});
    await vi.waitFor(async () => expect(await page.evaluate(() => (window as any).__qaAsked)).toBe(1), { timeout: 10_000, interval: 100 });
    await new Promise(resolve => setTimeout(resolve, 2_000));
    expect(exited).toBe(false);
    expect(await page.evaluate(() => document.querySelector("#input") !== null)).toBe(true);

    await page.evaluate(() => { (window as any).__qaAnswer = true; });
    void app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => {});
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("app still running after Discard")), 15_000))]);
    expect(exited).toBe(true);
    app = undefined;
  } finally {
    // close() would itself be vetoed when the bug is present; kill instead.
    const pid = app?.process().pid;
    if (pid) {
      try {
        if (process.platform === "win32") require("node:child_process").execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
        else process.kill(pid, "SIGKILL");
      } catch { /* already gone */ }
    }
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() => {});
  }
}, 120_000);
