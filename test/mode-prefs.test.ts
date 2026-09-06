import { describe, it, expect } from "vitest";
import { modeToRemember, startsInYolo, rememberedEffort, withRememberedEffort } from "../src/mode-prefs";

describe("remembered mode preference (#25)", () => {
  it("remembers a switch to Agent or Auto accept, but never Plan", () => {
    expect(modeToRemember("agent")).toBe("agent");
    expect(modeToRemember("yolo")).toBe("yolo");
    // Plan is a transient per-task choice — leave the remembered preference alone.
    expect(modeToRemember("plan")).toBeNull();
  });

  it("starts a NEW session in Auto accept only when that's the remembered mode", () => {
    expect(startsInYolo("yolo", false)).toBe(true);
    expect(startsInYolo("agent", false)).toBe(false);
    expect(startsInYolo("", false)).toBe(false); // unset = Agent
    expect(startsInYolo(undefined, false)).toBe(false);
  });

  it("never pre-applies the remembered mode on a resume (those are verdict-driven)", () => {
    expect(startsInYolo("yolo", true)).toBe(false);
    expect(startsInYolo("agent", true)).toBe(false);
  });
});

describe("rememberedEffort", () => {
  it("gives each agent its own remembered level", () => {
    const prefs = { grok: "xhigh", claude: "low" };
    expect(rememberedEffort(prefs, "grok", "")).toBe("xhigh");
    expect(rememberedEffort(prefs, "claude", "")).toBe("low");
  });

  it("never lends grok's legacy setting to another agent", () => {
    // grok.defaultEffort is grok's --reasoning-effort flag. Handing it to Claude
    // set how hard every Claude turn thought, invisibly and per turn.
    expect(rememberedEffort({}, "grok", "high")).toBe("high");
    expect(rememberedEffort({}, "claude", "high")).toBe("");
    expect(rememberedEffort(undefined, "gemini", "high")).toBe("");
  });

  it("prefers the agent's own entry over the legacy value", () => {
    expect(rememberedEffort({ grok: "low" }, "grok", "high")).toBe("low");
  });
});

describe("withRememberedEffort", () => {
  it("records a choice for one agent without touching the others", () => {
    expect(withRememberedEffort({ grok: "high" }, "claude", "low"))
      .toEqual({ grok: "high", claude: "low" });
  });

  it("treats going back to the model default as an absence", () => {
    expect(withRememberedEffort({ grok: "high", claude: "low" }, "claude", ""))
      .toEqual({ grok: "high" });
  });

  it("does not mutate the map it was given", () => {
    const prefs = { grok: "high" };
    withRememberedEffort(prefs, "codex", "medium");
    expect(prefs).toEqual({ grok: "high" });
  });
});
