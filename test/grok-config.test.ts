import { describe, it, expect, vi } from "vitest";
import * as path from "node:path";
import {
  configForcesAlwaysApprove,
  ensureConfigToml,
  globalConfigPath,
  GLOBAL_CONFIG_STUB,
  isAlwaysApprovePermission,
  projectConfigPath,
  PROJECT_CONFIG_STUB,
  readUiPermissionMode,
} from "../src/grok-config";

// A realistic grok config.toml, mirroring the on-disk shape.
const CONFIG = (permission: string) => `[cli]
installer = "internal"
auto_update = false
channel = "stable"

[features]
feedback = true
support_permission = true

[ui]
max_thoughts_width = 120
fork_secondary_model = "grok-build"
yolo = false
compact_mode = false
permission_mode = "${permission}"

[marketplace]
official_marketplace_auto_installed = true

[[marketplace.sources]]
name = "xAI Official"
git = "https://github.com/xai-org/plugin-marketplace.git"

[models]
default = "grok-build"
`;

describe("isAlwaysApprovePermission", () => {
  it("matches the hyphenated value grok writes", () => {
    expect(isAlwaysApprovePermission("always-approve")).toBe(true);
  });

  it("accepts the underscore variant and stray case/whitespace", () => {
    expect(isAlwaysApprovePermission("always_approve")).toBe(true);
    expect(isAlwaysApprovePermission("  Always-Approve  ")).toBe(true);
  });

  it("rejects other modes and empties", () => {
    expect(isAlwaysApprovePermission("ask")).toBe(false);
    expect(isAlwaysApprovePermission("")).toBe(false);
    expect(isAlwaysApprovePermission(undefined)).toBe(false);
  });
});

describe("readUiPermissionMode", () => {
  it("reads permission_mode from the [ui] table", () => {
    expect(readUiPermissionMode(CONFIG("always-approve"))).toBe("always-approve");
    expect(readUiPermissionMode(CONFIG("ask"))).toBe("ask");
  });

  it("returns undefined when the key is absent", () => {
    expect(readUiPermissionMode("[ui]\nyolo = false\n")).toBeUndefined();
    expect(readUiPermissionMode("")).toBeUndefined();
  });

  it("ignores a permission_mode outside the [ui] table", () => {
    const toml = `[other]\npermission_mode = "always-approve"\n\n[ui]\nyolo = false\n`;
    expect(readUiPermissionMode(toml)).toBeUndefined();
  });

  it("does not misread the array table [[marketplace.sources]] as [ui]", () => {
    // The array-table line must not flip the in-ui flag on.
    const toml = `[[marketplace.sources]]\npermission_mode = "always-approve"\n`;
    expect(readUiPermissionMode(toml)).toBeUndefined();
  });

  it("strips inline comments and single quotes", () => {
    expect(readUiPermissionMode(`[ui]\npermission_mode = 'ask' # default\n`)).toBe("ask");
  });

  it("tolerates CRLF line endings", () => {
    expect(readUiPermissionMode(`[ui]\r\npermission_mode = "always-approve"\r\n`)).toBe(
      "always-approve",
    );
  });
});

describe("configForcesAlwaysApprove", () => {
  it("true when global config sets always-approve", () => {
    expect(configForcesAlwaysApprove({ global: CONFIG("always-approve") })).toBe(true);
  });

  it("false when global config is the default ask", () => {
    expect(configForcesAlwaysApprove({ global: CONFIG("ask") })).toBe(false);
  });

  it("false when neither config is present", () => {
    expect(configForcesAlwaysApprove({})).toBe(false);
    expect(configForcesAlwaysApprove({ project: undefined, global: undefined })).toBe(false);
  });

  it("project config overrides global (project ask beats global always-approve)", () => {
    expect(
      configForcesAlwaysApprove({ project: CONFIG("ask"), global: CONFIG("always-approve") }),
    ).toBe(false);
  });

  it("project config overrides global (project always-approve beats global ask)", () => {
    expect(
      configForcesAlwaysApprove({ project: CONFIG("always-approve"), global: CONFIG("ask") }),
    ).toBe(true);
  });

  it("falls back to global when project has no permission_mode", () => {
    const projectWithoutKey = `[ui]\nyolo = false\n`;
    expect(
      configForcesAlwaysApprove({ project: projectWithoutKey, global: CONFIG("always-approve") }),
    ).toBe(true);
  });
});

describe("config path helpers (host-resolved intents)", () => {
  it("globalConfigPath is GROK_HOME/config.toml", () => {
    expect(globalConfigPath({ GROK_HOME: "/tmp/fake-grok-home" } as NodeJS.ProcessEnv, "linux")).toBe(
      path.join("/tmp/fake-grok-home", "config.toml"),
    );
  });

  it("projectConfigPath is <cwd>/.grok/config.toml", () => {
    expect(projectConfigPath("/work/repo")).toBe(path.join("/work/repo", ".grok", "config.toml"));
  });

  it("ensureConfigToml creates a stub when missing and leaves an existing file", () => {
    const created: string[] = [];
    const written: Array<{ p: string; data: string }> = [];
    const files = new Set<string>();
    const fs = {
      existsSync: (p: string) => files.has(p),
      mkdirSync: (p: string) => {
        created.push(p);
      },
      writeFileSync: (p: string, data: string) => {
        files.add(p);
        written.push({ p, data });
      },
    };
    const target = path.join("/tmp", ".grok", "config.toml");
    expect(ensureConfigToml(target, GLOBAL_CONFIG_STUB, fs)).toBe(true);
    expect(created).toEqual([path.dirname(target)]);
    expect(written).toEqual([{ p: target, data: GLOBAL_CONFIG_STUB }]);
    // Second call is a no-op.
    expect(ensureConfigToml(target, PROJECT_CONFIG_STUB, fs)).toBe(false);
    expect(written).toHaveLength(1);
  });

  it("uses exclusive creation and treats an appearance during creation as an existing file", () => {
    const writeFileSync = vi.fn((_p: string, _data: string, opts?: { flag: string }) => {
      expect(opts).toEqual({ flag: "wx" });
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
    });
    expect(ensureConfigToml("/tmp/config.toml", GLOBAL_CONFIG_STUB, {
      existsSync: () => false, mkdirSync: () => {}, writeFileSync,
    })).toBe(false);
    expect(writeFileSync).toHaveBeenCalledTimes(1);
  });

  it.each(["mkdir", "write"])("propagates a %s failure during stub creation", (step) => {
    const fail = () => { throw new Error("disk denied"); };
    expect(() => ensureConfigToml("/tmp/config.toml", GLOBAL_CONFIG_STUB, {
      existsSync: () => false, mkdirSync: step === "mkdir" ? fail : () => {}, writeFileSync: fail,
    })).toThrow("disk denied");
  });
});
