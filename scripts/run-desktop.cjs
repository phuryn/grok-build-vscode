#!/usr/bin/env node
/**
 * Launch the Electron desktop app with ELECTRON_RUN_AS_NODE stripped.
 * That env var makes `electron` run as plain Node and kills BrowserWindow
 * before any page code runs (spike-confirmed).
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const REMOTE_FRAMES = path.join(__dirname, "..", "out", "remote-frames.js");

/** GROK_RELAY_URL from the gitignored .env, when the environment has none. */
function relayUrlFromEnvFile() {
  try {
    const line = fs
      .readFileSync(path.join(__dirname, "..", ".env"), "utf8")
      .split(/\r?\n/)
      .find((l) => /^\s*GROK_RELAY_URL\s*=/.test(l));
    if (!line) return undefined;
    return line
      .replace(/^\s*GROK_RELAY_URL\s*=\s*/, "")
      .replace(/^["']|["']$/g, "")
      .trim();
  } catch {
    return undefined; // no .env — the caller reports it
  }
}

// `npm run desktop-dev` — talk to a non-production relay, so pre-release testing
// does not mean editing REMOTE_RELAY_URL and remembering to put it back (that is
// how a staging URL reached this public repo once already). Done here rather
// than as a shell `VAR=x` prefix, which Windows does not have.
//
// The URL is NOT hardcoded here, deliberately: this repository is public, and a
// staging hostname committed to it is the very leak this feature exists to
// prevent. It comes from the environment, or from the gitignored `.env`.
//
// resolveRelayUrl honours it only in a NON-production build, so nothing here can
// redirect a packaged app.
//
// `--open-devtools` is a SEPARATE concern from `--relay-dev`. desktop-dev
// passes both; either can be used alone. Do not key DevTools off GROK_RELAY_URL.
const OPEN_DEVTOOLS_FLAG = "--open-devtools";
const OPEN_DEVTOOLS_ENV = "GROK_DESKTOP_OPEN_DEVTOOLS";
const openDevTools = process.argv.includes(OPEN_DEVTOOLS_FLAG);
// `--open-devtools` is PASSED THROUGH to Electron, not consumed here. When an
// app is already running, the single-instance lock hands the SECOND launch's
// command line to the first process — that is the only channel available, since
// the running process cannot see this child's environment. Filtering the flag
// out is why a second `desktop-dev` focused the window and opened nothing.
// The env var still serves the FIRST launch, where there is no second-instance
// event to carry it.
const args = process.argv.slice(2).filter((a) => a !== "--relay-dev");

if (openDevTools) {
  env[OPEN_DEVTOOLS_ENV] = "1";
}

if (process.argv.includes("--relay-dev")) {
  const candidate = env.GROK_RELAY_URL || relayUrlFromEnvFile();

  // Validated by the RESOLVER ITSELF, not by a second copy of its rules here.
  // `npm run desktop-dev` compiles first, so out/ is current. A launcher that
  // accepted a value the resolver rejects would print a staging-looking host,
  // start cleanly, and connect a stored device token to PRODUCTION — believing
  // you are on staging is worse than not starting at all.
  const { resolveRelayUrl, REMOTE_RELAY_URL, redactRelayUrl } = require(REMOTE_FRAMES);
  const resolved = candidate
    ? resolveRelayUrl({ isProduction: false, env: { GROK_RELAY_URL: candidate } })
    : REMOTE_RELAY_URL;

  if (resolved === REMOTE_RELAY_URL) {
    console.error(
      candidate
        ? [
            "[desktop] --relay-dev: GROK_RELAY_URL is not a usable relay URL, so it",
            "  would silently fall back to PRODUCTION. Wanted ws:// or wss:// with a",
            "  host, and no query, fragment or credentials.",
          ].join("\n")
        : [
            "[desktop] --relay-dev needs a relay URL.",
            "  Set GROK_RELAY_URL in the environment, or add a line to the gitignored .env:",
            "    GROK_RELAY_URL=wss://your-staging-relay.example",
          ].join("\n"),
    );
    process.exit(1);
  }
  env.GROK_RELAY_URL = resolved;
  console.log(`[desktop] relay: ${redactRelayUrl(resolved)}`);
} else if (env.GROK_RELAY_URL) {
  // Plain `desktop` means PRODUCTION. One door to the override, and it is
  // `--relay-dev`.
  //
  // The resolver honours the variable in any non-production build, and a
  // source-run app is one — so a GROK_RELAY_URL left in a shell profile would
  // otherwise make `npm run desktop` connect a stored device token to staging
  // while looking exactly like a production run. Dropping it here keeps the two
  // scripts meaning what their names say, which is worth more than letting the
  // variable work through both entry points.
  delete env.GROK_RELAY_URL;
  console.log("[desktop] relay: production (GROK_RELAY_URL ignored — use `npm run desktop-dev`)");
}

const electronBin = require("electron");
const mainJs = path.join(__dirname, "..", "out", "desktop", "main.js");
const needsShell = typeof electronBin === "string" && /\.(cmd|bat)$/i.test(electronBin);
const command = needsShell && electronBin.includes(" ") && !electronBin.startsWith('"')
  ? `"${electronBin}"`
  : electronBin;

const child = spawn(command, [mainJs, ...args], {
  env,
  stdio: "inherit",
  shell: needsShell,
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
