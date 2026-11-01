// Integration tests for the ACP wire layer + plan-mode gate.
//
// Spawns the fake `grok agent stdio` from test/fixtures/fake-grok-acp.cjs
// (~150 lines, encodes only what the protocol requires — not grok version
// quirks) and drives src/acp.ts AcpClient against it over real JSON-RPC stdio.
// This catches the bugs the pure tests + DOM tests can't:
//
//   - Plan-snoop: when grok writes plan.md (outside workspace), the host's
//     fs/write_text_file handler must (a) allow the write and (b) emit a
//     `planFileContent` event so the review card has content.
//   - Workspace-write gate: when planActive is true, fs/write_text_file for a
//     path *inside* the workspace must be refused with PLAN_BLOCKED, and the
//     client must emit a `mutationBlocked` event so the UI can show a notice.
//   - Terminal-create gate: when planActive is true, mutating commands (rm,
//     npm install, etc.) must be refused at terminal/create; read-only ones
//     (ls, grep, head, etc.) must be allowed and reach the terminal handler.
//   - exit_plan_mode round-trip: the host receives an `exitPlanRequest` event
//     whose `plan` field is populated from the snooped plan.md content.
//
// Cross-platform: uses fake-grok-acp.cmd on Windows, fake-grok-acp.sh elsewhere
// (both wrap the .cjs script via node). Subprocess startup adds ~50–100ms per
// test — same order as the existing terminal-manager suite.
import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { AcpClient } from "../src/acp";
import { contextUsedFromCompactNotification } from "../src/acp-dispatch";

function fixtureCli(): string {
  const dir = path.join(__dirname, "fixtures");
  return process.platform === "win32"
    ? path.join(dir, "fake-grok-acp.cmd")
    : path.join(dir, "fake-grok-acp.sh");
}

beforeAll(() => {
  // git from a Windows checkout may strip the +x bit on the .sh wrapper. Make
  // sure it's executable so spawn() can run it directly on Linux/macOS CI.
  if (process.platform !== "win32") {
    const sh = path.join(__dirname, "fixtures", "fake-grok-acp.sh");
    try { fs.chmodSync(sh, 0o755); } catch { /* best-effort */ }
  }
});

/** Collect `mutationBlocked` events so tests can assert on the gate. */
function collect<T>(client: AcpClient, event: string): T[] {
  const out: T[] = [];
  client.on(event, (v) => out.push(v));
  return out;
}

/** Wait for a single event, with a small timeout so a hung subprocess fails the
 *  test instead of hanging vitest. */
/**
 * These bounds exist to fail a HUNG subprocess, not to measure how fast one
 * starts. At 2000ms this was the latter: `npm test` runs one worker per core
 * (20 here) and several files spawn real processes, so a cold Node start plus
 * an ACP handshake routinely lost the race. Measured 2026-08-19 on one commit:
 * 3-4 tests failed per run and a DIFFERENT set each time, while the same suite
 * with `--no-file-parallelism` was 168 files / 3818 tests green. A gate that
 * reports the machine's mood is worse than a slow one — a genuinely failing
 * test that day was first waved off as another flake.
 */
const SUBPROCESS_WAIT_MS = 15_000;

function waitFor<T>(client: AcpClient, event: string, timeoutMs = SUBPROCESS_WAIT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    client.once(event, (v) => { clearTimeout(t); resolve(v); });
  });
}

/** Poll until the captured stderr matches `re`. The fake CLI writes its
 *  *_RESPONSE marker to stderr just before the stdout response that resolves the
 *  prompt; stderr can lag stdout across pipes (reliably so on Linux), so asserting
 *  synchronously after the prompt resolves is racy. */
async function waitForStderr(arr: string[], re: RegExp, timeoutMs = SUBPROCESS_WAIT_MS): Promise<void> {
  const start = Date.now();
  while (!re.test(arr.join(""))) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`stderr never matched ${re}; got: ${JSON.stringify(arr.join(""))}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Bounded temp-dir removal. Windows refuses rmdir while a child still has
 *  the path as cwd; `kill()` does not wait for that, so a swallowed `rmSync`
 *  leaves an empty `grok-int-ws-*` behind (34,175 of them had accumulated).
 *  Retry after the process has exited, then fail visibly rather than leak.
 *
 *  The bound is generous on purpose. Failing loudly is the point — a silent
 *  catch is what let the leak grow — but the OS can hold the handle for
 *  seconds when the machine is busy running other agents, and a test that
 *  fails because the box was loaded is worse than the leak it prevents. At
 *  15s this throws only when removal is genuinely stuck. */
async function removeTempDir(dir: string | undefined, timeoutMs = 15000): Promise<void> {
  if (!dir) return;
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  for (;;) {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
      if (!fs.existsSync(dir)) return;
      lastErr = new Error("directory still exists");
    } catch (err) {
      lastErr = err;
      if (!fs.existsSync(dir)) return;
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const detail = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`failed to remove temp dir ${dir}: ${detail}`);
}

describe("ACP integration (real subprocess, fake CLI)", () => {
  let client: AcpClient;
  let workspace: string;
  let planHome: string;
  let stderr: string[];

  beforeEach(async () => {
    // Fresh temp dirs so the gate's workspace-vs-outside calculations are
    // deterministic per test, independent of where vitest was launched.
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "grok-int-ws-"));
    planHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-int-plan-"));
    const planPath = path.join(planHome, ".grok", "sessions", "cwd-x", "sess-y", "plan.md");
    // Bind the listener to a per-test local array, not the shared `stderr`
    // variable — otherwise a prior test's still-alive client can push late
    // stderr into the current test's array (cross-test bleed, flaky on Linux).
    // (@shugav fixed the same bleed independently in #6.)
    const captured: string[] = [];
    stderr = captured;

    client = new AcpClient({
      cliPath: fixtureCli(),
      cwd: workspace,
      env: {
        ...process.env,
        GROK_HOME: path.join(planHome, ".grok"),
        FAKE_WORKSPACE_ROOT: workspace,
        FAKE_PLAN_PATH: planPath,
      },
      log: () => {},
      grokVersion: "1.0.4",
      grokVersionVerified: true,
    });
    client.on("stderr", (t: string) => captured.push(t));

    // Wire up minimal fs/terminal handlers. Real fs writes for plan.md so we
    // can verify content lands on disk; in-memory terminal handler so we can
    // detect "was it called or blocked".
    client.fsRead = async (p) => fs.readFileSync(p, "utf8");
    client.fsWrite = async (p, content) => {
      const target = path.isAbsolute(p) ? p : path.join(workspace, p);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, "utf8");
    };
    let terminalCalls = 0;
    (client as any).terminal = {
      create: (params: { command: string }) => { terminalCalls += 1; return { terminalId: `t-${terminalCalls}` }; },
      output: () => ({ output: "", exitStatus: { exitCode: 0 }, truncated: false }),
      waitForExit: async () => ({ exitCode: 0 }),
      kill: () => {},
      release: () => {},
    };
    (client as any).__terminalCalls = () => terminalCalls;

    await client.start();
    await client.newSession();
  });

  afterEach(async () => {
    // Stop the old client emitting into anything before the next test starts.
    // `client` / dirs may be unset if beforeEach failed before assignment.
    const toStop = client as AcpClient | undefined;
    const ws = workspace as string | undefined;
    const home = planHome as string | undefined;
    try { toStop?.removeAllListeners(); } catch { /* */ }
    // Await the real exit (bounded). `kill()` only signals; on Windows the
    // workspace stays the live cwd until the process actually goes away.
    try { await toStop?.dispose(); } catch { /* process already gone */ }
    await removeTempDir(ws);
    await removeTempDir(home);
  });

  it("lifecycle: spawn → initialize → session/new succeeds and a basic prompt round-trips", async () => {
    expect(client.sessionId).toBe("fake-session-1");
    await waitForStderr(stderr, /INITIALIZE_CAPS:/);
    const capsLine = stderr.find((t) => t.includes("INITIALIZE_CAPS:"));
    const capsJson = capsLine!.slice(capsLine!.indexOf("INITIALIZE_CAPS:") + "INITIALIZE_CAPS:".length);
    expect(JSON.parse(capsJson)).toEqual({ fs: { writeTextFile: true }, terminal: true });
    const meta = await client.prompt("hello");
    expect(meta).toMatchObject({ totalTokens: 10 });
  });

  it("advertises the delegated handshake on grok 0.2.117", async () => {
    const captured: string[] = [];
    const legacy = new AcpClient({
      cliPath: fixtureCli(),
      cwd: workspace,
      env: {
        ...process.env,
        GROK_HOME: path.join(planHome, ".grok"),
        FAKE_WORKSPACE_ROOT: workspace,
      },
      log: () => {},
      grokVersion: "0.2.117",
    });
    legacy.on("stderr", (t: string) => captured.push(t));
    try {
      await legacy.start();
      await waitForStderr(captured, /INITIALIZE_CAPS:/);
      const capsLine = captured.find((t) => t.includes("INITIALIZE_CAPS:"));
      const capsJson = capsLine!.slice(capsLine!.indexOf("INITIALIZE_CAPS:") + "INITIALIZE_CAPS:".length);
      expect(JSON.parse(capsJson)).toEqual({
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      });
    } finally {
      try { legacy.removeAllListeners(); } catch { /* */ }
      try { await legacy.dispose(); } catch { /* */ }
    }
  });

  it("dispatches a final interject ACK before exposing immediate process exit", async () => {
    let accepted = false;
    let acceptedAtExit = false;
    const exitP = waitFor<number | null>(client, "exit");
    client.once("exit", () => { acceptedAtExit = accepted; });

    const resultP = client.interject("SCENARIO_INTERJECT_ACK_THEN_EXIT", () => {
      accepted = true;
    });

    await expect(resultP).resolves.toBe("ok");
    await exitP;
    expect(acceptedAtExit).toBe(true);
  });

  it("forwards interject content image blocks to the CLI", async () => {
    const b64 = Buffer.from("fake-png-bytes").toString("base64");
    await client.interject("look at this", undefined, [
      { type: "text", text: "look at [Image #1]" },
      { type: "image", mimeType: "image/png", data: b64 },
    ]);
    await waitForStderr(stderr, /INTERJECT_CONTENT:1:image\/png/);
  });

  it("vision: image content blocks cross the wire verbatim alongside the text block", async () => {
    const chunks: string[] = [];
    client.on("messageChunk", (t: string) => chunks.push(t));
    const b64 = Buffer.from("fake-png-bytes").toString("base64");
    await client.prompt([
      { type: "text", text: "SCENARIO_VISION_ECHO\n\n[Image #1]\n[Image #2]" },
      { type: "image", mimeType: "image/png", data: b64 },
      { type: "image", mimeType: "image/jpeg", data: b64 },
    ]);
    // The fake CLI echoes what it actually received: count, mimes, non-empty data.
    expect(chunks.join("")).toContain("vision:2:image/png,image/jpeg:true");
  });

  it("compact: auto_compact_completed on the _x.ai/session_notification rail surfaces as xaiNotification with tokens_after", async () => {
    const notes = collect<{ sessionUpdate?: string; tokens_after?: number }>(client, "xaiNotification");
    await client.prompt("SCENARIO_COMPACT_NOTIFY");
    const compact = notes.find((u) => u?.sessionUpdate === "auto_compact_completed");
    expect(compact).toBeDefined();
    expect(compact?.tokens_after).toBe(12345);
    // The host derives the donut's fresh `used` from exactly this payload.
    expect(contextUsedFromCompactNotification(compact)).toBe(12345);
  });

  it("reads the structured session/info meter without sending a prompt", async () => {
    const info = await client.getSessionInfo();
    expect(info).toEqual({
      used: 16017,
      window: 512000,
      systemPromptTokens: 1039,
      toolDefinitionsTokens: 812,
      messageTokens: 12166,
      freeTokens: 495983,
      autoCompactThresholdPercent: 92,
      categories: [{ label: "Skills", tokens: 1200 }],
    });
  });

  it("effort: setReasoningEffort sends set_model with _meta.reasoningEffort live (no restart), gated on the advertised capability", async () => {
    expect(client.currentModelSupportsEffort()).toBe(true); // fake model advertises it
    // Seeded from the advertised ACTIVE session effort (not the spawn default).
    expect(client.currentReasoningEffort).toBe("high");
    const applied = await client.setReasoningEffort("low");
    expect(applied).toBe(true);
    expect(client.currentReasoningEffort).toBe("low"); // updated on success
    await new Promise((r) => setTimeout(r, 150)); // let the fake's stderr echo flush
    const line = stderr.find((t) => t.includes("SET_MODEL:"));
    expect(line).toBeDefined();
    expect(line).toContain('"reasoningEffort":"low"');
    // Empty effort ("unset") is not expressible as a live override — must not fire a set_model.
    expect(await client.setReasoningEffort("")).toBe(false);
  });

  it("effort: a live override is CARRIED through a subsequent model switch (not dropped)", async () => {
    await client.setReasoningEffort("low");
    stderr.length = 0; // ignore the setReasoningEffort echo
    await client.setModel("fake-model");
    await new Promise((r) => setTimeout(r, 150));
    const line = stderr.find((t) => t.includes("SET_MODEL:"));
    expect(line).toBeDefined();
    expect(line).toContain('"reasoningEffort":"low"'); // switch re-sends the override
  });

  it.each(["low", "medium"])("startup: explicit effort overrides a %s Grok TOML default", async (configuredEffort) => {
    const logs: string[] = [];
    const effortClient = new AcpClient({
      cliPath: fixtureCli(),
      cwd: workspace,
      env: {
        ...process.env,
        GROK_HOME: path.join(planHome, ".grok"),
        FAKE_WORKSPACE_ROOT: workspace,
        FAKE_PLAN_PATH: path.join(planHome, ".grok", "sessions", "cwd-x", "sess-effort", "plan.md"),
        FAKE_CONFIG_EFFORT: configuredEffort,
      },
      effort: "high",
      log: (msg) => logs.push(msg),
    });

    try {
      const advertised: (string | undefined)[] = [];
      effortClient.on("session", () => advertised.push(effortClient.availableModels[0]?.reasoningEffort));
      await effortClient.start();
      await effortClient.newSession();
      expect(effortClient.currentReasoningEffort).toBe("high");
      expect(advertised).toEqual(["high"]);
      await waitForStderr(logs, /SET_MODEL:/);
      expect(logs.join("\n")).toContain('"reasoningEffort":"high"');

      // The fixture exits 2 on any argv it doesn't recognize, so a successful
      // session proves the forwarded shape (`agent --reasoning-effort high stdio`)
      // is what the extension sent.
      expect(effortClient.sessionId).toBe("fake-session-1");
      expect(logs.join("\n")).toContain("--reasoning-effort high");
      expect(logs.join("\n")).toContain("agent --reasoning-effort high stdio");
    } finally {
      effortClient.dispose();
    }
  });

  it("plan-snoop: grok's plan.md write is allowed AND emits planFileContent with the text", async () => {
    client.planActive = true; // gate is up, but plan.md (outside workspace) must still be allowed
    const planFireP = waitFor<string>(client, "planFileContent");
    const exitFireP = waitFor<any>(client, "exitPlanRequest");

    const promptP = client.prompt("SCENARIO_PROPOSE_PLAN");
    const planText = await planFireP;
    expect(planText).toContain("TEST PLAN");

    const exitReq = await exitFireP;
    expect(exitReq.sessionId).toBe("fake-session-1");
    // The host responds via respondExitPlan; the fake CLI doesn't care which
    // verdict — just complete the round-trip so the prompt resolves.
    client.respondExitPlan(exitReq.id, "rejected");

    await promptP;
    // plan.md actually landed on disk (the fsWrite handler ran, so the gate
    // allowed it despite planActive=true).
    const planPathFromEnv = (client as any).opts.env.FAKE_PLAN_PATH;
    expect(fs.existsSync(planPathFromEnv)).toBe(true);
    expect(fs.readFileSync(planPathFromEnv, "utf8")).toContain("TEST PLAN");
  });

  it("gate: planActive=true blocks fs/write_text_file inside the workspace", async () => {
    client.planActive = true;
    const blocked = collect<{ kind: string; target: string }>(client, "mutationBlocked");

    await client.prompt("SCENARIO_WORKSPACE_WRITE");

    expect(blocked).toHaveLength(1);
    expect(blocked[0].kind).toBe("write");
    // Normalize slashes — the fake CLI uses `+ "/"` on its end, so the path
    // arrives as forward-slash; the host's gate works either way.
    expect(blocked[0].target.replace(/\\/g, "/")).toBe(workspace.replace(/\\/g, "/") + "/file.ts");
    // The fake CLI got an error reply (visible on its stderr).
    await waitForStderr(stderr, /WRITE_RESPONSE.*"error"/);
    expect(stderr.join("")).toMatch(/WRITE_RESPONSE.*"error"/);
    // And no file landed on disk.
    expect(fs.existsSync(path.join(workspace, "file.ts"))).toBe(false);
  });

  it("gate: planActive=true blocks relative fs/write_text_file paths inside the workspace", async () => {
    client.planActive = true;
    const blocked = collect<{ kind: string; target: string }>(client, "mutationBlocked");

    await client.prompt("SCENARIO_RELATIVE_WORKSPACE_WRITE");

    expect(blocked).toHaveLength(1);
    expect(blocked[0].kind).toBe("write");
    expect(blocked[0].target).toBe("relative-file.ts");
    // `mutationBlocked` fires host-side; the CLI's WRITE_RESPONSE still has to
    // come back down the pipe and be flushed. Asserting straight off `blocked`
    // is a race, and it is the sibling test above that shows the wait is the
    // point rather than a formality.
    await waitForStderr(stderr, /WRITE_RESPONSE.*"error"/);
    expect(stderr.join("")).toMatch(/WRITE_RESPONSE.*"error"/);
    expect(fs.existsSync(path.join(workspace, "relative-file.ts"))).toBe(false);
  });

  it("gate: planActive=false allows fs/write_text_file inside the workspace", async () => {
    client.planActive = false;
    const blocked = collect<unknown>(client, "mutationBlocked");

    await client.prompt("SCENARIO_WORKSPACE_WRITE");

    expect(blocked).toHaveLength(0);
    expect(fs.readFileSync(path.join(workspace, "file.ts"), "utf8")).toBe("// new file");
  });

  it("gate: planActive=true blocks terminal/create with a mutating command", async () => {
    client.planActive = true;
    const blocked = collect<{ kind: string; target: string }>(client, "mutationBlocked");

    await client.prompt("SCENARIO_MUTATING_TERMINAL");

    expect(blocked).toHaveLength(1);
    expect(blocked[0].kind).toBe("terminal");
    expect(blocked[0].target).toContain("rm");
    expect((client as any).__terminalCalls()).toBe(0); // handler was never reached
  });

  it("gate: planActive=true blocks terminal/create with mutating args on an otherwise read-only head", async () => {
    client.planActive = true;
    const blocked = collect<{ kind: string; target: string }>(client, "mutationBlocked");

    await client.prompt("SCENARIO_MUTATING_READONLY_HEAD_TERMINAL");

    expect(blocked).toHaveLength(1);
    expect(blocked[0].kind).toBe("terminal");
    expect(blocked[0].target).toContain("sed");
    expect((client as any).__terminalCalls()).toBe(0);
  });

  it("gate: planActive=true allows terminal/create with a read-only command (ls)", async () => {
    client.planActive = true;
    const blocked = collect<unknown>(client, "mutationBlocked");

    await client.prompt("SCENARIO_READONLY_TERMINAL");

    expect(blocked).toHaveLength(0);
    expect((client as any).__terminalCalls()).toBe(1); // handler was called → command allowed
  });

  // Regression (#12): grok's x.ai/ask_user_question must get a response with the
  // `outcome` tag. The old catch-all replied `{}` → "missing field outcome" and
  // the tool failed. The host now emits a `questionRequest`; respondQuestion
  // sends { outcome: "accepted", answers, annotations }.
  it("ask_user_question: host emits questionRequest and respondQuestion replies with outcome:accepted", async () => {
    const reqP = waitFor<any>(client, "questionRequest");
    const promptP = client.prompt("SCENARIO_ASK_QUESTION");

    const req = await reqP;
    expect(req.sessionId).toBe("fake-session-1");
    expect(req.questions[0].question).toBe("Pick one?");
    expect(req.questions[0].options[0].label).toBe("Option A");

    client.respondQuestion(req.id, { "Pick one?": "Option A" });

    await promptP;
    // The fake CLI echoes the host's reply on stderr — assert grok received a
    // well-formed accepted outcome, not a bare {}.
    await waitForStderr(stderr, /ASK_RESPONSE.*"outcome":"accepted"/);
    expect(stderr.join("")).toMatch(/"answers":\{"Pick one\?":"Option A"\}/);
  });

  // Regression: grok ≥0.2.33 echoes the *live* prompt back as a
  // user_message_chunk (0.2.3 did not — the fake CLI now models this on every
  // prompt). The wire client surfaces it as a `userMessageChunk` event;
  // sidebar.ts gates forwarding to replay-only so the optimistic live bubble
  // isn't doubled. Here we prove the event reaches the client during a live
  // prompt — the trigger the host's gate guards against.
  it("user_message_chunk: a live echo surfaces as a userMessageChunk event on the client", async () => {
    const echoes = collect<string>(client, "userMessageChunk");

    await client.prompt("investigate the parser");

    expect(echoes).toContain("investigate the parser");
  });

  // Regression (HIGH): writing to the CLI's stdin after the pipe is gone must
  // not crash the extension host. Pre-fix, respond*/cancel did a bare
  // `this.proc?.stdin.write(...)` — a destroyed pipe throws ERR_STREAM_DESTROYED
  // and (lacking a `stdin` 'error' listener) became an uncaught host exception.
  it("respond*/cancel swallow stdin write failures instead of crashing", async () => {
    // Simulate a destroyed pipe that throws on write, the way Node's stdin does
    // after the child exits.
    const originalStdin = (client as any).proc.stdin;
    (client as any).proc.stdin = {
      writable: true,
      write() {
        throw new Error("write EPIPE / ERR_STREAM_DESTROYED");
      },
      destroy() {},
    };

    try {
      expect(client.respondPermission(1, "opt-1")).toBe(false);
      expect(client.respondExitPlan(2, "rejected")).toBe(false);
      await expect(client.cancel()).resolves.toBe(false);
    } finally { (client as any).proc.stdin = originalStdin; }
  });

  it("session/load replays chat_history.jsonl from GROK_HOME before resolving", async () => {
    const resumeId = "stored-resume-1";
    const dir = path.join(planHome, ".grok", "sessions", encodeURIComponent(workspace), resumeId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ session_id: resumeId }));
    fs.writeFileSync(
      path.join(dir, "chat_history.jsonl"),
      [
        JSON.stringify({ type: "user", content: "<user_query>stored question</user_query>" }),
        JSON.stringify({ type: "assistant", content: "stored answer" }),
      ].join("\n"),
    );

    const resumeClient = new AcpClient({
      cliPath: fixtureCli(),
      cwd: workspace,
      env: {
        ...process.env,
        GROK_HOME: path.join(planHome, ".grok"),
        FAKE_WORKSPACE_ROOT: workspace,
      },
      log: () => {},
    });
    const users: string[] = [];
    const agents: string[] = [];
    resumeClient.on("userMessageChunk", (t: string) => users.push(t));
    resumeClient.on("messageChunk", (t: string) => agents.push(t));
    try {
      await resumeClient.start();
      const loaded = await resumeClient.loadSession(resumeId);
      expect(loaded.sessionId).toBe(resumeId);
      expect(users.join("")).toContain("stored question");
      expect(agents.join("")).toContain("stored answer");
    } finally {
      resumeClient.dispose();
    }
  });

  it("unique mode: two ACP processes mint distinct session ids", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const extra = new AcpClient({
        cliPath: fixtureCli(),
        cwd: workspace,
        env: {
          ...process.env,
          GROK_HOME: path.join(planHome, ".grok"),
          FAKE_WORKSPACE_ROOT: workspace,
          FAKE_UNIQUE_SESSION_IDS: "1",
        },
        log: () => {},
      });
      try {
        await extra.start();
        const created = await extra.newSession();
        ids.push(created.sessionId);
      } finally {
        extra.dispose();
      }
    }
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^fake-session-\d+-1$/);
    expect(ids[1]).toMatch(/^fake-session-\d+-1$/);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("session/load: later notifications keep the loaded id, not a pid-derived one", async () => {
    const resumeId = "kept-across-restart";
    const dir = path.join(planHome, ".grok", "sessions", encodeURIComponent(workspace), resumeId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ session_id: resumeId }));

    const resumeClient = new AcpClient({
      cliPath: fixtureCli(),
      cwd: workspace,
      env: {
        ...process.env,
        GROK_HOME: path.join(planHome, ".grok"),
        FAKE_WORKSPACE_ROOT: workspace,
        FAKE_UNIQUE_SESSION_IDS: "1",
      },
      log: () => {},
    });
    const echoes: string[] = [];
    resumeClient.on("userMessageChunk", (t: string) => echoes.push(t));
    try {
      await resumeClient.start();
      const loaded = await resumeClient.loadSession(resumeId);
      expect(loaded.sessionId).toBe(resumeId);
      await resumeClient.prompt("hello after load");
      // isForeignSessionUpdate drops chunks whose sessionId is not the loaded
      // one — a pid-derived constant after restart would make this silent.
      expect(echoes).toContain("hello after load");
    } finally {
      resumeClient.dispose();
    }
  });

  it("a write to a non-writable stdin is skipped, not attempted", () => {
    let called = false;
    const originalStdin = (client as any).proc.stdin;
    (client as any).proc.stdin = {
      writable: false,
      write() {
        called = true;
        throw new Error("should never be called");
      },
      destroy() {},
    };
    try {
      expect(client.respondPermission(1, "opt-1")).toBe(false);
      expect(called).toBe(false);
    } finally { (client as any).proc.stdin = originalStdin; }
  });
});
