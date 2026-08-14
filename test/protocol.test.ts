import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  HOST_CAPABILITIES,
  HOST_MESSAGE_TYPES as TS_HOST,
  WEBVIEW_MESSAGE_TYPES as TS_WEBVIEW,
} from "../src/protocol";
// The webview's own copy of the contract (plain JS — it can't import the TS types).
import { HOST_MESSAGE_TYPES as JS_HOST, WEBVIEW_MESSAGE_TYPES as JS_WEBVIEW } from "../media/webview-helpers.js";

// chat.js is loaded as a raw <script> in the webview, so there's nothing to import
// — we assert against its source text instead.
const chatSrc = readFileSync(new URL("../media/chat.js", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const sorted = (a: readonly string[]) => [...a].sort();

describe("host <-> webview message contract (src/protocol.ts is the source of truth)", () => {
  it("advertises remote voice as a host protocol capability", () => {
    expect(HOST_CAPABILITIES).toEqual({ uploadFile: true, remoteVoice: true });
  });

  it("keeps read-aloud defaults explicit", () => {
    expect(
      packageJson.contributes.configuration.properties["grok.readRepliesAloud"].default,
    ).toBe(false);
    expect(
      packageJson.contributes.configuration.properties["grok.processingSound"].default,
    ).toBe(false);
    expect(
      packageJson.contributes.configuration.properties["grok.summarizeRepliesAloud"].default,
    ).toBe(true);
  });

  it("scopes the macOS Emacs composer bindings to composer focus", () => {
    const bindings = packageJson.contributes.keybindings;
    expect(bindings).toContainEqual({
      command: "grok.composerForward",
      key: "ctrl+f",
      when: "isMac && grok.composerFocus",
    });
    expect(bindings).toContainEqual({
      command: "grok.composerPreviousLine",
      key: "ctrl+p",
      when: "isMac && grok.composerFocus",
    });
  });

  it("uses findable AFK Pilot titles without changing the remote command ids", () => {
    expect(packageJson.contributes.commands).toContainEqual({
      command: "grok.linkRemote",
      title: "AFK Pilot: Link this device",
    });
    expect(packageJson.contributes.commands).toContainEqual({
      command: "grok.unlinkRemote",
      title: "AFK Pilot: Unlink this device",
    });
  });

  it("contributes an MCP command that opens the side-bar manager, not a terminal command", () => {
    expect(packageJson.contributes.commands).toContainEqual({
      command: "grok.mcpServers",
      title: "Grok: MCP Servers",
    });
    expect(chatSrc).not.toContain("runMcpList");
  });

  it("the webview's host-message list matches the TS union exactly", () => {
    // Guards the "post one shape, handle another" class: if the two copies drift,
    // the host could post a type the webview silently drops (or vice versa).
    expect(sorted(JS_HOST)).toEqual(sorted(TS_HOST));
  });

  it("the webview's outgoing-message list matches the TS union exactly", () => {
    expect(sorted(JS_WEBVIEW)).toEqual(sorted(TS_WEBVIEW));
  });

  it("chat.js has a switch handler for every host->webview message type", () => {
    // Collect every `case "x":` in chat.js (a superset — other switches, e.g. tool
    // kinds, contribute too). Every HostMsg discriminant must appear among them, so
    // no host message can reach the webview with no handler.
    const handled = new Set(
      [...chatSrc.matchAll(/case\s+"([^"]+)":/g)].map((m) => m[1]),
    );
    const unhandled = TS_HOST.filter((t) => !handled.has(t));
    expect(unhandled).toEqual([]);
  });

  it("every type chat.js posts back to the host is in the webview->host contract", () => {
    const posted = new Set(
      [...chatSrc.matchAll(/vscode\.postMessage\(\s*\{\s*type:\s*"([^"]+)"/g)].map((m) => m[1]),
    );
    expect(posted.size).toBeGreaterThan(0); // regex still matches the call shape
    const unknown = [...posted].filter((t) => !TS_WEBVIEW.includes(t as never));
    expect(unknown).toEqual([]);
  });
});
