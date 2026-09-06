import { describe, it, expect } from "vitest";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { TerminalManager, resolveExitCode, buildKillPlan, resolveTerminalShell, posixShellFromEnv, grokShellEnvValue, commandLanguageForDialect, unwrapGrokBashLoginWrapper, posixSpawnArgv, parseOneShellWord } from "../src/terminal-manager";

// Use `node -e` everywhere so tests are deterministic on Windows, macOS, and Linux.
// Quoting strategy: single-quote the outer node script, escape inner single quotes if any.
const nodeEval = (script: string) => `node -e "${script.replace(/"/g, '\\"')}"`;

describe("TerminalManager", () => {
  it("captures stdout from a quick command", async () => {
    const m = new TerminalManager();
    const { terminalId } = m.create({ command: nodeEval("process.stdout.write('HELLO_TM')") });
    const { exitCode } = await m.waitForExit(terminalId);
    expect(exitCode).toBe(0);
    const r = m.output(terminalId);
    expect(r.output).toContain("HELLO_TM");
    expect(r.exitStatus).toEqual({ exitCode: 0 });
    expect(r.truncated).toBe(false);
    m.release(terminalId);
  });

  it("captures stderr and nonzero exit", async () => {
    const m = new TerminalManager();
    const { terminalId } = m.create({
      command: nodeEval("process.stderr.write('ERR'); process.exit(7)"),
    });
    const r = await m.waitForExit(terminalId);
    // The Windows host is PowerShell (#46). Windows PowerShell 5.1 collapses any
    // non-zero native exit to 1 (pwsh 7 preserves the exact code); /bin/sh passes
    // it through. Assert failure is detected everywhere, exact code only off-win32
    // (this box may resolve to 5.1, so don't assert exactly 7 on Windows).
    expect(r.exitCode).not.toBe(0);
    if (process.platform !== "win32") expect(r.exitCode).toBe(7);
    const out = m.output(terminalId);
    expect(out.output).toContain("ERR");
    m.release(terminalId);
  });

  it("respects outputByteLimit and sets truncated flag", async () => {
    const m = new TerminalManager();
    const { terminalId } = m.create({
      command: nodeEval("process.stdout.write('a'.repeat(5000))"),
      outputByteLimit: 100,
    });
    await m.waitForExit(terminalId);
    const r = m.output(terminalId);
    expect(r.output.length).toBeLessThanOrEqual(100);
    expect(r.truncated).toBe(true);
    m.release(terminalId);
  });

  // Regression: truncating at a byte boundary must not split a multi-byte UTF-8
  // character into a replacement char (U+FFFD). '✓' is 3 bytes; a 100-byte limit
  // lands mid-character. Pre-fix `Buffer.toString` on the partial slice produced
  // a trailing '�'; a StringDecoder buffers the incomplete bytes instead.
  it("does not emit U+FFFD when truncation splits a multi-byte character", async () => {
    const m = new TerminalManager();
    const { terminalId } = m.create({
      // 60 copies of '✓' = 180 bytes; limit 100 cuts mid-character.
      command: nodeEval("process.stdout.write('\\u2713'.repeat(60))"),
      outputByteLimit: 100,
    });
    await m.waitForExit(terminalId);
    const r = m.output(terminalId);
    expect(r.truncated).toBe(true);
    expect(r.output).not.toContain("�");
    expect(/^✓+$/.test(r.output)).toBe(true);
    m.release(terminalId);
  });

  it("returns exitStatus null while still running", () => {
    const m = new TerminalManager();
    const { terminalId } = m.create({
      command: nodeEval("setTimeout(()=>{}, 5000)"),
    });
    const r = m.output(terminalId);
    expect(r.exitStatus).toBeNull();
    m.kill(terminalId);
    m.release(terminalId);
  });

  it("injects env from {name,value} pairs", async () => {
    const m = new TerminalManager();
    const { terminalId } = m.create({
      command: nodeEval("process.stdout.write(process.env.GROK_TEST_VAR || '')"),
      env: [{ name: "GROK_TEST_VAR", value: "INJECTED" }],
    });
    await m.waitForExit(terminalId);
    expect(m.output(terminalId).output).toContain("INJECTED");
    m.release(terminalId);
  });

  it("honors cwd", async () => {
    const m = new TerminalManager();
    const tmp = os.tmpdir();
    const { terminalId } = m.create({
      command: nodeEval("process.stdout.write(process.cwd())"),
      cwd: tmp,
    });
    await m.waitForExit(terminalId);
    // On macOS tmpdir() resolves a /private/var symlink; normalize both sides.
    const got = m.output(terminalId).output.trim().toLowerCase();
    expect(got).toContain(tmp.replace(/\\/g, "/").toLowerCase().split("/").pop()!);
  });

  it("waitForExit resolves immediately if already exited", async () => {
    const m = new TerminalManager();
    const { terminalId } = m.create({ command: nodeEval("process.exit(0)") });
    await m.waitForExit(terminalId);
    const r = await m.waitForExit(terminalId);
    expect(r.exitCode).toBe(0);
    m.release(terminalId);
  });

  it("output() throws on unknown terminalId", () => {
    const m = new TerminalManager();
    expect(() => m.output("nope")).toThrowError(/unknown terminalId/);
  });

  it("kill+release on a missing id is a no-op", () => {
    const m = new TerminalManager();
    expect(() => m.kill("nope")).not.toThrow();
    expect(() => m.release("nope")).not.toThrow();
  });

  it("disposeAll kills outstanding terminals", () => {
    const m = new TerminalManager();
    const { terminalId } = m.create({
      command: nodeEval("setTimeout(()=>{}, 60000)"),
    });
    m.disposeAll();
    expect(() => m.output(terminalId)).toThrow();
  });

  // Regression: a process killed by a signal must not be reported as a clean
  // exit (code 0). The old `code ?? 0` masked signal kills as success, so the
  // agent assumed a command it interrupted had actually succeeded.
  it("reports a non-zero exit code when a running process is killed", async () => {
    const m = new TerminalManager();
    const { terminalId } = m.create({ command: nodeEval("setInterval(()=>{}, 1000)") });
    await new Promise((r) => setTimeout(r, 150)); // let it start
    m.kill(terminalId);
    const { exitCode } = await m.waitForExit(terminalId);
    expect(exitCode).not.toBe(0);
    m.release(terminalId);
  });
});

// Real-shell integration for #46: on Windows the agent's `terminal/*` commands
// now run under PowerShell, so PowerShell-only syntax that cmd.exe cannot run
// must succeed end-to-end through TerminalManager. These spawn the actual host
// shell, so they only make sense on Windows — skipped on the Linux CI box, where
// the host is /bin/sh and unchanged. (CLAUDE.md's "node -e everywhere" rule is
// for the cross-platform tests above; proving the PowerShell switch inherently
// needs PowerShell syntax, so this block is the deliberate exception.)
const describeWin = process.platform === "win32" ? describe : describe.skip;

describeWin("Windows PowerShell host (#46)", () => {
  const runToEnd = async (command: string) => {
    const m = new TerminalManager();
    const { terminalId } = m.create({ command });
    const { exitCode } = await m.waitForExit(terminalId);
    const output = m.output(terminalId).output;
    m.release(terminalId);
    return { exitCode, output };
  };

  it("runs a PowerShell pipeline cmd.exe cannot (the issue's failure mode)", async () => {
    // Under the old cmd host this errored: "'Measure-Object' is not recognized".
    const { exitCode, output } = await runToEnd("'a','b','c' | Measure-Object | ForEach-Object { $_.Count }");
    expect(exitCode).toBe(0);
    expect(output).toContain("3");
  });

  it("runs a cmdlet that is not a cmd builtin (Get-Date)", async () => {
    const { exitCode, output } = await runToEnd("Get-Date -Format yyyy");
    expect(exitCode).toBe(0);
    expect(output.trim()).toMatch(/^\d{4}$/);
  });

  it("executes inside a real PowerShell host ($PSVersionTable resolves)", async () => {
    // cmd would treat "$PSVersionTable.PSVersion.Major" as an unknown command;
    // PowerShell prints the host major version (5 for Windows PowerShell, 7 for pwsh).
    const { exitCode, output } = await runToEnd("$PSVersionTable.PSVersion.Major");
    expect(exitCode).toBe(0);
    expect(output.trim()).toMatch(/^\d+$/);
  });

  it("survives a Format-List pipeline (the exact re-wrap the agent had to do)", async () => {
    const { exitCode, output } = await runToEnd("[pscustomobject]@{ RepoRoot = 'demo' } | Format-List");
    expect(exitCode).toBe(0);
    expect(output).toMatch(/RepoRoot/);
    expect(output).toMatch(/demo/);
  });

  it("resolves the host shell to a PowerShell, never cmd.exe, on this box", () => {
    const shell = resolveTerminalShell("win32", (name) => {
      try {
        const out = execFileSync("where", [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        const first = out.split(/\r?\n/)[0]?.trim();
        return first && existsSync(first) ? first : undefined;
      } catch {
        return undefined;
      }
    });
    // pwsh may be absent; either PowerShell is acceptable, cmd (true) is not.
    expect(shell).not.toBe(true);
    expect(String(shell).toLowerCase()).toMatch(/pwsh\.exe$|powershell\.exe$/);
  });
});

describe("resolveExitCode", () => {
  it("passes through a real exit code, including 0", () => {
    expect(resolveExitCode(0, null)).toBe(0);
    expect(resolveExitCode(7, null)).toBe(7);
  });

  it("maps a signal kill to 128 + signum (SIGTERM -> 143), never 0", () => {
    expect(resolveExitCode(null, "SIGTERM")).toBe(128 + os.constants.signals.SIGTERM);
    expect(resolveExitCode(null, "SIGTERM")).toBe(143);
    expect(resolveExitCode(null, "SIGKILL")).toBe(128 + os.constants.signals.SIGKILL);
    expect(resolveExitCode(null, "SIGTERM")).not.toBe(0);
  });
});

describe("buildKillPlan", () => {
  it("uses taskkill with /T /F (tree + force) on Windows", () => {
    const plan = buildKillPlan(1234, "win32");
    expect(plan.kind).toBe("taskkill");
    if (plan.kind === "taskkill") {
      expect(plan.file).toBe("taskkill");
      expect(plan.args).toContain("/T");
      expect(plan.args).toContain("/F");
      expect(plan.args).toContain("1234");
    }
  });

  it("signals the whole process GROUP on POSIX, not just the shell", () => {
    // `sh -c 'node build.js & wait'` is one wrapper and one long-lived child.
    // Signalling the wrapper alone leaves the child running with nothing
    // tracking it — and a running command is what keeps a cloud machine awake,
    // so we would stop paying for a machine that is still working and then
    // freeze it. On a laptop the orphan is the battery.
    const plan = buildKillPlan(1234, "linux");
    expect(plan).toEqual({ kind: "group", signal: "SIGTERM", pid: 1234 });
  });

  it("kills the group by negative pid, and falls back to the child", () => {
    const killed: number[] = [];
    const m = new TerminalManager({
      platform: "linux",
      killImpl: (pid) => {
        killed.push(pid);
        if (pid < 0) throw new Error("ESRCH"); // group already gone
      },
    });
    const { terminalId } = m.create({ command: nodeEval("setTimeout(() => {}, 3000)") });
    m.kill(terminalId);
    // The negative pid is the group; the throw proves the fallback path runs
    // rather than leaving the command alive.
    expect(killed.some((p) => p < 0)).toBe(true);
    m.release(terminalId);
  });
});

describe("resolveTerminalShell", () => {
  // Fake PATH resolver: returns a path only for the listed names.
  const has = (map: Record<string, string>) => (name: string) => map[name];
  const PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
  const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

  it("returns true (/bin/sh) on POSIX without probing PATH when $SHELL is unset", () => {
    let probed = false;
    const shell = resolveTerminalShell("linux", () => {
      probed = true;
      return undefined;
    });
    expect(shell).toBe(true);
    expect(probed).toBe(false); // never shell out to `where` off Windows
  });

  it("uses $SHELL on POSIX when it is an absolute path", () => {
    let probed = false;
    const shell = resolveTerminalShell(
      "darwin",
      () => {
        probed = true;
        return PWSH;
      },
      "auto",
      "/bin/zsh",
    );
    expect(shell).toBe("/bin/zsh");
    expect(probed).toBe(false);
  });

  it("falls back to /bin/sh when POSIX $SHELL is /bin/sh itself", () => {
    expect(resolveTerminalShell("linux", () => undefined, "auto", "/bin/sh")).toBe(true);
  });

  it("returns true on darwin without $SHELL", () => {
    expect(resolveTerminalShell("darwin", () => PWSH)).toBe(true);
  });

  it("prefers pwsh.exe (PowerShell 7) on Windows when available", () => {
    expect(resolveTerminalShell("win32", has({ pwsh: PWSH, powershell: POWERSHELL }))).toBe(PWSH);
  });

  it("falls back to powershell.exe (5.1) when pwsh is absent", () => {
    expect(resolveTerminalShell("win32", has({ powershell: POWERSHELL }))).toBe(POWERSHELL);
  });

  it("falls back to cmd.exe (shell:true) when neither PowerShell is on PATH", () => {
    expect(resolveTerminalShell("win32", () => undefined)).toBe(true);
  });

  it("probes pwsh before powershell", () => {
    const order: string[] = [];
    resolveTerminalShell("win32", (name) => {
      order.push(name);
      return undefined;
    });
    expect(order).toEqual(["pwsh", "powershell"]);
  });

  it("pref 'cmd' forces cmd.exe (shell:true) on Windows without probing PATH", () => {
    let probed = false;
    const shell = resolveTerminalShell("win32", () => {
      probed = true;
      return PWSH;
    }, "cmd");
    expect(shell).toBe(true);
    expect(probed).toBe(false); // escape hatch short-circuits before `where`
  });

  it("pref 'cmd' forces /bin/sh on POSIX even when $SHELL is zsh", () => {
    expect(resolveTerminalShell("linux", () => undefined, "cmd", "/bin/zsh")).toBe(true);
  });

  it("pref 'auto' matches the default (PowerShell on Windows)", () => {
    expect(resolveTerminalShell("win32", has({ pwsh: PWSH }), "auto")).toBe(PWSH);
  });
});

describe("grokShellEnvValue (GROK_SHELL derived from the shell we run)", () => {
  const PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
  const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

  it("maps a resolved pwsh path to 'pwsh' on Windows", () => {
    expect(grokShellEnvValue(PWSH, "win32")).toBe("pwsh");
  });
  it("maps a resolved Windows PowerShell path to 'powershell'", () => {
    expect(grokShellEnvValue(POWERSHELL, "win32")).toBe("powershell");
  });
  it("maps the cmd.exe fallback (true) to 'cmd' on Windows", () => {
    expect(grokShellEnvValue(true, "win32")).toBe("cmd");
  });
  it("leaves GROK_SHELL unset on POSIX when the host is /bin/sh", () => {
    expect(grokShellEnvValue(true, "linux")).toBeUndefined();
  });
  it("sets nothing on POSIX, whatever shell we resolved", () => {
    // This replaces a PR assertion that GROK_SHELL carries the dialect on
    // POSIX. It does not: upstream builds the model-facing `Shell:` from
    // `$SHELL` on Unix (`resolve_shell_display`) and reads GROK_SHELL there as
    // a PATH to a shell binary, validated as executable — so a bare `zsh`
    // never reached the model. Running the shell `$SHELL` names is the
    // alignment, which is what the rest of this PR does.
    expect(grokShellEnvValue("/bin/zsh", "darwin")).toBeUndefined();
    expect(grokShellEnvValue("/opt/homebrew/bin/bash", "linux")).toBeUndefined();
    expect(grokShellEnvValue(true, "linux")).toBeUndefined();
  });
  it("refuses a $SHELL whose grammar is not POSIX", () => {
    // `posixSpawnArgv` hands the agent's POSIX script to this shell as an
    // explicit `-c` argument, so an unrecognised grammar breaks commands that
    // work today rather than merely running them somewhere else.
    for (const s of ["/usr/bin/fish", "/usr/local/bin/nu", "/bin/tcsh", "/usr/bin/pwsh"]) {
      expect(posixShellFromEnv(s)).toBe(true);
    }
    expect(posixShellFromEnv("/bin/zsh")).toBe("/bin/zsh");
    expect(posixShellFromEnv("/opt/homebrew/bin/bash")).toBe("/opt/homebrew/bin/bash");
  });
  it("returns undefined for an unrecognized Windows shell path", () => {
    expect(grokShellEnvValue("C:\\weird\\thing.exe", "win32")).toBeUndefined();
  });
});

describe("posixShellFromEnv", () => {
  it("keeps Node's /bin/sh fallback for empty, relative, or sh paths", () => {
    expect(posixShellFromEnv(undefined)).toBe(true);
    expect(posixShellFromEnv("")).toBe(true);
    expect(posixShellFromEnv("zsh")).toBe(true);
    expect(posixShellFromEnv("/bin/sh")).toBe(true);
    expect(posixShellFromEnv("/usr/bin/sh")).toBe(true);
  });
  it("returns an absolute login shell path", () => {
    expect(posixShellFromEnv("/bin/zsh")).toBe("/bin/zsh");
    expect(posixShellFromEnv("  /usr/bin/zsh  ")).toBe("/usr/bin/zsh");
  });
});

describe("unwrapGrokBashLoginWrapper", () => {
  it("unwraps grok's /bin/bash -lc payload", () => {
    // NOT `bash -lc echo hi` -> `echo hi`: POSIX hands `-c` only the next word,
    // so bash runs `echo` and `hi` becomes `$0`. Rewriting it to `echo hi`
    // changes what the command does — harmless there, destructive for
    // `bash -lc rm -rf target`, which really does run `rm` with no operands.
    expect(unwrapGrokBashLoginWrapper("/bin/bash -lc 'echo'")).toBe("echo");
    expect(unwrapGrokBashLoginWrapper("/bin/bash -lc echo hi")).toBeUndefined();
    expect(unwrapGrokBashLoginWrapper("/bin/bash -lc rm -rf target")).toBeUndefined();
    expect(unwrapGrokBashLoginWrapper("/bin/bash -lc 'echo hi'")).toBe("echo hi");
    expect(unwrapGrokBashLoginWrapper('/bin/bash -lc "echo hi"')).toBe("echo hi");
  });

  it("unwraps bash -l -c, -cl, and --login -c", () => {
    // Quoted payloads, which is what grok actually sends. The unquoted
    // multi-word spellings that used to be asserted here are refused now: POSIX
    // gives `-c` only the next word, so rewriting them changes the command.
    expect(unwrapGrokBashLoginWrapper("bash -l -c 'echo hi'")).toBe("echo hi");
    expect(unwrapGrokBashLoginWrapper("bash -cl 'echo hi'")).toBe("echo hi");
    expect(unwrapGrokBashLoginWrapper("bash --login -c 'echo hi'")).toBe("echo hi");
    expect(unwrapGrokBashLoginWrapper("/usr/bin/env bash -lc 'echo hi'")).toBe("echo hi");
  });

  it("peels POSIX nested single quotes in the inner script", () => {
    expect(unwrapGrokBashLoginWrapper("/bin/bash -lc 'it'\\''s'")).toBe("it's");
  });

  it("leaves non-wrappers alone", () => {
    expect(unwrapGrokBashLoginWrapper("echo hi")).toBeUndefined();
    expect(unwrapGrokBashLoginWrapper("bash --version")).toBeUndefined();
    expect(unwrapGrokBashLoginWrapper("bash script.sh")).toBeUndefined();
    expect(unwrapGrokBashLoginWrapper("bash -c echo hi")).toBeUndefined();
    expect(unwrapGrokBashLoginWrapper("/bin/zsh -lc echo hi")).toBeUndefined();
    expect(unwrapGrokBashLoginWrapper("echo /bin/bash -lc foo")).toBeUndefined();
  });

  it("unwraps a bare one-word payload, which shlex leaves unquoted", () => {
    // `try_quote` only quotes what needs it, so the commands most likely to be
    // typed arrive naked. These have nothing to expand, glob or split.
    expect(unwrapGrokBashLoginWrapper("/bin/bash -lc ls")).toBe("ls");
    expect(unwrapGrokBashLoginWrapper("/bin/bash -lc pwd")).toBe("pwd");
    expect(unwrapGrokBashLoginWrapper("/bin/bash -lc ./scripts/build.sh")).toBe("./scripts/build.sh");
  });

  it("still refuses unquoted text a shell would read differently", () => {
    // Each of these means one thing to the outer shell we used to hand it to and
    // another to the host we would hand it to instead, so the wrapper stays.
    for (const payload of ["echo hi", "$HOME", "*.ts", "a&&b", "a|b", "a>b", "~/x", "a;b", "`id`", "a\b"]) {
      expect(unwrapGrokBashLoginWrapper(`/bin/bash -lc ${payload}`)).toBeUndefined();
    }
  });

  it("unwraps only the outer grok layer", () => {
    expect(unwrapGrokBashLoginWrapper("/bin/bash -lc '/bin/bash -lc echo hi'")).toBe(
      "/bin/bash -lc echo hi",
    );
  });
});

describe("posixSpawnArgv", () => {
  it("runs the inner script under $SHELL, not bash -lc", () => {
    expect(posixSpawnArgv("/bin/bash -lc 'echo hi'", "/bin/zsh")).toEqual({
      file: "/bin/zsh",
      args: ["-c", "echo hi"],
    });
  });

  it("passes a raw command through to $SHELL -c", () => {
    expect(posixSpawnArgv("echo hi", "/bin/zsh")).toEqual({
      file: "/bin/zsh",
      args: ["-c", "echo hi"],
    });
  });

  it("uses /bin/sh when the host is Node's fallback, and keeps the wrapper there", () => {
    // Corrects the PR's expectation, which peeled the wrapper here too. On
    // `/bin/sh` there is nothing to gain and something to lose: macOS `/bin/sh`
    // IS bash 3.2, so the script lands on the same shell either way, while on
    // Linux it is dash — and a script grok deliberately wrote for bash would
    // newly fail on `[[ ]]`, arrays or process substitution. Leaving the
    // wrapper is what v3.19.5 did, and for this host it was right.
    expect(posixSpawnArgv("/bin/bash -lc 'echo'", true)).toEqual({
      file: "/bin/sh",
      args: ["-c", "/bin/bash -lc 'echo'"],
    });
  });
});

const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("POSIX host does not exec grok's bash -lc wrapper", () => {
  it("runs the agent's command, and routes it by host capability", async () => {
    // `$0` was the probe here and it is NOT portable: zsh reports the shell's
    // path, bash on ubuntu-latest reported an empty string, and on the retained
    // path the OUTER `sh -c` expands it before the inner shell ever sees it. CI
    // failed twice on that alone while both dev machines passed. So this asserts
    // what we actually promise — the command runs, and the ROUTING is right —
    // and leaves shell trivia out of it.
    const m = new TerminalManager();
    const { terminalId } = m.create({ command: `/bin/bash -lc 'printf HIT'` });
    const { exitCode } = await m.waitForExit(terminalId);
    const result = m.output(terminalId);
    // SELF-DESCRIBING on failure. This assertion has now failed twice on
    // ubuntu-latest and cannot be reproduced on macOS, on Windows (skipped), or
    // on a real Ubuntu 26.04 under WSL where the same manager returns HIT
    // 25 times out of 25. Guessing at the cause from a bare `expected '' to be
    // 'HIT'` is what produced the two wrong fixes before this one, so let the
    // failing machine say what it saw.
    const seen = JSON.stringify({
      shell: process.env.SHELL ?? null,
      host: posixShellFromEnv(process.env.SHELL),
      argv: posixSpawnArgv(`/bin/bash -lc 'printf HIT'`, posixShellFromEnv(process.env.SHELL)),
      exitCode,
      output: result.output,
      truncated: result.truncated,
    });
    expect(exitCode, `command did not exit cleanly: ${seen}`).toBe(0);
    expect(result.output.trim(), `no output from the agent's command: ${seen}`).toBe("HIT");
    m.release(terminalId);

    const host = posixShellFromEnv(process.env.SHELL);
    const base = host === true ? "sh" : host.slice(host.lastIndexOf("/") + 1);
    const argv = posixSpawnArgv("/bin/bash -lc 'printf HIT'", host);
    expect(argv.file).toBe(host === true ? "/bin/sh" : host);
    if (base === "bash" || base === "zsh") {
      expect(argv.args[1]).toBe("printf HIT"); // peeled: the host stands in for bash
    } else {
      expect(argv.args[1]).toBe("/bin/bash -lc 'printf HIT'"); // retained
    }
  });
});

describe("unwrapGrokBashLoginWrapper refuses what it does not model", () => {
  it("leaves a wrapper carrying any other flag completely alone", () => {
    // Dropping a flag while still running the script is worse than not
    // unwrapping: `-n` means syntax-check WITHOUT executing, so discarding it
    // would turn a dry run into a real one.
    expect(unwrapGrokBashLoginWrapper("/bin/bash -n -l -c 'rm target'")).toBeUndefined();
    expect(unwrapGrokBashLoginWrapper("/bin/bash -e -lc 'x'")).toBeUndefined();
    expect(unwrapGrokBashLoginWrapper("/bin/bash -u -lc 'x'")).toBeUndefined();
    expect(unwrapGrokBashLoginWrapper("/bin/bash --posix -lc 'x'")).toBeUndefined();
    expect(unwrapGrokBashLoginWrapper("/bin/bash --restricted -lc 'x'")).toBeUndefined();
    expect(unwrapGrokBashLoginWrapper("/bin/bash -lnc 'x'")).toBeUndefined();
    // ...while the shapes grok actually sends still unwrap.
    expect(unwrapGrokBashLoginWrapper("/bin/bash -lc 'echo hi'")).toBe("echo hi");
    expect(unwrapGrokBashLoginWrapper("/bin/bash -cl 'echo hi'")).toBe("echo hi");
    expect(unwrapGrokBashLoginWrapper("/bin/bash --login -c 'echo hi'")).toBe("echo hi");
  });

  it("decodes a double-quoted payload the way the shell would", () => {
    // POSIX drops the backslash before `$`, a backtick, a quote and a
    // backslash. Leaving `\$` intact turned an expansion into literal text.
    expect(unwrapGrokBashLoginWrapper('/bin/bash -lc "printf %s \\"\$HOME\\""'))
      .toBe('printf %s "$HOME"');
    expect(unwrapGrokBashLoginWrapper('/bin/bash -lc "echo \`date\`"')).toBe("echo `date`");
  });
});

describe("posixSpawnArgv only unwraps where it is safe", () => {
  it("decodes concatenated shlex quoting, which is what grok emits", () => {
    // Rust's `shlex::try_quote` does not pick one style for the whole script:
    // it CONCATENATES chunks when no single strategy encodes the string, so
    // `echo '$HOME'` becomes `"echo '"'$HOME'"'"` — one word made of a
    // double-quoted, a single-quoted and another double-quoted segment. An
    // earlier version refused this shape, which left every command containing
    // a quote on the old bash-3.2 path; the one before that passed the raw text
    // through and a real zsh answered `exit 127, no such file or directory`.
    const mixed = String.raw`/bin/bash -lc "echo '"'$HOME'"'"`;
    expect(unwrapGrokBashLoginWrapper(mixed)).toBe("echo '$HOME'");
    expect(posixSpawnArgv(mixed, "/bin/zsh")).toEqual({
      file: "/bin/zsh",
      args: ["-c", "echo '$HOME'"],
    });
  });

  it("treats backslash-newline as a line continuation, not a newline", () => {
    // POSIX removes BOTH characters. Decoding it to a newline split the script:
    // `printf '<%s>' foo\<newline>bar` prints `<foobar>`, but a real newline
    // makes it print `<foo>` and then try to run `bar`.
    const dq = '"foo' + String.fromCharCode(92) + String.fromCharCode(10) + 'bar"';
    expect(parseOneShellWord(dq)).toEqual({ word: "foobar", rest: "" });
    const bare = "foo" + String.fromCharCode(92) + String.fromCharCode(10) + "bar";
    expect(parseOneShellWord(bare)).toEqual({ word: "foobar", rest: "" });
  });

  it("separates tokens on POSIX blanks only, never Unicode spaces", () => {
    // `trimStart()` strips NBSP; a shell does not. A command starting with NBSP
    // fails today as an invalid pathname, and trimming it would make us
    // recognise the wrapper and RUN what previously could not run.
    const nbsp = String.fromCharCode(0x00a0);
    expect(unwrapGrokBashLoginWrapper(nbsp + "/bin/bash -lc 'printf HIT'")).toBeUndefined();
    expect(unwrapGrokBashLoginWrapper(" /bin/bash -lc 'printf HIT'")).toBe("printf HIT");
  });

  it("unwraps a quoted payload, or an unquoted one that cannot be read two ways", () => {
    // `shlex::try_quote` quotes anything containing a shell character and passes
    // everything else through, so `echo` really does arrive naked. Unquoted text
    // is where the readings CAN diverge — the old path let the OUTER shell expand
    // `$VAR` before bash saw it, while unwrapping makes it the script the host
    // expands — so the test is whether there is anything to expand at all.
    expect(unwrapGrokBashLoginWrapper("/bin/bash -lc echo")).toBe("echo");
    expect(unwrapGrokBashLoginWrapper("/bin/bash -lc $PAYLOAD")).toBeUndefined();
    expect(unwrapGrokBashLoginWrapper("/bin/bash -lc 'echo hi'")).toBe("echo hi");
  });

  it("parses a shell word the way a shell does", () => {
    expect(parseOneShellWord("'a b'c")).toEqual({ word: "a bc", rest: "" });
    expect(parseOneShellWord('"x\\"y" tail')).toEqual({ word: 'x"y', rest: " tail" });
    expect(parseOneShellWord("plain rest")).toEqual({ word: "plain", rest: " rest" });
    expect(parseOneShellWord("'unterminated")).toBeUndefined();
    expect(parseOneShellWord('"unterminated')).toBeUndefined();
  });

  it("keeps grok's bash wrapper when the host cannot stand in for bash", () => {
    // `/bin/sh`, dash and ksh cannot run `[[ ]]`, arrays or process
    // substitution. Grok sent the script to BASH deliberately, so on those
    // hosts the wrapper stays and the script still reaches bash — which is
    // what v3.19.5 did and is right for them.
    const wrapped = "/bin/bash -lc 'echo hi'";
    expect(posixSpawnArgv(wrapped, true)).toEqual({ file: "/bin/sh", args: ["-c", wrapped] });
    expect(posixSpawnArgv(wrapped, "/bin/dash").args[1]).toBe(wrapped);
    expect(posixSpawnArgv(wrapped, "/bin/ksh").args[1]).toBe(wrapped);
    // ...and is peeled for the hosts that can.
    expect(posixSpawnArgv(wrapped, "/bin/zsh")).toEqual({ file: "/bin/zsh", args: ["-c", "echo hi"] });
    expect(posixSpawnArgv(wrapped, "/opt/homebrew/bin/bash").args[1]).toBe("echo hi");
  });
});

describePosix("waitForExit waits for the output, but not forever", () => {
  it("has the full output by the time it resolves", async () => {
    // `exit` can fire before stdout reaches us. Three ubuntu-latest runs showed
    // a clean `printf` returning nothing; resolving on the pipes instead is the
    // difference between an agent reading a command's output and reading "".
    for (let i = 0; i < 20; i++) {
      const m = new TerminalManager();
      const { terminalId } = m.create({ command: "/bin/sh -c 'printf PAYLOAD'" });
      await m.waitForExit(terminalId);
      expect(m.output(terminalId).output.trim()).toBe("PAYLOAD");
      m.release(terminalId);
    }
  });

  it("returns promptly when something is left holding the pipe", async () => {
    // The regression the obvious fix would cause: waiting for `close` alone
    // means a command that starts a daemon blocks until the DAEMON exits. The
    // background `sleep` here inherits stdout, so `close` cannot arrive — and
    // this must still come back.
    const m = new TerminalManager();
    const started = Date.now();
    const { terminalId } = m.create({ command: "/bin/sh -c '(sleep 30 &) ; printf DONE'" });
    const { exitCode } = await m.waitForExit(terminalId);
    const took = Date.now() - started;
    expect(exitCode).toBe(0);
    expect(took, `waited ${took}ms for a command whose child holds stdout`).toBeLessThan(10000);
    m.kill(terminalId);
    m.release(terminalId);
  }, 20000);
});

describe("commandLanguageForDialect (View all command language)", () => {
  it("maps each known dialect to a VS Code language id", () => {
    expect(commandLanguageForDialect("powershell")).toBe("powershell");
    expect(commandLanguageForDialect("posix")).toBe("shellscript");
    expect(commandLanguageForDialect("cmd")).toBe("bat");
  });

  it("returns undefined for an unknown dialect", () => {
    expect(commandLanguageForDialect("unknown")).toBeUndefined();
    expect(commandLanguageForDialect(undefined)).toBeUndefined();
    expect(commandLanguageForDialect("")).toBeUndefined();
  });
});

// #6 regression: a taskkill that RUNS BUT FAILS (Access Denied, protected child)
// used to be fire-and-forget — the tree stayed alive and the agent's
// wait_for_exit pended forever. The manager must fall back to a direct signal.
// Deps-injected so the Windows plan runs deterministically on every platform.
describe("TerminalManager kill fallback (Windows taskkill failure)", () => {
  it("falls back to SIGTERM when taskkill errors, so waitForExit still settles", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const failingExec = ((file: string, args: string[], ...rest: any[]) => {
      calls.push({ file, args });
      const cb = rest.find((r) => typeof r === "function");
      // Simulate taskkill running and failing (e.g. Access Denied) — async like
      // the real execFile callback.
      setImmediate(() => cb?.(new Error("ERROR: The process could not be terminated. Access is denied.")));
    }) as unknown as typeof import("node:child_process").execFile;

    const m = new TerminalManager({ execFileImpl: failingExec, platform: "win32" });
    // A process that outlives the test unless something actually kills it (but
    // self-expires in 8s so a regression can't leak it past the suite).
    const { terminalId } = m.create({ command: nodeEval("setTimeout(()=>{}, 8000)") });
    // Give the shell a beat to actually start the child.
    await new Promise((r) => setTimeout(r, 300));

    m.kill(terminalId);
    const { exitCode } = await m.waitForExit(terminalId);

    // The taskkill plan ran (and failed)…
    expect(calls.length).toBe(1);
    expect(calls[0].file).toBe("taskkill");
    expect(calls[0].args).toContain("/T");
    // …and the SIGTERM fallback still brought the wrapper down: a signal kill
    // resolves as 128+signum via resolveExitCode (143), or the platform's
    // plain non-zero termination code — never a hang, never a clean 0.
    expect(exitCode).not.toBe(0);
    m.release(terminalId);
  }, 15000);

  it("does not signal when taskkill fails but the process already exited", async () => {
    let exec: ((err: Error | null) => void) | undefined;
    const capturedExec = ((_f: string, _a: string[], ...rest: any[]) => {
      exec = rest.find((r) => typeof r === "function"); // hold the callback so we control when taskkill "fails"
    }) as unknown as typeof import("node:child_process").execFile;

    const m = new TerminalManager({ execFileImpl: capturedExec, platform: "win32" });
    const { terminalId } = m.create({ command: nodeEval("process.exit(0)") });
    const { exitCode } = await m.waitForExit(terminalId); // let it finish naturally
    expect(exitCode).toBe(0);

    const t = (m as any).terminals.get(terminalId);
    let signalled = false;
    const origKill = t.proc.kill.bind(t.proc);
    t.proc.kill = (...args: unknown[]) => {
      signalled = true;
      return origKill(...args);
    };

    m.kill(terminalId); // taskkill path (pid may still be defined on the exited proc)
    exec?.(new Error("ERROR: not found"));
    await new Promise((r) => setTimeout(r, 50));
    // exitCode was already recorded — the fallback must not fire a late signal.
    expect(signalled).toBe(false);
    m.release(terminalId);
  }, 15000);
});

describe("anyRunning — the honest answer to 'is this machine still doing something'", () => {
  /**
   * Session status cannot answer that. An agent can start a twenty-five-minute
   * build and THEN ask a question, at which point the session says it is
   * waiting for a person while the build carries on — and on a cloud machine,
   * believing the status there freezes the build.
   */
  it("is false with nothing to run", () => {
    expect(new TerminalManager().anyRunning()).toBe(false);
  });

  it("is true while a command runs and false once it exits", async () => {
    const m = new TerminalManager();
    const { terminalId } = m.create({ command: nodeEval("setTimeout(() => {}, 300)") });
    expect(m.anyRunning()).toBe(true);
    await m.waitForExit(terminalId);
    expect(m.anyRunning()).toBe(false);
    m.release(terminalId);
  });

  it("stays true while ANY command is still going", async () => {
    // The case that matters: a quick one finishing must not make a long one
    // invisible.
    const m = new TerminalManager();
    const quick = m.create({ command: nodeEval("process.exit(0)") }).terminalId;
    const slow = m.create({ command: nodeEval("setTimeout(() => {}, 600)") }).terminalId;
    await m.waitForExit(quick);
    expect(m.anyRunning()).toBe(true);
    await m.waitForExit(slow);
    expect(m.anyRunning()).toBe(false);
    m.release(quick);
    m.release(slow);
  });

  it("is false once a running command is released", async () => {
    // Released means we have stopped tracking it; holding a machine awake for
    // something nothing is watching would be a bill with no owner.
    const m = new TerminalManager();
    const { terminalId } = m.create({ command: nodeEval("setTimeout(() => {}, 5000)") });
    expect(m.anyRunning()).toBe(true);
    m.release(terminalId);
    expect(m.anyRunning()).toBe(false);
  });
});

describe("commands belong to whoever started them", () => {
  /**
   * A terminal is a child of the extension, not of the agent, so it outlives the
   * ACP client that asked for it — and once that client is gone nothing can
   * send it `terminal/release`. Left alone it is a command nobody owns, and
   * since a running command is what keeps a cloud machine awake, it holds one
   * running and billing until the extension itself exits.
   */
  it("takes an owner's commands with it and leaves everyone else's", async () => {
    const m = new TerminalManager();
    const alice = {};
    const bob = {};
    const a = m.ownedBy(alice).create({ command: nodeEval("setTimeout(() => {}, 5000)") }).terminalId;
    const b = m.ownedBy(bob).create({ command: nodeEval("setTimeout(() => {}, 5000)") }).terminalId;
    expect(m.anyRunning()).toBe(true);

    expect(m.releaseOwnedBy(alice)).toBe(1);
    // Bob's is still going, so the machine is still busy.
    expect(m.anyRunning()).toBe(true);
    expect(() => m.output(a)).toThrow();

    expect(m.releaseOwnedBy(bob)).toBe(1);
    expect(m.anyRunning()).toBe(false);
    void b;
  });

  it("stops reporting a machine as busy once the owner is gone", async () => {
    // The whole point: this is what reopened the ghost path.
    const m = new TerminalManager();
    const owner = {};
    m.ownedBy(owner).create({ command: nodeEval("setTimeout(() => {}, 5000)") });
    expect(m.anyRunning()).toBe(true);
    m.releaseOwnedBy(owner);
    expect(m.anyRunning()).toBe(false);
  });

  it("releasing an owner with nothing running is a no-op", () => {
    expect(new TerminalManager().releaseOwnedBy({})).toBe(0);
  });

  it("hands the agent the same interface either way", () => {
    // The owned view must be indistinguishable from the manager, or the ACP
    // side would need to know about ownership.
    const m = new TerminalManager();
    const view = m.ownedBy({});
    for (const k of ["create", "output", "waitForExit", "kill", "release"]) {
      expect(typeof (view as unknown as Record<string, unknown>)[k]).toBe("function");
    }
  });
});

describe("signalling a process group, and when not to", () => {
  /**
   * Three versions of this rule have now been wrong in three different ways, so
   * the reasoning is worth keeping next to the tests.
   *
   * Signalling whenever asked can reach a pid the OS recycled and kill somebody
   * else's work. Probing first with signal 0 does not save it: that proves *a*
   * group holds the id, not that it is ours — an empty group releases its id
   * and the next holder answers the probe just as happily.
   *
   * The wrapper's own liveness is the one thing that settles it. Alive, its
   * group exists and is unambiguously ours. Exited, we cannot tell our
   * surviving descendants from a stranger's group, and killing a stranger is
   * the worse mistake.
   */
  function manager() {
    const sent: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
    const m = new TerminalManager({
      platform: "linux",
      killImpl: (pid, signal) => { sent.push({ pid, signal }); },
    });
    return { m, sent };
  }

  it("signals the group while the command is running", () => {
    const { m, sent } = manager();
    const { terminalId } = m.create({ command: nodeEval("setTimeout(() => {}, 3000)") });
    m.kill(terminalId);
    expect(sent.some((c) => c.pid < 0 && c.signal === "SIGTERM")).toBe(true);
    m.release(terminalId);
  });

  it("sends NOTHING once the command has exited", async () => {
    // Where the pid may since have been recycled. Our cleanup must never kill
    // somebody else's work, and a detached job outliving its shell — which is
    // what detaching means — is the accepted cost.
    const { m, sent } = manager();
    const { terminalId } = m.create({ command: nodeEval("process.exit(0)") });
    await m.waitForExit(terminalId);
    m.kill(terminalId);
    expect(sent).toEqual([]);
    m.release(terminalId);
    expect(sent).toEqual([]);
  });

  it("never probes — a probe cannot tell our group from a stranger's", async () => {
    const { m, sent } = manager();
    const { terminalId } = m.create({ command: nodeEval("setTimeout(() => {}, 3000)") });
    m.kill(terminalId);
    expect(sent.every((c) => c.signal !== 0)).toBe(true);
    m.release(terminalId);
  });
});
