const { spawn } = require("node:child_process");
const path = require("node:path");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const electronBin = require("electron");
const mainScript = path.join(__dirname, "media-range-harness-main.cjs");
const needsShell = typeof electronBin === "string" && /\.(cmd|bat)$/i.test(electronBin);
const command = needsShell && electronBin.includes(" ") && !electronBin.startsWith('"')
  ? `"${electronBin}"`
  : electronBin;

const child = spawn(command, ["--no-sandbox", "--disable-gpu", "--disable-gpu-compositing", mainScript, ...process.argv.slice(2)], {
  env,
  stdio: "inherit",
  shell: needsShell,
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
