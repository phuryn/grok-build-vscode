/**
 * Gate: sidebar.ts must load in a plain Node process where `vscode` is absent.
 * That is the hard blocker for constructing GrokSidebar from an Electron host.
 *
 * Always recompiles to a temp outDir so a stale `out/sidebar.js` cannot make
 * this gate pass against old code.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sidebarSrc = path.join(root, "src", "sidebar.ts");

describe("sidebar is portable (no vscode module)", () => {
  it("does not import or require the vscode module", () => {
    const src = readFileSync(sidebarSrc, "utf8");
    expect(src).not.toMatch(/\bfrom\s+["']vscode["']/);
    expect(src).not.toMatch(/\brequire\s*\(\s*["']vscode["']\s*\)/);
    expect(src).not.toMatch(/\bimport\s*\(\s*["']vscode["']\s*\)/);
  });

  it("loads freshly compiled sidebar.js when resolving vscode throws", () => {
    // Always compile to a dedicated temp dir — never load `out/sidebar.js`,
    // which may lag src after an edit (false green on the portability premise).
    const tempOut = path.join(root, ".tmp-sidebar-portable-out");
    rmSync(tempOut, { recursive: true, force: true });
    mkdirSync(tempOut, { recursive: true });
    const tsc = spawnSync(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["tsc", "-p", ".", "--outDir", `"${tempOut}"`, "--declaration", "false"],
      { cwd: root, encoding: "utf8", shell: true },
    );
    if (tsc.status !== 0) {
      throw new Error(
        `sidebar portable gate: compile failed (status ${tsc.status}):\n${tsc.stdout}\n${tsc.stderr}`,
      );
    }
    const loadPath = path.join(tempOut, "sidebar.js");
    if (!existsSync(loadPath)) {
      throw new Error(`sidebar portable gate: expected ${loadPath} after compile`);
    }

    const probe = path.join(root, ".tmp-sidebar-portable-probe.cjs");
    writeFileSync(
      probe,
      `
const Module = require("module");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") {
    throw new Error("vscode module must not be resolved when loading sidebar");
  }
  return originalLoad.apply(this, arguments);
};
require(${JSON.stringify(loadPath)});
console.log("SIDEBAR_LOADED_OK");
`,
      "utf8",
    );

    try {
      const run = spawnSync(process.execPath, [probe], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env },
      });
      if (run.status !== 0) {
        throw new Error(
          `sidebar portable gate: load failed (status ${run.status}):\n${run.stdout}\n${run.stderr}`,
        );
      }
      expect(run.stdout).toContain("SIDEBAR_LOADED_OK");
      expect(run.stderr ?? "").not.toContain("vscode module must not be resolved");
    } finally {
      rmSync(probe, { force: true });
      rmSync(tempOut, { recursive: true, force: true });
    }
  });
});
