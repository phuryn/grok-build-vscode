import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Labels the manifest renders itself — command titles, view names, setting
 * descriptions — are `%key%` placeholders resolved from `package.nls.json` for
 * English, or `package.nls.<locale>.json` when the editor runs in that
 * language. A test that pins a user-visible label has to resolve the
 * placeholder first; asserting the raw value pins a key instead of the text.
 *
 * Resolving against the English bundle is what keeps these assertions stable:
 * the text they check is the text an English editor shows, and the locale
 * bundles are separately held in step by `test/manifest-nls.test.ts`.
 */
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const english = JSON.parse(
  readFileSync(path.join(root, "package.nls.json"), "utf8"),
) as Record<string, string>;

/** The English text behind a manifest placeholder; any other string is returned as-is. */
export function manifestLabel(value: string): string {
  return value.replace(/^%([A-Za-z0-9._-]+)%$/, (placeholder, key: string) => english[key] ?? placeholder);
}
