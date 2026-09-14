/**
 * Minimal workspace file find for the desktop host (mention index).
 * Not a full VS Code glob engine — good enough for `**\/*` + common excludes.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Uri } from "../host";

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".pnpm",
  ".git",
  ".hg",
  ".svn",
  "out",
  "out-integration",
  "dist",
  "dist-desktop",
  ".vscode-test",
  "coverage",
  ".next",
  ".nuxt",
  "target",
  "venv",
  ".venv",
  "tmp",
  "temp",
]);

function matchesExclude(relPosix: string, exclude?: string): boolean {
  if (!exclude) return false;
  // VS Code exclude is a glob string; handle the shapes we actually emit.
  const patterns = exclude
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const pat of patterns) {
    if (pat === "**/*" || pat === "*") return true;
    // `**/node_modules/**` style
    const bare = pat.replace(/^\*\*\//, "").replace(/\/\*\*$/, "").replace(/\*\*/g, "");
    if (bare && (relPosix === bare || relPosix.includes(`/${bare}/`) || relPosix.startsWith(`${bare}/`))) {
      return true;
    }
    if (pat.endsWith("/**") || pat.endsWith("/*")) {
      const prefix = pat.replace(/\/\*\*?$/, "").replace(/^\*\*\//, "");
      if (prefix && (relPosix === prefix || relPosix.startsWith(prefix + "/"))) return true;
    }
  }
  return false;
}

/**
 * Walk `base` asynchronously and return file URIs under it, newest-not-sorted (order free).
 * Uses non-blocking cooperative scheduling to never starve the Electron main loop / Windows Message Pump.
 */
export async function findFilesUnder(
  base: string,
  exclude?: string,
  maxResults = 5000,
): Promise<Uri[]> {
  const root = path.resolve(base);
  try {
    const st = await fs.promises.stat(root);
    if (!st.isDirectory()) return [];
  } catch {
    return [];
  }

  const out: Uri[] = [];
  let yieldCounter = 0;

  async function walk(dir: string): Promise<void> {
    if (out.length >= maxResults) return;

    yieldCounter++;
    if (yieldCounter % 30 === 0) {
      await new Promise<void>((resolve) => {
        if (typeof setImmediate === "function") {
          setImmediate(resolve);
        } else {
          setTimeout(resolve, 0);
        }
      });
    }

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      if (out.length >= maxResults) return;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIR_NAMES.has(ent.name)) continue;
        const rel = path.relative(root, abs).split(path.sep).join("/");
        if (matchesExclude(rel + "/", exclude) || matchesExclude(rel, exclude)) continue;
        await walk(abs);
      } else if (ent.isFile()) {
        const rel = path.relative(root, abs).split(path.sep).join("/");
        if (matchesExclude(rel, exclude)) continue;
        out.push(Uri.file(abs));
      }
    }
  }

  await walk(root);
  return out;
}
