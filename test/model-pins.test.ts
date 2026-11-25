import { describe, expect, it } from "vitest";
import { orderedModelPins, parseModelPins, toggleModelPin } from "../src/model-pins";

describe("model pin records", () => {
  it("keeps only well-formed records whose keys match their provider and model", () => {
    const good = { provider: "deepseek", modelId: "model:latest", pinnedAt: 1 };
    expect(parseModelPins({
      "deepseek:model:latest": { ...good, extra: true },
      "grok:wrong": good,
      "future:model": { provider: "future", modelId: "model", pinnedAt: 1 },
      "grok:": { provider: "grok", modelId: "", pinnedAt: 1 },
      "grok:bad": { provider: "grok", modelId: "bad", pinnedAt: "1" },
      "grok:infinity": { provider: "grok", modelId: "infinity", pinnedAt: Infinity },
      "codex:nil": null,
    })).toEqual({ "deepseek:model:latest": good });
    for (const bad of [undefined, null, [good], 3]) expect(parseModelPins(bad)).toEqual({});
  });

  it("orders by pin time, preserves existing ties, and appends despite clock rollback", () => {
    const pins = parseModelPins({
      "grok:z": { provider: "grok", modelId: "z", pinnedAt: 100 },
      "codex:a": { provider: "codex", modelId: "a", pinnedAt: 100 },
      "claude:m": { provider: "claude", modelId: "m", pinnedAt: 90 },
    });
    const next = toggleModelPin(pins, "grok", "a", true, 80);
    const last = toggleModelPin(next, "grok", "b", true, 101);
    expect(orderedModelPins(last).map(({ modelId, pinnedAt }) => [modelId, pinnedAt]))
      .toEqual([["m", 90], ["z", 100], ["a", 100], ["a", 101], ["b", 102]]);
    expect(Object.keys(pins)).toHaveLength(3);
  });

  it("keeps repeat requests idempotent and appends a pin added back after removal", () => {
    const first = toggleModelPin({}, "codex", "a", true, 3);
    const both = toggleModelPin(first, "codex", "b", true, 3);
    expect(toggleModelPin(both, "codex", "a", true, 10)).toBe(both);
    expect(toggleModelPin(both, "claude", "a", false, 10)).toBe(both);
    const removed = toggleModelPin(both, "codex", "a", false, 10);
    const restored = toggleModelPin(removed, "codex", "a", true, 10);
    expect(orderedModelPins(restored).map((pin) => pin.modelId)).toEqual(["b", "a"]);
  });

  it("can append to a store whose last timestamp reached the maximum safe integer", () => {
    const pins = toggleModelPin({}, "codex", "a", true, Number.MAX_SAFE_INTEGER);
    const next = toggleModelPin(pins, "codex", "b", true, 3);
    expect(orderedModelPins(parseModelPins(next)).map((pin) => pin.modelId)).toEqual(["a", "b"]);
  });
});
