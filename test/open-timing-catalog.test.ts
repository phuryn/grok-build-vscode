import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { runInNewContext } from "node:vm";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

// Execute the exact callback Playwright installs in main, with fake filesystem
// and scheduling seams. No Electron launch or compiled product files required.
const source = readFileSync(new URL("../scripts/open-timing-check.mjs", import.meta.url), "utf8");
const ast = ts.createSourceFile("open-timing-check.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
let probeSource = "";
function findProbe(node: ts.Node): void {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "app.evaluate") {
    const callback = node.arguments[0]?.getText(ast) ?? "";
    if (callback.includes("globalThis.__catalogWalks = state")) probeSource = callback;
  }
  ts.forEachChild(node, findProbe);
}
findProbe(ast);

function install() {
  const root = path.resolve("fixture-repo");
  const grokHome = path.resolve("fixture-grok-home");
  const sessionsRoot = path.join(grokHome, "sessions");
  const catalog = path.join(sessionsRoot, "project");
  const sidebarPath = path.join(root, "out", "sidebar.js");
  const queued: Array<() => void> = [];
  const defaultFs = { readdirSync: (_dir: string) => ["project"] };
  class Sidebar {
    scheduled = false;
    postInitialState() {
      return undefined;
    }
    postSessionsList(opts?: object) {
      if (opts) return this.postSessionsListNow(opts);
      if (this.scheduled) return;
      this.scheduled = true;
      queued.push(() => {
        this.scheduled = false;
        this.postSessionsListNow();
      });
    }
    postSessionsListNow(_opts?: object) { defaultFs.readdirSync(catalog); }
  }
  const sidebarSource = "\n".repeat(200) + Sidebar.prototype.postInitialState.toString();
  let stack = "Error: unrelated catalog walk";
  const app = new EventEmitter();
  const sandbox: any = {
    process: { getBuiltinModule: () => ({ createRequire: () => (name: string) => {
      if (name === "node:path") return path;
      if (name === "node:fs") return { readFileSync: () => sidebarSource };
      if (name === path.join(root, "out", "sessions.js")) return { defaultFs };
      if (name === sidebarPath) return { GrokSidebar: Sidebar };
      throw new Error(`unexpected require: ${name}`);
    } }) },
    Error: class { stack = stack; },
  };
  expect(probeSource).not.toBe("");
  runInNewContext(`(${probeSource})`, sandbox)({ app }, { root, grokHome });
  const sidebar = new Sidebar();
  const request = (startup: boolean, opts?: object) => {
    // 202 is inside postInitialState's compiled body; 10 is outside it.
    stack = `Error: refresh requested\n    at ${sidebarPath}:${startup ? 202 : 10}:7`;
    sidebar.postSessionsList(opts);
  };
  const flush = () => {
    stack = "Error: walk\n    at Immediate._onImmediate (node:internal/timers:1:1)";
    for (const callback of queued.splice(0)) callback();
  };
  const walks = () => sandbox.__catalogWalks.walks as Array<{ startup: boolean; requestedBy: string[] }>;
  return { request, flush, walks, defaultFs, catalog, app };
}

describe("open timing catalog attribution", () => {
  it.each(["before", "after"])("excludes startup scheduled %s the click, even if the walk runs later", (when) => {
    const h = install();
    if (when === "before") h.request(true);
    const beforeClick = h.walks().length;
    // On a slow host, the startup promise's continuation may request its list
    // after the click. Its compiled scheduling location still owns the work.
    if (when === "after") h.request(true);
    h.flush();
    const observed = h.walks().slice(beforeClick);
    expect(observed).toHaveLength(1);
    expect(observed.filter((walk) => !walk.startup)).toEqual([]);
  });

  it("counts an open's deferred refresh after its timing line", () => {
    const h = install();
    h.request(false);
    expect(h.walks()).toEqual([]);
    h.flush();
    expect(h.walks().map((walk) => walk.startup)).toEqual([false]);
  });

  it.each([true, false])("counts a refresh shared by startup and an open (startup first: %s)", (startupFirst) => {
    const h = install();
    h.request(startupFirst);
    h.request(!startupFirst);
    h.flush();
    expect(h.walks()).toHaveLength(1);
    expect(h.walks()[0].startup).toBe(false);
    expect(h.walks()[0].requestedBy).toHaveLength(2);
  });

  it("keeps an immediate paged request separate from queued startup work", () => {
    const h = install();
    h.request(true);
    h.request(false, { offset: 50 });
    h.flush();
    expect(h.walks().map((walk) => walk.startup)).toEqual([false, true]);
  });

  it("counts a walk outside the list-refresh funnel", () => {
    const h = install();
    h.defaultFs.readdirSync(h.catalog);
    expect(h.walks().map((walk) => walk.startup)).toEqual([false]);
  });
});
