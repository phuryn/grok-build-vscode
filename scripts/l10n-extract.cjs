#!/usr/bin/env node
/**
 * Panel strings → l10n/bundle.l10n.json (the English default, key = value).
 *
 *   node scripts/l10n-extract.cjs           report what is out of step
 *   node scripts/l10n-extract.cjs --write   rewrite the default bundle and
 *                                           sort every language into its order
 *
 * A language is one file, l10n/bundle.l10n.<locale>.json, with the same keys.
 * test/webview-l10n.test.ts holds the bundles to the sources.
 */
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.join(__dirname, "..");
const SOURCES = [
  "media/webview-helpers.js",
  "media/settings.js",
  "media/chat.js",
  "media/projects-rail.js",
  "media/repo-icon-picker.js",
  "src/sidebar.ts",
];
const CALLS = new Set(["l10n", "l10nKey"]);

/** Every key in the sources, plus calls whose key is not a literal. */
function collect() {
  const keys = new Set();
  const problems = [];
  for (const file of SOURCES) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
      file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    const literals = (node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
      if (ts.isParenthesizedExpression(node)) return literals(node.expression);
      if (ts.isConditionalExpression(node)) {
        const yes = literals(node.whenTrue);
        const no = literals(node.whenFalse);
        return yes && no ? [...yes, ...no] : null;
      }
      return null;
    };
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
        if (ts.isIdentifier(callee) && CALLS.has(callee.text)) {
          const found = node.arguments.length ? literals(node.arguments[0]) : null;
          // The helper's own definition and the lookup of a key collected
          // elsewhere pass a variable named `key` or `line`.
          const forwarded = node.arguments.length && ts.isIdentifier(node.arguments[0])
            && ["key", "line"].includes(node.arguments[0].text);
          if (found) found.forEach((key) => keys.add(key));
          else if (!forwarded) {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart());
            problems.push(`${file}:${line + 1} ${node.getText().slice(0, 100)}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { keys: [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), problems };
}

function bundleFiles() {
  return fs.readdirSync(path.join(root, "l10n"))
    .filter((name) => /^bundle\.l10n\.[a-z-]+\.json$/.test(name));
}

function writeJson(file, value) {
  fs.writeFileSync(path.join(root, "l10n", file), JSON.stringify(value, null, 2) + "\n");
}

if (require.main === module) {
  const { keys, problems } = collect();
  if (problems.length) {
    console.error("The key must be a string literal:\n" + problems.join("\n"));
    process.exit(1);
  }
  const write = process.argv.includes("--write");
  if (write) writeJson("bundle.l10n.json", Object.fromEntries(keys.map((key) => [key, key])));
  let missing = 0;
  for (const file of bundleFiles()) {
    const bundle = JSON.parse(fs.readFileSync(path.join(root, "l10n", file), "utf8"));
    const absent = keys.filter((key) => !bundle[key]);
    const extra = Object.keys(bundle).filter((key) => !keys.includes(key));
    missing += absent.length + extra.length;
    console.log(`${file}: ${keys.length} keys, ${absent.length} untranslated, ${extra.length} unused`);
    for (const key of absent) console.log(`  + ${key}`);
    for (const key of extra) console.log(`  - ${key}`);
    if (write) writeJson(file, Object.fromEntries(keys.filter((key) => bundle[key]).map((key) => [key, bundle[key]])));
  }
  process.exitCode = missing ? 1 : 0;
}

module.exports = { collect, bundleFiles };
