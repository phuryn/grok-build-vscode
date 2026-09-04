import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  HOST_CAPABILITIES,
  HOST_MESSAGE_TYPES as TS_HOST,
  INTERRUPTED_SEND_CODE,
  SESSION_SUPERSEDED_CODE,
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
  it("pins the interrupted-send error code so harnesses do not match copy", () => {
    expect(INTERRUPTED_SEND_CODE).toBe("interrupted-send");
    expect(chatSrc).toContain('el.setAttribute("data-error-code", code)');
  });

  it("pins the session-superseded error code so a takeover is not matched on copy", () => {
    expect(SESSION_SUPERSEDED_CODE).toBe("session-superseded");
    expect(chatSrc).toContain('const SESSION_SUPERSEDED_CODE = "session-superseded"');
    expect(chatSrc).toContain("opts.claim");
    expect(chatSrc).toContain("Continue here");
  });

  it("advertises remote voice as a host protocol capability", () => {
    expect(HOST_CAPABILITIES).toEqual({
      uploadFile: true,
      remoteVoice: true,
      // Older hosts refuse to delete the conversation the requester is reading,
      // so the client has to be told rather than assume. Capability, not version.
      deleteActiveSession: true,
      queueSendChips: true,
      // Project file browse for AFK Pilot. Absent on older hosts.
      browseProjectFiles: true,
      // Edit+save existing files — separate from browse so a host can offer
      // list/read without a write path.
      editProjectFiles: true,
      // Running an agent's headless sign-in for a remote. Absent on every host
      // built before it shipped, and those hosts DROP `runGrokLogin` silently —
      // so the client must gate the Connect control on this rather than offer a
      // button that does nothing.
      remoteAgentSignIn: true,
      // Same for GitHub in the clone form: older hosts DROP `setupGithubCli`.
      remoteGithubSignIn: true,
      // And separately for the token paste and the `github` cancel value, which
      // arrived after it — a host advertising only the line above takes a
      // credential across the relay and drops it, and reads a github cancel as
      // `grok`.
      remoteGithubToken: true,
      // Same again for Rewind and Edit, which 4.1.0 opened to remotes. Every
      // host before it classifies `rewindSession` / `editLastMessage` as
      // host-local and drops them, and the relay always deploys ahead of the
      // extension — so without this the browser shows two dead buttons to
      // everyone who has not updated yet.
      remoteRewind: true,
    });
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
    expect(
      packageJson.contributes.configuration.properties["grok.thumbsFeedback"].default,
    ).toBe(false);
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

  it("contributes find-in-conversation as a palette command and a Cmd/Ctrl+F fallback", () => {
    expect(packageJson.contributes.commands).toContainEqual({
      command: "grok.findInSession",
      title: "Grok: Find in Conversation",
    });
    expect(packageJson.contributes.keybindings).toContainEqual({
      command: "grok.findInSession",
      key: "ctrl+f",
      mac: "cmd+f",
      when: "focusedView == grok.chat",
    });
  });

  it("contributes a native title-bar settings command on the chat view", () => {
    expect(packageJson.contributes.commands).toContainEqual({
      command: "grok.settings",
      title: "Grok: Settings",
      icon: "$(gear)",
    });
    expect(packageJson.contributes.menus["view/title"]).toContainEqual({
      command: "grok.settings",
      when: "view == grok.chat",
      group: "navigation",
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
