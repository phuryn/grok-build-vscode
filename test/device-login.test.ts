/**
 * Device-code sign-in — the pure half, and the runner over a fake process.
 *
 * The fixtures here are not invented. `GROK_REAL` is the exact bytes
 * `grok login --device-auth` wrote to stderr on 2026-08-26, escape codes
 * included, and `CLAUDE_REAL` is the exact bytes `claude auth login` wrote to
 * a plain pipe on 2.1.251. Both behaviours drove the design, so both are
 * pinned: a change that makes the parser stricter has to keep reading the
 * real thing, and a change that makes the runner more patient has to keep
 * noticing a CLI that will never speak.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import {
  classifyDeviceLoginFailure,
  deviceLoginEnv,
  deviceLoginFailureText,
  deviceLoginPlan,
  deviceLoginPreflight,
  deviceLoginUnavailable,
  noRemoteSignInMessage,
  DEVICE_LOGIN_PROMPT_TIMEOUT_MS,
  parseClaudeAuthStatus,
  parseDeviceLoginPrompt,
  stripAnsi,
} from "../src/device-login";
import { probeClaudeAuthStatus, runDeviceLogin, type DeviceLoginIo } from "../src/device-login-run";

const ESC = String.fromCharCode(27);

/** Verbatim from `grok login --device-auth`, stderr, piped stdio, grok 1.0.5. */
const GROK_REAL = [
  "",
  "To sign in, open this URL in your browser:",
  "",
  "  https://accounts.x.ai/oauth2/device?user_code=SDCN-9XZS",
  "",
  "Confirm this code in your browser:",
  "",
  "  SDCN-9XZS",
  "",
  `${ESC}[90mOnly continue with a code you requested. Don't share it with anyone.${ESC}[0m`,
  "",
  "Waiting for authorization...",
].join("\n");

/** Verbatim from `claude auth login`, piped stdio, claude 2.1.251. */
const CLAUDE_REAL = [
  "Opening browser to sign in…",
  "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=…&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=…&code_challenge=…&state=…",
  "Paste code here if prompted > ",
].join("\n");

describe("reading what the CLI printed", () => {
  it("reads the measured Muse login URL and code without a paste-code prompt", () => {
    expect(parseDeviceLoginPrompt(
      "Open this page to sign in:  https://auth.meta.com/oauth/device/?code=FLVM-CRRJ\n"
      + "confirm this code matches:  FLVM-CRRJ\nWaiting for approval…",
    )).toEqual({ url: "https://auth.meta.com/oauth/device/?code=FLVM-CRRJ", code: "FLVM-CRRJ" });
  });
  it("finds the URL and code in real grok output", () => {
    expect(parseDeviceLoginPrompt(GROK_REAL)).toEqual({
      url: "https://accounts.x.ai/oauth2/device?user_code=SDCN-9XZS",
      code: "SDCN-9XZS",
    });
  });

  it("does not drag an escape sequence into the URL", () => {
    const coloured = `${ESC}[36mhttps://example.test/device?user_code=AAAA-BBBB${ESC}[0m`;
    expect(parseDeviceLoginPrompt(coloured)?.url).toBe("https://example.test/device?user_code=AAAA-BBBB");
  });

  it("strips OSC hyperlinks without swallowing the rest of the line", () => {
    const osc = `${ESC}]8;;https://hidden.test${ESC}\\link${ESC}]8;;${ESC}\\ https://real.test/d?code=ZZZZ-1111`;
    expect(parseDeviceLoginPrompt(osc)?.url).toBe("https://real.test/d?code=ZZZZ-1111");
  });

  it("prefers the code carried in the URL over a lookalike elsewhere", () => {
    const text = "SOME-THING went wrong earlier\nhttps://x.test/d?user_code=REAL-CODE";
    expect(parseDeviceLoginPrompt(text)?.code).toBe("REAL-CODE");
  });

  it("falls back to a bare code when the URL carries none", () => {
    const text = "Open https://x.test/device\nthen enter  WDJB-MJHT";
    expect(parseDeviceLoginPrompt(text)).toEqual({ url: "https://x.test/device", code: "WDJB-MJHT" });
  });

  it("does not mistake ordinary prose for a code", () => {
    const text = "Open https://x.test/device and wait\nWaiting for authorization...";
    expect(parseDeviceLoginPrompt(text)).toEqual({ url: "https://x.test/device" });
  });

  it("finds the URL in real claude auth login output, and does not take code=true as a chip", () => {
    expect(parseDeviceLoginPrompt(CLAUDE_REAL)).toEqual({
      url: "https://claude.com/cai/oauth/authorize?code=true&client_id=…&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=…&code_challenge=…&state=…",
    });
  });

  it("is undefined until a URL exists — a code with nowhere to type it is not a prompt", () => {
    expect(parseDeviceLoginPrompt("your code is WDJB-MJHT")).toBeUndefined();
    expect(parseDeviceLoginPrompt("")).toBeUndefined();
  });

  it("drops sentence punctuation that is not part of the URL", () => {
    expect(parseDeviceLoginPrompt("Go to https://x.test/device.")?.url).toBe("https://x.test/device");
  });

  it("survives being handed a partial first chunk", () => {
    // The runner parses on every chunk, so half a URL must not become a prompt
    // that is then never corrected.
    const half = "To sign in, open this URL in your browser:\n\n  https://accounts.x.ai/oauth2/dev";
    const prompt = parseDeviceLoginPrompt(half);
    // It does match — a URL prefix IS a URL shape — but it carries no code, and
    // the panel shows a code only when there is one. What must not happen is a
    // WRONG code.
    expect(prompt?.code).toBeUndefined();
  });

  it("strips ANSI without touching ordinary text", () => {
    expect(stripAnsi(`${ESC}[90mplain${ESC}[0m`)).toBe("plain");
    expect(stripAnsi("nothing to strip")).toBe("nothing to strip");
  });
});

describe("which providers have a headless flow", () => {
  it("uses Muse's login subcommand, which skips workspace trust and polls on pipes", () => {
    expect(deviceLoginPlan("muse")).toEqual({ args: ["login"] });
    expect(deviceLoginPlan("muse")?.needsCode).toBeUndefined();
  });
  it("offers one for grok and codex", () => {
    expect(deviceLoginPlan("grok")).toEqual({ args: ["login", "--device-auth"] });
    expect(deviceLoginPlan("codex")).toEqual({ args: ["login", "--device-auth"] });
  });

  it("offers paste-code for claude, named on the plan rather than inferred", () => {
    expect(deviceLoginPlan("claude")).toEqual({ args: ["auth", "login"], needsCode: true });
    expect(deviceLoginPlan("grok")?.needsCode).toBeUndefined();
    expect(deviceLoginPlan("codex")?.needsCode).toBeUndefined();
  });

  it("has nothing to explain for the providers that work, including claude", () => {
    expect(deviceLoginUnavailable("grok")).toBeUndefined();
    expect(deviceLoginUnavailable("codex")).toBeUndefined();
    expect(deviceLoginUnavailable("claude")).toBeUndefined();
    expect(deviceLoginUnavailable("claude", { isCloud: true })).toBeUndefined();
  });
});

describe("classifying a failure", () => {
  it("reads clap's rejection of an unknown flag as an old CLI", () => {
    const out = "error: unexpected argument '--device-auth' found\n\nUsage: codex login [OPTIONS]";
    expect(classifyDeviceLoginFailure(out, false)).toBe("unsupported");
  });

  it("reads the workspace-admin refusal as a permission problem", () => {
    const out = "Please contact your workspace admin to enable device code authentication";
    expect(classifyDeviceLoginFailure(out, false)).toBe("not-permitted");
  });

  it("separates never-printed-a-prompt from printed-then-gave-up", () => {
    expect(classifyDeviceLoginFailure("", false)).toBe("no-prompt");
    expect(classifyDeviceLoginFailure("timed out waiting", true)).toBe("failed");
  });

  it("says something actionable for each failure", () => {
    for (const failure of ["unsupported", "not-permitted", "no-prompt", "failed"] as const) {
      const text = deviceLoginFailureText("codex", failure, "Codex");
      expect(text.length).toBeGreaterThan(20);
      expect(text).toContain("Codex");
    }
  });

  it("names the exact ChatGPT setting for codex, because that is the fix", () => {
    expect(deviceLoginFailureText("codex", "not-permitted", "Codex")).toContain("Allow device code login");
  });
});

describe("the environment a headless login runs in", () => {
  it("says in every dialect that nobody is here to answer", () => {
    const env = deviceLoginEnv({ PATH: "/usr/bin" });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.CI).toBe("1");
    expect(env.TERM).toBe("dumb");
    expect(env.NO_COLOR).toBe("1");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("refuses to open a browser on an unattended desk", () => {
    expect(deviceLoginEnv({}).BROWSER).toBe("none");
  });

  it("does not set CI when the flow must wait for a pasted code", () => {
    const env = deviceLoginEnv({ PATH: "/usr/bin" }, { needsCode: true });
    expect(env.CI).toBeUndefined();
    expect(env.BROWSER).toBe("none");
  });
});

describe("reading claude auth status", () => {
  it("treats loggedIn true as signed in", () => {
    expect(parseClaudeAuthStatus('{"loggedIn": true, "authMethod": "claudeai"}')).toBe(true);
  });

  it("treats loggedIn false as not signed in", () => {
    expect(parseClaudeAuthStatus('{"loggedIn": false, "authMethod": "none"}')).toBe(false);
  });

  it("is undefined when the output is not that JSON", () => {
    expect(parseClaudeAuthStatus("not json")).toBeUndefined();
    expect(parseClaudeAuthStatus("{}")).toBeUndefined();
  });
});

/** A child process that tests can drive. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { writes: [] as string[], write(chunk: string) { this.writes.push(String(chunk)); return true; } };
  killed: string[] = [];
  kill(signal?: string) {
    this.killed.push(signal ?? "SIGTERM");
    return true;
  }
}

function fakeIo(): { io: DeviceLoginIo; child: FakeChild; calls: unknown[][] } {
  const child = new FakeChild();
  const calls: unknown[][] = [];
  const io = {
    spawn: ((...args: unknown[]) => {
      calls.push(args);
      return child;
    }) as unknown as DeviceLoginIo["spawn"],
  };
  return { io, child, calls };
}

describe("device login shell policy", () => {
  it.skipIf(process.platform !== "win32").each(["grok", "codex", "claude", "muse"] as const)(
    "starts %s login and receives its URL from a real shim in a spaced path", async provider => {
      const dir = mkdtempSync(join(tmpdir(), "Login install with spaces "));
      try {
        const executable = join(dir, `${provider}.cmd`);
        writeFileSync(executable, "@echo off\r\necho https://example.com/device?user_code=ABCD-1234\r\n");
        const onPrompt = vi.fn();
        const plan = deviceLoginPlan(provider);
        const result = await new Promise(resolve => runDeviceLogin(executable, plan.args,
          { onPrompt, onDone: resolve }, undefined, process.env, { needsCode: !!plan.needsCode }));
        expect({ result, prompts: onPrompt.mock.calls }).toEqual({
          result: { ok: true, output: expect.stringContaining("https://example.com/device") },
          prompts: [[expect.objectContaining({ url: "https://example.com/device?user_code=ABCD-1234" })]],
        });
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  afterEach(() => Object.defineProperty(process, "platform", platformDescriptor));

  it.each([
    ["win32", String.raw`C:\Users\Dell\AppData\Local\Programs\muse\muse.cmd`, true],
    ["win32", String.raw`C:\muse\muse.BAT`, true],
    ["win32", String.raw`C:\muse\muse.exe`, false],
    ["linux", "/home/u/.local/bin/muse", false],
    ["darwin", "/home/u/.local/bin/muse", false],
    ["linux", "/home/u/.local/bin/muse.cmd", false],
  ] as const)("on %s launches %s with shell=%s", (platform, executable, shell) => {
    Object.defineProperty(process, "platform", { value: platform });
    const { io, child, calls } = fakeIo();
    runDeviceLogin(executable, ["login"], { onPrompt: vi.fn(), onDone: vi.fn() }, io, {});
    child.emit("close", 0);
    expect(calls[0]).toEqual([shell ? `"${executable}"` : executable, ["login"], expect.objectContaining({ shell })]);
  });

  it("keeps Claude paste-code stdin piped through the win32 shell", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const { io, child, calls } = fakeIo();
    const handle = runDeviceLogin(String.raw`C:\claude\claude.cmd`, ["auth", "login"],
      { onPrompt: vi.fn(), onDone: vi.fn() }, io, {}, { needsCode: true });
    handle.submitCode("  paste-me-now  ");
    child.emit("close", 0);
    expect(calls[0][2]).toMatchObject({ shell: true, stdio: ["pipe", "pipe", "pipe"] });
    expect(child.stdin.writes).toEqual(["paste-me-now\n"]);
  });
});

describe("running one", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reports the prompt from stderr as soon as it lands, long before exit", () => {
    const { io, child } = fakeIo();
    const onPrompt = vi.fn();
    const onDone = vi.fn();
    runDeviceLogin("/bin/grok", ["login", "--device-auth"], { onPrompt, onDone }, io, {});

    child.stderr.emit("data", GROK_REAL);

    expect(onPrompt).toHaveBeenCalledWith({
      url: "https://accounts.x.ai/oauth2/device?user_code=SDCN-9XZS",
      code: "SDCN-9XZS",
    });
    // The whole point: the code is usable while the child is still polling.
    expect(onDone).not.toHaveBeenCalled();
  });

  it("reports it only once, however many chunks arrive", () => {
    const { io, child } = fakeIo();
    const onPrompt = vi.fn();
    runDeviceLogin("/bin/grok", [], { onPrompt, onDone: vi.fn() }, io, {});
    child.stderr.emit("data", GROK_REAL);
    child.stderr.emit("data", "Waiting for authorization...\n");
    child.stderr.emit("data", "Waiting for authorization...\n");
    expect(onPrompt).toHaveBeenCalledTimes(1);
  });

  it("closes stdin, so a CLI waiting for input cannot look like one that is working", () => {
    const { io, calls } = fakeIo();
    runDeviceLogin("/bin/grok", [], { onPrompt: vi.fn(), onDone: vi.fn() }, io, {});
    const options = calls[0][2] as { stdio: string[]; windowsHide: boolean };
    expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(options.windowsHide).toBe(true);
  });

  it("opens stdin only for a paste-code plan, stamps needsCode, and writes the code plus a newline", () => {
    const { io, child, calls } = fakeIo();
    const onPrompt = vi.fn();
    const handle = runDeviceLogin(
      "/bin/claude",
      ["auth", "login"],
      { onPrompt, onDone: vi.fn() },
      io,
      {},
      { needsCode: true },
    );
    const options = calls[0][2] as { stdio: string[]; env: NodeJS.ProcessEnv };
    expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(options.env.CI).toBeUndefined();

    child.stdout.emit("data", CLAUDE_REAL);
    expect(onPrompt).toHaveBeenCalledWith({
      url: "https://claude.com/cai/oauth/authorize?code=true&client_id=…&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=…&code_challenge=…&state=…",
      needsCode: true,
    });

    handle.submitCode("  paste-me-now  ");
    expect(child.stdin.writes).toEqual(["paste-me-now\n"]);
    handle.submitCode("second-try");
    expect(child.stdin.writes).toHaveLength(1);
  });

  it("does not write an empty paste", () => {
    const { io, child } = fakeIo();
    const handle = runDeviceLogin("/bin/claude", [], { onPrompt: vi.fn(), onDone: vi.fn() }, io, {}, { needsCode: true });
    handle.submitCode("   ");
    expect(child.stdin.writes).toEqual([]);
  });

  it("gives up on a CLI that never speaks, rather than spinning for fifteen minutes", () => {
    const { io, child } = fakeIo();
    const onDone = vi.fn();
    runDeviceLogin("/bin/claude", ["setup-token"], { onPrompt: vi.fn(), onDone }, io, {});

    // The measured claude case: zero bytes on both streams.
    vi.advanceTimersByTime(DEVICE_LOGIN_PROMPT_TIMEOUT_MS + 1);

    expect(child.killed.length).toBeGreaterThan(0);
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ ok: false, failure: "no-prompt" }));
  });

  it("does not start that clock over once the prompt has arrived", () => {
    const { io, child } = fakeIo();
    const onDone = vi.fn();
    runDeviceLogin("/bin/grok", [], { onPrompt: vi.fn(), onDone }, io, {});
    child.stderr.emit("data", GROK_REAL);

    // A real device code lives ~15 minutes and the child polls the whole time.
    vi.advanceTimersByTime(DEVICE_LOGIN_PROMPT_TIMEOUT_MS * 4);

    expect(onDone).not.toHaveBeenCalled();
    expect(child.killed).toEqual([]);
  });

  it("succeeds on exit 0", () => {
    const { io, child } = fakeIo();
    const onDone = vi.fn();
    runDeviceLogin("/bin/grok", [], { onPrompt: vi.fn(), onDone }, io, {});
    child.stderr.emit("data", GROK_REAL);
    child.emit("close", 0);
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });

  it("classifies a non-zero exit from what the CLI said", () => {
    const { io, child } = fakeIo();
    const onDone = vi.fn();
    runDeviceLogin("/bin/codex", [], { onPrompt: vi.fn(), onDone }, io, {});
    child.stderr.emit("data", "error: unexpected argument '--device-auth' found");
    child.emit("close", 2);
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ ok: false, failure: "unsupported" }));
  });

  it("settles exactly once when cancel races the child's own exit", () => {
    const { io, child } = fakeIo();
    const onDone = vi.fn();
    const handle = runDeviceLogin("/bin/grok", [], { onPrompt: vi.fn(), onDone }, io, {});
    handle.cancel();
    child.emit("close", 1);
    handle.cancel();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ cancelled: true }));
  });

  it("does not settle twice when the child errors after closing", () => {
    const { io, child } = fakeIo();
    const onDone = vi.fn();
    runDeviceLogin("/bin/grok", [], { onPrompt: vi.fn(), onDone }, io, {});
    child.emit("close", 0);
    child.emit("error", new Error("late"));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });

  it("survives a spawn that throws outright", () => {
    const onDone = vi.fn();
    const io = {
      spawn: (() => {
        throw new Error("ENOENT");
      }) as unknown as DeviceLoginIo["spawn"],
    };
    const handle = runDeviceLogin("/nope", [], { onPrompt: vi.fn(), onDone }, io, {});
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ ok: false, failure: "failed" }));
    expect(() => handle.cancel()).not.toThrow();
    expect(() => handle.submitCode("x")).not.toThrow();
  });
});

describe("claude auth status over the spawn seam", () => {
  it("passes consent cancellation to the child and skips a withdrawn consent", async () => {
    const { io, child, calls } = fakeIo();
    const controller = new AbortController();
    const pending = probeClaudeAuthStatus("/bin/claude", io, {}, controller.signal);
    expect(calls[0][2]).toMatchObject({ signal: controller.signal, windowsHide: true });
    controller.abort();
    // Node's spawn reports AbortError when its signal kills the child.
    child.emit("error", new Error("AbortError"));
    await expect(pending).resolves.toBeUndefined();
    await expect(probeClaudeAuthStatus("/bin/claude", io, {}, controller.signal)).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });
  it("treats loggedIn true as success", async () => {
    const { io, child } = fakeIo();
    const pending = probeClaudeAuthStatus("/bin/claude", io, {});
    child.stdout.emit("data", '{"loggedIn": true, "authMethod": "claudeai"}\n');
    child.emit("close", 0);
    await expect(pending).resolves.toBe(true);
  });

  it("treats loggedIn false as not signed in", async () => {
    const { io, child } = fakeIo();
    const pending = probeClaudeAuthStatus("/bin/claude", io, {});
    child.stdout.emit("data", '{"loggedIn": false, "authMethod": "none"}\n');
    child.emit("close", 0);
    await expect(pending).resolves.toBe(false);
  });
});

describe("what we say when a provider cannot be signed in from here", () => {
  it("does not send a cloud environment to a computer that does not exist", () => {
    const desk = noRemoteSignInMessage("SomeAgent");
    expect(desk).toContain("at your computer");

    const cloud = noRemoteSignInMessage("SomeAgent", { isCloud: true });
    expect(cloud).not.toContain("at your computer");
    expect(cloud).toContain("from here");
    expect(cloud).not.toMatch(/Claude/);
    expect(cloud).not.toContain("working on adding it");
  });
});

describe("the Codex preflight names where the setting actually is", () => {
  it("marks up the location, because people could not find it", () => {
    const pf = deviceLoginPreflight("codex", { isCloud: true });
    const step = (pf?.steps ?? []).find((s) => s.includes("Device code authorization"));
    expect(step).toBeDefined();
    // `**` is the panel's inline-bold marker (media/chat.js), applied AFTER
    // escaping so the host cannot inject markup through a step string.
    expect(step).toContain("**at the very bottom**");
  });

  it("is cloud-only and codex-only", () => {
    expect(deviceLoginPreflight("codex")).toBeUndefined();
    expect(deviceLoginPreflight("grok", { isCloud: true })).toBeUndefined();
    expect(deviceLoginPreflight("claude", { isCloud: true })).toBeUndefined();
  });
});
