/**
 * The first real cloud test (2026-08-31) found four ways a device sign-in
 * could fail with no visible or recorded trace: a "success" announced before
 * any credential existed, a re-tap answered with silence, settles that logged
 * nothing, and feedback rendered into a welcome card that cannot show over a
 * painted conversation. These tests pin the fixes.
 *
 * The sidebar half uses the same source-shape pattern as
 * provider-review-fixes.test.ts: the orchestration lives deep in GrokSidebar,
 * and what must not regress is the SHAPE — what is announced when, and what
 * always leaves a log line.
 */
import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { shouldKeepAwake } from "../src/keep-awake";
import { GrokSidebar } from "../src/sidebar";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sidebar = fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8").replace(/\r\n/g, "\n");
const modelCache = fs.readFileSync(path.join(root, "src", "codex-model-cache.ts"), "utf8");

function methodBody(signature: string): string {
  const start = sidebar.indexOf(signature);
  expect(start, `${signature} must exist`).toBeGreaterThan(-1);
  const next = sidebar.indexOf("\n  private ", start + signature.length);
  return sidebar.slice(start, next < 0 ? sidebar.length : next);
}

describe("device login: announce only what is verified", () => {
  it("never sends done from the flow itself — only the credential probe may", () => {
    const start = methodBody("private async startDeviceLogin(");
    // Exit 0 says the vendor approved; codex 0.147 exited 0 having written no
    // auth.json. "done" therefore belongs exclusively to confirmDeviceLogin.
    expect(start).not.toContain('status: "done"');
    expect(start).toContain("this.confirmDeviceLogin(");
    expect(start).toContain("needsCode: !!plan.needsCode");

    const confirm = methodBody("private async confirmDeviceLoginInner(");
    expect(confirm).toContain("reprobeProviderCredentials(");
    expect(confirm).toContain("deviceLoginCredentialReady(");
    expect(confirm).toContain('status: "done"');
    expect(confirm.indexOf("reprobeProviderCredentials(")).toBeLessThan(
      confirm.indexOf('status: "done"'),
    );
    // And a verdict either way: exhausting the probes must tell the user.
    expect(confirm).toContain('status: "failed"');
    expect(confirm).toContain("no usable credential");
  });

  it("answers a re-tap by repeating the flow's state, never with silence", () => {
    const body = methodBody("private async startDeviceLogin(");
    expect(body).toContain("running.clientId = clientId");
    expect(body).toContain("running.send(running.last)");
  });

  it("logs every settle, including cancellation", () => {
    const body = methodBody("private async startDeviceLogin(");
    expect(body).toContain("device login started");
    expect(body).toContain("device login cancelled after");
    expect(body).toContain("device login failed (");
    expect(body).toContain("verifying the credential");
  });

  it("never parks a settled flow in the guard map (synchronous spawn failure)", () => {
    const body = methodBody("private async startDeviceLogin(");
    const settledCheck = body.indexOf("if (!settled)");
    const registration = body.indexOf("this.deviceLogins.set(");
    expect(settledCheck).toBeGreaterThan(-1);
    expect(registration).toBeGreaterThan(settledCheck);
  });
});

describe("keep-awake on a hosted cloud machine", () => {
  it("never holds an OS wake lock there — sleeping is the cost model", () => {
    expect(shouldKeepAwake({ enabled: true, linked: true, cloudHost: true })).toBe(false);
    expect(shouldKeepAwake({ enabled: true, linked: false, turnInFlight: true, cloudHost: true })).toBe(false);
    // And the desk behaviour is untouched.
    expect(shouldKeepAwake({ enabled: true, linked: true })).toBe(true);
    expect(shouldKeepAwake({ enabled: false, linked: true })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Settings → Providers renders the flow where the click happened.
// ---------------------------------------------------------------------------

const settingsSrc = fs.readFileSync(path.join(root, "media", "settings.js"), "utf8");

type SettingsApi = {
  ROWS: Array<{ id: string; keepOpen?: (s: unknown, e: unknown) => boolean }>;
  defaultSnapshot: (p?: Record<string, unknown>) => Record<string, unknown>;
  defaultEnv: (p?: Record<string, unknown>) => Record<string, unknown>;
  mount: (el: Element, opts: Record<string, unknown>) => { dispose: () => void };
};

function mountSettings(env: Record<string, unknown>, opts: Record<string, unknown> = {}) {
  const window = new Window({ url: "https://localhost/" });
  (window as unknown as { eval: (src: string) => void }).eval(settingsSrc);
  const api = (window as unknown as { GrokSettings: SettingsApi }).GrokSettings;
  const doc = window.document as unknown as Document;
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const { snapshotOverrides, ...mountOpts } = opts as { snapshotOverrides?: Record<string, unknown> };
  const mounted = api.mount(container, {
    snapshot: api.defaultSnapshot(snapshotOverrides || {}),
    env: api.defaultEnv(env),
    category: "providers",
    ...mountOpts,
  });
  return { api, container, window, mounted };
}

const remoteEnv = (extra: Record<string, unknown> = {}) => ({
  isRemote: true,
  isDesktop: false,
  providersKnown: true,
  hostCaps: { remoteAgentSignIn: true, remoteAgentSignOut: true },
  ...extra,
});

describe("host-config wording knows there is no desk in the cloud", () => {
  it("says cloud on a cloud host and host-machine on a desk remote", () => {
    const cloud = mountSettings(remoteEnv(), { category: "advanced" });
    const cloudRow = cloud.container.querySelector('.settings-row[data-id="hostConfigRemote"]');
    expect(cloudRow!.textContent).toContain("cloud machine");

    const desk = mountSettings(remoteEnv({ hostCaps: { remoteAgentSignIn: true } }), { category: "advanced" });
    const deskRow = desk.container.querySelector('.settings-row[data-id="hostConfigRemote"]');
    expect(deskRow!.textContent).toContain("machine running this workspace");
    expect(deskRow!.textContent).not.toContain("desk");
  });
});

describe("the codex warm-up survives its own cleanup", () => {
  it("never lets the throwaway delete fail the warm-up — that read a valid sign-in as no credential", () => {
    const start = modelCache.indexOf("await client.deleteSession(created.sessionId);");
    expect(start).toBeGreaterThan(-1);
    const before = modelCache.slice(0, start);
    // The delete sits inside its own try. codex 0.147 answers it with
    // "Internal error: no rollout found" for a session that never rolled out.
    expect(before.lastIndexOf("try {")).toBeGreaterThan(before.lastIndexOf("await options.onModels"));
    expect(modelCache).toContain("models already cached, continuing");
  });
});

describe("the verdict never blames a credential that landed", () => {
  it("announces verifying, and separates probe failure from a missing credential", () => {
    const start = methodBody("private async startDeviceLogin(");
    expect(start).toContain('send({ status: "verifying" })');
    const confirm = methodBody("private async confirmDeviceLoginInner(");
    expect(confirm).toContain("providerCredentialFilePresent(");
    expect(confirm).toContain("does not need repeating");
    const present = methodBody("private providerCredentialFilePresent(");
    expect(present).toContain("auth.json");
  });
});

describe("a cloud machine tells the truth about its agents up front", () => {
  it("offers Claude Connect on a cloud machine, and recommends Grok", () => {
    const { container } = mountSettings(remoteEnv());
    expect(container.querySelector('[data-id="providerClaudeCloud"]')).toBeNull();
    const claude = container.querySelector('[data-id="providerClaudeRemote"]');
    expect(claude).toBeTruthy();
    expect([...claude!.querySelectorAll("button")].map((b) => b.textContent)).toContain("Connect");
    const grok = container.querySelector('[data-id="providerGrokRemote"]');
    expect(grok!.textContent).toContain("Recommended");
  });

  it("keeps the desk remote unchanged: Claude offers Connect, Grok carries no tag", () => {
    const { container } = mountSettings(remoteEnv({ hostCaps: { remoteAgentSignIn: true } }));
    expect(container.querySelector('[data-id="providerClaudeCloud"]')).toBeNull();
    expect(container.querySelector('[data-id="providerClaudeRemote"]')).toBeTruthy();
    const grok = container.querySelector('[data-id="providerGrokRemote"]');
    expect(grok!.textContent).not.toContain("Recommended");
  });
});

// ---------------------------------------------------------------------------
// The whole state matrix, in one loop. The owner asked to see every button in
// every configuration rather than reach them by clicking; these are the same
// cases the scratchpad screenshot harness renders, asserted here so they stay
// true.
// ---------------------------------------------------------------------------

const CLOUD = { remoteAgentSignIn: true, remoteAgentSignOut: true };
const DESK = { remoteAgentSignIn: true };
const prov = (id: string, extra: Record<string, unknown> = {}) => ({ id, connected: false, ...extra });
const NONE = [prov("grok"), prov("codex"), prov("claude")];

type Case = {
  label: string;
  providers: Array<Record<string, unknown>>;
  deviceLogin: Record<string, unknown>;
  caps: Record<string, unknown>;
};

const CASES: Case[] = [
  { label: "fresh cloud machine", providers: NONE, deviceLogin: {}, caps: CLOUD },
  // A live flow no longer changes these rows — it renders in the wizard — so
  // what is asserted here is the rows themselves, in every account state.
  { label: "grok flow live in the wizard", providers: NONE, deviceLogin: { grok: { status: "waiting", url: "https://x", code: "AAAA-1111" } }, caps: CLOUD },
  { label: "grok connected", providers: [prov("grok", { connected: true }), prov("codex"), prov("claude")], deviceLogin: {}, caps: CLOUD },
  { label: "grok lapsed", providers: [prov("grok", { connected: true, needsLogin: true }), prov("codex"), prov("claude")], deviceLogin: {}, caps: CLOUD },
  { label: "grok failed", providers: NONE, deviceLogin: { grok: { status: "failed", message: "did not finish" } }, caps: CLOUD },
  { label: "codex waiting", providers: NONE, deviceLogin: { codex: { status: "waiting", url: "https://y", code: "BBBB-2222" } }, caps: CLOUD },
  { label: "both connected", providers: [prov("grok", { connected: true }), prov("codex", { connected: true }), prov("claude")], deviceLogin: {}, caps: CLOUD },
  { label: "desk remote, nothing connected", providers: NONE, deviceLogin: {}, caps: DESK },
  { label: "desk remote, grok connected", providers: [prov("grok", { connected: true }), prov("codex"), prov("claude")], deviceLogin: {}, caps: DESK },
];

describe("every provider configuration a remote can be in", () => {
  for (const testCase of CASES) {
    it(`renders one row per provider: ${testCase.label}`, () => {
      const { container } = mountSettings({
        isRemote: true,
        isDesktop: false,
        providersKnown: true,
        hostCaps: testCase.caps,
        deviceLogin: testCase.deviceLogin,
      }, { snapshotOverrides: { providers: testCase.providers } });
      // The row's id still keys on the agent; the heading is the product's own
      // name and whose it is.
      const HEADINGS: Record<string, string> = {
        Grok: "Grok Build by SpaceXAI",
        Codex: "Codex by OpenAI",
        Claude: "Claude Code by Anthropic",
      };
      for (const provider of ["Grok", "Codex", "Claude"]) {
        const rows = [...container.querySelectorAll(".settings-row")]
          .filter((row) => ((row as HTMLElement).dataset.id || "").startsWith("provider" + provider));
        expect(rows.length, `${testCase.label}: ${provider}`).toBe(1);
        // A heading is the account's name, whatever is happening to it.
        const title = rows[0].querySelector(".settings-row-title");
        expect((title!.textContent || "").trim()).toBe(HEADINGS[provider]);
      }
    });
  }

  it("offers Sign out for every connected account, and never for a live flow", () => {
    const connected = mountSettings({
      isRemote: true, isDesktop: false, providersKnown: true, hostCaps: CLOUD, deviceLogin: {},
    }, { snapshotOverrides: { providers: [prov("grok", { connected: true }), prov("codex", { connected: true }), prov("claude")] } });
    for (const id of ["providerGrokRemote", "providerCodexRemote"]) {
      const row = connected.container.querySelector(`[data-id="${id}"]`);
      expect([...row!.querySelectorAll("button")].map((b) => b.textContent)).toContain("Sign out");
    }
  });

  it("asks the client to open the wizard, and still posts the sign-in message", () => {
    // Connect must do BOTH: post `runGrokLogin` (the capability) and open the
    // wizard (where the flow reports). A local action used to return before
    // the message, so the dialog opened with nothing on its way to it.
    const posted: unknown[] = [];
    const locals: string[] = [];
    const { container, window } = mountSettings({
      isRemote: true, isDesktop: false, providersKnown: true, hostCaps: CLOUD,
    }, {
      snapshotOverrides: { providers: NONE },
      post: (m: unknown) => posted.push(m),
      onLocal: (name: string) => locals.push(name),
      closeOnAction: true,
      onClose: () => { throw new Error("settings must stay open behind the wizard"); },
    });
    const row = container.querySelector('[data-id="providerCodexRemote"]')!;
    const btn = row.querySelector(".settings-action") as HTMLElement;
    btn.dispatchEvent(new (window as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent("click", { bubbles: true }));
    expect(posted).toContainEqual({ type: "runGrokLogin", provider: "codex" });
    expect(locals).toContain("connectWizard:codex");
  });

  it("says it is disconnecting, because the answer is 10-15 seconds away", () => {
    // A remote sign-out crosses the relay, wakes a machine that may have
    // suspended, and runs the vendor CLI's own logout. The owner waited 10-15
    // seconds with the button still reading "Sign out" and clicked it several
    // times (2026-08-31).
    const posted: unknown[] = [];
    const { container, window, mounted } = mountSettings({
      isRemote: true, isDesktop: false, providersKnown: true, hostCaps: CLOUD,
    }, {
      snapshotOverrides: { providers: [prov("grok", { connected: true }), prov("codex"), prov("claude")] },
      post: (m: unknown) => posted.push(m),
    });
    const action = () => container.querySelector('[data-id="providerGrokRemote"] .settings-action') as HTMLButtonElement;
    expect(action().textContent).toBe("Sign out");
    action().dispatchEvent(new (window as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent("click", { bubbles: true }));
    expect(posted).toContainEqual({ type: "logout", provider: "grok" });
    expect(action().textContent).toBe("Disconnecting…");
    expect(action().disabled).toBe(true);
    expect(action().getAttribute("aria-busy")).toBe("true");

    // A second click cannot reach the host — which is the point.
    action().dispatchEvent(new (window as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent("click", { bubbles: true }));
    expect(posted.filter((m) => (m as { type: string }).type === "logout")).toHaveLength(1);

    // The host's answer is what puts the row back.
    mounted.update({ providers: [prov("grok"), prov("codex"), prov("claude")] }, undefined);
    expect(action().textContent).toBe("Connect");
    expect(action().disabled).toBe(false);
  });

  it("never disables a DESK sign-out, which answers a modal and can be cancelled", () => {
    // The wait "Disconnecting…" covers is the remote one. At a desk the modal
    // is instant, and its Cancel returns without a provider frame — so the row
    // sat disabled for the full backstop after a sign-out the user called off
    // (review, 2026-08-31).
    const posted: unknown[] = [];
    const { container, window } = mountSettings({
      isRemote: false, isDesktop: true, providersKnown: true,
    }, {
      snapshotOverrides: { providers: [prov("grok", { connected: true }), prov("codex"), prov("claude")] },
      post: (m: unknown) => posted.push(m),
    });
    const action = () => container.querySelector('[data-id="providerGrok"] .settings-action') as HTMLButtonElement;
    action().dispatchEvent(new (window as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent("click", { bubbles: true }));
    expect(posted).toContainEqual({ type: "logout", provider: "grok" });
    expect(action().disabled).toBe(false);
    expect(action().textContent).not.toBe("Disconnecting…");
  });

  it("leaves Connect alone — the wizard reports for itself", () => {
    const { container, window } = mountSettings({
      isRemote: true, isDesktop: false, providersKnown: true, hostCaps: CLOUD,
    }, { snapshotOverrides: { providers: NONE }, post: () => {}, onLocal: () => {} });
    const action = () => container.querySelector('[data-id="providerCodexRemote"] .settings-action') as HTMLButtonElement;
    action().dispatchEvent(new (window as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent("click", { bubbles: true }));
    expect(action().textContent).toBe("Connect");
    expect(action().disabled).toBe(false);
  });

  it("no longer renders a second copy of the flow", () => {
    // The whole point of the wizard. If these rows come back, two
    // implementations of one auth flow have to be kept in step again.
    const { container } = mountSettings({
      isRemote: true, isDesktop: false, providersKnown: true, hostCaps: CLOUD,
      deviceLogin: { codex: { status: "waiting", url: "https://x", code: "CCCC-3333" } },
    }, { snapshotOverrides: { providers: NONE } });
    expect(container.querySelector('[data-id="providerCodexFlow"]')).toBeNull();
    expect(container.querySelector(".settings-deviceflow")).toBeNull();
    expect(container.querySelector("[data-device-copy]")).toBeNull();
  });
});

describe("host age is never inferred from a missing rail reply", () => {
  const chatSrc = fs.readFileSync(path.join(root, "media", "chat.js"), "utf8");

  it("renders host errors verbatim and leaves version checks to initialState", () => {
    expect(chatSrc).not.toContain("repoPreviewsUnsupported");
    expect(chatSrc).not.toContain("errorTextForHostAge");
    expect(chatSrc).toContain("addError(msg.text, msg.code)");
  });
});

describe("a newly connected agent reaches the picker you are looking at", () => {
  it("refreshes every live session when a provider appears for the first time", () => {
    const body = methodBody("private cacheProviderModels(");
    // Connected Codex from a conversation with history: Providers said
    // connected, the model picker did not list it until a reload (owner,
    // 2026-08-31). A first-time provider is additive, so every live session
    // gets the catalog; an ordinary re-cache keeps the empty-session rule.
    expect(body).toContain("providerIsNew");
    expect(body).toContain("this.sessionsForModelRefresh()");
    expect(body).toContain("this.emptySessionsForModelRefresh()");
    const post = methodBody("private postSessionModels(");
    expect(post).not.toContain("session.hasHistory) return");
  });
});

describe("a sign-in must not be paused underneath", () => {
  it("holds the machine from BEFORE the spawn until AFTER verification", () => {
    // The first attempt at this fix did not work and the test did not notice:
    // it asserted that refreshKeepAwake appeared after a log line, while the
    // flag it depended on was set later still, so the refresh ran with an
    // empty map and asserted "not working" (found in review, 2026-08-31).
    // Pin the ORDER that matters and the single exit door.
    const start = methodBody("private async startDeviceLogin(");
    const enter = start.indexOf("this.beginDeviceLoginWork()");
    const spawn = start.indexOf("runDeviceLogin(");
    expect(enter).toBeGreaterThan(-1);
    expect(enter).toBeLessThan(spawn);

    // Success must NOT release at onDone: verification is still to come.
    expect(start).toContain("if (!result.ok) this.endDeviceLoginWork(workId)");

    // The verification wrapper releases in a finally, whatever happened.
    const confirm = methodBody("private async confirmDeviceLogin(");
    expect(confirm).toContain("finally");
    expect(confirm).toContain("this.endDeviceLoginWork(workId)");

    // The flag the keep-awake reads is the operation's own set, never the
    // guard map whose lifetime is shorter than the operation.
    const inFlight = methodBody("private deviceLoginInFlight(");
    expect(inFlight).toContain("this.deviceLoginWork.size > 0");
    expect(inFlight).not.toContain("this.deviceLogins.size");

    // Ownership is per OPERATION, not per provider: a login that is still
    // verifying has already left the guard map, so a second tab can start the
    // same provider and a provider-keyed hold let the older one's cleanup
    // release the newer one's machine (review round 2).
    const begin = methodBody("private beginDeviceLoginWork(");
    expect(begin).toContain("++this.deviceLoginWorkSeq");
    const end = methodBody("private endDeviceLoginWork(");
    expect(end).toContain("this.deviceLoginWork.delete(id)");
    expect(start).toContain("const workId = this.beginDeviceLoginWork()");
    expect(start).toContain("this.endDeviceLoginWork(workId)");
    expect(confirm).toContain("this.endDeviceLoginWork(workId)");
    // Nothing may release by provider any more.
    expect(sidebar).not.toContain("setDeviceLoginWork(");
  });

  it("keeps the credential fallback on GROK_HOME rather than a hardcoded path", () => {
    const present = methodBody("private providerCredentialFilePresent(");
    expect(present).toContain("resolveGrokHome(process.env)");
    expect(present).not.toContain('os.homedir(), ".grok"');
  });

  it("counts a pending device login as work, so the cloud machine stays awake", () => {
    // The relay holds a machine awake only while frames arrive (90s idle).
    // A phone that switches to the vendor's page generates none, and the
    // platform pauses the sprite seconds after the hold is released, killing
    // the CLI's polling connection. cloud-environments.md measured exactly
    // that failure with `grok login --device-auth`.
    const refresh = methodBody("private refreshKeepAwake(");
    expect(refresh).toContain("this.deviceLoginInFlight()");

    // Cancel is the third exit and releases too.
    // Cancel releases through onDone (cancel() settles the runner
    // synchronously), so the handler must NOT release a token it does not own.
    const cancelBlock = sidebar.slice(sidebar.indexOf('case "cancelDeviceLogin"'), sidebar.indexOf('case "recheckConnection"'));
    expect(cancelBlock).toContain("running.handle.cancel()");
    expect(cancelBlock).not.toContain("DeviceLoginWork");
  });

  it("writes a pasted code to the in-flight handle and never logs it", () => {
    const at = sidebar.indexOf('case "submitDeviceLoginCode"');
    expect(at).toBeGreaterThan(-1);
    const body = sidebar.slice(at, sidebar.indexOf('case "cancelDeviceLogin"'));
    expect(body).toContain("this.deviceLogins.get(provider)");
    expect(body).toContain("running.handle.submitCode(code)");
    expect(body).toContain("running.clientId = clientId");
    expect(body).not.toContain("appendLine");
  });
});

describe("a settled flow's explanation survives the refresh that Providers sends", () => {
  it("keeps a failed mirror on a disconnected provider, and drops only done", () => {
    const chatSrc = fs.readFileSync(path.join(root, "media", "chat.js"), "utf8");
    const start = chatSrc.indexOf("A confirmed account retires its device-flow mirror");
    const block = chatSrc.slice(start, start + 2000);
    expect(block).toContain('mirrored.status === "done"');
    // Nothing may key the retirement on the live states any more: that
    // erased the reason a login had just failed (review round 2).
    expect(block).not.toContain('mirrored.status !== "waiting"');
    // But a healthy account retires its old failure too, or the row offers
    // Sign out above the reason an earlier attempt failed (review round 3).
    expect(block).toContain("provider.needsLogin !== true");
    expect(block).toContain("healthy && terminal");
  });
});

describe("one connect wizard, in a dialog, opened from anywhere", () => {
  const chatSrc = fs.readFileSync(path.join(root, "media", "chat.js"), "utf8");

  it("renders the flow with the SAME builder the welcome card uses", () => {
    // One renderer is the point. A wizard with its own markup restarts the
    // drift that made the settings copy diverge in the first place.
    const render = chatSrc.slice(chatSrc.indexOf("function renderConnectWizard("), chatSrc.indexOf("function syncConnectWizard("));
    expect(render).toContain("remoteConnectPanel(");
    // …and it must not rewrite the welcome status line, which belongs to the
    // card, so `ver` goes in as null.
    expect(render).toContain("null,");
  });

  it("keeps the welcome card as an entry point, never as a second renderer", () => {
    const show = chatSrc.slice(chatSrc.indexOf("function showOnboarding("), chatSrc.indexOf("function showOnboarding(") + 2500);
    // A live flow is stripped from the card unconditionally — not merely when
    // a wizard is already open, because this function runs BEFORE
    // syncConnectWizard on the frame that starts one, and both painted it.
    expect(show).toContain("const liveFlow =");
    expect(show).toContain("device: undefined");
    expect(show).toContain("liveFlow || wizardOwnsIt");
  });

  it("opens on any live flow and closes itself once connected", () => {
    const sync = chatSrc.slice(chatSrc.indexOf("function syncConnectWizard("), chatSrc.indexOf("function showOnboarding("));
    // Only a RUNNING flow opens a dialog.
    for (const status of ["starting", "waiting", "verifying"]) {
      expect(sync).toContain(`"${status}"`);
    }
    // A settled outcome renders where the reader already is, so it must not
    // open one of its own — that put the same retry button on the page twice.
    const liveTest = sync.slice(sync.indexOf("const live ="), sync.indexOf("if (live)"));
    expect(liveTest).not.toContain('"failed"');
    expect(liveTest).not.toContain('"unavailable"');
    expect(sync).toContain("openConnectWizard(provider)");
    expect(sync).toContain("closeConnectWizard()");
  });

  it("closing the window does not cancel the sign-in", () => {
    // The flow lives on the host and finishes on its own; cancelling is a
    // separate, explicit button inside the panel.
    const open = chatSrc.slice(chatSrc.indexOf("function openConnectWizard("));
    const onclick = open.indexOf("closeBtn.onclick");
    expect(open.slice(onclick, onclick + 160)).toContain("closeConnectWizard()");
    expect(open.slice(onclick, onclick + 160)).not.toContain("cancelDeviceLogin");
  });

  it("opens on \"starting\", never on the offer it was opened from", () => {
    // On a cloud machine the first frame is seconds away. Rendering the
    // empty-state offer in that gap put "Connect Codex" back in front of the
    // person who had just clicked it, and they clicked it again (owner,
    // 2026-08-31).
    const open = chatSrc.slice(chatSrc.indexOf("function openConnectWizard("));
    const seed = open.indexOf("connectWizard.lastDevice = { status: \"starting\" }");
    const render = open.indexOf("renderConnectWizard()", open.indexOf("connectWizard = {"));
    expect(seed).toBeGreaterThan(-1);
    expect(render).toBeGreaterThan(seed);
    // Only when there is nothing live: a wizard opened FOR a running flow
    // renders that flow, not a fake first frame.
    expect(open.slice(seed - 120, seed)).toContain("!state.deviceLoginByProvider[provider]");
  });

  it("is reachable from Settings through the local-action channel", () => {
    expect(chatSrc).toContain('name.indexOf("connectWizard:") === 0');
    expect(chatSrc).toContain('openConnectWizard(name.slice("connectWizard:".length))');
  });
});

describe("a device-code sign-in finishes the job", () => {
  it("adopts the stranded session instead of waiting for a reload", async () => {
    // The tab that signs in is the tab that must end up with an agent on it.
    // Until this, `confirmDeviceLoginInner` promoted the account and stopped:
    // the model picker stayed on "Loading…" and the card kept offering to
    // connect until the page was reloaded (owner, on a fresh cloud machine,
    // 2026-08-31).
    const host = Object.create(GrokSidebar.prototype) as any;
    const adopted: Array<{ provider: string; session: unknown }> = [];
    const sent: Array<Record<string, unknown>> = [];
    const bound = { id: "tab-1" };
    host.host = { appendLine: vi.fn() };
    host.reprobeProviderCredentials = vi.fn(async () => true);
    host.setProviderConnected = vi.fn(async () => {});
    host.remoteSessionFor = vi.fn(() => bound);
    host.remoteClients = {
      clientForTabToken: () => "client-42",
      cwdIfPresent: () => "/repo",
      tabToken: () => "tab-42",
    };
    host.focused = { id: "desk" };
    host.adoptSessionsForConnectedProvider = vi.fn(async (provider: string, session: unknown) => {
      adopted.push({ provider, session });
    });

    await host.confirmDeviceLoginInner(
      "grok",
      (device: Record<string, unknown>) => sent.push(device),
      "Grok Build",
      () => ({ clientId: "client-42", tabToken: "tab-42" }),
    );

    expect(sent).toEqual([{ status: "done" }]);
    expect(host.setProviderConnected).toHaveBeenCalledWith("grok", true);
    // The flow's CURRENT client, read at confirm time — a phone that visited
    // the vendor's page and came back has reconnected under a new id.
    expect(host.remoteSessionFor).toHaveBeenCalledWith("client-42");
    expect(adopted).toEqual([{ provider: "grok", session: bound }]);
  });

  it("follows the TAB when the phone reconnects mid-verification", async () => {
    // Every trip to the vendor's code page reconnects the phone, so the client
    // id a sign-in began with is usually gone by the time the credential is
    // verified. The relay sends client-left(old) before client-ready(new), and
    // `identify` re-points the tab token at the new client — so the token is
    // what this must resolve through. My first attempt used `isCurrent`, which
    // answers TRUE for an id it has never heard of, so the guard was inert and
    // the tab was left with no agent and the card already dismissed (review,
    // 2026-08-31).
    const host = Object.create(GrokSidebar.prototype) as any;
    const adopted: unknown[] = [];
    const reconnected = { id: "session-on-the-new-socket" };
    host.host = { appendLine: vi.fn() };
    host.reprobeProviderCredentials = vi.fn(async () => true);
    host.setProviderConnected = vi.fn(async () => {});
    host.focused = { id: "desk" };
    host.remoteClients = {
      // The old socket is gone; the tab is here under a new one.
      clientForTabToken: (token: string) => (token === "tab-1" ? "client-new" : undefined),
      cwdIfPresent: (id: string) => (id === "client-new" ? "/repo" : undefined),
      tabToken: () => "tab-1",
    };
    host.remoteSessionFor = vi.fn((id: string) => {
      if (id !== "client-new") throw new Error(`Remote client ${id} is not ready`);
      return reconnected;
    });
    host.adoptSessionsForConnectedProvider = vi.fn(async (_p: string, s: unknown) => { adopted.push(s); });
    const sent: Array<Record<string, unknown>> = [];

    await host.confirmDeviceLoginInner(
      "grok",
      (d: Record<string, unknown>) => sent.push(d),
      "Grok Build",
      () => ({ clientId: "client-old", tabToken: "tab-1" }),
    );

    expect(sent).toEqual([{ status: "done" }]);
    // The reconnected tab gets the agent — not the desk session, and not an
    // exception.
    expect(adopted).toEqual([reconnected]);
  });

  it("uses the desk session when the tab is gone for good", async () => {
    const host = Object.create(GrokSidebar.prototype) as any;
    const adopted: unknown[] = [];
    host.host = { appendLine: vi.fn() };
    host.reprobeProviderCredentials = vi.fn(async () => true);
    host.setProviderConnected = vi.fn(async () => {});
    host.focused = { id: "desk" };
    host.remoteClients = {
      clientForTabToken: () => undefined,
      cwdIfPresent: () => undefined,
      tabToken: () => undefined,
    };
    host.remoteSessionFor = vi.fn(() => { throw new Error("not ready"); });
    host.adoptSessionsForConnectedProvider = vi.fn(async (_p: string, s: unknown) => { adopted.push(s); });

    await host.confirmDeviceLoginInner("grok", () => {}, "Grok Build",
      () => ({ clientId: "client-old", tabToken: "tab-gone" }));

    // Still adopts — the retarget picks up every stranded view — and never
    // throws out of a sign-in that already said "done".
    expect(adopted).toEqual([{ id: "desk" }]);
    expect(host.remoteSessionFor).not.toHaveBeenCalled();
  });

  it("falls back to the focused session when the flow has no client", async () => {
    const host = Object.create(GrokSidebar.prototype) as any;
    const adopted: unknown[] = [];
    host.host = { appendLine: vi.fn() };
    host.reprobeProviderCredentials = vi.fn(async () => true);
    host.setProviderConnected = vi.fn(async () => {});
    host.remoteSessionFor = vi.fn(() => ({ id: "remote" }));
    host.remoteClients = { clientForTabToken: () => undefined, cwdIfPresent: () => undefined, tabToken: () => undefined };
    host.focused = { id: "desk" };
    host.adoptSessionsForConnectedProvider = vi.fn(async (_p: string, session: unknown) => {
      adopted.push(session);
    });

    await host.confirmDeviceLoginInner("codex", () => {}, "Codex", () => ({}));

    expect(host.remoteSessionFor).not.toHaveBeenCalled();
    expect(adopted).toEqual([{ id: "desk" }]);
  });
});

describe("signing out resets what the next sign-in is told", () => {
  const sidebarSrc = fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");

  it("clears the preflight latch, so step 1 is shown again", () => {
    // The latch stops the advice repeating inside ONE flow. A sign-out ends
    // the flow, and the account setting the advice names is the first thing to
    // check before the next one — the owner reconnected Codex and was taken
    // straight to step 2 (2026-08-31).
    const start = sidebarSrc.indexOf("private async finishProviderLogout(");
    expect(start).toBeGreaterThan(-1);
    const body = sidebarSrc.slice(start, sidebarSrc.indexOf("private async resetProviderSessionsAfterLogout(", start));
    expect(body).toContain("this.deviceLoginPreflightShown.delete(provider)");
  });
});

describe("the wizard and Settings share a screen", () => {
  const chatCss = fs.readFileSync(path.join(root, "media", "chat.css"), "utf8");
  const settingsCss = fs.readFileSync(path.join(root, "media", "settings.css"), "utf8");
  const zIndexOf = (css: string, selector: string) => {
    const at = css.indexOf(selector);
    expect(at, `${selector} must exist`).toBeGreaterThan(-1);
    const block = css.slice(at, css.indexOf("}", at));
    return Number(/z-index:\s*(\d+)/.exec(block)?.[1] ?? 0);
  };

  it("paints the wizard ABOVE the settings overlay it can be opened from", () => {
    // It shipped at the confirm dialog's z-index (100) under the settings
    // overlay's 120, so a Connect clicked in Settings opened the wizard
    // behind the page that launched it — reproducing the exact invisibility
    // the wizard was built to cure (review, 2026-08-31).
    //
    // The private `.connect-wizard-overlay { z-index: 200 }` that fixed it is
    // gone: the same bug turned up a third time on the Changes view's Discard,
    // so the base now clears every layer that can launch a confirmation (see
    // confirm-stacking.test.ts). Keeping the 200 would have been actively
    // harmful — equal specificity, later in the file, so it would have pinned
    // the wizard back under the phone's full-screen panel. The wizard mounts as
    // `confirm-overlay connect-wizard-overlay` and now simply inherits.
    const wizard = zIndexOf(chatCss, ".confirm-overlay");
    const settings = zIndexOf(settingsCss, ".settings-overlay");
    expect(settings).toBeGreaterThan(0);
    expect(wizard).toBeGreaterThan(settings);
  });

  it("stands Settings' keyboard traps down while a modal is above it", () => {
    // Both listen on document in the capture phase and Settings registers
    // first, so without this its Escape closed the page underneath the dialog
    // and its Tab trap pulled focus out of it.
    const settingsSrc = fs.readFileSync(path.join(root, "media", "settings.js"), "utf8");
    const onKey = settingsSrc.slice(settingsSrc.indexOf("function onKey(e) {"));
    const guard = onKey.indexOf("document.body.dataset.modalAbove");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(onKey.indexOf('e.key === "Escape"'));

    const chatSrc = fs.readFileSync(path.join(root, "media", "chat.js"), "utf8");
    expect(chatSrc).toContain('markModalAbove(overlay, "connect-wizard")');
    expect(chatSrc).toContain("delete document.body.dataset.modalAbove");
  });

  it("opens the wizard for Connect and never for Sign out", () => {
    // The row's `local` used to fire whichever message it sent, so asking to
    // disconnect opened a dialog offering to connect.
    const connected = mountSettings({
      isRemote: true, isDesktop: false, providersKnown: true, hostCaps: CLOUD,
    }, { snapshotOverrides: { providers: [prov("grok", { connected: true }), prov("codex"), prov("claude")] } });
    const rows = connected.api.ROWS as Array<{ id: string; local?: (s: unknown, e: unknown) => string }>;
    const env = connected.api.defaultEnv({ isRemote: true, providersKnown: true, hostCaps: CLOUD });
    const snap = connected.api.defaultSnapshot({
      providers: [prov("grok", { connected: true }), prov("codex"), prov("claude")],
    });
    const grokRow = rows.find((r) => r.id === "providerGrokRemote")!;
    const codexRow = rows.find((r) => r.id === "providerCodexRemote")!;
    // Grok is connected: this row signs OUT, so no wizard.
    expect(grokRow.local!(snap, env)).toBe("");
    // Codex is not: this row signs IN.
    expect(codexRow.local!(snap, env)).toBe("connectWizard:codex");
  });

  it("carries dialog semantics, being long-lived and stacked", () => {
    const chatSrc = fs.readFileSync(path.join(root, "media", "chat.js"), "utf8");
    const open = chatSrc.slice(chatSrc.indexOf("function openConnectWizard("));
    expect(open).toContain('panel.setAttribute("role", "dialog")');
    expect(open).toContain('panel.setAttribute("aria-modal", "true")');
  });
});

describe("a success must not end on an invitation to start over", () => {
  const chatSrc = fs.readFileSync(path.join(root, "media", "chat.js"), "utf8");

  it("keeps the settled panel painted after its mirror is retired", () => {
    // A confirmed account retires its mirror, so between "connected" and the
    // auto-close the wizard had nothing to render and fell back to the idle
    // offer: the last thing a successful sign-in showed was "Connect Codex"
    // (owner, on a phone, 2026-08-31).
    const render = chatSrc.slice(chatSrc.indexOf("function renderConnectWizard("), chatSrc.indexOf("function syncConnectWizard("));
    expect(render).toContain("connectWizard.lastDevice");
    const sync = chatSrc.slice(chatSrc.indexOf("function syncConnectWizard("), chatSrc.indexOf("function showOnboarding("));
    expect(sync).toContain("connectWizard.settled = true");
    expect(sync).toContain("if (connectWizard.settled) return;");
    // And the guard must sit BEFORE the repaint it is guarding.
    expect(sync.indexOf("if (connectWizard.settled) return;")).toBeLessThan(sync.lastIndexOf("renderConnectWizard()"));
  });

  it("centres a button's label instead of leaving it to line-height", () => {
    const chatCss = fs.readFileSync(path.join(root, "media", "chat.css"), "utf8");
    const at = chatCss.indexOf(".onb-action {");
    const block = chatCss.slice(at, chatCss.indexOf("}", at));
    expect(block).toContain("align-items: center");
    expect(block).toContain("justify-content: center");
  });
});

describe("re-checking a connection proves it before claiming it", () => {
  it("promotes only on a passing probe, and never demotes on a failing one", () => {
    // Marking the provider connected first left a FAILED check reading
    // "connected but needs to sign in again" for an account that was never
    // signed in — seen on a fresh cloud machine (owner, 2026-08-31).
    const at = sidebar.indexOf('case "recheckConnection": {');
    expect(at).toBeGreaterThan(-1);
    const body = sidebar.slice(at, sidebar.indexOf('case "', at + 40));
    const probe = body.indexOf("const rechecked = await this.reprobeProviderCredentials(provider)");
    const promote = body.indexOf("if (rechecked) await this.setProviderConnected(provider, true)");
    expect(probe).toBeGreaterThan(-1);
    expect(promote).toBeGreaterThan(probe);
    expect(body).not.toContain("await this.setProviderConnected(provider, true);\n        await this.reprobeProviderCredentials");
  });
});
