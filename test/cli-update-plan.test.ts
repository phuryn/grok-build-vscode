import { describe, expect, it } from "vitest";
import { cliUpdatePlan, npmPrefixForBinary, selfUpdateArgs } from "../src/cli-update-plan";

describe("npmPrefixForBinary", () => {
  it("reads back the prefix a POSIX npm install used", () => {
    // The exact shape measured on a cloud machine, where `npm config get
    // prefix` disagrees and reports a root-owned nvm directory instead.
    expect(npmPrefixForBinary("/home/sprite/.local/lib/node_modules/@openai/codex/bin/codex.js"))
      .toBe("/home/sprite/.local");
  });

  it("handles a system prefix and a Windows prefix", () => {
    expect(npmPrefixForBinary("/usr/local/lib/node_modules/@openai/codex/bin/codex.js"))
      .toBe("/usr/local");
    expect(npmPrefixForBinary("C:\\Users\\d\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js"))
      .toBe("C:\\Users\\d\\AppData\\Roaming\\npm");
  });

  it("declines anything that is not an npm layout", () => {
    expect(npmPrefixForBinary("/opt/homebrew/bin/codex")).toBeUndefined();
    expect(npmPrefixForBinary("C:\\tools\\codex.cmd")).toBeUndefined();
    expect(npmPrefixForBinary("/node_modules/@openai/codex/bin/codex.js")).toBeUndefined();
  });
});

describe("cliUpdatePlan", () => {
  it("sends our own install to our own installer", () => {
    expect(cliUpdatePlan({ managed: true, realPath: "/x/codex-managed/rust-v1/bin/codex", packageName: "@openai/codex" }))
      .toEqual({ kind: "managed" });
  });

  it("corrects the prefix for an npm install", () => {
    expect(cliUpdatePlan({
      managed: false,
      realPath: "/home/sprite/.local/lib/node_modules/@openai/codex/bin/codex.js",
      packageName: "@openai/codex",
    })).toEqual({ kind: "npm", prefix: "/home/sprite/.local", packageSpec: "@openai/codex@latest" });
  });

  it("leaves every other shape to the CLI's own updater", () => {
    // Claude on a cloud machine is a native install, not npm — it must keep
    // using `claude update`, which works there.
    expect(cliUpdatePlan({
      managed: false,
      realPath: "/home/sprite/.local/share/claude/versions/2.1.251",
      packageName: "@anthropic-ai/claude-code",
    })).toEqual({ kind: "self" });
  });
});

describe("carrying an exact version", () => {
  it("names the pinned version in the npm spec rather than latest", () => {
    expect(cliUpdatePlan({
      managed: false,
      realPath: "/home/x/.local/lib/node_modules/@openai/codex/bin/codex.js",
      packageName: "@openai/codex",
      targetVersion: "0.153.4",
    })).toEqual({ kind: "npm", prefix: "/home/x/.local", packageSpec: "@openai/codex@0.153.4" });
  });

  it("still falls back to latest where nothing pins a version", () => {
    expect(cliUpdatePlan({
      managed: false,
      realPath: "/home/x/.local/lib/node_modules/@openai/codex/bin/codex.js",
      packageName: "@openai/codex",
    })).toMatchObject({ packageSpec: "@openai/codex@latest" });
  });

  it("hands the target to the CLI's own updater instead of dropping it", () => {
    // `{ kind: "self" }` used to carry nothing, so a self-updating CLI was
    // asked for "newest" however exactly the caller had named a version.
    expect(cliUpdatePlan({ managed: false, realPath: "/usr/local/bin/claude", targetVersion: "2.1.263" }))
      .toEqual({ kind: "self", target: "2.1.263" });
    expect(cliUpdatePlan({ managed: false, realPath: "/usr/local/bin/claude" }))
      .toEqual({ kind: "self" });
  });

  it("spells the version the way each CLI takes it", () => {
    // Measured on a real machine: `claude update` has no version flag at all,
    // and grok wants it after `--version`. Guessing either is how a working
    // plain update becomes a failing one.
    expect(selfUpdateArgs("claude", "2.1.263")).toEqual(["install", "2.1.263"]);
    expect(selfUpdateArgs("grok", "1.0.25")).toEqual(["update", "--version", "1.0.25"]);
    // Codex has no measured version-capable spelling of its own updater.
    expect(selfUpdateArgs("codex", "0.153.4")).toEqual(["update"]);
    for (const p of ["codex", "claude", "grok"] as const) {
      expect(selfUpdateArgs(p)).toEqual(["update"]);
    }
  });
});
