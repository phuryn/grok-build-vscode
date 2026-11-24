import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `package.json` contributes strings that VS Code renders itself — command
 * titles, view names, and every setting's description — are written as
 * `%key%` placeholders and resolved from `package.nls.<locale>.json`. Three
 * failure modes are silent at runtime, so they are pinned here:
 *
 *  1. A placeholder with no key in `package.nls.json` renders literally as
 *     `%key%` in the Command Palette and the settings UI.
 *  2. A new contribute string that is not wrapped stays English for every
 *     locale — nobody notices, because English is what the author sees.
 *  3. A translation may drop a documentation link, or drift out of key order
 *     with the English bundle, which no compiler checks.
 */
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const readJson = (file: string) => JSON.parse(read(file)) as Record<string, string>;

const pkgRaw = read("package.json");
const pkg = JSON.parse(pkgRaw) as {
  contributes: {
    viewsContainers: Record<string, Array<{ id: string; title: string }>>;
    views: Record<string, Array<{ id: string; name: string }>>;
    commands: Array<{ command: string; title: string; category?: string }>;
    configuration: {
      title: string;
      properties: Record<string, {
        description?: string;
        markdownDescription?: string;
        enumDescriptions?: string[];
      }>;
    };
  };
};
const english = readJson("package.nls.json");
const chinese = readJson("package.nls.zh-cn.json");

/** Every manifest string VS Code localizes, as `[where, value]` pairs. */
function localizableStrings(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const containers of Object.values(pkg.contributes.viewsContainers)) {
    for (const c of containers) out.push([`viewsContainers.${c.id}.title`, c.title]);
  }
  for (const views of Object.values(pkg.contributes.views)) {
    for (const v of views) out.push([`views.${v.id}.name`, v.name]);
  }
  for (const c of pkg.contributes.commands) {
    out.push([`commands.${c.command}.title`, c.title]);
    if (c.category) out.push([`commands.${c.command}.category`, c.category]);
  }
  const config = pkg.contributes.configuration;
  out.push(["configuration.title", config.title]);
  for (const [prop, spec] of Object.entries(config.properties)) {
    if (typeof spec.description === "string") out.push([`${prop}.description`, spec.description]);
    if (typeof spec.markdownDescription === "string") {
      out.push([`${prop}.markdownDescription`, spec.markdownDescription]);
    }
    for (const [i, d] of (spec.enumDescriptions || []).entries()) {
      out.push([`${prop}.enumDescriptions[${i}]`, d]);
    }
  }
  return out;
}

const placeholderKeys = [...new Set([...pkgRaw.matchAll(/%([A-Za-z0-9._-]+)%/g)].map((m) => m[1]))];
const urls = (value: string) => (value.match(/https?:\/\/[^\s)]+/g) || []).sort();

describe("manifest localization", () => {
  it("wraps every localizable string in a placeholder", () => {
    const unwrapped = localizableStrings()
      .filter(([, value]) => !/^%[A-Za-z0-9._-]+%$/.test(value))
      .map(([where]) => where);
    expect(unwrapped).toEqual([]);
  });

  it("resolves every placeholder from package.nls.json", () => {
    expect(placeholderKeys.filter((key) => !(key in english))).toEqual([]);
    expect(placeholderKeys.length).toBe(Object.keys(english).length);
  });

  it("keeps the zh-cn bundle in step with the English one", () => {
    expect(Object.keys(chinese).sort()).toEqual(Object.keys(english).sort());
    expect(Object.keys(chinese).filter((key) => !chinese[key].trim())).toEqual([]);
  });

  it("keeps every documentation link in the translated string", () => {
    const lost = Object.keys(english)
      .filter((key) => key in chinese)
      .filter((key) => urls(english[key]).join("|") !== urls(chinese[key]).join("|"));
    expect(lost).toEqual([]);
  });
});
