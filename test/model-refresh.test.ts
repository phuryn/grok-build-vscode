import { describe, expect, it } from "vitest";
import { MODEL_LIST_MAX_AGE_MS, modelListIsStale, modelRefreshAttempts, sameModelList } from "../src/model-refresh";

const NOW = 1_800_000_000_000;
const DAY = MODEL_LIST_MAX_AGE_MS;

describe("when a model list is read again", () => {
  it("a list read within the day is kept, an older or missing one is not", () => {
    expect(modelListIsStale(NOW - DAY + 1, undefined, NOW)).toBe(false);
    expect(modelListIsStale(NOW - DAY, undefined, NOW)).toBe(true);
    expect(modelListIsStale(undefined, undefined, NOW)).toBe(true);
  });

  it("an agent that did not answer is left alone for a day", () => {
    expect(modelListIsStale(NOW - 30 * DAY, NOW - 60_000, NOW)).toBe(false);
    expect(modelListIsStale(undefined, NOW - DAY, NOW)).toBe(true);
  });

  it("a stamp from the future or of the wrong type says nothing", () => {
    expect(modelListIsStale(NOW + 1, NOW + DAY, NOW)).toBe(true);
    expect(modelListIsStale("today", null, NOW)).toBe(true);
    expect(modelListIsStale(Number.NaN, Number.NaN, NOW)).toBe(true);
  });

  it("a stored attempts value of any shape is safe to read", () => {
    for (const stored of [undefined, null, "x", 3, ["grok"]]) expect(modelRefreshAttempts(stored)).toEqual({});
    const stored = { grok: NOW };
    expect(modelRefreshAttempts(stored)).toEqual(stored);
    expect(modelRefreshAttempts(stored)).not.toBe(stored);
  });
});

describe("whether the picker would show anything new", () => {
  const sol = { modelId: "gpt-6.2-sol", name: "GPT-6.2 Sol", reasoningEfforts: ["low", "high"], supportsReasoningEffort: true };
  const luna = { modelId: "gpt-6.2-luna", name: "GPT-6.2 Luna" };

  it("ignores the effort a model is set to, absent fields and field order", () => {
    expect(sameModelList(
      [{ ...sol, reasoningEffort: "low", description: undefined }, luna],
      [{ supportsReasoningEffort: true, reasoningEfforts: ["low", "high"], name: "GPT-6.2 Sol", modelId: "gpt-6.2-sol", reasoningEffort: "high" }, luna],
    )).toBe(true);
    expect(sameModelList(undefined, [])).toBe(true);
  });

  it("sees a model added, removed, renamed or moved, and a changed effort ladder", () => {
    expect(sameModelList([luna], [sol, luna])).toBe(false);
    expect(sameModelList([sol, luna], [luna])).toBe(false);
    expect(sameModelList([luna], [{ ...luna, name: "Luna" }])).toBe(false);
    expect(sameModelList([sol, luna], [luna, sol])).toBe(false);
    expect(sameModelList([sol], [{ ...sol, reasoningEfforts: ["low", "high", "xhigh"] }])).toBe(false);
  });
});
