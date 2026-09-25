import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch } from "./webview-harness";
import { INTERNAL_PROVIDERS, supportsCompaction } from "../src/acp-backend";

const description = "Your content, including inter-session messages, may be used for product improvement.";
const reason = "This provider is disabled by the host administrator";

it.each([false, true])("renders Muse's advertised effort tiers and commits the selected effort (remote=%s)", remote => {
  const h = bootWebview({ remote });
  const levels = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
  dispatch(h.window, { type: "providerState", providers: [{ id: "muse", connected: true }] });
  dispatch(h.window, { type: "session", sessionId: "s", provider: "muse", currentModelId: "muse-model",
    models: [{ provider: "muse", modelId: "muse-model", name: "Muse", supportsReasoningEffort: true,
      reasoningEfforts: levels, reasoningEffort: "medium" }] });
  click(h.window, h.doc.getElementById("gear-btn"));
  expect(h.doc.querySelector(".model-effort-strip")).not.toBeNull();
  expect([...h.doc.querySelectorAll(".effort-strip-stop")].map(el => el.getAttribute("data-effort"))).toEqual(levels);
  click(h.window, h.doc.querySelector('[data-effort="ultra"]'));
  expect(h.doc.querySelector(".model-chip-effort")?.textContent).toBe("Ultra");
  expect(h.posted.filter(m => m.type === "setEffort")).toEqual([]);
  click(h.window, h.doc.getElementById("gear-btn"));
  expect(h.posted.filter(m => m.type === "setEffort")).toEqual([{ type: "setEffort", level: "ultra" }]);
});

it.each(INTERNAL_PROVIDERS)("omits the effort strip when %s explicitly advertises no effort capability or tiers", provider => {
  const h = bootWebview();
  dispatch(h.window, { type: "providerState", providers: [{ id: provider, connected: true }] });
  dispatch(h.window, { type: "session", sessionId: "s", provider, currentModelId: "no-effort",
    models: [{ provider, modelId: "no-effort", name: "No effort", supportsReasoningEffort: false, reasoningEfforts: [] }] });
  click(h.window, h.doc.getElementById("gear-btn"));
  expect(h.doc.querySelector(".model-picker-row")).not.toBeNull();
  expect(h.doc.querySelector(".model-effort-strip")).toBeNull();
  expect(h.posted.some(m => m.type === "setEffort")).toBe(false);
});

it("retains the legacy effort fallback when model capability metadata is missing", () => {
  const h = bootWebview();
  dispatch(h.window, { type: "session", provider: "grok", currentModelId: "legacy",
    models: [{ modelId: "legacy", name: "Legacy" }] });
  click(h.window, h.doc.getElementById("gear-btn"));
  expect([...h.doc.querySelectorAll(".effort-strip-stop")].map(el => el.getAttribute("data-effort")))
    .toEqual(["none", "minimal", "low", "medium", "high", "xhigh"]);
});

it("retains every advertised provider's identity in the model picker", () => {
  const h = bootWebview();
  dispatch(h.window, { type: "providerState", providers: INTERNAL_PROVIDERS.map(id => ({ id, connected: true })) });
  dispatch(h.window, { type: "session", sessionId: "s", provider: "grok", models: INTERNAL_PROVIDERS.map(provider => ({ provider, modelId: provider, name: provider })) });
  click(h.window, h.doc.getElementById("gear-btn"));
  expect(h.doc.querySelectorAll(".model-picker-row")).toHaveLength(INTERNAL_PROVIDERS.length);
  for (const provider of INTERNAL_PROVIDERS) {
    expect(h.doc.querySelector(`.model-picker-row .provider-${provider}`)).not.toBeNull();
  }
});

it.each(INTERNAL_PROVIDERS)("offers compaction only when implemented for %s", provider => {
  const h = bootWebview();
  dispatch(h.window, { type: "providerState", providers: INTERNAL_PROVIDERS.map(id => ({ id, connected: true })) });
  dispatch(h.window, { type: "session", sessionId: "s", provider, models: [] });
  dispatch(h.window, { type: "contextUsage", used: 10000, window: 100000 });
  click(h.window, h.doc.getElementById("donut"));
  const button = h.doc.querySelector(".context-compact");
  expect(!!button).toBe(supportsCompaction(provider));
  if (button) click(h.window, button);
  expect(h.posted.some(m => m.type === "send" && m.text === "/compact")).toBe(supportsCompaction(provider));
});
function catalog(h: ReturnType<typeof bootWebview>) {
  dispatch(h.window, { type: "session", sessionId: "s", provider: "grok", currentModelId: "grok",
    models: [{ provider: "grok", modelId: "grok", name: "Grok" },
      { provider: "muse", modelId: "muse-spark-1.3-contributor", name: "Muse Contributor", description }] });
}

describe("Muse host advertisement", () => {
  it.each(["connectProvider", "connectRemote"])("gates %s on advertisement even with remote sign-in capability", act => {
    const h = bootWebview({ remote: true });
    dispatch(h.window, { type: "initialState", capabilities: { remoteAgentSignIn: true } });
    const button = h.doc.createElement("button");
    button.className = "onb-action";
    button.dataset.act = act;
    button.dataset.provider = "muse";
    h.doc.getElementById("welcome-onboarding")!.appendChild(button);
    h.posted.length = 0;
    click(h.window, button);
    expect(h.posted).toEqual([]);
    dispatch(h.window, { type: "providerState", providers: [{ id: "muse", connected: false }] });
    click(h.window, button);
    expect(h.posted).toContainEqual({ type: "runGrokLogin", provider: "muse" });
    dispatch(h.window, { type: "providerState", providers: [{ id: "grok", connected: true }] });
    h.posted.length = 0;
    click(h.window, button);
    expect(h.posted).toEqual([]);
  });

  it.each([false, true])("sends no Muse message without host advertisement (remote=%s)", remote => {
    const h = bootWebview({ remote });
    dispatch(h.window, { type: "initialState", capabilities: {} });
    dispatch(h.window, { type: "providerState", providers: [{ id: "grok", connected: true }] });
    catalog(h);
    click(h.window, h.doc.getElementById("gear-btn"));
    expect(h.doc.getElementById("gear-popover")?.textContent).not.toContain("Muse");
    // A stale injected control exercises the send guard as well as visibility.
    const button = h.doc.createElement("button"); button.className = "onb-action";
    button.dataset.act = "recheckProvider"; button.dataset.provider = "muse";
    h.doc.getElementById("welcome-onboarding")!.appendChild(button);
    click(h.window, button);
    expect(h.posted.some(m => JSON.stringify(m).includes('"muse"'))).toBe(false);
    dispatch(h.window, { type: "providerState", providers: [{ id: "muse", connected: true }] });
    click(h.window, button);
    expect(h.posted.some(m => m.type === "recheckConnection" && m.provider === "muse")).toBe(true);
    h.posted.length = 0;
    dispatch(h.window, { type: "providerState", providers: [{ id: "grok", connected: true }] });
    click(h.window, button);
    expect(h.posted.some(m => m.provider === "muse")).toBe(false);
  });

  it.each([false, true])("keeps Muse's data-use notice verbatim in the tooltip (remote=%s)", remote => {
    const h = bootWebview({ remote });
    dispatch(h.window, { type: "providerState", providers: [{ id: "grok", connected: true }, { id: "muse", connected: true }] });
    catalog(h);
    click(h.window, h.doc.getElementById("gear-btn"));
    const rows = [...h.doc.querySelectorAll(".model-picker-row")];
    expect(rows).toHaveLength(2);
    const muse = rows.find(row => row.querySelector(".model-picker-description"));
    expect(muse?.getAttribute("title")).toBe(description);
    expect(muse?.querySelector(".model-picker-description")?.textContent).toBe(description);
  });

  it("hides the inline notice except where hover tooltips do not exist", () => {
    // happy-dom does not evaluate media queries, so the rule text is the check.
    const css = readFileSync(new URL("../media/chat.css", import.meta.url), "utf8");
    const body = (selector: string) => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
    };
    expect(body(".model-picker-description")).toMatch(/display\s*:\s*none/);
    const touch = css.slice(css.indexOf("@media (hover: none) {\n  .model-picker-description"));
    expect(touch.slice(0, touch.indexOf("}"))).toMatch(/display\s*:\s*block/);
  });

  it("does not offer models when the execution host reports the provider unavailable", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "providerState", providers: [{ id: "muse", connected: false, unavailableReason: reason }] });
    catalog(h);
    click(h.window, h.doc.getElementById("gear-btn"));
    expect(h.doc.getElementById("gear-popover")?.textContent).not.toContain("Muse Contributor");
  });
});


it.each([false, true])("shows only the advertised disabled host row in Settings (remote=%s)", remote => {
  const h = bootWebview({ remote });
  const api = (h.window as any).GrokSettings;
  const root = h.doc.createElement("div"); h.doc.body.appendChild(root);
  const posted: any[] = [];
  const env = api.defaultEnv({ isRemote: remote, providersKnown: true, hostCaps: { remoteAgentSignIn: true } });
  const surface = api.mount(root, { standalone: true, category: "providers", env,
    snapshot: api.defaultSnapshot({ providers: [{ id: "grok", connected: true }] }), post: (m: any) => posted.push(m) });
  expect(root.textContent).not.toContain("Muse Code");
  surface.update(api.defaultSnapshot({ providers: [{ id: "muse", connected: false, unavailableReason: reason }] }), env);
  expect(root.textContent).toContain(reason);
  const row = root.querySelector('[data-id="providerMuse"]') || [...root.querySelectorAll('.settings-row')].find(el => el.textContent?.includes("Muse Code"));
  expect(row).toBeTruthy();
  expect([...row!.querySelectorAll('button')].every(button => button.disabled)).toBe(true);
  for (const button of row!.querySelectorAll('button')) click(h.window, button);
  expect(posted.some(m => m.provider === "muse")).toBe(false);
  surface.update(api.defaultSnapshot({ providers: [{ id: "muse", connected: false }] }), env);
  expect(root.textContent).not.toContain(reason);
  expect(root.textContent).toContain("Muse Code");
  const live = root.querySelector('[data-id="providerMuse"], [data-id="providerMuseRemote"]')!;
  expect(live.querySelectorAll("button")).toHaveLength(1);
  expect(live.querySelector<HTMLButtonElement>(".settings-action")?.disabled).toBe(false);
});
