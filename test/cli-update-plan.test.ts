import { describe, expect, it } from "vitest";
import { cliUpdatePlan, npmPrefixForBinary } from "../src/cli-update-plan";

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
