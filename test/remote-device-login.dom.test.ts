/**
 * Connecting an agent from a phone, in the real webview.
 *
 * The panel this replaces was a dead end: "accounts can only be connected on
 * the computer running this workspace." What a DOM run has to show is that the
 * dead end is gone in the ways that matter — a button that posts the SAME
 * message the desk posts (so there is one capability, not two), a code that
 * arrives mid-flow and is copyable, and a provider that genuinely cannot work
 * here saying so without offering a retry that would loop.
 *
 * The desk surface renders from the same function, so it is pinned here too:
 * nothing about this feature may change what someone at their computer sees.
 */
import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch, type Harness } from "./webview-harness";

function boot(opts: { remote?: boolean; caps?: Record<string, unknown> } = {}) {
  const h = bootWebview({ remote: opts.remote });
  dispatch(h.window, {
    type: "initialState",
    effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "3.18.0",
    showThinking: false, expandCommandOutputs: false, steerByDefault: false,
    soundNotifications: false, processingSound: false, readRepliesAloud: false,
    appPurpose: "coding",
    capabilities: opts.caps ?? { remoteAgentSignIn: true },
  });
  h.posted.length = 0;
  return h;
}

// Where the connect flow renders. Since 3.19.9 a LIVE flow renders in the
// connect wizard — one renderer, in a dialog, because the welcome card cannot
// paint over a conversation and Settings had grown a second copy to work
// around that. The card is still the empty-state OFFER, so this helper reads
// whichever is showing and every assertion below keeps its original meaning.
const onb = (h: Harness) =>
  (h.doc.querySelector(".connect-wizard-body") as HTMLElement | null)
  ?? (h.doc.querySelector("#welcome-onboarding") as HTMLElement);
const text = (h: Harness) => (onb(h).textContent || "").replace(/\s+/g, " ").trim();
const actions = (h: Harness) =>
  [...onb(h).querySelectorAll(".onb-action")].map((el) => (el.textContent || "").trim());
const byAct = (h: Harness, act: string) =>
  onb(h).querySelector(`[data-act="${act}"]`) as HTMLElement | null;

function onboarding(h: Harness, extra: Record<string, unknown>) {
  dispatch(h.window, { type: "onboarding", state: "auth-required", platform: "linux", provider: "grok", ...extra });
}

describe("a phone with nothing connected", () => {
  it("offers to connect, instead of saying it cannot be done here", () => {
    const h = boot({ remote: true });
    onboarding(h, {});
    expect(text(h)).not.toMatch(/only be connected on the computer/i);
    expect(actions(h)).toContain("Connect Grok Build");
  });

  it("offers every agent when none is connected, rather than guessing", () => {
    const h = boot({ remote: true });
    dispatch(h.window, { type: "onboarding", state: "connect-agent", platform: "linux" });
    expect(actions(h)).toEqual(["Connect Grok Build", "Connect Codex", "Connect Claude Code", "Connect Gemini CLI"]);
  });

  it("offers Claude on a cloud machine instead of a dead-end note", () => {
    const h = boot({ remote: true, caps: { remoteAgentSignIn: true, remoteAgentSignOut: true } });
    dispatch(h.window, { type: "onboarding", state: "connect-agent", platform: "linux" });
    expect(text(h)).not.toMatch(/not available yet/i);
    expect(actions(h)).toEqual([
      "Connect Grok Build (recommended)",
      "Connect Codex",
      "Connect Claude Code",
      "Connect Gemini CLI",
    ]);
  });

  it("posts the same message the desk posts — one capability, not two", () => {
    const h = boot({ remote: true });
    onboarding(h, {});
    click(h.window, byAct(h, "connectRemote")!);
    expect(h.posted).toEqual([{ type: "runGrokLogin", provider: "grok" }]);
  });

  it("promises no password is typed here, because that is the question being asked", () => {
    const h = boot({ remote: true });
    onboarding(h, {});
    expect(text(h)).toMatch(/no password is typed here/i);
  });
});

describe("while the flow runs", () => {
  it("says something between the tap and the code", () => {
    const h = boot({ remote: true });
    onboarding(h, { device: { status: "starting" } });
    expect(text(h)).toMatch(/Connecting Grok Build/);
    expect(byAct(h, "cancelDeviceLogin")).toBeTruthy();
  });

  it("shows the URL as a real link and the code as copyable text", () => {
    const h = boot({ remote: true });
    onboarding(h, {
      device: { status: "waiting", url: "https://accounts.x.ai/oauth2/device?user_code=SDCN-9XZS", code: "SDCN-9XZS" },
    });
    const link = onb(h).querySelector("a.onb-action") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://accounts.x.ai/oauth2/device?user_code=SDCN-9XZS");
    // A phone has to leave this page to authorise, and come back to it.
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    const copy = onb(h).querySelector(".onb-copy") as HTMLElement;
    expect(copy.dataset.cmd).toBe("SDCN-9XZS");
    expect(onb(h).querySelector(".onb-cmd code")?.textContent).toBe("SDCN-9XZS");
  });

  it("tells the reader not to press anything else", () => {
    const h = boot({ remote: true });
    onboarding(h, { device: { status: "waiting", url: "https://x.test/d", code: "AAAA-BBBB" } });
    expect(text(h)).toMatch(/finishes on its own/i);
  });

  it("still shows the link when the CLI printed no code", () => {
    const h = boot({ remote: true });
    onboarding(h, { device: { status: "waiting", url: "https://x.test/d" } });
    expect(onb(h).querySelector("a.onb-action")).toBeTruthy();
    expect(onb(h).querySelector(".onb-cmd")).toBeNull();
  });

  it("shows a paste field when the host says the flow needs a code, not a read-only chip", () => {
    const h = boot({ remote: true });
    dispatch(h.window, {
      type: "onboarding",
      state: "claude-login",
      provider: "claude",
      device: {
        status: "waiting",
        url: "https://claude.com/cai/oauth/authorize?code=true&client_id=x",
        needsCode: true,
      },
    });
    expect(onb(h).querySelector(".onb-code-input")).toBeTruthy();
    expect(onb(h).querySelector(".onb-cmd code")).toBeNull();
    expect(text(h)).not.toMatch(/finishes on its own/i);
    const input = onb(h).querySelector(".onb-code-input") as HTMLInputElement;
    input.value = "paste-me-now";
    h.posted.length = 0;
    click(h.window, byAct(h, "submitDeviceLoginCode")!);
    expect(h.posted).toEqual([{ type: "submitDeviceLoginCode", provider: "claude", code: "paste-me-now" }]);
  });

  it("hides the paste field after the code is sent", () => {
    const h = boot({ remote: true });
    dispatch(h.window, {
      type: "onboarding",
      state: "claude-login",
      provider: "claude",
      device: {
        status: "waiting",
        url: "https://claude.com/cai/oauth/authorize",
        needsCode: true,
        submitted: true,
      },
    });
    expect(onb(h).querySelector(".onb-code-input")).toBeNull();
    expect(byAct(h, "submitDeviceLoginCode")).toBeNull();
    expect(text(h)).toMatch(/finishes on its own/i);
  });

  it("does not submit a blank paste", () => {
    const h = boot({ remote: true });
    dispatch(h.window, {
      type: "onboarding",
      state: "claude-login",
      provider: "claude",
      device: { status: "waiting", url: "https://claude.com/cai/oauth/authorize", needsCode: true },
    });
    h.posted.length = 0;
    click(h.window, byAct(h, "submitDeviceLoginCode")!);
    expect(h.posted).toEqual([]);
  });

  it("cancels the flow rather than the whole panel", () => {
    const h = boot({ remote: true });
    onboarding(h, { device: { status: "waiting", url: "https://x.test/d", code: "AAAA-BBBB" } });
    h.posted.length = 0;
    click(h.window, byAct(h, "cancelDeviceLogin")!);
    expect(h.posted).toEqual([{ type: "cancelDeviceLogin", provider: "grok" }]);
  });
});

describe("when it ends", () => {
  it("confirms success", () => {
    const h = boot({ remote: true });
    onboarding(h, { device: { status: "done" } });
    expect(text(h)).toMatch(/Grok Build connected/);
  });

  it("offers a retry on a failure that retrying could fix", () => {
    const h = boot({ remote: true });
    onboarding(h, { device: { status: "failed", message: "The code may have expired — try again." } });
    expect(text(h)).toMatch(/code may have expired/);
    click(h.window, byAct(h, "connectRemote")!);
    expect(h.posted).toEqual([{ type: "runGrokLogin", provider: "grok" }]);
  });

  it("offers NO retry for a provider that cannot work here — a dead end must not look like a loop", () => {
    const h = boot({ remote: true });
    dispatch(h.window, {
      type: "onboarding",
      state: "claude-login",
      provider: "claude",
      device: { status: "unavailable", message: "Claude's sign-in needs a real terminal, so it has to be done at your computer." },
    });
    expect(text(h)).toMatch(/needs a real terminal/);
    expect(byAct(h, "connectRemote")).toBeNull();
    expect(byAct(h, "cancelDeviceLogin")).toBeNull();
  });

  it("bolds the part of a preflight step people could not find, and still escapes", () => {
    const h = boot({ remote: true });
    dispatch(h.window, {
      type: "onboarding",
      state: "codex-login",
      provider: "codex",
      device: {
        status: "unavailable",
        message: "Codex needs one setting turned on.",
        preflight: {
          reason: "Codex needs one setting turned on.",
          steps: [
            "Turn on \"Device code authorization for Codex\" **at the very bottom**",
            "<img src=x onerror=alert(1)> **and this**",
          ],
          url: "https://chatgpt.com/#settings/Security",
        },
      },
    });
    const strong = [...onb(h).querySelectorAll("strong")].map((n) => n.textContent);
    expect(strong).toContain("at the very bottom");
    // Escape FIRST, then bold: the emphasis is re-admitted onto text that is
    // already inert, so a step string still cannot become markup.
    expect(onb(h).querySelector("img")).toBeNull();
    expect(text(h)).toContain("<img src=x onerror=alert(1)>");
    expect(strong).toContain("and this");
  });

  it("makes step one a link, and refuses a link that is not https", () => {
    // The step is a PLACE to go: ChatGPT's own security page. It arrives as
    // `[label](url)` in host text and comes out as a new-tab link, on the same
    // escape-first pass as the bold — so a javascript: or data: URL, or a
    // quote-bearing one, stays inert text (owner asked for the link back,
    // 2026-08-31).
    const h = boot({ remote: true });
    dispatch(h.window, {
      type: "onboarding",
      state: "codex-login",
      provider: "codex",
      device: {
        status: "unavailable",
        message: "Codex needs one setting turned on.",
        preflight: {
          reason: "Codex needs one setting turned on.",
          steps: [
            "[Open ChatGPT](https://chatgpt.com/#settings/Security) and go to Settings → Security",
            "[Nope](javascript:alert(1)) stays text",
          ],
          url: "https://chatgpt.com/#settings/Security",
        },
      },
    });
    const links = [...onb(h).querySelectorAll(".onb-steps a")] as HTMLAnchorElement[];
    expect(links.map((a) => a.textContent)).toEqual(["Open ChatGPT"]);
    expect(links[0].getAttribute("href")).toBe("https://chatgpt.com/#settings/Security");
    expect(links[0].getAttribute("target")).toBe("_blank");
    expect(links[0].getAttribute("rel")).toContain("noopener");
    expect(text(h)).toContain("[Nope](javascript:alert(1)) stays text");
  });

  it("bolds the warning the vendor is about to show, in the note beside the code", () => {
    const h = boot({ remote: true });
    dispatch(h.window, {
      type: "onboarding",
      state: "codex-login",
      provider: "codex",
      device: {
        status: "waiting",
        url: "https://auth.openai.com/codex/device",
        code: "ABCD-1234",
        note: "OpenAI will show a **security warning** about device codes.",
      },
    });
    const strong = [...onb(h).querySelectorAll(".onb-note strong")].map((n) => n.textContent);
    expect(strong).toEqual(["security warning"]);
  });

  it("offers the connect button again on a preflight card, because the advice is not a gate", () => {
    // The host shows this card once and then attempts for real. If the panel
    // stopped offering the button, the person who fixed the setting would have
    // no way to say so.
    const h = boot({ remote: true });
    dispatch(h.window, {
      type: "onboarding",
      state: "codex-login",
      provider: "codex",
      device: {
        status: "unavailable",
        message: "Codex needs one setting turned on.",
        preflight: { reason: "Codex needs one setting turned on.", steps: ["Do the thing"] },
      },
    });
    expect(byAct(h, "connectRemote")).not.toBeNull();
  });

  it("escapes whatever the host put in the message", () => {
    const h = boot({ remote: true });
    onboarding(h, { device: { status: "failed", message: "<img src=x onerror=alert(1)>" } });
    expect(onb(h).querySelector("img")).toBeNull();
    expect(text(h)).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("after the sign-in succeeds", () => {
  it("stops offering to connect an agent that is now connected", () => {
    // The dismissal was keyed on the OLD recovery button, which a device-code
    // card never draws — so the owner finished connecting Grok and the card
    // underneath still said "Connect Grok Build" (2026-08-31).
    const h = boot({ remote: true });
    dispatch(h.window, { type: "onboarding", state: "connect-agent", platform: "linux" });
    expect(actions(h).length).toBeGreaterThan(0);
    dispatch(h.window, {
      type: "providerState",
      providers: [
        { id: "grok", connected: true },
        { id: "codex", connected: false },
        { id: "claude", connected: false },
      ],
    });
    expect((h.doc.getElementById("welcome") as HTMLElement).hidden).toBe(true);
  });

  it("keeps offering while the connected account still needs a sign-in", () => {
    // The frame order a fresh cloud machine sends on its first attach: the
    // credential probe fails, the host posts connect-agent, then a broadcast
    // providerState lands BEHIND it with grok configured (connected) but
    // needsLogin. Dismissing on "connected" alone hid the card, and the owner
    // saw an empty page until a reload (2026-09-05).
    const h = boot({ remote: true });
    dispatch(h.window, { type: "onboarding", state: "connect-agent", platform: "linux" });
    dispatch(h.window, {
      type: "providerState",
      providers: [
        { id: "grok", connected: true, cliVersion: "1.0.13", needsLogin: true },
        { id: "codex", connected: false },
        { id: "claude", connected: false },
      ],
    });
    expect((h.doc.getElementById("welcome") as HTMLElement).hidden).toBe(false);
    expect(actions(h)).toContain("Connect Grok Build");

    // The sign-in lands: the same frame without needsLogin answers the card.
    dispatch(h.window, {
      type: "providerState",
      providers: [
        { id: "grok", connected: true, cliVersion: "1.0.13" },
        { id: "codex", connected: false },
        { id: "claude", connected: false },
      ],
    });
    expect((h.doc.getElementById("welcome") as HTMLElement).hidden).toBe(true);
  });

  it("keeps offering while the account it asked about is still not connected", () => {
    const h = boot({ remote: true });
    onboarding(h, { provider: "codex" });
    dispatch(h.window, {
      type: "providerState",
      providers: [
        { id: "grok", connected: false },
        { id: "codex", connected: false },
        { id: "claude", connected: false },
      ],
    });
    expect(actions(h).length).toBeGreaterThan(0);
    expect((h.doc.getElementById("welcome") as HTMLElement).hidden).toBe(false);
  });

  it("dismisses a provider-scoped card when THAT provider connects", () => {
    const h = boot({ remote: true });
    onboarding(h, { provider: "codex" });
    dispatch(h.window, {
      type: "providerState",
      providers: [
        { id: "grok", connected: false },
        { id: "codex", connected: true },
        { id: "claude", connected: false },
      ],
    });
    expect((h.doc.getElementById("welcome") as HTMLElement).hidden).toBe(true);
  });
});

describe("a host that predates this feature", () => {
  // The relay serves this page, so after a deploy every 3.18.0 user's phone is
  // running THIS client against a host that classifies runGrokLogin as
  // host-local and drops it without a word. Offering Connect there is a button
  // that does nothing — strictly worse than the dead end it replaced, because a
  // dead end tells you where to go.
  it("falls back to the old guidance instead of offering a button that does nothing", () => {
    const h = boot({ remote: true, caps: {} });
    onboarding(h, {});
    expect(byAct(h, "connectRemote")).toBeNull();
    expect(text(h)).toContain("only be connected on the computer");
  });

  it("offers nothing on the connect-agent panel either", () => {
    const h = boot({ remote: true, caps: {} });
    dispatch(h.window, { type: "onboarding", state: "connect-agent", platform: "linux" });
    expect(onb(h).querySelectorAll("button")).toHaveLength(0);
  });

  it("an explicit false is treated the same as absent", () => {
    const h = boot({ remote: true, caps: { remoteAgentSignIn: false } });
    onboarding(h, {});
    expect(byAct(h, "connectRemote")).toBeNull();
  });
});

describe("the desk is untouched", () => {
  it("still offers the terminal, not a device code", () => {
    const h = boot();
    dispatch(h.window, { type: "onboarding", state: "auth-required", platform: "linux", provider: "grok" });
    expect(text(h)).toMatch(/Open terminal/);
    expect(byAct(h, "connectRemote")).toBeNull();
    expect(byAct(h, "runLogin")).toBeTruthy();
  });

  it("ignores a device payload if one ever reached it", () => {
    const h = boot();
    dispatch(h.window, {
      type: "onboarding", state: "auth-required", platform: "linux", provider: "grok",
      device: { status: "waiting", url: "https://x.test/d", code: "AAAA-BBBB" },
    });
    expect(text(h)).toMatch(/Open terminal/);
    expect(text(h)).not.toContain("AAAA-BBBB");
  });
});
