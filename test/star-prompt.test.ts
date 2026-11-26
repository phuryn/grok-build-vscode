import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { countStarPromptConversations, mayAskForStar, STAR_PROMPT_REPEAT_MS, StarPromptRecord } from "../src/star-prompt";
import type { SessionMetaOverride, SessionMetaOverrides } from "../src/sessions";

const recent: SessionMetaOverrides = Object.fromEntries(
  [0, 1, 2, 3].map(id => [`conversation-${id}`, { sentAt: id }]),
);

it("requires five distinct conversations with sentAt and excludes routine and legacy signals", () => {
  const meta: SessionMetaOverrides = {
    ...recent,
    routine: { sentAt: 123, customName: " [Routine] Daily report" },
    old: { activeAt: 123, usageLog: [] },
    usage: { usageLog: [{ afterUserMessage: 1 }] },
    string: { sentAt: "123" } as unknown as SessionMetaOverride,
  };
  expect(countStarPromptConversations(meta)).toBe(4);
  expect(mayAskForStar("due", () => meta)).toBe(false);
  const fifth = { ...meta, fifth: { sentAt: 345, provider: "codex" as const } };
  expect(countStarPromptConversations(fifth)).toBe(5);
  expect(mayAskForStar("due", () => fifth)).toBe(true);
});

it.each(["asked", "unavailable"] as const)("skips counting when state is %s", state => {
  const readMeta = vi.fn(() => ({ ...recent, fifth: { sentAt: 123 } }));
  expect(mayAskForStar(state, readMeta)).toBe(false);
  expect(readMeta).not.toHaveBeenCalled();
});

describe("the record, on a real disk", () => {
  const make = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "star-prompt-")), "client-state");
  const read = (dir: string) => fs.readFileSync(path.join(dir, "star-prompt.json"), "utf8");
  const T = Date.UTC(2026, 10, 1);

  it("lets one window claim the first ask, and another window sees that at once", () => {
    const dir = make();
    const first = new StarPromptRecord(dir, fs);
    const second = new StarPromptRecord(dir, fs);
    expect([first.state(T), second.state(T)]).toEqual(["due", "due"]);
    expect(second.claim(T)).toBe(true);
    expect(first.state(T)).toBe("asked");
    expect(first.claim(T)).toBe(false);
    expect(JSON.parse(read(dir))).toEqual({ askedAt: T });
  });

  it("loses the first ask to a window that created the record after this one looked", () => {
    const dir = make();
    expect(new StarPromptRecord(dir, fs).claim(T)).toBe(true);
    const late = new StarPromptRecord(dir, {
      ...fs, readFileSync: () => { throw Object.assign(new Error("not yet"), { code: "ENOENT" }); },
    });
    expect(late.claim(T + 1)).toBe(false);
    expect(JSON.parse(read(dir))).toEqual({ askedAt: T });
  });

  it("is due again 30 days after an ask nobody answered with Star or Open GitHub", () => {
    const dir = make();
    const first = new StarPromptRecord(dir, fs);
    const second = new StarPromptRecord(dir, fs);
    expect(first.claim(T)).toBe(true);
    expect(second.state(T + STAR_PROMPT_REPEAT_MS - 1)).toBe("asked");
    expect(second.claim(T + STAR_PROMPT_REPEAT_MS - 1)).toBe(false);
    expect(second.state(T + STAR_PROMPT_REPEAT_MS)).toBe("due");
    expect(second.claim(T + STAR_PROMPT_REPEAT_MS)).toBe(true);
    expect(JSON.parse(read(dir))).toEqual({ askedAt: T + STAR_PROMPT_REPEAT_MS });
    expect(first.state(T + STAR_PROMPT_REPEAT_MS)).toBe("asked");
    expect(first.claim(T + STAR_PROMPT_REPEAT_MS)).toBe(false);
    expect(first.state(T + 2 * STAR_PROMPT_REPEAT_MS)).toBe("due");
  });

  it("is never due again after Star or Open GitHub", () => {
    const dir = make();
    const record = new StarPromptRecord(dir, fs);
    expect(record.claim(T)).toBe(true);
    record.finish(T);
    expect(JSON.parse(read(dir))).toEqual({ askedAt: T, done: true });
    expect(record.state(T + 100 * STAR_PROMPT_REPEAT_MS)).toBe("asked");
    expect(record.claim(T + 100 * STAR_PROMPT_REPEAT_MS)).toBe(false);
  });

  it.each(["[]", '"asked"', "null", "{}", '{"askedAt":"1"}', '{"askedAt":1,"done":false}', "not json"])(
    "never asks when the record reads %s, and leaves it as it is", text => {
      const dir = make();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "star-prompt.json"), text);
      const record = new StarPromptRecord(dir, fs);
      expect(record.state(T + 100 * STAR_PROMPT_REPEAT_MS)).toBe("unavailable");
      expect(record.claim(T + 100 * STAR_PROMPT_REPEAT_MS)).toBe(false);
      expect(read(dir)).toBe(text);
    });

  it("never asks when the record cannot be read or written", () => {
    const dir = make();
    fs.mkdirSync(dir, { recursive: true });
    const blocked = path.join(dir, "file");
    fs.writeFileSync(blocked, "");
    expect(new StarPromptRecord(blocked, fs).claim(T)).toBe(false);
    const denied = new StarPromptRecord(dir, {
      ...fs, readFileSync: () => { throw Object.assign(new Error("access denied"), { code: "EACCES" }); },
    });
    expect(denied.state(T)).toBe("unavailable");
    expect(denied.claim(T)).toBe(false);
  });
});
