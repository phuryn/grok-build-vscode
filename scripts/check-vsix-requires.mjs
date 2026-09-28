/**
 * Fail packaging if the vsix would ship code that cannot load.
 *
 * `out/` is plain `tsc` output, not a bundle, so every `require()` in it is
 * resolved at runtime against whatever actually made it into the package. The
 * file list is an allowlist in `.vscodeignore` maintained by hand, and nothing
 * checked that the two agreed — so the failure mode is an extension that
 * installs cleanly, then throws on activation before registering a single
 * command. Every `Grok:` command reports "not found" and the sidebar never
 * appears. The user has no way to tell that apart from a broken editor.
 *
 * That is not hypothetical. Two separate releases shipped it:
 *
 *   3.2.0-3.2.5  out/sidebar.js required ./desktop/desktop-policy, which
 *                .vscodeignore excluded (#101). Six dead releases; the report
 *                came from a user, not from us.
 *   2.x          a hand-rolled `vsce package --no-dependencies` dropped
 *                node_modules/ws, which out/remote-uplink.js requires. The
 *                extension installed and did not load at all.
 *
 * Both are the same bug — packed code requiring unpacked files — so this checks
 * both directions: relative requires must resolve to a packed file, and bare
 * requires must resolve to a packed dependency. It also refuses unexpected
 * packed deps: the Codex adapter's declared tree (especially @openai/codex
 * platform binaries) must install for `npm list` but must not enter the vsix.
 *
 * Runs from `prepackage`, so it gates `npm run package` and therefore CI, which
 * already packages on every push and PR.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkEsmPackageGraph } from "./check-esm-package-graph.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The authoritative answer to "what ships", straight from vsce's own collector
 * rather than a reimplementation of .vscodeignore's matcher — whose ordering
 * rules are subtle enough that the file carries a comment warning about them.
 */
function packedFiles() {
  const local = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "vsce.cmd" : "vsce");
  const cmd = existsSync(local) ? `"${local}" ls` : "npx --no-install vsce ls";
  return execSync(cmd, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\\/g, "/"))
    .filter((line) => line && !line.includes(" "));
}

const packed = packedFiles();
const packedSet = new Set(packed);

// Dependency names present in the package, e.g. "ws", "@scope/name".
const packedDeps = new Set();
for (const f of packed) {
  const m = /^node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(f);
  if (m) packedDeps.add(m[1]);
}

const builtins = new Set(builtinModules);
// Spawned entries are not reachable from a CJS require. Check their existence
// and recursively resolve their ESM imports against the actual packed files.
const problems = checkEsmPackageGraph(root, packed, ["out/muse-adapter/main.mjs"]);

// Production install of @agentclientprotocol/codex-acp also pulls its
// declared tree, including optional @openai/codex platform binaries.
// Those must stay out of the vsix — the adapter bundle does not need
// them when the host sets CODEX_PATH, and packing them balloons the file.
const ALLOWED_PACKED_DEPS = new Set([
  "ws",
  "jpeg-js",
  "qrcode-generator",
  "@agentclientprotocol/codex-acp",
  "@agentclientprotocol/claude-agent-acp",
  "@agentclientprotocol/sdk",
  "@muse-code/sdk",
  "@anthropic-ai/claude-agent-sdk",
  "zod",
]);
for (const name of packedDeps) {
  if (!ALLOWED_PACKED_DEPS.has(name)) {
    problems.push(
      `node_modules/${name}/ is packed but is not an allowed runtime dependency.\n` +
        `    Narrow .vscodeignore to the supported runtime dependencies.`,
    );
  }
}
for (const file of packed) {
  if (file.startsWith("node_modules/@agentclientprotocol/codex-acp/node_modules/") ||
      file.startsWith("node_modules/@agentclientprotocol/claude-agent-acp/node_modules/")) {
    problems.push(
      `${file}\n    nested adapter dependency packed — re-include only package.json / dist / LICENSE.`,
    );
  }
  if (file.startsWith("node_modules/@anthropic-ai/claude-agent-sdk-")) {
    problems.push(
      `${file}\n    Claude SDK native binary packed — set CLAUDE_CODE_EXECUTABLE and keep optional natives out of the vsix.`,
    );
  }
}

for (const file of packed) {
  // Only our own compiled output. Dependency internals are the dependency's
  // problem, and node_modules is large enough to make scanning it wasteful.
  if (!file.startsWith("out/") || !file.endsWith(".js")) continue;

  const abs = path.join(root, file);
  if (!existsSync(abs)) {
    problems.push(`${file}\n    listed for packaging but missing on disk — stale build?`);
    continue;
  }

  const src = readFileSync(abs, "utf8");
  for (const m of src.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
    const spec = m[1];

    if (spec.startsWith(".")) {
      const target = path.posix.join(path.posix.dirname(file), spec);
      // tsc emits extensionless requires; Node tries these in order.
      const candidates = [target, `${target}.js`, `${target}/index.js`];
      if (!candidates.some((c) => packedSet.has(c))) {
        problems.push(
          `${file}\n    requires "${spec}" -> ${target}.js, which is NOT packed.\n` +
            `    Add \`!${target}.js\` to .vscodeignore, or move the module into the extension tree.`,
        );
      }
      continue;
    }

    // Bare specifier: a builtin, the editor API, or a real dependency.
    const bare = spec.replace(/^node:/, "");
    if (spec.startsWith("node:") || builtins.has(bare.split("/")[0]) || bare === "vscode") continue;

    const name = bare.startsWith("@") ? bare.split("/").slice(0, 2).join("/") : bare.split("/")[0];
    if (!packedDeps.has(name)) {
      problems.push(
        `${file}\n    requires "${spec}", but node_modules/${name}/ is NOT packed.\n` +
          `    Add \`!node_modules/${name}/**\` to .vscodeignore.`,
      );
    }
  }
}

const scanned = packed.filter((f) => f.startsWith("out/") && f.endsWith(".js")).length;

if (problems.length) {
  console.error(`\n✗ vsix would ship code that cannot load (${problems.length} unresolved):\n`);
  for (const p of problems) console.error(`  ${p}\n`);
  console.error("  This is the #101 class of bug: it installs fine and dies on activation.\n");
  process.exit(1);
}

console.log(`✓ vsix requires resolve — ${scanned} packed JS files, ${packedDeps.size} packed deps`);
