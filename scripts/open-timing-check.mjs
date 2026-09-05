// Does the real app actually EMIT the open-timing line, and does the line
// account for its own total?
//
// The unit tests prove the formatter. They cannot prove that `sidebar.ts` wires
// the clock to phases that tile a real open, or that the line survives the
// route to `desktop.log` — which is precisely the failure #131/#133 already hit
// once: "Show logs" was a menu item that did nothing, so nobody could send one.
//
// So: launch the real Electron build against the deterministic QA fixture, open
// two conversations through the rail (the SECOND one is the session switch that
// #133 and #138 describe), then read the log the app wrote and check the
// arithmetic on every line it produced.
// Also count actual catalog enumerations in main: every rail open must do zero,
// including deferred work after its timing line. Walks scheduled by startup are
// reported separately, even when its continuation runs after a rail click.
import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.REPO || process.cwd();
const { buildQaFixture } = await import(pathToFileURL(path.join(root, "scripts", "qa-fixture.mjs")).href);
const mainJs = path.join(root, "out", "desktop", "main.js");
const electronExe = await resolveElectronExe(root);
const fixtureCli = path.join(root, "test", "fixtures", process.platform === "win32" ? "fake-grok-acp.cmd" : "fake-grok-acp.sh");
const log = (m) => console.log(`[open-timing] ${m}`);

/** Electron's own binary, which is NOT `dist/electron` everywhere: macOS keeps
 *  it inside `Electron.app`. The `electron` package exports the resolved path
 *  for exactly this reason, so ask it rather than rebuilding the path here. */
async function resolveElectronExe(root) {
  try {
    const mod = await import("electron");
    const exe = typeof mod.default === "string" ? mod.default : undefined;
    if (exe && fs.existsSync(exe)) return exe;
  } catch {
    // fall through to the layout-based guess
  }
  const dist = path.join(root, "node_modules", "electron", "dist");
  if (process.platform === "win32") return path.join(dist, "electron.exe");
  if (process.platform === "darwin") return path.join(dist, "Electron.app", "Contents", "MacOS", "Electron");
  return path.join(dist, "electron");
}


assert.ok(fs.existsSync(mainJs), `Missing ${mainJs} — run \`npm run compile\` first`);
assert.ok(fs.existsSync(electronExe), `Missing Electron at ${electronExe}`);

let qa;
let userData;
let logPath;

/**
 * Extra conversations on disk, because the catalog is walked SYNCHRONOUSLY.
 *
 * The QA fixture ships three, and three is not a load test. Every open indexes
 * the session catalog and then sweeps it for empties — `stat`ing each directory
 * and, for candidates, reading the transcript — all on the Electron main
 * thread. At three conversations that is invisible. A real store has hundreds,
 * and the same code then holds the thread that paints the window.
 *
 * FILLER_SESSIONS=N writes N synthesised conversations beside the real ones so
 * the heartbeat can say whether that cost is flat or grows. Contents are
 * generated; nothing is ever copied from a real store. Off by default: it makes
 * the check slower; the walk gate applies at every catalog size.
 */
function writeFillerSessions(fixture) {
  const NL = String.fromCharCode(10); // literal newline, no escape to lose
  const n = Number(process.env.FILLER_SESSIONS || 0);
  if (!(n > 0)) return 0;
  const sessionsRoot = path.join(fixture.grokHome, "sessions");
  // The catalog leaf is an encoding of the project path; read it back rather
  // than rebuilding it, so this cannot drift from the fixture's own encoder.
  const [leaf] = fs.readdirSync(sessionsRoot);
  assert.ok(leaf, `no session catalog under ${sessionsRoot}`);
  const dirRoot = path.join(sessionsRoot, leaf);
  const base = Date.UTC(2026, 0, 1);
  for (let i = 0; i < n; i += 1) {
    const id = `filler-${String(i).padStart(6, "0")}-0000-4000-8000-000000000000`;
    const dir = path.join(dirRoot, id);
    fs.mkdirSync(dir, { recursive: true });
    const at = base + i * 1000;
    fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({
      info: { id, cwd: fixture.project },
      session_summary: `Synthesised conversation ${i}`,
      generated_title: `Synthesised conversation ${i}`,
      created_at: new Date(at).toISOString(),
      updated_at: new Date(at).toISOString(),
      num_messages: 2,
      current_model_id: "grok-build",
    }) + NL);
    fs.writeFileSync(path.join(dir, "events.jsonl"),
      `{"type":"user","text":"filler ${i}"}${NL}{"type":"agent","text":"Acknowledged."}${NL}`);
    fs.utimesSync(path.join(dir, "events.jsonl"), new Date(at), new Date(at));
  }
  return n;
}

/**
 * A heavy `session-meta.json`. This machine's real one is 1.47 MB and
 * `PersistedState.get` re-reads and re-parses the whole file whenever its stamp
 * has moved — and the cold-open path reads that key before `startSession` is
 * reached. Writing it every run is deliberate: it is what turns the pre-clock
 * window from a handful of milliseconds into a couple of hundred, and so what
 * lets the assertion below actually SEE the clock wiring disappear. Size only;
 * contents are synthesised, never copied from a real store. `SMALL_META=1` opts
 * out, for comparing the two.
 */
function writeHeavyMeta(fixture) {
  if (process.env.SMALL_META) return;
  const dir = path.join(fixture.grokHome, "client-state");
  fs.mkdirSync(dir, { recursive: true });
  const target = Number(process.env.META_BYTES || 1468603);
  // Built by APPENDING, not by re-serialising the whole map each pass. The
  // obvious `while (JSON.stringify(meta).length < target)` is quadratic and
  // spent ~16 seconds here before Electron was even launched — long enough to
  // look like the probe had hung.
  const parts = [];
  let size = 2; // the braces
  let i = 0;
  while (size < target) {
    const key = `0000fill${String(i).padStart(4, "0")}-0000-4000-8000-0000000000${(i % 100).toString().padStart(2, "0")}`;
    const entry = JSON.stringify({
      provider: "grok",
      providerCwd: `C:/Users/someone/projects/filler-project-${i}/nested/deeper/still`,
      autoName: `A synthesised conversation title number ${i}, long enough to weigh what a real one weighs`,
    });
    const chunk = `${parts.length ? "," : ""}${JSON.stringify(key)}:${entry}`;
    parts.push(chunk);
    size += chunk.length;
    i++;
  }
  const file = path.join(dir, "session-meta.json");
  fs.writeFileSync(file, `{${parts.join("")}}`, "utf8");
  JSON.parse(fs.readFileSync(file, "utf8")); // it has to be a map the app can read
  log(`meta: wrote ${fs.statSync(file).size} bytes (${i} entries) to ${file}`);
}

/** Every `session open:` line the app has written so far. */
function openLines() {
  try {
    return fs.readFileSync(logPath, "utf8").split(/\r?\n/).filter((l) => l.includes("session open:"));
  } catch {
    return [];
  }
}

async function waitForOpenLines(page, atLeast, ms = 60000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (openLines().length >= atLeast) return openLines();
    await page.waitForTimeout(250);
  }
  return openLines();
}

/** Split one line back into its phases, so the arithmetic can be checked. */
function parse(line) {
  const body = line.slice(line.indexOf("session open:") + "session open:".length).trim();
  const parts = body.split(" · ").map((s) => s.trim());
  const totalPart = parts.pop();
  const total = /^total (\d+)ms \(events: (\d+)\)$/.exec(totalPart);
  assert.ok(total, `no total on the line: ${JSON.stringify(totalPart)}`);
  const phases = parts.map((p) => {
    const m = /^(.+?) (\d+)ms(?: \((.*)\))?$/.exec(p);
    assert.ok(m, `unparsable phase ${JSON.stringify(p)}`);
    return { name: m[1], ms: Number(m[2]), note: m[3] };
  });
  return { phases, totalMs: Number(total[1]), events: Number(total[2]) };
}

// The launch lives INSIDE the try: a launch that throws or times out used to
// skip the cleanup entirely and leave both temporary trees on disk — the QA
// fixture and a multi-megabyte synthesised metadata store, every failed run.
let failed = false;
let app;
try {
  // Every line that CREATES something lives in here, so the finally below is
  // actually a cleanup guarantee rather than a claim: a disk-full, a permission
  // error or a failed launch used to leave both temporary trees on disk.
  qa = buildQaFixture();
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "grok-timing-ud-"));
  logPath = path.join(userData, "logs", "desktop.log");
  fs.writeFileSync(path.join(userData, "test-config.json"), JSON.stringify({ "grok.cliPath": fixtureCli }), "utf8");
  writeHeavyMeta(qa);
  const filler = writeFillerSessions(qa);
  if (filler) log(`wrote ${filler} synthesised conversations beside the fixture's ${qa.sessions.length}`);
  const env = { ...process.env, GROK_HOME: qa.grokHome };
  delete env.ELECTRON_RUN_AS_NODE;
  const electronArgs = JSON.parse(process.env.OPEN_TIMING_ELECTRON_ARGS || "[]");
  assert.ok(Array.isArray(electronArgs) && electronArgs.every((arg) => typeof arg === "string"));
  if (electronArgs.length) log(`extra Electron arguments: ${JSON.stringify(electronArgs)}`);
  app = await electron.launch({
    executablePath: electronExe,
    args: [
      mainJs,
      `--workspace=${qa.project}`,
      `--user-data-dir=${userData}`,
      `--config-json=${path.join(userData, "test-config.json")}`,
      ...electronArgs,
    ],
    env,
    timeout: 60000,
  });
  const page = await app.firstWindow({ timeout: 60000 });
  await page.setViewportSize({ width: 1440, height: 900 });

  // A HEARTBEAT ON THE MAIN PROCESS — because the timing line cannot tell a
  // spinner from a freeze.
  //
  // `total` is wall time. An open that waits 3 seconds on the agent's
  // `session/new` reply and an open that spends 3 seconds doing synchronous
  // filesystem and JSON work print the same number, and only the second one is
  // what #133 reports: the title bar goes white because the Electron MAIN
  // process — where `GrokSidebar` lives — stopped servicing its loop.
  //
  // A timer that should fire every 50ms cannot fire while that thread is busy,
  // so how LATE it is measures exactly the thing the line is blind to. Read
  // back after the opens. `app.evaluate` runs in main, so this needs no product
  // code and ships nothing.
  const BEAT_MS = 50;
  await app.evaluate(({ app: electronApp }, beat) => {
    const state = { max: 0, stalls: [], beat, startedAt: Date.now() };
    globalThis.__mainHeartbeat = state;
    let last = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      const late = now - last - beat;
      last = now;
      if (late > state.max) state.max = late;
      // Only what a person would notice. Sub-frame jitter is scheduler noise.
      if (late >= 100) state.stalls.push({ at: now, late });
    }, beat);
    // Never hold the app open on account of the probe.
    timer.unref?.();
    electronApp.once("will-quit", () => clearInterval(timer));
  }, BEAT_MS);

  // Instrument the filesystem seam used by the catalog walkers, not a product
  // counter or just postSessionsList (which would miss other callers). Reading
  // GROK_HOME/sessions itself only discovers projects; reading one of its direct
  // children enumerates a conversation catalog. Deeper reads are single sessions.
  await app.evaluate(({ app: electronApp }, { root, grokHome }) => {
    const nodeRequire = process.getBuiltinModule("module").createRequire(`${root}/package.json`);
    const nodePath = nodeRequire("node:path");
    const { defaultFs } = nodeRequire(nodePath.join(root, "out", "sessions.js"));
    const sidebarPath = nodePath.join(root, "out", "sidebar.js");
    const { GrokSidebar } = nodeRequire(sidebarPath);
    // The startup .then callback is anonymous in V8's stack. Resolve its owning
    // method's range from THIS compiled build, never a hardcoded line number or
    // a wall-clock cutoff. A late postInitialState continuation is still startup.
    const sidebarSource = nodeRequire("node:fs").readFileSync(sidebarPath, "utf8");
    const startupSource = GrokSidebar.prototype.postInitialState.toString();
    const startupAt = sidebarSource.indexOf(startupSource);
    if (startupAt < 0) throw new Error("cannot locate postInitialState for catalog startup attribution");
    const startupFirstLine = sidebarSource.slice(0, startupAt).split("\n").length;
    const startupLastLine = startupFirstLine + startupSource.split("\n").length - 1;
    const scheduledByStartup = (stack = "") => stack.split("\n").some((frame) => {
      const marker = `${sidebarPath}:`;
      const at = frame.indexOf(marker);
      if (at < 0) return false;
      const line = Number(frame.slice(at + marker.length).split(":")[0]);
      return line >= startupFirstLine && line <= startupLastLine;
    });
    const sessionsRoot = nodePath.join(grokHome, "sessions");
    const original = defaultFs.readdirSync;
    const state = { walks: [] };
    globalThis.__catalogWalks = state;
    // A deferred walk's stack ends at setImmediate. Keep the scheduling stack
    // too, so a nonzero gate names the caller that requested the rebuild.
    const pendingRefreshes = [];
    let refreshing = [];
    const postList = GrokSidebar.prototype.postSessionsList;
    const postListNow = GrokSidebar.prototype.postSessionsListNow;
    GrokSidebar.prototype.postSessionsList = function (...args) {
      const stack = new Error("catalog refresh requested").stack;
      const request = { stack, startup: scheduledByStartup(stack) };
      // Paged requests run immediately and don't consume a queued whole-list
      // refresh's provenance, just as they don't consume that refresh itself.
      if (args[0]) {
        const previous = refreshing;
        refreshing = [request];
        try { return postList.apply(this, args); }
        finally { refreshing = previous; }
      }
      pendingRefreshes.push(request);
      return postList.apply(this, args);
    };
    GrokSidebar.prototype.postSessionsListNow = function (...args) {
      const previous = refreshing;
      if (!args[0]) refreshing = pendingRefreshes.splice(0);
      try { return postListNow.apply(this, args); }
      finally { refreshing = previous; }
    };
    defaultFs.readdirSync = function (dir) {
      const relative = nodePath.relative(sessionsRoot, dir);
      if (relative && relative !== ".." && !nodePath.isAbsolute(relative) && !relative.includes(nodePath.sep)) {
        const stack = new Error("catalog walk").stack;
        // A coalesced refresh requested by an open AND startup still counts.
        const startup = refreshing.length ? refreshing.every((request) => request.startup) : scheduledByStartup(stack);
        state.walks.push({ dir, stack, requestedBy: refreshing.map((request) => request.stack), startup });
      }
      return original.call(this, dir);
    };
    // Positive control: exercise the real wrapper once, then discard it. This
    // costs one readdir, with no per-conversation stats or transcript reads.
    const [leaf] = original(sessionsRoot);
    if (!leaf) throw new Error("catalog counter has no fixture to verify against");
    defaultFs.readdirSync(nodePath.join(sessionsRoot, leaf));
    if (state.walks.length !== 1) throw new Error("catalog counter positive control failed");
    state.walks.length = 0;
    electronApp.once("will-quit", () => {
      defaultFs.readdirSync = original;
      GrokSidebar.prototype.postSessionsList = postList;
      GrokSidebar.prototype.postSessionsListNow = postListNow;
    });
  }, { root, grokHome: qa.grokHome });

  await page.waitForSelector(".rail-session", { timeout: 60000 });
  const titles = await page.evaluate(
    () => [...document.querySelectorAll(".rail-session")].map((n) => (n.textContent || "").trim()),
  );
  log(`rail: ${titles.length} conversations — ${JSON.stringify(titles.slice(0, 4))}`);

  // Address conversations BY NAME. Clicking `.rail-session` by index looks like
  // it works and does not: the rail reorders by recency, so "click index 1
  // again" lands on a different conversation and the return trip below is never
  // actually taken. The first run of this check passed indices and reported a
  // dispose of 0ms for that reason alone.
  // The line's total starts when `startSessionBody` constructs its clock. The
  // user's open starts when they click. Everything between the two — parking
  // the old session, resolving the catalog, and the `session-meta.json` read —
  // is outside the line entirely, not even inside `other`. Measure it.
  const preludes = [];
  // Wait until the app stops opening things of its own accord. Without this the
  // click lands while a startup open is still in flight, the next line to appear
  // belongs to THAT open, and its clock legitimately started before the click —
  // which is how the first version of this check produced negative preludes.
  const settle = async (quietMs = 1200) => {
    let count = openLines().length;
    let quietSince = Date.now();
    while (Date.now() - quietSince < quietMs) {
      await page.waitForTimeout(150);
      const now = openLines().length;
      if (now !== count) {
        count = now;
        quietSince = Date.now();
      }
    }
  };

  const clicked = [];
  const catalogOpens = [];
  const openByName = async (name, { requireLine = true } = {}) => {
    await settle();
    const walksBefore = await app.evaluate(() => globalThis.__catalogWalks.walks.length);
    // Count FIRST. The app opens a conversation of its own on startup, so the
    // log already has a line in it whose clock started before this click — and
    // measuring against that one produces a negative prelude, which is how this
    // bug announced itself.
    const before = openLines().length;
    const clickedAt = Date.now();
    await page.locator(".rail-session", { hasText: name }).first().click();
    // A click that is EXPECTED to log nothing must not wait the full timeout for
    // it: the re-focus case is the documented success, and paying 60s for it
    // made a passing run a minute longer for nothing.
    const got = await waitForOpenLines(page, before + 1, requireLine ? 60000 : 4000);
    // postSessionsList schedules setImmediate, and post-open cleanup can run
    // after the line. Include the quiet window in THIS open's count.
    await settle();
    const observed = await app.evaluate((_, before) => globalThis.__catalogWalks.walks.slice(before), walksBefore);
    const walks = observed.filter((walk) => !walk.startup);
    catalogOpens.push({ name, walks });
    log(`catalog walks opening "${name}": ${walks.length}`);
    const startupWalks = observed.length - walks.length;
    if (startupWalks) log(`excluded ${startupWalks} walk(s) scheduled by postInitialState startup`);
    for (const walk of observed) {
      log(walk.stack);
      for (const request of walk.requestedBy) log(request);
    }
    const line = got[before];
    if (!line) {
      // Returning to a conversation whose client is still alive takes the
      // `focusSession` branch — a pure re-focus, no reopen, and so NO TIMING
      // LINE AT ALL. Expected on that one click and stated plainly (a user who
      // freezes there has nothing to send us); a FAILURE anywhere else, because
      // "the app logged nothing" must never be a way for this check to pass.
      assert.ok(!requireLine, `opening "${name}" produced no timing line at all`);
      log(`opened "${name}" — no timing line: the app re-focused a live conversation instead of reopening it`);
      return got;
    }
    const stamp = /\[desktop ([^\]]+)\]/.exec(line);
    const emittedAt = stamp ? Date.parse(stamp[1]) : NaN;
    const { totalMs } = parse(line);
    const prelude = Math.round(emittedAt - totalMs - clickedAt);
    const resolveMs = parse(line).phases.find((x) => x.name === "resolve")?.ms ?? 0;
    preludes.push({ name, totalMs, prelude, resolveMs });
    clicked.push({ name, line, totalMs, resolveMs });
    log(`opened "${name}" — total ${totalMs}ms (resolve ${resolveMs}ms); still unmeasured before the clock: ${prelude}ms`);
    return got;
  };

  const first = qa.expectedOrder[0];
  const second = qa.expectedOrder[1];

  let lines = await openByName(first);
  assert.ok(lines.length >= 1, "the app opened a conversation and logged no timing line at all");

  lines = await openByName(second);

  // Back to the first. This is #131 verbatim — "navigated to an existing chat,
  // started loading and then froze" — and it is the only open of the three with
  // a client already bound to the target, so it is the only one that can put a
  // non-zero number in `dispose`.
  lines = await openByName(first, { requireLine: false });

  console.log("\n----- lines the app actually wrote -----");
  for (const l of lines) console.log(l);
  console.log("----------------------------------------\n");

  // The claim being proved: the line names its own total. Whatever the phases
  // do not claim is printed, so a slow open cannot read as fast.
  for (const line of lines) {
    const { phases, totalMs, events } = parse(line);
    const named = phases.filter((p) => p.name !== "other");
    const other = phases.find((p) => p.name === "other");
    const sum = phases.reduce((a, p) => a + p.ms, 0);
    const drift = Math.abs(sum - totalMs);
    // EXACT. Every value on the line is a whole millisecond and the formatter
    // rounds along the timeline, so equality is the contract — and a 1ms
    // tolerance is precisely what let a double-rounding bug through.
    assert.equal(drift, 0, `phases do not tile the total (sum ${sum}ms vs total ${totalMs}ms): ${line}`);
    for (const want of ["resolve", "approve-gate", "dispose", "prep", "version", "client", "spawn+init", "new", "load", "replay(post)"]) {
      assert.ok(named.some((p) => p.name === want), `phase "${want}" missing from: ${line}`);
    }
    log(
      `checked: ${named.length} named phases + ${other ? `other ${other.ms}ms` : "no residue"} ` +
        `= total ${totalMs}ms (drift ${drift}ms, events ${events})`,
    );
  }

  const parsed = lines.map(parse);
  // NOT an assertion, and deliberately so. Opening a conversation from the rail
  // runs `this.focused = this.newLocalSession()` first, so the target is a fresh
  // object with no client and `dispose` is structurally 0 on this path — the
  // outgoing conversation is parked by `parkFocused()`, before the clock exists.
  // `dispose` earns its number on the restart path (same Session object), which
  // this check does not drive. Reported so a future reader does not mistake a
  // row of zeroes for "teardown is free".
  const switched = parsed.find((p) => (p.phases.find((x) => x.name === "dispose")?.ms ?? 0) > 0);
  log(
    switched
      ? `dispose measured ${switched.phases.find((x) => x.name === "dispose").ms}ms`
      : "dispose was 0ms on every open — expected here: a rail open builds a fresh session object",
  );
  // THE REGRESSION THIS CHECK EXISTS FOR. Counting lines proves nothing: the
  // app logs a line whether or not the clock starts at the click, and `resolve`
  // is printed as `0ms` when no caller owned one. With a heavy
  // `session-meta.json` in place the pre-start window is hundreds of
  // milliseconds, so a wired clock CANNOT report a near-zero resolve — and
  // unwiring it reports exactly zero.
  assert.ok(clicked.length >= 2, `only ${clicked.length} click(s) produced a timing line`);
  // NON-ZERO, not "at least 25ms". The regression makes `resolve` exactly 0 —
  // the phase is printed as 0ms when no caller owns a clock — so zero is the
  // functional signal. A millisecond floor would have been a claim about how
  // fast the machine is, and a fast enough machine would fail a correct build.
  // The heavy meta is still what makes the window comfortably measurable.
  const widestResolve = Math.max(...clicked.map((c) => c.resolveMs));
  // A FLOOR, not just non-zero. With the wiring removed `startSessionBody`
  // still makes its own clock a moment before measuring `resolve`, and a
  // scheduler pause of half a millisecond rounds that to `1ms` — so `> 0` can
  // pass on a broken build. The floor is justified by the fixture rather than
  // by machine speed: the 1.4MB `session-meta.json` this check writes costs
  // ~12ms to read and parse, and the cold-open path reads it before
  // `startSession`. Measured 11-264ms across both platforms; 5ms is well under
  // the smallest real value and well above the rounding it must reject.
  assert.ok(
    widestResolve >= 5,
    `widest resolve was ${widestResolve}ms against a 1.4MB session-meta.json — ` +
      `the open clock is no longer started by openSession, so the pre-start ` +
      `window is unmeasured again`,
  );
  // What the heartbeat saw. REPORTED, not asserted by default: the number is a
  // property of the machine as much as of the code, and a threshold that fails
  // on a loaded CI box would be a check nobody trusts. Set MAIN_STALL_MS to turn
  // it into a gate once a healthy range is known on the hardware that matters.
  const beat = await app.evaluate(() => globalThis.__mainHeartbeat || null);
  if (beat) {
    const worst = [...beat.stalls].sort((a, b) => b.late - a.late).slice(0, 5);
    console.log("\n----- main-process responsiveness -----");
    // TOTAL, not just the worst. Moving work out of a measured phase and into
    // the gap between two opens improves the line and changes nothing for the
    // person watching the window — only the sum says whether the thread got its
    // time back. Reading a single favourable `max` is how that mistake is made.
    const totalLate = beat.stalls.reduce((a2, s2) => a2 + s2.late, 0);
    console.log(`  heartbeat every ${beat.beat}ms; worst lateness ${beat.max}ms; ${beat.stalls.length} stall(s) over 100ms`);
    console.log(`  TOTAL time the main thread was unresponsive: ${totalLate}ms`);
    for (const s of worst) {
      const rel = Math.round((s.at - beat.startedAt) / 100) / 10;
      // ABSOLUTE time as well, because the useful question is WHICH phase was
      // running: the log lines above carry absolute stamps, and a stall that
      // lands inside an open's clock window is a different bug from one that
      // lands after the summary was printed (the post-open sweep).
      console.log(`    +${rel}s into the run (ended ${new Date(s.at).toISOString()}): main thread unresponsive for ${s.late}ms`);
    }
    console.log(`  (a freeze is lateness here, not a big total on the line above —`);
    console.log(`   run with FAKE_NEW_SESSION_DELAY_MS=3000 to see the difference)`);
    console.log("---------------------------------------");
    const gate = Number(process.env.MAIN_STALL_MS || 0);
    if (gate > 0) {
      assert.ok(
        beat.max < gate,
        `main process was unresponsive for ${beat.max}ms (limit ${gate}ms) — that is a frozen window, not a slow open`,
      );
    }
  }
  assert.ok(
    catalogOpens.every((open) => open.walks.length === 0),
    `expected zero catalog walks per rail open: ${catalogOpens.map((open) => `${JSON.stringify(open.name)}=${open.walks.length}`).join(", ")}`,
  );
  log(`PASS — zero catalog walks on all ${catalogOpens.length} rail opens; ${lines.length} real lines, every one accounting for its own total; widest resolve ${widestResolve}ms`);
  console.log("\n----- what the line does NOT cover -----");
  for (const p of preludes) {
    const share = p.prelude + p.totalMs > 0 ? Math.round((100 * p.prelude) / (p.prelude + p.totalMs)) : 0;
    console.log(`  ${p.name}: click→clock ${p.prelude}ms, clock ${p.totalMs}ms of which resolve ${p.resolveMs}ms  (${share}% still unlogged)`);
  }
  console.log("----------------------------------------");
} catch (e) {
  // A FLAG, not the thrown value: JavaScript lets you throw `undefined`, and
  // `failure ? 1 : 0` then printed FAIL and exited 0 — a red run reported green.
  failed = true;
  console.error(`[open-timing] FAIL ${e && e.message}`);
  console.error("log tail:");
  try {
    console.error(fs.readFileSync(logPath, "utf8").split(/\r?\n/).slice(-40).join("\n"));
  } catch {
    console.error(`  (no log file at ${logPath})`);
  }
} finally {
  if (app) await app.close().catch(() => {});
  // Both trees, not just the app's. Left behind, each run cost a QA fixture
  // plus a multi-megabyte synthesised metadata store.
  if (qa) { try { qa.cleanup(); } catch { /* best effort */ } }
  if (userData) fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5 });
}
process.exit(failed ? 1 : 0);
