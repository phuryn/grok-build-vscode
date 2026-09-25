// Publishes the built .vsix through the Marketplace publisher page, using the
// browser session saved by `npm run marketplace:login`.
//
// HUMAN IN THE LOOP, BY DESIGN. The upload dialog is behind an invisible
// reCAPTCHA. Clicking Upload from an automated browser puts an image challenge
// on screen and never issues a token — measured: `g-recaptcha-response` stays
// empty and the bframe iframe grows past 100px. That control is there to make
// sure a person is publishing, and it is not something to work around.
//
// So this does every part that is clicking and leaves the part that is
// verification: it opens the page, finds the extension, opens the dialog, hands
// over the right .vsix, presses Upload, and then WAITS for you to solve the
// puzzle in the window it left open. After that it waits for Microsoft's
// verification to clear and for the PUBLIC gallery to serve the new version,
// because a row showing a version number and users being able to install it are
// two different events.
//
// Why a browser at all: `vsce publish` wants a Personal Access Token, and the
// owner would rather not mint and rotate one. `vsce publish --azure-credential`
// is the other supported path and needs no PAT — worth knowing, but this keeps
// the flow in the browser where the session already lives.
//
// Run: npm run marketplace:publish
//      npm run marketplace:publish -- --dry-run     (stops before uploading)
//      npm run marketplace:publish -- --vsix path/to.vsix
import { chromium } from "playwright";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const EXTENSION = pkg.displayName || pkg.name;
// The publisher page lists the extension under the display name of the version
// ALREADY published. A release that renames it (4.12.0: "Grok Build for VS Code
// (Community)" -> "GUI for Grok Build & Muse Code") must still find its row, so
// ask the gallery what is listed under the id, and accept either name.
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
async function listedDisplayName() {
  try {
    const res = await fetch("https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json;api-version=7.2-preview.1" },
      body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: `${pkg.publisher}.${pkg.name}` }] }], flags: 914 }),
    });
    return (await res.json())?.results?.[0]?.extensions?.[0]?.displayName || "";
  } catch { return ""; }
}
const PUBLISHER = pkg.publisher;
const VERSION = pkg.version;

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const vsixArg = (argv.find((a) => a.startsWith("--vsix=")) || "").split("=")[1]
  || (argv.includes("--vsix") ? argv[argv.indexOf("--vsix") + 1] : "");
const vsix = path.resolve(root, vsixArg || `${pkg.name}-${VERSION}.vsix`);

const OUT = path.join(root, ".screens");
const log = (m) => console.log(`[marketplace] ${m}`);
const fail = (m) => { console.error(`[marketplace] ${m}`); process.exit(1); };

function profileDir(env = process.env, platform = process.platform) {
  const base = platform === "win32"
    ? env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
    : path.join(os.homedir(), ".local", "share");
  return path.join(base, "GrokBuildRelease", "marketplace-profile");
}

// Publishing yesterday's .vsix under today's version number is invisible until
// somebody installs it.
if (!fs.existsSync(vsix)) fail(`no .vsix at ${vsix}\n  build it first: npm run package`);
if (!path.basename(vsix).includes(VERSION)) {
  fail(`${path.basename(vsix)} is not version ${VERSION} — refusing to publish a mismatch`);
}
const dir = profileDir();
if (!fs.existsSync(dir)) fail(`no saved session at ${dir}\n  run: npm run marketplace:login`);
fs.mkdirSync(OUT, { recursive: true });

log(`publishing ${path.basename(vsix)} as ${PUBLISHER}`);
const context = await chromium.launchPersistentContext(dir, {
  headless: false,
  viewport: null,
  args: ["--start-maximized"],
});
let ok = false;
try {
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(`https://marketplace.visualstudio.com/manage/publishers/${PUBLISHER}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("[role='row']", { timeout: 45000 }).catch(() => {
    fail("the publisher list never appeared — the saved session may have expired.\n"
      + "  run: npm run marketplace:login");
  });
  await page.waitForTimeout(2500);

  const listed = await listedDisplayName();
  const NAMES = [...new Set([EXTENSION, listed].filter(Boolean))];
  if (listed && listed !== EXTENSION) log(`listed as "${listed}"; this upload renames it to "${EXTENSION}"`);
  const isOurRow = (text) => NAMES.some((n) => text.includes(n));
  const rowFor = () => page.locator("[role='row']").filter({
    hasText: new RegExp(NAMES.map(escapeRegExp).join("|")),
  }).first();
  const before = (await rowFor().textContent()).replace(/\s+/g, " ").trim();
  log(`row before: ${before}`);
  if (before.includes(VERSION)) {
    log(/verif/i.test(before)
      ? `${VERSION} is uploaded and still verifying — nothing to do.`
      : `already on ${VERSION} — nothing to do.`);
    ok = true;
    await context.close();
    process.exit(0);
  }
  if (DRY) {
    log("--dry-run: stopping before the upload. Everything above is a read.");
    ok = true;
    await context.close();
    process.exit(0);
  }

  await rowFor().click();
  await page.waitForTimeout(500);
  await rowFor().locator("button[aria-label='More Actions...']").first().click();
  await page.waitForTimeout(900);
  // `.upload-extension-dialog`, not `[role=dialog]`: the page keeps other hidden
  // dialogs mounted and `.first()` picks one of those.
  await page.locator("[role='menuitem'], .ms-ContextualMenu-link")
    .filter({ hasText: /^Update$/ }).first().click();
  const dialog = page.locator(".upload-extension-dialog").first();
  await dialog.waitFor({ state: "visible", timeout: 30000 });

  // The dropzone only wires itself up through its own click affordance —
  // setting the hidden input directly leaves the component's state empty and
  // Upload stays dead. So drive the affordance and catch the OS dialog.
  const chooser = page.waitForEvent("filechooser", { timeout: 30000 });
  await dialog.locator("a, .droptarget-region, .file-upload")
    .filter({ hasText: /click/i }).first().click();
  (await chooser).setFiles(vsix);

  // Upload going from disabled to enabled is the dialog confirming it took the
  // file. Clicking before that lands on a dead button and looks like success.
  const upload = dialog.locator("button").filter({ hasText: /^Upload$/ }).first();
  const btnDeadline = Date.now() + 30000;
  while (Date.now() < btnDeadline && !(await upload.isEnabled().catch(() => false))) {
    await page.waitForTimeout(500);
  }
  if (!(await upload.isEnabled().catch(() => false))) {
    await page.screenshot({ path: path.join(OUT, "mp-stuck.png") });
    fail("the dialog never enabled Upload — it did not accept the file (see .screens/mp-stuck.png)");
  }
  await upload.click();

  console.log("");
  log("=======================================================");
  log("  reCAPTCHA will now ask you to prove you are a person.");
  log("  Solve the puzzle in the browser window that is open.");
  log("  I will wait, then verify the version actually changed.");
  log("=======================================================");
  console.log("");

  // Wait for the outcome, not for the token: a token is only the middle of the
  // story, and the row's version is what anyone actually cares about.
  const deadline = Date.now() + 15 * 60 * 1000;
  let after = before;
  let announced = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(5000);
    const seen = await page.evaluate(() => {
      const ta = document.querySelector("textarea.g-recaptcha-response");
      const dlg = document.querySelector(".upload-extension-dialog");
      const r = [...document.querySelectorAll("[role='row']")]
        .map((x) => (x.textContent || "").replace(/\s+/g, " ").trim());
      return { token: !!(ta && ta.value), dialogOpen: !!dlg && dlg.offsetParent !== null, rows: r };
    }).catch(() => null);
    if (!seen) continue;
    if (seen.token && !announced) {
      announced = true;
      log("puzzle solved — uploading");
    }
    const row = seen.rows.find((t) => isOurRow(t));
    if (row) after = row;
    if (after.includes(VERSION)) break;
    // Once the dialog closes the upload has been submitted; keep polling the
    // list, which lags behind by a few seconds.
    if (!seen.dialogOpen && announced) {
      try {
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForSelector("[role='row']", { timeout: 30000 });
      } catch { /* keep waiting */ }
    }
  }
  await page.screenshot({ path: path.join(OUT, "mp-after.png") });
  log(`row after: ${after}`);
  if (!after.includes(VERSION)) {
    fail(`the row still does not show ${VERSION}.\n`
      + "  If the puzzle was never solved, run this again.\n"
      + "  If it was, check the page for a red validation error on the extension.");
  }
  // The row carrying the version means UPLOADED. Microsoft then verifies it, and
  // until that clears nobody can install it — so "published" here is a stronger
  // claim than the evidence supports. It was claimed anyway on 3.18.0 and the
  // owner had to ask whether it was verified. The PUBLIC gallery is the
  // authority, so ask it.
  log("uploaded — waiting for Marketplace verification to clear");
  const verifyDeadline = Date.now() + 30 * 60 * 1000;
  let live = false;
  while (Date.now() < verifyDeadline) {
    const seen = await page.evaluate(async (id) => {
      try {
        const res = await fetch("https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json;api-version=7.2-preview.1" },
          body: JSON.stringify({
            filters: [{ criteria: [{ filterType: 7, value: id }] }],
            flags: 914,
          }),
        });
        const data = await res.json();
        return data?.results?.[0]?.extensions?.[0]?.versions?.[0]?.version || "";
      } catch { return ""; }
    }, `${PUBLISHER}.${pkg.name}`).catch(() => "");
    if (seen === VERSION) { live = true; break; }
    await page.waitForTimeout(30000);
  }
  ok = true;
  if (live) {
    log(`PUBLISHED ${VERSION} — live in the gallery`);
  } else {
    log(`uploaded, but the public gallery still does not serve ${VERSION}.`);
    log("Verification sometimes runs long — check the publisher page for a validation error.");
  }
} finally {
  await context.close().catch(() => {});
  if (!ok) process.exitCode = 1;
}
