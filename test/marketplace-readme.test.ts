import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `README.marketplace.md` is GENERATED from `README.md` by
 * `scripts/gen-marketplace-readme.cjs`, and it is what `vsce package
 * --readme-path` ships — i.e. the VS Code Marketplace and Open VSX listing.
 *
 * Two failure modes, both of which had actually happened by 2026-08-09 and
 * neither of which anything noticed:
 *
 *  1. The generator injected a clean extension-only Install/Quick start pair
 *     and then appended the body from `## Requirements` onward — which still
 *     contained README.md's OWN Install and Quick start. The live listing
 *     printed both headings twice.
 *  2. `## Companion apps` had been hand-added to the output file. Since the
 *     output is generated, running the script deleted it. A hand-edit here is
 *     not a fix; it is a change that survives until the next regeneration.
 *
 * So: assert the committed file is exactly what the generator produces, and
 * assert the generator's own output has no duplicated headings.
 */
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);
const { buildMarketplaceReadme } = require_(
  path.join(root, "scripts", "gen-marketplace-readme.cjs"),
) as { buildMarketplaceReadme: (githubReadme?: string) => string };

/** Line endings differ between a fresh generate (LF) and a git checkout (CRLF). */
const lf = (s: string) => s.replace(/\r\n/g, "\n");

/** Every ATX heading, e.g. "## Install". */
function headings(markdown: string): string[] {
  return [...markdown.matchAll(/^(#{1,6} .+)$/gm)].map((m) => m[1].trim());
}

describe("marketplace README", () => {
  it("is in sync with the generator — regenerating must be a no-op", () => {
    const committed = lf(readFileSync(path.join(root, "README.marketplace.md"), "utf8"));
    expect(lf(buildMarketplaceReadme())).toBe(committed);
  });

  it("prints no heading twice", () => {
    const all = headings(buildMarketplaceReadme());
    // Guard the guard: a regex that matched nothing would pass silently.
    expect(all.length).toBeGreaterThan(8);
    const seen = new Set<string>();
    const duplicated = all.filter((h) => (seen.has(h) ? true : (seen.add(h), false)));
    expect(duplicated).toEqual([]);
  });

  it("keeps the sections the listing cannot be generated without", () => {
    const out = buildMarketplaceReadme();
    for (const heading of [
      "## Requirements",
      "## Install",
      "## Quick start",
      "## Companion apps",
      "## Privacy",
    ]) {
      expect(out).toContain(`\n${heading}\n`);
    }
  });

  it("reads Requirements before Install before Quick start", () => {
    const out = buildMarketplaceReadme();
    expect(out.indexOf("\n## Requirements\n")).toBeLessThan(out.indexOf("\n## Install\n"));
    expect(out.indexOf("\n## Install\n")).toBeLessThan(out.indexOf("\n## Quick start\n"));
  });

  it("puts Install before the feature tour, on GitHub and in the listing", () => {
    // 2026-11-22: a reader who came to install should not scroll past every
    // feature to find how.
    const github = lf(readFileSync(path.join(root, "README.md"), "utf8"));
    const out = buildMarketplaceReadme();
    for (const doc of [github, out]) {
      expect(doc.indexOf("\n## Install\n")).toBeGreaterThan(0);
      expect(doc.indexOf("\n## Quick start\n")).toBeLessThan(doc.indexOf("\n## Why use this?\n"));
    }
  });

  it("refuses dual-host install wording that drifts in from README.md", () => {
    // The guard protects the BODY, not the generator's own blocks — Companion
    // apps names the desktop app on purpose. Feed it a README whose kept body
    // carries the banned wording and it must throw.
    const poisoned = readFileSync(path.join(root, "README.md"), "utf8").replace(
      "## Known limits",
      "## Known limits\n\nRun the desktop app instead.\n",
    );
    expect(() => buildMarketplaceReadme(poisoned)).toThrow(/still matches/);
  });
});
