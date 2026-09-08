import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GrokSidebar } from "../src/sidebar";

describe("isolateFromInstalledGrok", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const dir of temps.splice(0)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  function decoyCli(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-iso-unit-"));
    temps.push(dir);
    const decoy = path.join(dir, process.platform === "win32" ? "grok.cmd" : "grok");
    fs.writeFileSync(decoy, "");
    // A configured path must be an EXECUTABLE regular file, not merely present,
    // so a decoy that stands in for a real CLI has to carry the bit. Windows
    // decides by extension and ignores the mode, which is why leaving this out
    // stayed invisible on a Windows dev box and failed both POSIX CI legs.
    fs.chmodSync(decoy, 0o755);
    return decoy;
  }

  function instance(opts: { isolated: boolean; cliPath?: string; configuredPath: string }) {
    const sidebar = Object.create(GrokSidebar.prototype) as any;
    sidebar.cliPath = opts.cliPath;
    sidebar.codexCliPath = undefined;
    sidebar.testForceMissingGrokCli = opts.isolated;
    sidebar.host = { getConfiguration: () => ({ get: () => opts.configuredPath }) };
    sidebar.context = { globalStorageUri: { fsPath: os.tmpdir() } };
    return sidebar;
  }

  it("discovers a configured CLI when isolation is off", () => {
    const decoy = decoyCli();
    const sidebar = instance({ isolated: false, configuredPath: decoy });
    expect(sidebar.locateProvider("grok")).toBe(decoy);
  });

  it("does not rediscover a configured or PATH CLI while isolated", () => {
    const decoy = decoyCli();
    const sidebar = instance({ isolated: true, configuredPath: decoy });
    expect(sidebar.locateProvider("grok")).toBeUndefined();
    expect(sidebar.cliPath).toBeUndefined();
  });

  it("still returns an explicit provisioned path while isolated", () => {
    const decoy = decoyCli();
    const sidebar = instance({ isolated: true, cliPath: decoy, configuredPath: decoy });
    expect(sidebar.locateProvider("grok")).toBe(decoy);
  });
});
