/**
 * Panel text in the editor's display language.
 *
 * The English sentence is the key: `l10n("Session history")` in a webview
 * script looks itself up in the bundle the editor loaded from
 * `l10n/bundle.l10n.<locale>.json` and shows the English when there is none.
 * Desktop, phones and browsers never get a bundle, so they stay English.
 */
export type WebviewStrings = Readonly<Record<string, string>>;

function lookup(strings: WebviewStrings | undefined, key: string): string {
  const value = strings && Object.hasOwn(strings, key) ? strings[key] : undefined;
  return typeof value === "string" && value ? value : key;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Lookup for text the host writes straight into a webview's HTML. */
export function webviewHtmlText(strings: WebviewStrings | undefined): (key: string) => string {
  return (key) => escapeHtml(lookup(strings, key));
}

/** Hands the bundle to the page. Must precede webview-helpers.js: some tables
 *  (settings rows, mode names) are built while the scripts load. */
export function webviewStringsScript(strings: WebviewStrings | undefined, nonce: string): string {
  if (!strings || !Object.keys(strings).length) return "";
  const json = JSON.stringify(strings).replace(/</g, "\\u003c");
  return `<script nonce="${nonce}">globalThis.__grokL10n = ${json};</script>`;
}

/** `<html lang>`: the display language only when the page is in it. */
export function webviewLang(strings: WebviewStrings | undefined, language: string): string {
  return strings && Object.keys(strings).length && /^[A-Za-z0-9-]+$/.test(language) ? language : "en";
}
