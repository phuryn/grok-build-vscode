import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { editRewindConfirmMessage, rewindConfirmMessage } from "../src/rewind";
import { webviewHtmlText, webviewLang, webviewStringsScript } from "../src/webview-l10n";

/**
 * Panel text is keyed by its English sentence (`l10n("Session history")`), so
 * nothing at runtime complains when a key has no translation, a translation
 * has lost its `{0}`, or a sentence was edited and left its old key behind.
 */
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { collect, bundleFiles } = require("../scripts/l10n-extract.cjs") as {
  collect(): { keys: string[]; problems: string[] };
  bundleFiles(): string[];
};
const readBundle = (file: string) =>
  JSON.parse(readFileSync(path.join(root, "l10n", file), "utf8")) as Record<string, string>;
const placeholders = (text: string) => (text.match(/\{\d+\}/g) || []).sort().join(" ");

const { keys, problems } = collect();

describe("panel translations", () => {
  it("every key is a string literal, so it can be collected", () => {
    expect(problems).toEqual([]);
  });

  it("the default bundle is exactly the sources' keys, in English", () => {
    expect(readBundle("bundle.l10n.json")).toEqual(Object.fromEntries(keys.map((key) => [key, key])));
  });

  it("Simplified Chinese ships", () => {
    expect(bundleFiles()).toContain("bundle.l10n.zh-cn.json");
  });

  it.each(bundleFiles())("%s translates every key and nothing else", (file) => {
    const bundle = readBundle(file);
    expect(Object.keys(bundle).sort()).toEqual([...keys].sort());
    expect(keys.filter((key) => !bundle[key].trim())).toEqual([]);
  });

  it.each(bundleFiles())("%s keeps every placeholder and every link", (file) => {
    const bundle = readBundle(file);
    const links = (text: string) => (text.match(/https?:\/\/[^\s)]+/g) || []).sort().join(" ");
    expect(keys.filter((key) => placeholders(key) !== placeholders(bundle[key] ?? ""))).toEqual([]);
    expect(keys.filter((key) => links(key) !== links(bundle[key] ?? ""))).toEqual([]);
  });

  it("covers every line of the host's edit and rewind dialogs", () => {
    const point = { promptIndex: 0, promptPreview: "my prompt", hasFileChanges: true } as never;
    const lines = [editRewindConfirmMessage(point, true), rewindConfirmMessage(point, "all")]
      .flatMap((text) => text.split("\n"))
      .filter((line) => line && line !== '"my prompt"');
    expect(lines.filter((line) => !keys.includes(line))).toEqual([]);
    const sidebar = readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    const calls = [...sidebar.matchAll(/await this\.confirmInChat\(session, \{\s*title: "([^"]+)",\s*body: (\w+)\([\s\S]*?confirmLabel: "([^"]+)"/g)];
    expect(calls.length).toBe([...sidebar.matchAll(/this\.confirmInChat\(/g)].length);
    for (const [, title, , label] of calls) expect(keys).toEqual(expect.arrayContaining([title, label]));
  });
});

describe("handing the bundle to a page", () => {
  const strings = { "Session history": "会话 <历史> & \"更多\"" };

  it("shows English without a bundle or without the key", () => {
    expect(webviewHtmlText(undefined)("Session history")).toBe("Session history");
    expect(webviewHtmlText(strings)("New session")).toBe("New session");
    expect(webviewHtmlText(strings)("toString")).toBe("toString");
    expect(webviewStringsScript(undefined, "n")).toBe("");
    expect(webviewStringsScript({}, "n")).toBe("");
    expect(webviewLang(undefined, "zh-cn")).toBe("en");
  });

  it("escapes a translation for the attribute it lands in", () => {
    expect(webviewHtmlText(strings)("Session history")).toBe("会话 &lt;历史&gt; &amp; &quot;更多&quot;");
  });

  it("cannot close its own script tag", () => {
    const script = webviewStringsScript({ a: "</script><script>alert(1)</script>" }, "nonce1");
    expect(script.match(/<\/script>/g)).toHaveLength(1);
    expect(script).toContain('nonce="nonce1"');
  });

  it("names the page language only when the page is in it", () => {
    expect(webviewLang(strings, "zh-cn")).toBe("zh-cn");
    expect(webviewLang(strings, '"><x')).toBe("en");
  });
});
