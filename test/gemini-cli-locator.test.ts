import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  hasAntigravityCredentials,
  isAntigravityCli,
  locateGeminiCli,
  parseAgyVersionOutput,
  parseGeminiVersionOutput,
  type GeminiLocatorFs,
} from "../src/gemini-cli-locator";

function fakeFs(files: string[]): GeminiLocatorFs {
  const set = new Set(files);
  return {
    exists: (value) => set.has(value),
    isFile: (value) => set.has(value),
  };
}

describe("locateGeminiCli", () => {
  it("uses a valid configured path before PATH or well-known locations", () => {
    const configured = "C:\\custom\\gemini.exe";
    const result = locateGeminiCli({
      configuredPath: configured,
      platform: "win32",
      fs: fakeFs([configured]),
      which: () => "C:\\path\\gemini.cmd",
    });
    expect(result).toBe(configured);
  });

  it("returns undefined for an invalid configured path without falling through", () => {
    const result = locateGeminiCli({
      configuredPath: "C:\\nonexistent\\gemini.exe",
      platform: "win32",
      fs: fakeFs([]),
      which: () => "C:\\path\\gemini.cmd",
    });
    expect(result).toBeUndefined();
  });

  it("prefers agy on PATH over legacy gemini on PATH", () => {
    const agyPath = "C:\\tools\\agy.exe";
    const geminiPath = "C:\\tools\\gemini.exe";
    const result = locateGeminiCli({
      platform: "win32",
      fs: fakeFs([agyPath, geminiPath]),
      which: (name) => {
        if (name === "agy.exe") return agyPath;
        if (name === "gemini.exe") return geminiPath;
        return undefined;
      },
    });
    expect(result).toBe(agyPath);
  });

  it("prefers well-known agy.exe over legacy gemini.exe in ~/.gemini/bin", () => {
    const home = "C:\\Users\\Developer";
    const agyBin = "C:\\Users\\Developer\\.gemini\\bin\\agy.exe";
    const geminiBin = "C:\\Users\\Developer\\.gemini\\bin\\gemini.exe";
    const result = locateGeminiCli({
      platform: "win32",
      home,
      fs: fakeFs([agyBin, geminiBin]),
      which: () => undefined,
      env: { USERPROFILE: home },
    });
    expect(result).toBe(agyBin);
  });

  it("finds gemini on PATH when no configured path is provided", () => {
    const onPath = "C:\\tools\\gemini.exe";
    const result = locateGeminiCli({
      platform: "win32",
      fs: fakeFs([onPath]),
      which: (name) => (name === "gemini.exe" ? onPath : undefined),
    });
    expect(result).toBe(onPath);
  });

  it("falls back to well-known directories if not on PATH (win32)", () => {
    const home = "C:\\Users\\Developer";
    const wellKnown = "C:\\Users\\Developer\\.gemini\\bin\\gemini.exe";
    const result = locateGeminiCli({
      platform: "win32",
      home,
      fs: fakeFs([wellKnown]),
      which: () => undefined,
      env: { USERPROFILE: home },
    });
    expect(result).toBe(wellKnown);
  });

  it("falls back to well-known directories on POSIX", () => {
    const home = "/home/dev";
    const wellKnown = "/home/dev/.gemini/bin/gemini";
    const result = locateGeminiCli({
      platform: "linux",
      home,
      fs: fakeFs([wellKnown]),
      which: () => undefined,
      env: { HOME: home },
    });
    expect(result).toBe(wellKnown);
  });

  it("returns undefined if gemini is not found anywhere", () => {
    const result = locateGeminiCli({
      platform: "linux",
      home: "/home/dev",
      fs: fakeFs([]),
      which: () => undefined,
      env: { HOME: "/home/dev" },
    });
    expect(result).toBeUndefined();
  });
});

describe("isAntigravityCli", () => {
  it("recognizes agy and agy.exe binaries", () => {
    expect(isAntigravityCli("agy")).toBe(true);
    expect(isAntigravityCli("agy.exe")).toBe(true);
    expect(isAntigravityCli("C:\\Users\\dev\\.gemini\\bin\\agy.exe")).toBe(true);
    expect(isAntigravityCli("/usr/local/bin/agy")).toBe(true);
    expect(isAntigravityCli("antigravity")).toBe(true);
    expect(isAntigravityCli("antigravity.exe")).toBe(true);
  });

  it("returns false for legacy gemini and other CLIs", () => {
    expect(isAntigravityCli("gemini")).toBe(false);
    expect(isAntigravityCli("gemini.exe")).toBe(false);
    expect(isAntigravityCli("C:\\npm\\gemini.cmd")).toBe(false);
    expect(isAntigravityCli("claude.exe")).toBe(false);
    expect(isAntigravityCli("")).toBe(false);
  });
});

describe("parseGeminiVersionOutput & parseAgyVersionOutput", () => {
  it("parses clean semver strings", () => {
    expect(parseGeminiVersionOutput("1.2.3")).toBe("1.2.3");
    expect(parseGeminiVersionOutput("v1.2.3")).toBe("1.2.3");
    expect(parseAgyVersionOutput("1.1.26")).toBe("1.1.26");
  });

  it("parses version numbers with pre-release tags", () => {
    expect(parseGeminiVersionOutput("gemini version 0.9.1-beta.2 (commit abc)")).toBe("0.9.1-beta.2");
  });

  it("returns empty string when no semver matches", () => {
    expect(parseGeminiVersionOutput("unknown command")).toBe("");
  });
});

describe("hasAntigravityCredentials", () => {
  // path.join, not literal separators: this runs on Linux and macOS in CI too.
  const home = path.join("C:", "Users", "dev");
  const gemini = path.join(home, ".gemini");

  it("finds the account agy auth login wrote", () => {
    expect(hasAntigravityCredentials({
      home,
      env: {},
      fs: fakeFs([path.join(gemini, "oauth_creds.json")]),
    })).toBe(true);
  });

  it("also accepts the CLI-scoped copy", () => {
    expect(hasAntigravityCredentials({
      home,
      env: {},
      fs: fakeFs([path.join(gemini, "antigravity-cli", "oauth_creds.json")]),
    })).toBe(true);
  });

  it("says no when only the binary is installed", () => {
    // The whole point: an installed agy used to read as a signed-in account,
    // because the ACP adapter answers session/new without ever launching it.
    expect(hasAntigravityCredentials({
      home,
      env: {},
      fs: fakeFs([path.join(gemini, "bin", "agy.exe")]),
    })).toBe(false);
  });

  it("honours GEMINI_HOME", () => {
    const custom = path.join("D:", "gem");
    expect(hasAntigravityCredentials({
      home,
      env: { GEMINI_HOME: custom },
      fs: fakeFs([path.join(custom, "oauth_creds.json")]),
    })).toBe(true);
  });
});
