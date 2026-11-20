import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch } from "./webview-harness";

// Relative to now, deliberately. The note says "Resets" for a period still
// running and "Reported reset" for one already past, so fixed dates make the
// wording flip the day the clock passes them — which is exactly how the
// two-lines-of-one-note test below started failing on a diff that never touched
// it. A window that is always mid-flight keeps these tests about structure.
const day = 86_400_000;
const windowUsage = {
  usedPercent: 3, label: "Weekly", periodType: "USAGE_PERIOD_TYPE_WEEKLY",
  periodStart: new Date(Date.now() - 5 * day).toISOString(),
  periodEnd: new Date(Date.now() + 2 * day).toISOString(),
  observedAt: new Date(Date.now() - day).toISOString(),
};
const open = (h: ReturnType<typeof bootWebview>) => {
  click(h.window, h.doc.getElementById("donut")!);
  return h.doc.getElementById("context-popover")!;
};
/**
 * What a host that KNOWS this frame does at session start, empty or not:
 * `startSession` binds the account and publishes straight away. The section is
 * gated on that frame having arrived, so a test that skips it is testing an old
 * host without meaning to.
 */
const started = (h: ReturnType<typeof bootWebview>, provider: string) => {
  dispatch(h.window, { type: "session", provider, models: [], currentModelId: "model" } as any);
  dispatch(h.window, { type: "subscriptionUsage", windows: [] } as any);
};

describe("subscription usage in the context popover", () => {
  it("uses the existing meter only when a frame that opts out of the empty state has data", () => {
    const h = bootWebview({ remote: true });
    started(h, "agy");
    dispatch(h.window, { type: "subscriptionUsage", windows: [], hideWhenEmpty: true } as any);
    const pop = open(h);
    expect(pop.querySelector(".subscription-usage")).toBeNull();
    dispatch(h.window, { type: "subscriptionUsage", windows: [{ ...windowUsage, label: "Gemini · Weekly" }], hideWhenEmpty: true } as any);
    expect(pop.querySelector(".subscription-usage")?.textContent).toContain("Gemini · Weekly");
    dispatch(h.window, { type: "subscriptionUsage", windows: [], hideWhenEmpty: true } as any);
    expect(pop.querySelector(".subscription-usage")).toBeNull();
    started(h, "claude");
    expect(pop.querySelector(".subscription-usage")?.textContent).toContain("Fills in after the next reply.");
  });

  /**
   * The phone's client is always as new as the relay deploy while the host is
   * whatever the person installed, so this section meets hosts that have never
   * heard of `subscriptionUsage`. Those drop `refreshSubscriptionUsage` in
   * silence, and an ungated section then promised a Claude user numbers after a
   * reply that could not produce them (review, 2026-09-14).
   */
  it("says nothing at all on a host that has never sent the frame", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "session", provider: "claude", models: [], currentModelId: "model" } as any);
    const pop = open(h);
    expect(pop.hidden).toBe(false);
    expect(pop.querySelector(".subscription-usage")).toBeNull();
    expect(pop.textContent).not.toContain("Subscription usage");
    expect(pop.textContent).not.toContain("next reply");
    // The rest of the popover is this host's own accounting and still paints.
    expect(pop.querySelector('.context-fullness[aria-label="Context used"]')).not.toBeNull();
  });

  // A host that knows the frame sends it even with nothing observed, so the
  // deliberate empty states are not collateral of the gate above.
  it("appears as soon as that frame arrives, empty windows included", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "session", provider: "claude", models: [], currentModelId: "model" } as any);
    expect(open(h).querySelector(".subscription-usage")).toBeNull();
    dispatch(h.window, { type: "subscriptionUsage", windows: [] } as any);
    expect(h.doc.getElementById("context-popover")!.querySelector(".subscription-usage")!.textContent)
      .toContain("Fills in after the next reply.");
  });

  // The host's capability does not change under a running client, and a new
  // conversation clears the windows rather than the knowledge of the frame.
  it("does not un-learn the frame when a new conversation starts", () => {
    const h = bootWebview();
    started(h, "claude");
    expect(open(h).querySelector(".subscription-usage")).not.toBeNull();
    dispatch(h.window, { type: "session", provider: "claude", models: [], currentModelId: "model" } as any);
    expect(h.doc.getElementById("context-popover")!.querySelector(".subscription-usage")).not.toBeNull();
  });

  it.each(["grok", "claude", "codex"] as const)("%s with no data has a visible, deliberate empty state without a subscription meter", (provider) => {
    const h = bootWebview();
    started(h, provider);
    const pop = open(h);
    expect(pop.hidden).toBe(false);
    expect(pop.querySelector(".subscription-usage")?.textContent).toMatch(/No subscription usage reported yet\.|Fills in after the next reply\./);
    expect(pop.querySelector(".subscription-fullness")).toBeNull();
    expect(pop.querySelector('.context-fullness[aria-label="Context used"]')).not.toBeNull();
  });

  // Grok pulls its window and Codex reads one off disk, so an empty panel there
  // really does mean "nothing yet". Claude's only source is the rate-limit event
  // that rides a reply, so the same words would describe a working panel as a
  // broken one on the surface where waiting is the whole answer.
  it("tells a Claude user the number arrives with the next reply", () => {
    const h = bootWebview();
    started(h, "claude");
    expect(open(h).querySelector(".subscription-usage")!.textContent)
      .toContain("Fills in after the next reply.");
  });

  it.each(["grok", "codex"] as const)("does not promise %s a reply that is not what fills it", (provider) => {
    const h = bootWebview();
    started(h, provider);
    const text = open(h).querySelector(".subscription-usage")!.textContent!;
    expect(text).toContain("No subscription usage reported yet.");
    expect(text).not.toContain("next reply");
  });

  it.each(["knowledge", "coding"] as const)("shows a list of labelled windows alongside context in %s mode", (appPurpose) => {
    const h = bootWebview();
    dispatch(h.window, { type: "initialState", appPurpose, capabilities: {} } as any);
    dispatch(h.window, { type: "contextUsage", used: 25, window: 100 });
    const iconTitle = h.doc.getElementById("donut")!.title;
    dispatch(h.window, { type: "subscriptionUsage", windows: [windowUsage,
      { ...windowUsage, label: "5-hour", periodType: "five_hour", usedPercent: 80 }] });
    const pop = open(h);
    const section = pop.querySelector(".subscription-usage")!;
    expect(section.textContent).toContain("Subscription usage · account");
    expect(section.textContent).toContain("3% used · 97% left");
    expect(section.textContent).toContain("80% used · 20% left");
    expect(section.textContent).toContain("Observed");
    expect(section.textContent).toMatch(/Resets|Reported reset/);
    expect(section.querySelectorAll('[role="meter"]')).toHaveLength(2);
    expect(pop.querySelector(".context-fullness")!.getAttribute("aria-valuenow")).toBe("25");
    expect(h.doc.getElementById("donut")!.title).toBe(iconTitle);
  });

  // The phone hides the popover's billing explanation, and it can only address
  // it as `#context-popover > .popover-fineprint` — the class alone also covers
  // the window's own notes, which is how "Resets …" vanished on the surface
  // where it matters most. That selector is correct only while these notes stay
  // NESTED. The relay half is grok-remote's test/web-context-popover-phone.
  it("keeps the window's own notes out of the popover's direct children", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "subscriptionUsage", windows: [windowUsage] });
    const pop = open(h);
    const nested = [...pop.querySelectorAll(".subscription-usage .popover-fineprint")];
    expect(nested.map((el) => el.textContent).join(" ")).toMatch(/Resets|Reported reset/);
    expect(nested.map((el) => el.textContent).join(" ")).toContain("Observed");
    for (const note of nested) expect(note.parentElement).not.toBe(pop);
  });

  // Two notes cost two paragraph gaps for one thought, and on a phone that put
  // "Observed" a meter's height below the figure it qualifies.
  it("puts the reset and the observation on two lines of one note", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "subscriptionUsage", windows: [windowUsage] });
    const notes = [...open(h).querySelectorAll(".subscription-usage .popover-fineprint")];
    expect(notes).toHaveLength(1);
    expect(notes[0].querySelectorAll("br")).toHaveLength(1);
    expect(notes[0].textContent).toMatch(/^Resets .+Observed .+$/);
  });

  it.each([undefined, [], [{}], [{ ...windowUsage, usedPercent: null }],
    [{ ...windowUsage, usedPercent: "0" }], [{ ...windowUsage, usedPercent: NaN }],
    [{ ...windowUsage, periodEnd: "bad" }]])("malformed/missing windows render nothing rather than zero: %j", (windows) => {
    const h = bootWebview();
    dispatch(h.window, { type: "subscriptionUsage", windows } as any);
    const section = open(h).querySelector(".subscription-usage")!;
    expect(section.querySelector('[role="meter"]')).toBeNull();
    expect(section.textContent).toContain("No subscription usage reported yet.");
    expect(section.textContent).not.toContain("0%");
  });

  it("accepts a measured zero and clears it on an account snapshot or session switch", () => {
    const h = bootWebview();
    const pop = open(h);
    dispatch(h.window, { type: "subscriptionUsage", windows: [{ ...windowUsage, usedPercent: 0 }] });
    expect(pop.querySelector(".subscription-fullness")!.getAttribute("aria-valuenow")).toBe("0");
    dispatch(h.window, { type: "subscriptionUsage", windows: [] });
    expect(pop.querySelector(".subscription-fullness")).toBeNull();
    dispatch(h.window, { type: "subscriptionUsage", windows: [windowUsage] });
    dispatch(h.window, { type: "session", provider: "claude", models: [], currentModelId: "model" } as any);
    expect(pop.querySelector(".subscription-fullness")).toBeNull();
    dispatch(h.window, { type: "subscriptionUsage", windows: [windowUsage] });
    dispatch(h.window, { type: "clearMessages" });
    // Clearing a session must not retain a previous account's meter.
    if (pop.hidden) open(h);
    expect(pop.querySelector(".subscription-fullness")).toBeNull();
  });

  it("Claude shows only its latest labelled window and never fabricates reset dates", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "session", provider: "claude", models: [], currentModelId: "model" } as any);
    const pop = open(h);
    dispatch(h.window, { type: "subscriptionUsage", windows: [windowUsage] });
    dispatch(h.window, { type: "subscriptionUsage", windows: [{
      usedPercent: 42, label: "Weekly · Sonnet", periodType: "seven_day_sonnet", observedAt: windowUsage.observedAt,
    }] });
    expect(pop.querySelectorAll(".subscription-fullness")).toHaveLength(1);
    expect(pop.textContent).toContain("Weekly · Sonnet");
    expect(pop.textContent).toContain("Reset time not reported.");
    expect(pop.textContent).toContain("Latest reported window; other limits may apply.");
  });

  it("requests a refresh only on actual open, never on an incoming usage redraw", () => {
    const h = bootWebview();
    open(h);
    const requests = () => h.posted.filter((m: any) => m.type === "refreshSubscriptionUsage");
    expect(requests()).toHaveLength(1);
    for (let i = 0; i < 5; i++) {
      dispatch(h.window, { type: "subscriptionUsage", windows: [windowUsage] });
      dispatch(h.window, { type: "usage", session: { inputTokens: i + 1 } });
      dispatch(h.window, { type: "contextUsage", used: 25, window: 100 });
    }
    expect(requests()).toHaveLength(1);
    click(h.window, h.doc.getElementById("donut")!); // close
    open(h);
    expect(requests()).toHaveLength(2);
    expect(h.posted.some((m: any) => m.type === "send")).toBe(false);
  });
});
