import { describe, it, expect } from "vitest";
import {
  applySlashPick,
  filterAdvertisedCommands,
  filterCommands,
  getSlashQuery,
  HIDDEN_SLASH_COMMANDS,
  isAdvertisedSkill,
  matchSlashCommand,
} from "../src/slash-filter";

describe("getSlashQuery", () => {
  it("returns null when there is no slash token", () => {
    expect(getSlashQuery("hello", 5)).toBeNull();
    expect(getSlashQuery("foo/bar", 7)).toBeNull();
  });

  it("returns a start query when slash is at position 0", () => {
    expect(getSlashQuery("/com", 4)).toEqual({ query: "com", atStart: true });
  });

  it("returns a mid-prompt query after whitespace — skills load there", () => {
    expect(getSlashQuery("hello /not", 10)).toEqual({ query: "not", atStart: false });
    expect(getSlashQuery("hi\n/pla", 7)).toEqual({ query: "pla", atStart: false });
  });

  it("ignores text after the caret", () => {
    expect(getSlashQuery("/co  more", 3)).toEqual({ query: "co", atStart: true });
  });

  it("returns empty string for bare `/`", () => {
    expect(getSlashQuery("/", 1)).toEqual({ query: "", atStart: true });
  });
});

describe("isAdvertisedSkill", () => {
  it("is true only when _meta has both path and scope strings", () => {
    expect(isAdvertisedSkill({
      name: "frontend-design:frontend-design",
      _meta: { scope: "plugin", path: "/skills/frontend-design/SKILL.md" },
    })).toBe(true);
    expect(isAdvertisedSkill({
      name: "commit",
      meta: { scope: "user", path: "/home/u/.grok/skills/commit/SKILL.md" },
    })).toBe(true);
  });

  it("treats builtins and malformed meta as commands", () => {
    expect(isAdvertisedSkill({ name: "compact" })).toBe(false);
    expect(isAdvertisedSkill({ name: "imagine", _meta: { commandAction: "review" } })).toBe(false);
    expect(isAdvertisedSkill({ name: "broken", _meta: { scope: "local" } })).toBe(false);
    expect(isAdvertisedSkill({ name: "broken", _meta: { path: "/x/SKILL.md" } })).toBe(false);
    expect(isAdvertisedSkill({ name: "broken", _meta: { scope: "", path: "/x/SKILL.md" } })).toBe(false);
  });
});

describe("filterCommands", () => {
  const cmds = [
    { name: "compact", description: "Compress conversation" },
    { name: "clear", description: "" },
    { name: "context", description: "Show context" },
    { name: "yolo", description: "Toggle auto-approve" },
  ];

  it("empty query returns all", () => {
    expect(filterCommands(cmds, "")).toEqual(cmds);
  });

  it("filters by prefix", () => {
    expect(filterCommands(cmds, "co").map((c) => c.name)).toEqual([
      "compact",
      "context",
    ]);
  });

  it("matches a mid-name substring (#110)", () => {
    const skills = [
      { name: "ux-ui-promax" },
      { name: "web-design" },
      { name: "compact" },
    ];
    expect(filterCommands(skills, "ui").map((c) => c.name)).toEqual(["ux-ui-promax"]);
    expect(filterCommands(skills, "design").map((c) => c.name)).toEqual(["web-design"]);
  });

  it("ranks prefix matches above substring matches, stably within each tier", () => {
    const skills = [
      { name: "ux-ui-promax" },
      { name: "ui-kit" },
      { name: "fluid" },
      { name: "uid" },
    ];
    expect(filterCommands(skills, "ui").map((c) => c.name)).toEqual([
      "ui-kit",
      "uid",
      "ux-ui-promax",
      "fluid",
    ]);
  });

  it("is case-insensitive", () => {
    expect(filterCommands(cmds, "CO").map((c) => c.name)).toEqual([
      "compact",
      "context",
    ]);
    expect(filterCommands([{ name: "ux-ui-promax" }], "UI").map((c) => c.name)).toEqual([
      "ux-ui-promax",
    ]);
  });

  it("returns empty when no matches", () => {
    expect(filterCommands(cmds, "zzz")).toEqual([]);
  });

  it("includes a description-only match after every name match", () => {
    const skills = [
      { name: "web-design", description: "layout kit" },
      { name: "compact", description: "Compress conversation" },
      { name: "context", description: "Show tokens" },
    ];
    expect(filterCommands(skills, "compress").map((c) => c.name)).toEqual(["compact"]);
    expect(filterCommands(skills, "kit").map((c) => c.name)).toEqual(["web-design"]);
  });

  it("ranks name matches above description-only matches", () => {
    const skills = [
      { name: "web-design", description: "UI components" },
      { name: "ui-kit", description: "buttons" },
      { name: "fluid", description: "contains ui" },
      { name: "notes", description: "quick ui tips" },
    ];
    expect(filterCommands(skills, "ui").map((c) => c.name)).toEqual([
      "ui-kit",
      "fluid",
      "web-design",
      "notes",
    ]);
  });

  it("keeps advertised order inside the description-only tier", () => {
    const skills = [
      { name: "alpha", description: "handles widgets" },
      { name: "beta", description: "other" },
      { name: "gamma", description: "more widgets" },
    ];
    expect(filterCommands(skills, "widgets").map((c) => c.name)).toEqual(["alpha", "gamma"]);
  });

  it("does not double-count a name hit that also matches the description", () => {
    const skills = [
      { name: "compact", description: "compact the conversation" },
      { name: "notes", description: "compact leftovers" },
    ];
    expect(filterCommands(skills, "compact").map((c) => c.name)).toEqual(["compact", "notes"]);
  });
});

describe("applySlashPick", () => {
  it("replaces the partial /q with /name and trailing space", () => {
    const r = applySlashPick("/com", 4, "compact");
    expect(r.text).toBe("/compact ");
    expect(r.caret).toBe(9);
  });

  it("preserves text after caret", () => {
    const r = applySlashPick("/co rest", 3, "compact");
    expect(r.text).toBe("/compact  rest");
    expect(r.caret).toBe(9);
  });

  // #110. Skills load anywhere in the prompt (owner-measured: a mid-line
  // `/frontend-design:frontend-design` is expanded; `/compact` and `/effort`
  // in the same message are not). The completer must therefore rewrite a
  // `/token` after whitespace. Commands are still only *offered* at
  // position 0 (`getSlashQuery.atStart`); matchSlashCommand stays `^`.
  it("completes a skill at the start of a later line", () => {
    const r = applySlashPick("hi\n/front", 9, "frontend-design:frontend-design");
    expect(r.text).toBe("hi\n/frontend-design:frontend-design ");
    expect(r.caret).toBe(r.text.length);
  });

  it("completes a skill mid-line after whitespace", () => {
    const r = applySlashPick("use /front", 10, "frontend-design:frontend-design");
    expect(r.text).toBe("use /frontend-design:frontend-design ");
    expect(r.caret).toBe(r.text.length);
  });

  it("does not rewrite a slash inside a path", () => {
    const r = applySlashPick("edit foo/bar", 12, "compact");
    expect(r.text).toBe("edit foo/bar");
    expect(r.caret).toBe(12);
  });
});

describe("filterAdvertisedCommands", () => {
  it("drops /always-approve (#31) and /context (#39) from the advertised list", () => {
    const cmds = [
      { name: "compact", description: "Compress conversation" },
      { name: "always-approve", description: "Auto-approve everything" },
      { name: "context", description: "Show context" },
      { name: "session-info", description: "Show session info" },
    ];
    expect(filterAdvertisedCommands(cmds).map((c) => c.name)).toEqual(["compact", "session-info"]);
  });

  it("keeps /context for Claude, whose adapter answers it in the chat, and still drops /always-approve", () => {
    const cmds = [{ name: "compact" }, { name: "always-approve" }, { name: "context" }];
    expect(filterAdvertisedCommands(cmds, "claude").map((c) => c.name)).toEqual(["compact", "context"]);
    for (const provider of ["grok", "codex", "muse", undefined]) {
      expect(filterAdvertisedCommands(cmds, provider).map((c) => c.name)).toEqual(["compact"]);
    }
    expect(matchSlashCommand("/context", filterAdvertisedCommands(cmds, "claude").map((c) => c.name))).toBe("context");
  });

  it("leaves a list without hidden commands untouched", () => {
    const cmds = [{ name: "compact" }, { name: "session-info" }];
    expect(filterAdvertisedCommands(cmds)).toEqual(cmds);
  });

  it("HIDDEN_SLASH_COMMANDS contains always-approve and context", () => {
    expect(HIDDEN_SLASH_COMMANDS.has("always-approve")).toBe(true);
    expect(HIDDEN_SLASH_COMMANDS.has("context")).toBe(true);
  });

  it("keeps the resulting list out of the dispatch gate too", () => {
    const cmds = [{ name: "compact" }, { name: "always-approve" }];
    const names = filterAdvertisedCommands(cmds).map((c) => c.name);
    // Filtered out → matchSlashCommand won't recognize it as a command.
    expect(matchSlashCommand("/always-approve", names)).toBeNull();
    expect(matchSlashCommand("/compact", names)).toBe("compact");
  });
});

describe("matchSlashCommand", () => {
  const commands = ["compact", "context", "imagine-video", "user:code-review"];

  it("matches an advertised command at position 0, with or without args", () => {
    expect(matchSlashCommand("/compact", commands)).toBe("compact");
    expect(matchSlashCommand("/compact focus on the tests", commands)).toBe("compact");
    expect(matchSlashCommand("/imagine-video a red cube", commands)).toBe("imagine-video");
    expect(matchSlashCommand("/user:code-review src/a.ts", commands)).toBe("user:code-review");
  });

  it("matches a multi-line prompt whose first line is the command", () => {
    expect(matchSlashCommand("/compact\n\nkeep the recent work", commands)).toBe("compact");
  });

  it("rejects prose that merely starts with a slash", () => {
    // Unix paths have no token boundary: `tmp` is followed by `/`, not whitespace.
    expect(matchSlashCommand("/tmp/foo is broken", commands)).toBeNull();
    expect(matchSlashCommand("/tmp/foo", ["tmp"])).toBeNull();
    expect(matchSlashCommand("please /compact", commands)).toBeNull();
    expect(matchSlashCommand("/", commands)).toBeNull();
    expect(matchSlashCommand("/ compact", commands)).toBeNull();
  });

  it("rejects unknown commands once the CLI has advertised its list", () => {
    expect(matchSlashCommand("/notacommand do it", commands)).toBeNull();
    expect(matchSlashCommand("/compact-ish", commands)).toBeNull();
  });

  it("falls back to shape alone before available_commands arrives", () => {
    expect(matchSlashCommand("/compact", [])).toBe("compact");
    expect(matchSlashCommand("/tmp/foo is broken", [])).toBeNull();
  });
});
