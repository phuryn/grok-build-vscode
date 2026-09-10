/**
 * Packaging policy — marketplace description vs GitHub README, and VSIX
 * exclusion of the desktop app. These silently regress at publish time if the
 * scripts or ignore rules drift, so they are pinned here.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

describe("marketplace vs GitHub README", () => {
  const github = read("README.md");
  const marketplace = read("README.marketplace.md");
  const pkg = JSON.parse(read("package.json")) as {
    scripts: Record<string, string>;
  };

  it("GitHub README covers Grok Build Desktop and both hosts", () => {
    expect(github).toMatch(/Grok Build Desktop/);
    expect(github).toMatch(/VS Code extension/i);
    // Desktop downloads moved from GitHub Releases to the site, which detects
    // the visitor's platform. The assertion follows the download source rather
    // than pinning the old one.
    expect(github).toMatch(/afkpilot\.com\/desktop/);
    expect(github).toMatch(/Grok-Build-Desktop-<version>-mac-arm64\.dmg/);
    expect(github).toMatch(/Grok-Build-Desktop-<version>-win-x64\.exe/);
  });

  // Owner, 2026-08-07: *"the key for me is what people see in marketplaces
  // focuses primarily on the extension side. we can mention companion apps."*
  // The rule is PRIMACY, not silence. The previous version banned the desktop
  // app outright, which also banned telling an extension user that the thing
  // they might actually want exists.
  it("marketplace README stays extension-primary, companions only as a footnote", () => {
    expect(marketplace).toMatch(/Grok Build for VS Code \(Community\)/);
    // The non-affiliation line must be there; WHO it names moved when xAI
    // rebranded to SpaceXAI, so match the shape rather than the company. The
    // trademark attribution is asserted separately and deliberately still says
    // xAI — their own brand guidelines and copyright line still do.
    expect(marketplace).toMatch(/not affiliated with or endorsed by\s+\S+/i);
    expect(marketplace).toMatch(/trademarks of xAI/i);

    // Build/packaging internals are noise for someone installing an extension,
    // and stay banned regardless of the relaxation above.
    expect(marketplace).not.toMatch(/npm run dist/i);
    expect(marketplace).not.toMatch(/dist-desktop/i);
    expect(marketplace).not.toMatch(/electron-builder/i);

    // Primacy, enforced mechanically: the extension must be established before
    // another product is named. "Later in the document" is the only
    // machine-checkable form of "not the headline".
    const firstExtension = marketplace.search(/Grok Build for VS Code \(Community\)/);
    const firstDesktop = marketplace.search(/Grok Build Desktop/i);
    expect(firstExtension).toBeGreaterThanOrEqual(0);
    if (firstDesktop >= 0) {
      expect(firstDesktop).toBeGreaterThan(firstExtension);
      // Past the halfway mark: a companion named in the first half is being
      // sold, not mentioned.
      expect(firstDesktop).toBeGreaterThan(marketplace.length / 2);
      // A footnote is named a handful of times, not threaded throughout.
      expect((marketplace.match(/Grok Build Desktop/gi) || []).length).toBeLessThanOrEqual(3);
    }
    // AFK Pilot may be named anywhere — it IS the extension's Remote Control
    // feature, not a separate product being cross-sold.
    expect(marketplace).toMatch(/AFK Pilot/);
  });

  it("package and publish always pass --readme-path README.marketplace.md", () => {
    // Fail-closed: if someone reverts to bare `vsce package`, the GitHub
    // dual-host README becomes the store description by accident.
    expect(pkg.scripts.package).toMatch(
      /--readme-path\s+README\.marketplace\.md/,
    );
    expect(pkg.scripts.publish).toMatch(
      /--readme-path\s+README\.marketplace\.md/,
    );
    // Must not package without an explicit marketplace path.
    expect(pkg.scripts.package).not.toBe("npx @vscode/vsce package");
    expect(pkg.scripts.publish).not.toBe("npx @vscode/vsce publish");
  });

  it("pins @vscode/vsce in devDependencies (no floating npx fetch on package)", () => {
    const full = JSON.parse(read("package.json")) as {
      devDependencies?: Record<string, string>;
      scripts: Record<string, string>;
    };
    // Clean CI/release builds must use the locked binary, not whatever
    // `npx @vscode/vsce` resolves on the network that day.
    // Exact pin (no caret/tilde) so lockfile + package.json agree on the tool.
    expect(full.devDependencies?.["@vscode/vsce"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(full.scripts.package).toMatch(/^vsce package\b/);
    expect(full.scripts.publish).toMatch(/^vsce publish\b/);
    // Mutation: dropping the dep while keeping `npx @vscode/vsce` reopens float.
    expect(full.scripts.package).not.toMatch(/npx\s+@vscode\/vsce/);
  });
});

describe("VSIX excludes desktop app", () => {
  const vscodeignore = read(".vscodeignore");
  const pkg = JSON.parse(read("package.json")) as {
    scripts: Record<string, string>;
  };

  it(".vscodeignore excludes desktop sources, launcher, and dist output", () => {
    expect(vscodeignore).toMatch(/^\s*out\/desktop\/\*\*/m);
    expect(vscodeignore).toMatch(/^\s*src\/desktop\/\*\*/m);
    expect(vscodeignore).toMatch(/^\s*scripts\/run-desktop\.cjs\s*$/m);
    expect(vscodeignore).toMatch(/^\s*scripts\/lifecycle-host\.mjs\s*$/m);
    expect(vscodeignore).toMatch(/^\s*vitest\.desktop\.config\.ts\s*$/m);
    expect(vscodeignore).toMatch(/^\s*electron-builder\.yml\s*$/m);
    expect(vscodeignore).toMatch(/^\s*docs\/desktop-update-spec\.md\s*$/m);
    expect(vscodeignore).toMatch(/^\s*dist-desktop\/\*\*/m);
    // Both readmes excluded as files; vsce embeds marketplace content only.
    expect(vscodeignore).toMatch(/^\s*README\.marketplace\.md\s*$/m);
    expect(vscodeignore).toMatch(/^\s*README\.md\s*$/m);
    // Trap: `!out/**/*.js` re-includes out/desktop/** and a LATER exclude rule
    // does not win it back under vsce's matcher. A negation placed after the
    // exclusion does work — that is how the two modules below are re-included —
    // but the broad form must stay out.
    expect(vscodeignore).toMatch(/^\s*!out\/\*\.js\s*$/m);
    expect(vscodeignore).not.toMatch(/^\s*!out\/\*\*\/\*\.js\s*$/m);
  });

  it("re-includes the desktop modules the EXTENSION requires at runtime", () => {
    // #101: out/sidebar.js requires ./desktop/desktop-policy, which requires
    // ./file-tree. Excluding them shipped six releases (3.2.0-3.2.5) that threw
    // during activation before registering a command, so every Grok command
    // reported "not found" and the sidebar never appeared.
    //
    // A tripwire, not the enforcement — `npm run check:vsix` resolves every
    // require in the packed output against the packed file list and fails
    // packaging. This just stops the two lines being deleted as dead weight.
    expect(vscodeignore).toMatch(/^\s*!out\/desktop\/desktop-policy\.js\s*$/m);
    expect(vscodeignore).toMatch(/^\s*!out\/desktop\/file-tree\.js\s*$/m);
  });

  it("packaging cannot run without the require check", () => {
    // The check has to be reachable from `npm run package`, which CI already
    // runs on every push and PR — otherwise it is a script nobody invokes.
    expect(pkg.scripts["check:vsix"]).toMatch(/check-vsix-requires/);
    expect(pkg.scripts.prepackage).toMatch(/check:vsix/);
  });

  it("packaging cannot run without the production-relay check", () => {
    expect(pkg.scripts["check:relay"]).toMatch(/check-production-relay/);
    expect(pkg.scripts.prepackage).toMatch(/check:relay/);
    expect(pkg.scripts.prepackage.indexOf("check:vsix")).toBeGreaterThan(
      pkg.scripts.prepackage.indexOf("check:relay"),
    );
  });

  it("desktop dist scripts exist and do not replace npm run package", () => {
    expect(pkg.scripts["dist:win"]).toMatch(/electron-builder/);
    expect(pkg.scripts["dist:mac"]).toMatch(/electron-builder/);
    expect(pkg.scripts.dist).toMatch(/electron-builder/);
    expect(pkg.scripts.package).toMatch(/\bvsce package\b/);
  });

  it("generates updater yml without publishing from electron-builder", () => {
    const builder = read("electron-builder.yml");
    const workflow = read(".github/workflows/desktop-release.yml");
    const full = JSON.parse(read("package.json")) as {
      dependencies?: Record<string, string>;
      scripts: Record<string, string>;
    };
    // Publish config is required so latest.yml / latest-mac.yml exist; upload
    // stays in the workflow. A GitHub provider would stall on vsix-only tags.
    expect(builder).not.toMatch(/^publish:\s*null\s*$/m);
    expect(builder).toMatch(/provider:\s*generic/);
    expect(builder).toMatch(/afkpilot\.com\/update\/win/);
    expect(builder).toMatch(/afkpilot\.com\/update\/mac/);
    expect(builder).toMatch(/verifyUpdateCodeSignature:\s*false/);
    expect(builder).not.toMatch(/publisherName:/);
    for (const s of ["dist", "dist:mac", "dist:win"]) {
      expect(full.scripts[s]).toMatch(/--publish never/);
    }
    expect(full.dependencies?.["electron-updater"]).toBeTruthy();
    // Must not enter the vsix — desktop main is excluded; do not allowlist it.
    expect(read(".vscodeignore")).not.toMatch(/!node_modules\/electron-updater/);
    expect(workflow).toMatch(/dist-desktop\/latest\.yml/);
    expect(workflow).toMatch(/dist-desktop\/latest-mac\.yml/);
    expect(workflow).toMatch(/mac-arm64\.zip/);
    expect(workflow).toMatch(/mac-x64\.zip/);
    // Line-end so a yml that only lists the .exe.blockmap fails the gate.
    expect(workflow).toMatch(/grep -Eq 'win-x64\\.exe\\r\?\$'/);
    // One mac invocation, both arches — splitting jobs races latest-mac.yml.
    expect(full.scripts["dist:mac"]).toMatch(/electron-builder --mac/);
    expect(full.scripts["dist:mac"]).not.toMatch(/--arm64/);
    expect(full.scripts["dist:mac"]).not.toMatch(/--x64/);
  });

  it("does not pack Claude Agent SDK type declarations", () => {
    const vscodeignore = read(".vscodeignore");
    const builder = read("electron-builder.yml");
    expect(vscodeignore).not.toMatch(/claude-agent-sdk\/\*\.d\.ts/);
    expect(builder).not.toMatch(/claude-agent-sdk\/\*\.d\.ts/);
    expect(vscodeignore).toMatch(/!node_modules\/@anthropic-ai\/claude-agent-sdk\/\*\.js/);
    expect(builder).toMatch(/node_modules\/@anthropic-ai\/claude-agent-sdk\/\*\.js/);
  });

  it("packages the pinned Claude ACP runtime without native SDK binaries", () => {
    const builder = read("electron-builder.yml");
    const full = JSON.parse(read("package.json")) as { dependencies?: Record<string, string> };
    expect(full.dependencies?.["@agentclientprotocol/claude-agent-acp"]).toBe("0.76.0");
    expect(builder).toMatch(/node_modules\/@agentclientprotocol\/claude-agent-acp\/package\.json/);
    expect(builder).toMatch(/node_modules\/@agentclientprotocol\/claude-agent-acp\/dist\/\*\*\/\*/);
    expect(builder).not.toMatch(/node_modules\/@agentclientprotocol\/claude-agent-acp\/\*\*\/\*/);
    expect(builder).toMatch(/node_modules\/@anthropic-ai\/claude-agent-sdk\/package\.json/);
    expect(builder).toMatch(/^\s*- "!node_modules\/@anthropic-ai\/claude-agent-sdk-\*\/\*\*"\s*$/m);
    expect(fs.existsSync(path.join(
      root,
      "node_modules",
      "@agentclientprotocol",
      "claude-agent-acp",
      "dist",
      "index.js",
    ))).toBe(true);
  });

  it("packages the pinned Codex ACP runtime in the desktop artifact", () => {
    const builder = read("electron-builder.yml");
    const full = JSON.parse(read("package.json")) as { dependencies?: Record<string, string> };
    expect(full.dependencies?.["@agentclientprotocol/codex-acp"]).toBe("1.11.0");
    // The adapter's asar payload is package.json / dist / LICENSE only; the
    // broad `codex-acp/**/*` include is banned so nobody reverts to shipping
    // the whole package directory.
    expect(builder).toMatch(/node_modules\/@agentclientprotocol\/codex-acp\/package\.json/);
    expect(builder).toMatch(/node_modules\/@agentclientprotocol\/codex-acp\/dist\/\*\*\/\*/);
    expect(builder).not.toMatch(/node_modules\/@agentclientprotocol\/codex-acp\/\*\*\/\*/);
    // LOAD-BEARING excludes: electron-builder packs the full hoisted
    // production tree of every direct dep (the built asar carries zod,
    // vscode-jsonrpc, open's helpers), so without these lines the ~350 MB
    // @openai/codex platform binary and the adapter's nested conflict copies
    // enter app.asar. Only negative patterns reach the node_modules matcher.
    expect(builder).toMatch(/^\s*- "!node_modules\/@openai\/\*\*"\s*$/m);
    expect(builder).toMatch(
      /^\s*- "!node_modules\/@agentclientprotocol\/codex-acp\/node_modules\/\*\*"\s*$/m,
    );
    expect(fs.existsSync(path.join(
      root,
      "node_modules",
      "@agentclientprotocol",
      "codex-acp",
      "dist",
      "index.js",
    ))).toBe(true);
  });

  it("lockfile records the adapter's declared dependency tree", () => {
    // vsce runs `npm list --production`. A lockfile leaf (tarball, no
    // dependencies field) lets `npm ci` succeed and then fails that list
    // against the installed package.json.
    const lock = JSON.parse(read("package-lock.json")) as {
      packages: Record<string, { dependencies?: Record<string, string> }>;
    };
    expect(lock.packages["node_modules/@agentclientprotocol/codex-acp"]?.dependencies).toEqual({
      "@agentclientprotocol/sdk": "^1.4.0",
      "@openai/codex": "^0.153.4",
      diff: "^9.0.0",
      open: "^11.0.1",
      "vscode-jsonrpc": "^9.0.1",
      zod: "^4.0.0",
    });
    expect(lock.packages["node_modules/@openai/codex"]).toBeTruthy();
  });

  it("does not re-include the adapter's nested node_modules in the vsix", () => {
    const vscodeignore = read(".vscodeignore");
    expect(vscodeignore).toMatch(
      /^\s*!node_modules\/@agentclientprotocol\/codex-acp\/package\.json\s*$/m,
    );
    expect(vscodeignore).toMatch(
      /^\s*!node_modules\/@agentclientprotocol\/codex-acp\/dist\/\*\*\s*$/m,
    );
    // vsce: a later exclude cannot undo a negate, so the broad form packs
    // nested node_modules once npm installs the declared tree.
    expect(vscodeignore).not.toMatch(
      /^\s*!node_modules\/@agentclientprotocol\/codex-acp\/\*\*\s*$/m,
    );
    expect(vscodeignore).toMatch(
      /^\s*!node_modules\/@agentclientprotocol\/claude-agent-acp\/package\.json\s*$/m,
    );
    expect(vscodeignore).toMatch(
      /^\s*!node_modules\/@agentclientprotocol\/claude-agent-acp\/dist\/\*\*\s*$/m,
    );
    expect(vscodeignore).not.toMatch(
      /^\s*!node_modules\/@agentclientprotocol\/claude-agent-acp\/\*\*\s*$/m,
    );
    expect(vscodeignore).not.toMatch(
      /^\s*!node_modules\/@anthropic-ai\/claude-agent-sdk-\*\*?\s*$/m,
    );
  });
});

describe("desktop artifact naming (electron-builder.yml)", () => {
  const yml = read("electron-builder.yml");

  it("uses the stable Grok-Build-Desktop-${version}-${os}-${arch}.${ext} pattern", () => {
    expect(yml).toMatch(
      /artifactName:\s*Grok-Build-Desktop-\$\{version\}-\$\{os\}-\$\{arch\}\.\$\{ext\}/,
    );
    expect(yml).toMatch(/productName:\s*Grok Build Desktop/);
    expect(yml).toMatch(/extraMetadata:[\s\S]*main:\s*out\/desktop\/main\.js/);
    // The telemetry identity must NOT be committed. Nothing in the source
    // tree can tell our build from a fork's — a fork copies every file, and
    // a desktop-only fork has no reason to change `publisher` — so a build
    // made from this config alone reports nothing, and the official value is
    // injected by the workflow, gated on the repository it runs in.
    expect(yml).not.toMatch(/grokExtensionName:\s*\S/);
    const wf = read(".github/workflows/desktop-release.yml");
    // QUOTED, and the quotes are the point: the Windows leg runs under pwsh,
    // which splits a bare `-c.extraMetadata.…=…` at the `-c.` and leaves
    // electron-builder reading `-c` as a config-FILE path. v3.15.0's Windows
    // installer failed exactly this way; macOS passed the same token through
    // intact, so the matrix only half-broke and the release looked complete.
    expect(wf).toMatch(/-- '-c\.extraMetadata\.grokExtensionName=grok-vscode-phuryn'/);
    expect(wf).toMatch(/if:\s*github\.repository == 'phuryn\/grok-build-vscode'/);
    expect(wf).toMatch(/if:\s*github\.repository != 'phuryn\/grok-build-vscode'/);
  });

  // Comments in this file explain settings that are deliberately ABSENT, so a
  // regex over the raw text can match prose and assert the opposite of the
  // truth. `signAndEditExecutable: false` did exactly that: the line was removed
  // in 3.2.1 and the assertion kept passing off the paragraph explaining why.
  const config = yml.replace(/^\s*#.*$/gm, "");

  it("signs and notarises the macOS build", () => {
    // Mandatory for notarisation — and the reason entitlements exist at all.
    expect(config).toMatch(/hardenedRuntime:\s*true/);
    expect(config).toMatch(
      /entitlements:\s*resources\/entitlements\.mac\.plist/,
    );
    // Helper processes inherit separately; without this the window comes up blank.
    expect(config).toMatch(
      /entitlementsInherit:\s*resources\/entitlements\.mac\.plist/,
    );
    expect(config).toMatch(/notarize:\s*true/);
    // No usage string means macOS kills the process instead of prompting.
    expect(config).toMatch(/NSMicrophoneUsageDescription/);
    // `identity: null` is what shipped 3.2.2 unsigned and unopenable.
    expect(config).not.toMatch(/identity:\s*null/);
    // Turning Windows signing off also skips rcedit, which stamps the icon (3.2.0).
    expect(config).not.toMatch(/signAndEditExecutable/);
  });

  it("entitlements grant what Electron and voice input need", () => {
    const plist = read("resources/entitlements.mac.plist");
    // V8 compiles at runtime; without these the renderer dies immediately.
    expect(plist).toMatch(/com\.apple\.security\.cs\.allow-jit/);
    expect(plist).toMatch(
      /com\.apple\.security\.cs\.allow-unsigned-executable-memory/,
    );
    expect(plist).toMatch(
      /com\.apple\.security\.cs\.allow-dyld-environment-variables/,
    );
    expect(plist).toMatch(/com\.apple\.security\.device\.audio-input/);
    // Weakens the runtime and buys nothing: ws and jpeg-js are pure JS.
    expect(plist).not.toMatch(/disable-library-validation/);
  });
});

describe("desktop release workflow signing credentials", () => {
  const workflow = read(".github/workflows/desktop-release.yml");

  it("hands notarytool a key PATH, not the key itself", () => {
    // electron-builder forwards APPLE_API_KEY verbatim to `notarytool --key`,
    // which wants a file path. The secret can only hold text, so a macOS-only
    // step writes it out and exports the path through $GITHUB_ENV.
    expect(workflow).toMatch(/APPLE_API_KEY=\$key" >> "\$GITHUB_ENV"/);
    // Step-level env outranks $GITHUB_ENV, so declaring it on the build step
    // would put the raw key contents back and fail notarisation.
    expect(workflow).not.toMatch(
      /APPLE_API_KEY:\s*\$\{\{\s*secrets\.APPLE_API_KEY\s*\}\}/,
    );
  });

  it("passes the identity and notarisation credentials to the build", () => {
    for (const v of [
      "CSC_LINK",
      "CSC_KEY_PASSWORD",
      "APPLE_API_KEY_ID",
      "APPLE_API_ISSUER",
    ]) {
      expect(workflow).toMatch(
        new RegExp(`${v}:\\s*\\$\\{\\{\\s*secrets\\.${v}\\s*\\}\\}`),
      );
    }
    expect(workflow).toMatch(/APPLE_TEAM_ID:\s*L6TFKRX6QQ/);
    // This forced signing off; leaving it would silently unsign every release.
    expect(workflow).not.toMatch(/CSC_IDENTITY_AUTO_DISCOVERY/);
  });
});
