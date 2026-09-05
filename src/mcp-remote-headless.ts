/** NODE_OPTIONS preload for the remote-only, one-shot mcp-remote process.
 * The pinned package bundles `open` and has no headless flag. Its only spawn
 * is the browser launcher. Leave npx (which inherits this preload) untouched.
 * Do not apply this to session proxies or local Connect.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PRELOAD = String.raw`
const fs = require("node:fs");
let entry = "";
try { entry = fs.realpathSync(process.argv[1]); } catch {}
if (/[\\/]mcp-remote[\\/]dist[\\/]proxy\.js$/.test(entry)) {
  require("node:child_process").spawn = () => {
    throw new Error("Open the sign-in link on the requesting device.");
  };
  require("node:module").syncBuiltinESMExports();
}
`;

/** External Node cannot require a file inside Electron's app.asar. */
export function writeMcpRemoteHeadlessPreload(tmpRoot = tmpdir()): { path: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpRoot, "grok-mcp-headless-"));
  const path = join(dir, "preload.cjs");
  const dispose = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } };
  try { writeFileSync(path, PRELOAD, "utf8"); } catch (error) { dispose(); throw error; }
  return { path, dispose };
}
