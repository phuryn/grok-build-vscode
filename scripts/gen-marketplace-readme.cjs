/**
 * One-shot / rebuild helper: regenerate README.marketplace.md from README.md
 * by taking the extension-facing body and wrapping an extension-only header.
 * Run: node scripts/gen-marketplace-readme.cjs
 *
 * Packaging always uses --readme-path README.marketplace.md; this script is
 * only for regenerating content after large README edits.
 *
 * `buildMarketplaceReadme` is exported so the suite can assert the committed
 * file still matches what this produces. That check is the point: the listing
 * is generated, so a hand-edit to the output is silently destroyed the next
 * time anyone runs the script — which is how `## Companion apps` came to exist
 * only in the output file, and would have vanished on the next regeneration.
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

const header = `# AFK Pilot: Grok Build, Muse Code, Antigravity, Claude Code, Codex, DeepSeek & more

[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](https://github.com/phuryn/grok-build-vscode/blob/main/LICENSE) ![Agents](https://img.shields.io/badge/Agents-Grok%20Build%20%C2%B7%20Muse%20Code%20%C2%B7%20Antigravity%20%C2%B7%20Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20DeepSeek-000000) [![VS Code](https://img.shields.io/badge/VS%20Code-Extension-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com) [![Cursor](https://badgen.net/badge/Cursor/Extension/007ACC)](https://cursor.com) [![The Product Compass](https://img.shields.io/badge/The%20Product%20Compass-productcompass.pm-FF6B35)](https://www.productcompass.pm)

**Six coding agents in your editor's sidebar: Grok Build (Grok 4.7), Muse Code (Muse Wonder), Google Antigravity (Gemini 4 Neon), Claude Code (Opus 5.5), Codex (GPT-6.2 Sol) and DeepSeek (V4 Pro).** AFK Pilot is the graphical workflow on top of each agent's own CLI, and **Remote Control** is built in: pair your phone at **[afkpilot.com](https://afkpilot.com)** once, then watch, approve and steer any of them from your phone or any browser while away from your desk.

![Grok Build in VS Code, choosing Grok 4.7 and its reasoning effort](https://raw.githubusercontent.com/phuryn/grok-build-vscode/main/docs/screenshots/grok_4.7.png)

![The Projects rail beside a conversation running a deep-research workflow, with context and subscription usage open](https://raw.githubusercontent.com/phuryn/grok-build-vscode/main/docs/screenshots/rail.png)

---

`;

// Opens the feature tour, which follows Requirements, Install and Quick start.
const whyHeading = `## Why use this?

`;

// Install + Quick start for the marketplace: extension only. README.md's own
// pair is dual-host, so it is sliced out of the body rather than shipped —
// see buildMarketplaceReadme. Deliberately does NOT link to the Marketplace or
// Open VSX the way README.md does: this page IS the store page.
const installBlock = `## Install

**1. Install the extension.** In VS Code or Cursor, open **Extensions** (\`Ctrl/Cmd+Shift+X\`) and search **"AFK Pilot"**.

**2. Open AFK Pilot and connect an agent.** Press \`Ctrl/Cmd+;\`. The sidebar asks which agent to connect, then **walks you through its setup**: it installs the CLI for every agent but Claude Code and guides you through sign-in or key setup. For Claude Code, install Anthropic's \`claude\` CLI first, then sign in from its card if asked.

**3. Add more agents** any time from **Settings → Providers**, each with its own account. Each agent's section below says which account or key it takes.

AFK Pilot defaults to the **Secondary Side Bar** (right side, next to other AI tools). Cursor refuses that container, so a first installation moves the view to the Primary Side Bar. Use the editor's own Move View controls to relocate it; where the secondary container is unavailable, Settings → Advanced → **Move view…** opens that picker.

> Prefer the terminal, building from source, or installing into several IDEs at once? See the project [INSTALL docs](https://github.com/phuryn/grok-build-vscode/blob/main/docs/INSTALL.md).

---

## Quick start

1. **Open** the AFK Pilot view (\`Ctrl/Cmd+;\`, or **AFK Pilot: Open** from the command palette) — it lives in the Secondary Side Bar by default.
2. **Type a prompt** and press **Enter**; the agent's answer streams in. Want its reasoning inline? Turn on **Show thinking traces** in Settings.
3. **Approve actions.** When the agent wants to write a file or run a command it may raise a permission card — preview an edit in the native **diff editor**, with full-file context focused on the first changed line, then pick one of the card's options, such as *Allow once* or *Reject*.
4. **Pick your model** and **reasoning effort** from the model chip, and a **mode** from the bottom toolbar when the agent offers one; the picker lists what that agent has.
5. **Resume anytime** — the clock icon lists past sessions for this project.

---

`;

// The companion the listing may mention. The marketplace Install section is
// extension-only, so this is the one place a reader learns the desktop app
// exists. Generator-owned rather than carried from README.md, because
// README.md covers the same ground inside `## Install` — the section this file
// replaces wholesale. Remote Control is not a companion: it is built in.
const companionBlock = `## Companion apps

This extension is complete on its own, Remote Control included: pair your phone
at **[afkpilot.com](https://afkpilot.com)** from the **Remote control** phone
button in the chat's top bar. One optional companion shares the same chat UI and
the same agents:

- **[Grok Build Desktop (Community)](https://afkpilot.com/desktop)** — the same
  agent as a standalone app for Windows, macOS and Linux, for machines where you
  would rather not install an editor. Free.

It is not required, and nothing here depends on it.

---

`;

// Dual-host wording that must not drift in from README.md. Checked against the
// body-derived parts only — the blocks above are authored here and say "Grok
// Build Desktop" deliberately, so scanning the whole output would fire on our
// own text.
const BANNED_IN_BODY = [
  /Grok Build Desktop/i,
  /desktop app/i,
  /standalone Electron/i,
  /npm run dist/i,
  /dist-desktop/i,
  /electron-builder/i,
];

// Marketplace prefers absolute image/doc URLs (no local repo tree in the store).
// Applied to every part taken from README.md: the body and Requirements.
function absoluteLinks(markdown) {
  return markdown
    .replace(
      /\((docs\/screenshots\/[^)]+)\)/g,
      "(https://raw.githubusercontent.com/phuryn/grok-build-vscode/main/$1)",
    )
    .replace(/\]\((docs\/[^)]+)\)/g, "](https://github.com/phuryn/grok-build-vscode/blob/main/$1)")
    .replace(/\]\((research\/[^)]+)\)/g, "](https://github.com/phuryn/grok-build-vscode/blob/main/$1)")
    .replace(/\]\(LICENSE\)/g, "](https://github.com/phuryn/grok-build-vscode/blob/main/LICENSE)");
}

function buildMarketplaceReadme(githubReadme) {
  const github =
    githubReadme ?? fs.readFileSync(path.join(root, "README.md"), "utf8");

  // The listing's body starts at the agents overview: everything above it is
  // README.md's dual-host introduction, replaced by the header above.
  const featIdx = github.indexOf("### Six agents, one window");
  if (featIdx < 0) throw new Error("README.md missing ### Six agents, one window section");

  let body = github.slice(featIdx);

  // Drop repo Development section (marketplace listing is usage-focused).
  const dev = body.indexOf("## Development");
  const known = body.indexOf("## Known limits");
  if (dev >= 0 && known > dev) {
    body = body.slice(0, dev) + body.slice(known);
  }

  body = absoluteLinks(body);

  // README.md puts Requirements → Install → Quick start right after its
  // introduction, before the feature tour, so a reader installs first. The
  // listing keeps that order: README's Requirements, then the extension-only
  // Install/Quick start pair in place of README's dual-host one, then the tour.
  // Requirements is sliced from the whole README; the body (from the agents
  // overview on) must not hold Install, or both headings print twice.
  const reqIdx = github.indexOf("## Requirements");
  const installIdx = github.indexOf("## Install");
  const configIdx = body.indexOf("## Configuration");
  const privacyIdx = body.indexOf("## Privacy");
  for (const [name, idx] of [
    ["## Requirements", reqIdx],
    ["## Install", installIdx],
    ["## Configuration", configIdx],
    ["## Privacy", privacyIdx],
  ]) {
    if (idx < 0) throw new Error(`README.md missing ${name}`);
  }
  if (!(reqIdx < installIdx && installIdx < featIdx && configIdx < privacyIdx)) {
    throw new Error("README.md sections are out of the expected order");
  }

  const requirements = absoluteLinks(github.slice(reqIdx, installIdx));
  // The agents overview and the feature tour, up to Configuration.
  const featuresOnly = body.slice(0, configIdx);
  // Configuration .. Known limits.
  const middle = body.slice(configIdx, privacyIdx);
  const tail = body.slice(privacyIdx);

  const bodyDerived = featuresOnly + requirements + middle + tail;
  for (const re of BANNED_IN_BODY) {
    if (re.test(bodyDerived)) {
      throw new Error(`marketplace README still matches ${re}`);
    }
  }

  const out =
    header +
    requirements +
    installBlock +
    whyHeading +
    featuresOnly +
    middle +
    companionBlock +
    tail;

  // README.md is CRLF on disk while the blocks above are LF template literals,
  // so the concatenation is mixed. Markdown does not care, but a generated file
  // with two line endings in it is noise in every diff — normalise to LF and let
  // git renormalise on checkout.
  return out.replace(/\r\n/g, "\n");
}

module.exports = { buildMarketplaceReadme };

if (require.main === module) {
  const out = buildMarketplaceReadme();
  fs.writeFileSync(path.join(root, "README.marketplace.md"), out, "utf8");
  console.log("Wrote README.marketplace.md (%d bytes)", Buffer.byteLength(out, "utf8"));
}
