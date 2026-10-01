// Native control-plane probe. No model prompts, no overflow requests.
// npm run compile && node research/context-window-probe.cjs
const { AcpClient } = require("../out/acp.js");
const { mkdtempSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const cliPath = process.env.GROK_CLI_PATH || path.join(os.homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok");
const grokVersion = execFileSync(cliPath, ["--version"], { encoding: "utf8" }).trim();
const cwd = mkdtempSync(path.join(os.tmpdir(), "grok-context-window-"));
function makeClient() {
  return new AcpClient({ cliPath,
    cwd, grokVersion, grokVersionVerified: true, log: () => {} });
}
(async () => {
  let client = makeClient();
  try {
    await client.start(); await client.newSession();
    const sessionId = client.sessionId;
    assert.equal(client.contextWindowSelection.selectedSize, 256000);
    assert.deepEqual(client.contextWindowSelection.sizes, [256000, 500000]);
    await client.setContextWindow(500000, client.contextWindowSelection);
    assert.equal(client.contextWindowSelection.selectedSize, 500000);
    assert.equal((await client.getSessionInfo()).window, 500000);
    await client.setModel("grok-4.6");
    assert.equal(client.contextWindowSelection.selectedSize, 500000);
    await client.setContextWindow(256000, client.contextWindowSelection);
    assert.equal(client.contextWindowSelection.selectedSize, 256000);
    await client.setContextWindow(500000, client.contextWindowSelection);
    await client.dispose();
    client = makeClient(); await client.start(); await client.loadSession(sessionId);
    assert.equal(client.contextWindowSelection.selectedSize, 500000);
    console.log(JSON.stringify({ cli: grokVersion, selection: client.contextWindowSelection, verified: ["default", "enlarge", "session refresh", "model carry", "shrink", "resume"], promptsSent: 0 }));
  } finally { await client.dispose(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
