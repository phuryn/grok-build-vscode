import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeMcpRemoteHeadlessPreload } from "../src/mcp-remote-headless";

describe("remote OAuth browser suppression", () => {
  it("blocks mcp-remote's browser spawn, leaves the npm launcher alone, and handles spaces", () => {
    const root = mkdtempSync(join(tmpdir(), "mcp Jane Doe-"));
    const hook = writeMcpRemoteHeadlessPreload(root);
    const dist = join(root, "node_modules", "mcp-remote", "dist");
    mkdirSync(dist, { recursive: true });
    const proxy = join(dist, "proxy.js");
    const launcher = join(root, "npx.cjs");
    // Named ESM import mirrors the bundled open dependency; no real browser.
    const script = `import('node:child_process').then(({spawn}) => {
      try { spawn(process.execPath, ['-e', ''], {windowsHide: true}).on('exit', () => process.stdout.write('spawned')); }
      catch (error) { process.stdout.write(error.message); }
    });`;
    writeFileSync(proxy, script);
    writeFileSync(launcher, script);
    const run = (file: string, preload = true) => spawnSync(process.execPath, [file], {
      encoding: "utf8", windowsHide: true, timeout: 5000,
      env: { ...process.env, NODE_OPTIONS: preload ? `--require ${JSON.stringify(hook.path.replace(/\\/g, "/"))}` : "" },
    });
    try {
      const result = run(proxy);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("requesting device");
      expect(run(launcher).stdout).toBe("spawned");
      expect(run(proxy, false).stdout).toBe("spawned");
      if (process.platform !== "win32") {
        const alias = join(root, "mcp-remote");
        symlinkSync(proxy, alias);
        expect(run(alias).stdout).toContain("requesting device");
      }
      hook.dispose();
      expect(existsSync(hook.path)).toBe(false);
    } finally {
      hook.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
