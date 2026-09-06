import { ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import * as os from "node:os";

export interface TerminalCreateParams {
  command: string; // single shell-quoted string per ACP
  env?: Array<{ name: string; value: string }>;
  cwd?: string;
  outputByteLimit?: number;
}

export interface TerminalOutputResult {
  output: string;
  exitStatus: { exitCode: number } | null;
  truncated: boolean;
}

/** How long `waitForExit` lets stdout finish after the process has gone.
 *  Long enough for a pipe already holding bytes, short enough that a command
 *  which leaves a daemon on the other end still returns promptly. */
const DRAIN_GRACE_MS = 2000;

interface TerminalEntry {
  /**
   * Who asked for this command.
   *
   * A terminal outlives the ACP client that started it — the process is a child
   * of the extension, not of the agent — so without an owner a deleted
   * conversation leaves a command running that nothing can reach, and
   * {@link TerminalManager.anyRunning} goes on reporting the machine as busy
   * for ever.
   */
  owner?: object;
  proc: ChildProcess;
  buf: string;
  byteLen: number;
  truncated: boolean;
  exitCode: number | null;
  /** The code `exit` reported, held while the pipes finish draining. */
  pendingExitCode?: number;
  /** Set once listeners have been told; `exit` and `close` race to be first. */
  settled?: boolean;
  drainTimer?: ReturnType<typeof setTimeout>;
  exitListeners: Array<(code: number) => void>;
  byteLimit: number;
  // Buffers incomplete multi-byte UTF-8 sequences across chunk boundaries so a
  // character split by streaming (or by truncation) never becomes a U+FFFD.
  decoder: StringDecoder;
}

const DEFAULT_BYTE_LIMIT = 40_000;

/**
 * Resolve a child's reported `(code, signal)` to a single exit code. A process
 * killed by a signal reports `code === null`; the old `code ?? 0` masked that as
 * a clean success, so the agent assumed an interrupted command had finished OK.
 * Map signal kills to the shell convention `128 + signum` (SIGTERM → 143).
 */
export function resolveExitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code != null) return code;
  if (signal) {
    const num = (os.constants.signals as Record<string, number>)[signal];
    return num ? 128 + num : 1;
  }
  return 0;
}

export type KillPlan =
  | { kind: "signal"; signal: NodeJS.Signals }
  /** Signal the whole process group — `process.kill(-pid, signal)` on POSIX. */
  | { kind: "group"; signal: NodeJS.Signals; pid: number }
  | { kind: "taskkill"; file: string; args: string[] };

/**
 * On Windows `spawn(..., { shell: true })` wraps the command in `cmd.exe`, and
 * `proc.kill("SIGTERM")` only terminates that wrapper — long-running descendants
 * (npm, node, …) survive as orphans holding file locks. `taskkill /T /F` kills
 * the whole tree. POSIX keeps the direct signal. (Args, not a shell string, so
 * there's no shell to interpret anything — pid is numeric anyway.)
 */
export function buildKillPlan(pid: number, platform: NodeJS.Platform = process.platform): KillPlan {
  if (platform === "win32") {
    return { kind: "taskkill", file: "taskkill", args: ["/pid", String(pid), "/T", "/F"] };
  }
  // The whole GROUP, not the shell. `sh -c 'node build.js & wait'` is one
  // wrapper and one long-lived child; signalling the wrapper alone leaves the
  // child running with nothing tracking it — and since a running command is
  // what keeps a cloud machine awake, we would stop paying for a machine that
  // is still working, then freeze it. Spawned detached so the negative pid
  // names the group.
  return { kind: "group", signal: "SIGTERM", pid };
}

/**
 * Resolve a name to its first real PATH hit via Windows `where`, or undefined
 * when it isn't found. Thin impure wrapper so `resolveTerminalShell` stays pure
 * and unit-testable. `where` exits non-zero (throws) when nothing matches; the
 * piped stderr never reaches the console.
 *
 * Skips the Microsoft Store execution-alias stub (a 0-byte reparse point under
 * `…\WindowsApps\`): `existsSync` reports it present, but when the Store app
 * isn't installed it just prints an "install from Store" prompt and exits — the
 * same trap that bites `python.exe`. Take the first *non-stub* hit instead.
 */
function whichOnPath(name: string): string | undefined {
  try {
    // stderr → ignore so `where`'s "Could not find files" line on a miss never
    // reaches the extension's logs; stdout is still returned for a hit.
    const out = execFileSync("where", [name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    for (const line of out.split(/\r?\n/)) {
      const p = line.trim();
      if (!p || /[\\/]WindowsApps[\\/]/i.test(p)) continue;
      if (existsSync(p)) return p;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** How to pick the host shell — `grok.terminalShell` (#46). */
export type ShellPreference = "auto" | "cmd";

/**
 * `$SHELL` when it is an absolute path (the login shell the standalone TUI
 * inherits). `/bin/sh` and `/usr/bin/sh` stay `true` so Node's default and
 * `GROK_SHELL` unset remain the same no-op. Pure.
 */
/**
 * Shells whose grammar is close enough to `/bin/sh` that a command the agent
 * wrote for a POSIX host runs unchanged. An ALLOWLIST, not a denylist: `$SHELL`
 * can be fish, nushell, csh or even pwsh, and `posixSpawnArgv` hands the script
 * to it as an explicit `-c` argument — so an unrecognised grammar breaks
 * commands that work today rather than merely running them somewhere else.
 */
const POSIX_SHELL_NAMES = new Set(["sh", "bash", "zsh", "ksh", "ksh93", "mksh", "dash", "ash"]);

export function posixShellFromEnv(shell: string | undefined): string | true {
  if (typeof shell !== "string") return true;
  const trimmed = shell.trim();
  if (!trimmed.startsWith("/")) return true;
  if (trimmed === "/bin/sh" || trimmed === "/usr/bin/sh") return true;
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1).toLowerCase();
  if (!POSIX_SHELL_NAMES.has(name)) return true;
  return trimmed;
}

/**
 * Peel a single POSIX quoted word. Used only when grok wrapped the entire
 * inner script in one pair of quotes (`bash -lc 'script'`). A remainder that
 * is not one quoted word is returned as-is by the caller.
 */
/** Space, tab and newline — the only blanks a POSIX shell separates tokens on.
 *  `trimStart()` and `\s` also match NBSP and other Unicode spaces, which a
 *  shell does not: a command starting with NBSP fails today as an invalid
 *  pathname, and trimming it would make us recognise and RUN it instead. */
function stripPosixBlanks(v: string): string {
  let i = 0;
  while (i < v.length && (v[i] === " " || v[i] === "\t" || v[i] === "\n")) i++;
  return v.slice(i);
}

/**
 * Decode ONE shell word from the front of `s`.
 *
 * This is what grok actually emits. It builds the wrapper with Rust's
 * `shlex::try_quote`, which does not pick one quoting style for the whole
 * script — it CONCATENATES segments whenever a single strategy cannot encode
 * the string. `echo '$HOME'` comes out as `"echo '"'$HOME'"'"`: a
 * double-quoted chunk, a single-quoted chunk and another double-quoted chunk,
 * joined with no whitespace, forming one word.
 *
 * Handling that with special cases is what produced three separate defects
 * here — a dropped `-n` flag, mangled `\$`, and `rm -rf target` being made
 * destructive. One parser removes the whole class: single quotes are literal,
 * double quotes honour the backslash only before `$`, a backtick, a quote, a
 * backslash or a newline, and an unquoted backslash escapes the next
 * character. Unquoted whitespace ends the word.
 *
 * Returns the decoded word and whatever follows it, or `undefined` if the
 * quoting is unterminated — in which case the caller must not rewrite anything.
 */
export function parseOneShellWord(s: string): { word: string; rest: string } | undefined {
  let word = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === " " || ch === "\t" || ch === "\n") break;
    if (ch === "'") {
      const close = s.indexOf("'", i + 1);
      if (close === -1) return undefined; // unterminated
      word += s.slice(i + 1, close);
      i = close + 1;
      continue;
    }
    if (ch === '"') {
      i++;
      let closed = false;
      while (i < s.length) {
        if (s[i] === '"') { closed = true; i++; break; }
        if (s[i] === "\\" && i + 1 < s.length) {
          // A backslash-newline is a LINE CONTINUATION: POSIX removes both
          // characters, it does not yield a newline. Decoding it as one made
          // `printf '<%s>' foo\<newline>bar` print `<foo>` and then try to run
          // `bar`, where the original prints `<foobar>`.
          if (s[i + 1] === "\n") { i += 2; continue; }
          if ('$`"\\'.includes(s[i + 1])) {
            word += s[i + 1];
            i += 2;
            continue;
          }
        }
        word += s[i];
        i++;
      }
      if (!closed) return undefined; // unterminated
      continue;
    }
    if (ch === "\\") {
      if (i + 1 >= s.length) return undefined; // trailing backslash
      if (s[i + 1] === "\n") { i += 2; continue; } // line continuation
      word += s[i + 1];
      i += 2;
      continue;
    }
    word += ch;
    i++;
  }
  return { word, rest: s.slice(i) };
}

/**
 * If `command` is grok's POSIX login-bash wrapper, return the inner script.
 * Otherwise `undefined` (caller keeps `command`).
 *
 * Grok 1.0.x still sends `terminal/create` as `/bin/bash -lc <script>` even
 * when `GROK_SHELL=zsh`. Node `spawn(cmd, { shell: zsh })` is then
 * `zsh -c '/bin/bash -lc …'`; zsh execs bash, and macOS bash 3.2 sources
 * `~/.bash_profile` (sdkman `${var^^}`).
 *
 * Matches `bash` / `/bin/bash` / `/usr/bin/env bash` plus login+command flags
 * (`-lc`, `-cl`, `-l -c`, `--login -c`). One layer only: a script that itself
 * starts with `bash -lc` is the model's command, not grok's wrapper.
 * Pure.
 */
export function unwrapGrokBashLoginWrapper(command: string): string | undefined {
  let s = stripPosixBlanks(command);
  const envPrefix = /^\/usr\/bin\/env\s+/;
  const envMatch = s.match(envPrefix);
  if (envMatch) s = s.slice(envMatch[0].length);
  const exeMatch = s.match(/^(\S+)(\s+|$)/);
  if (!exeMatch) return undefined;
  const base = exeMatch[1].split("/").pop() ?? "";
  if (base !== "bash") return undefined;
  s = stripPosixBlanks(s.slice(exeMatch[0].length));

  // ONLY `-l` and `-c`, in any spelling. Every other flag is a refusal, not
  // something to skip: bash flags CHANGE WHAT THE SCRIPT DOES, and dropping one
  // while running the script anyway is worse than not unwrapping at all.
  // `bash -n -l -c 'rm target'` asks bash to syntax-check WITHOUT executing;
  // discarding `-n` turns that into a real `rm`. Same for `-e`, `-u`,
  // `--posix`, `--restricted`. We recognise only the wrapper grok actually
  // sends; anything else keeps its original command untouched.
  let sawLogin = false;
  let sawCommand = false;
  while (s.startsWith("-")) {
    const tokMatch = s.match(/^(--[a-zA-Z0-9-]+|-[a-zA-Z]+)(?:\s+|$)/);
    if (!tokMatch) return undefined;
    const tok = tokMatch[1];
    if (tok === "--login") {
      sawLogin = true;
    } else if (/^-[a-zA-Z]+$/.test(tok)) {
      for (const ch of tok.slice(1)) {
        if (ch === "l") sawLogin = true;
        else if (ch === "c") sawCommand = true;
        else return undefined; // a flag we do not model — do not rewrite it away
      }
    } else {
      return undefined;
    }
    s = stripPosixBlanks(s.slice(tokMatch[0].length));
    if (sawCommand) break;
  }
  if (!sawLogin || !sawCommand || s === "") return undefined;
  // QUOTED, or a single word that cannot mean anything but itself.
  //
  // `shlex::try_quote` quotes anything with a shell character in it and returns
  // everything else UNCHANGED, so a one-word command — `ls`, `pwd`, `make`,
  // `pytest` — arrives as a bare `/bin/bash -lc ls` with no quotes at all.
  // Refusing those kept the wrapper on exactly the commands people run most,
  // leaving them on the bash-3.2 path this whole change exists to get off (#140).
  //
  // The bar for accepting unquoted text is that the two readings cannot differ.
  // Our old path let the OUTER shell expand `$VAR`, glob a `*` or split on a
  // space before bash ever saw it; unwrapping makes the host expand it instead.
  // A word built only from characters no shell treats specially has nothing to
  // expand, glob or split, so `-c ls` and `-c '/bin/bash -lc ls'` run the same
  // program. Anything else — whitespace, `$`, a backtick, `~`, a glob, an
  // operator, a redirect — keeps the wrapper.
  if (s[0] !== "'" && s[0] !== '"') {
    return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : undefined;
  }
  const parsed = parseOneShellWord(s);
  if (!parsed) return undefined; // unterminated quoting — do not rewrite it
  // Exactly one word, or nothing to unwrap. POSIX hands `-c` only the FIRST
  // word as the script and makes the rest `$0`, `$1`, so a remainder means
  // rewriting would change what the command does — `bash -lc rm -rf target`
  // really does run `rm` with no operands.
  if (stripPosixBlanks(parsed.rest) === "") return parsed.word;
  return undefined;
}

export interface PosixSpawnArgv {
  file: string;
  args: [string, string];
}

/**
 * POSIX argv for `terminal/create`. Always `shell: false`: an explicit
 * `[file, '-c', script]` so the host shell cannot exec grok's `bash -lc`
 * wrapper. `hostShell === true` is `/bin/sh` (Node's old default / `cmd` pref).
 * Pure.
 */
/** Hosts whose grammar covers what grok's bash wrapper could run: `[[ ]]`,
 *  arrays, process substitution. Unwrapping into anything else would take a
 *  script grok deliberately sent to BASH and hand it to a smaller shell. */
const BASH_CAPABLE_HOSTS = new Set(["bash", "zsh"]);

export function posixSpawnArgv(command: string, hostShell: string | true): PosixSpawnArgv {
  const file = hostShell === true ? "/bin/sh" : hostShell;
  const base = file.slice(file.lastIndexOf("/") + 1).toLowerCase();
  // Only peel the wrapper when the host can stand in for bash. On `/bin/sh`,
  // dash or ksh — the fallback, the `cmd` preference, a dash `$SHELL` — grok's
  // wrapper stays, so the script still reaches the bash it was written for.
  // That is exactly what v3.19.5 did, and it is right for those hosts.
  const script = BASH_CAPABLE_HOSTS.has(base)
    ? unwrapGrokBashLoginWrapper(command) ?? command
    : command;
  return { file, args: ["-c", script] };
}

/**
 * Choose the shell for the agent's `terminal/*` commands (spawn's `shell`
 * option). On Windows, mirror the standalone grok CLI by running under
 * PowerShell — PowerShell 7 (`pwsh.exe`) when installed, else Windows
 * PowerShell 5.1 (`powershell.exe`), else cmd.exe (Node's `shell: true`
 * default). On POSIX, use `$SHELL` when it is an absolute path (typically
 * `/bin/zsh` on macOS), else `/bin/sh` (Node's `shell: true`). See issue #46.
 *
 * The extension is the one running commands — grok delegates every one over ACP
 * `terminal/create` — so the host shell is *our* choice, not a CLI flag. Under
 * cmd.exe the agent couldn't reach the user's PowerShell profile functions or
 * run pipelines, so it had to re-wrap each command; matching PowerShell (as the
 * standalone CLI already does) removes that friction. The POSIX half is the same
 * idea: a GUI-launched VS Code host otherwise always gets `/bin/sh` (macOS:
 * bash 3.2), which is not the zsh login shell the TUI runs under.
 *
 * POSIX actually spawns `[host, '-c', script]` (`posixSpawnArgv`); Node's
 * `shell:` option is Windows-only here. Node runs a string shell as
 * `<shell> -c "<command>"`, and both pwsh and Windows PowerShell accept `-c`
 * as the `-Command` alias, so the agent's command string runs with PowerShell
 * semantics. We deliberately don't force `-NoProfile`: profile-defined
 * functions/modules are exactly what users expect commands to reach (and what
 * standalone grok reaches).
 *
 * `pref = "cmd"` is the escape hatch (`grok.terminalShell`): force cmd.exe on
 * Windows, `/bin/sh` on POSIX, for anyone the default host bites — e.g. the
 * `powershell.exe` 5.1 fallback rejects `&&` chains and collapses non-zero
 * native exits to 1 (pwsh 7 does neither).
 * Pure given `resolve` and `posixShell`.
 */
export function resolveTerminalShell(
  platform: NodeJS.Platform,
  resolve: (name: string) => string | undefined,
  pref: ShellPreference = "auto",
  posixShell?: string,
): string | true {
  if (pref === "cmd") return true; // cmd.exe on Windows / /bin/sh on POSIX
  if (platform !== "win32") return posixShellFromEnv(posixShell);
  return resolve("pwsh") ?? resolve("powershell") ?? true;
}

/**
 * The `GROK_SHELL` value that tells the agent which shell dialect to WRITE for,
 * derived from the shell we'll actually RUN its commands under
 * (`resolveTerminalShell`). In ACP mode grok emits the raw command to the
 * client's shell but describes the shell from its own host detection, so the two
 * can diverge (e.g. the model writes POSIX `(cd x; y)` for a PowerShell host, or
 * PowerShell syntax when we fall back to cmd) — setting `GROK_SHELL` in grok's
 * spawn env realigns the model's dialect hints with our shell (§2.9;
 * research/oss-surfaces-probe.cjs confirms it drives the first-message `Shell:`).
 * Pure. POSIX maps a resolved `$SHELL` path (`zsh`, `bash`, …) and leaves
 * `undefined` for the `/bin/sh` fallback so grok keeps detecting. Windows maps
 * the resolved shell to grok's accepted override values (`pwsh` / `powershell` /
 * `cmd`).
 */
export function grokShellEnvValue(
  resolved: string | true,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== "win32") {
    // NOTHING on POSIX — a correction to this PR rather than a disagreement
    // with it. Upstream builds the model-facing `Shell:` from `$SHELL` on Unix
    // (`resolve_shell_display`) and reads `GROK_SHELL` there as a PATH to a
    // shell binary, validated with an executable check, so a bare `zsh` never
    // reached the model. Running the shell `$SHELL` names IS the alignment.
    return undefined;
  }
  if (resolved === true) return "cmd"; // cmd.exe: forced pref, or no PowerShell found
  const base = resolved.toLowerCase();
  if (base.includes("pwsh")) return "pwsh";
  if (base.includes("powershell")) return "powershell";
  return undefined; // unknown resolution — let grok's host detection decide
}

/** The resolved terminal shell (cached), for callers that need to align other
 *  subsystems (e.g. the agent's `GROK_SHELL`) with what we run commands under. */
export function resolvedTerminalShell(): string | true {
  return terminalShell();
}

/** Shell grammar used by the process returned from `resolvedTerminalShell`. */
export function resolvedTerminalShellDialect(): "posix" | "powershell" | "cmd" {
  if (process.platform !== "win32") return "posix";
  const resolved = resolvedTerminalShell();
  if (resolved === true) return "cmd";
  const base = resolved.toLowerCase();
  return base.includes("pwsh") || base.includes("powershell") ? "powershell" : "cmd";
}

/**
 * VS Code language id for a command opened via View all. Unknown dialects
 * return undefined so the untitled editor can detect instead of guessing.
 */
export function commandLanguageForDialect(
  dialect: "posix" | "powershell" | "cmd" | string | undefined,
): string | undefined {
  if (dialect === "powershell") return "powershell";
  if (dialect === "posix") return "shellscript";
  if (dialect === "cmd") return "bat";
  return undefined;
}

// Shell resolution runs a `where` subprocess, so cache it for the process
// lifetime instead of paying that cost on every `terminal/create`.
let shellPreference: ShellPreference = "auto";
let cachedTerminalShell: string | true | undefined;

/**
 * Apply the `grok.terminalShell` preference (host reads config → calls this on
 * startup + on change). Clears the cache so the next command re-resolves.
 */
export function setTerminalShellPreference(pref: ShellPreference): void {
  if (pref !== shellPreference) {
    shellPreference = pref;
    cachedTerminalShell = undefined;
  }
}

/**
 * A regular file we can actually execute.
 *
 * `existsSync` says yes to a DIRECTORY named `zsh`, and to a file with no
 * execute bit — either of which `spawn` then fails on for every command
 * (`EISDIR`, `EACCES`) instead of falling back to `/bin/sh`.
 */
function isRegularExecutable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function terminalShell(): string | true {
  if (cachedTerminalShell === undefined) {
    const resolved = resolveTerminalShell(
      process.platform,
      whichOnPath,
      shellPreference,
      process.env.SHELL,
    );
    cachedTerminalShell =
      typeof resolved === "string" && !isRegularExecutable(resolved) ? true : resolved;
  }
  return cachedTerminalShell;
}

/**
 * Manages background processes spawned on behalf of the agent's `terminal/*`
 * ACP requests. Each terminal is a headless shell child process (PowerShell on
 * Windows, `$SHELL` / `/bin/sh` elsewhere — see `resolveTerminalShell`) whose
 * stdout+stderr is captured into a single rolling buffer respecting
 * `outputByteLimit`.
 */
/** Injectable seams for tests — production callers pass nothing. */
export interface TerminalManagerDeps {
  execFileImpl?: typeof execFile;
  platform?: NodeJS.Platform;
  /** Injected so a test can assert the GROUP is signalled, not just the shell. */
  killImpl?: (pid: number, signal: NodeJS.Signals | 0) => void;
}

export class TerminalManager {
  private terminals = new Map<string, TerminalEntry>();
  private nextId = 1;

  constructor(private deps: TerminalManagerDeps = {}) {}

  /**
   * A view of this manager whose commands belong to `owner`.
   *
   * Handed to each ACP client instead of the manager itself, so tearing that
   * client down can take its commands with it. Same interface — the agent side
   * cannot tell the difference.
   */
  ownedBy(owner: object): {
    create(params: TerminalCreateParams): { terminalId: string };
    output(terminalId: string): TerminalOutputResult;
    waitForExit(terminalId: string): Promise<{ exitCode: number }>;
    kill(terminalId: string): void;
    release(terminalId: string): void;
  } {
    return {
      create: (params) => this.create(params, owner),
      output: (id) => this.output(id),
      waitForExit: (id) => this.waitForExit(id),
      kill: (id) => this.kill(id),
      release: (id) => this.release(id),
    };
  }

  /** Kill and forget everything `owner` started. Returns how many. */
  releaseOwnedBy(owner: object): number {
    let n = 0;
    for (const [id, t] of Array.from(this.terminals)) {
      if (t.owner !== owner) continue;
      this.release(id);
      n += 1;
    }
    return n;
  }

  create(params: TerminalCreateParams, owner?: object): { terminalId: string } {
    const env = this.envFromParams(params.env);
    const cwd = params.cwd || process.cwd();
    const byteLimit = params.outputByteLimit ?? DEFAULT_BYTE_LIMIT;
    // `detached` on POSIX so the shell leads its own PROCESS GROUP, which is
    // what makes killing the whole tree possible — see buildKillPlan. Without
    // it a SIGTERM reaches the wrapper and every descendant it started keeps
    // running: on a machine we rent that is an orphan burning CPU that nothing
    // can reach, and on a laptop it is the battery. Not on Windows, where
    // `taskkill /T` already walks the tree and `detached` would open a console
    // window.
    const detached = (this.deps.platform ?? process.platform) !== "win32";
    // Windows still uses Node `shell:` (pwsh/powershell/cmd). POSIX uses an
    // explicit argv so `$SHELL -c` cannot exec grok's `/bin/bash -lc` wrapper.
    // `process.platform` (not `deps.platform`): kill-plan tests inject win32
    // on a POSIX box and still have to spawn a real local command.
    let proc: ChildProcess;
    if (process.platform === "win32") {
      proc = spawn(params.command, { cwd, env, shell: terminalShell(), detached, windowsHide: true });
    } else {
      const { file, args } = posixSpawnArgv(params.command, terminalShell());
      proc = spawn(file, args, { cwd, env, detached });
    }

    const entry: TerminalEntry = {
      owner,
      proc,
      buf: "",
      byteLen: 0,
      truncated: false,
      exitCode: null,
      exitListeners: [],
      byteLimit,
      decoder: new StringDecoder("utf8"),
    };

    const onChunk = (d: Buffer) => {
      if (entry.byteLen >= entry.byteLimit) {
        entry.truncated = true;
        return;
      }
      const remaining = entry.byteLimit - entry.byteLen;
      const slice = d.length > remaining ? d.subarray(0, remaining) : d;
      // decoder.write emits only complete characters; any bytes that fall on a
      // truncation/chunk boundary mid-character are held back, not corrupted.
      entry.buf += entry.decoder.write(slice);
      entry.byteLen += slice.length;
      if (d.length > remaining) entry.truncated = true;
    };
    proc.stdout?.on("data", onChunk);
    proc.stderr?.on("data", onChunk);
    proc.on("error", (err) => {
      entry.settled = true;
      entry.buf += `\n[spawn error] ${err.message}`;
      entry.exitCode = -1;
      for (const l of entry.exitListeners) l(-1);
      entry.exitListeners = [];
    });
    // FINISHING is two events, not one. Node's `exit` fires when the process
    // ends, which can be BEFORE its stdout has been delivered to us; `close`
    // fires once the pipes are drained. Resolving on `exit` alone means an
    // agent can ask for the output of a command that ran fine and receive
    // nothing — three CI runs on ubuntu-latest showed exactly that, with
    // `printf HIT` exiting 0 and no output, while 65 spawns across macOS and a
    // real Ubuntu never reproduced it.
    //
    // Waiting for `close` ALONE would be worse: a command that starts a
    // background daemon leaves stdout open, and `waitForExit` would then block
    // until the daemon died instead of returning promptly. So: take the exit
    // code from `exit`, and give the pipes a bounded moment to finish.
    const settle = (code: number) => {
      if (entry.settled) return;
      entry.settled = true;
      if (entry.drainTimer) {
        clearTimeout(entry.drainTimer);
        entry.drainTimer = undefined;
      }
      if (!entry.truncated) entry.buf += entry.decoder.end();
      entry.exitCode = code;
      for (const l of entry.exitListeners) l(code);
      entry.exitListeners = [];
    };
    proc.on("close", () => {
      if (entry.exitCode != null && entry.settled) return;
      if (entry.pendingExitCode != null) settle(entry.pendingExitCode);
    });
    proc.on("exit", (code, signal) => {
      if (entry.exitCode != null) return; // spawn error already set it; don't clobber
      const resolved = resolveExitCode(code, signal);
      entry.pendingExitCode = resolved;
      // Already drained (`close` first, or no pipes to wait on): finish now.
      const open = [proc.stdout, proc.stderr].filter((st) => st && !st.readableEnded);
      if (open.length === 0) {
        settle(resolved);
        return;
      }
      // Otherwise let the reads finish, but never wait on them indefinitely.
      entry.drainTimer = setTimeout(() => settle(resolved), DRAIN_GRACE_MS);
      entry.drainTimer.unref?.();
    });

    const terminalId = `t-${this.nextId++}`;
    this.terminals.set(terminalId, entry);
    return { terminalId };
  }

  output(terminalId: string): TerminalOutputResult {
    const t = this.required(terminalId);
    return {
      output: t.buf,
      exitStatus: t.exitCode != null ? { exitCode: t.exitCode } : null,
      truncated: t.truncated,
    };
  }

  waitForExit(terminalId: string): Promise<{ exitCode: number }> {
    const t = this.required(terminalId);
    if (t.exitCode != null) return Promise.resolve({ exitCode: t.exitCode });
    return new Promise((resolve) => {
      t.exitListeners.push((code) => resolve({ exitCode: code }));
    });
  }

  kill(terminalId: string): void {
    const t = this.terminals.get(terminalId);
    if (!t) return;
    const pid = t.proc.pid;
    try {
      const platform = this.deps.platform ?? process.platform;
      const plan: KillPlan =
        pid != null ? buildKillPlan(pid, platform) : { kind: "signal", signal: "SIGTERM" };
      // Windows has no cheap way to ask whether a pid's tree still exists, and
      // `taskkill /T` on a recycled pid would kill somebody else's tree. The
      // exit code is the best answer available there.
      if (plan.kind === "taskkill" && t.exitCode != null) return;
      if (plan.kind === "taskkill") {
        const exec = this.deps.execFileImpl ?? execFile;
        (exec as any)(plan.file, plan.args, { windowsHide: true }, (err: Error | null) => {
          // taskkill can run-but-FAIL (Access Denied, protected child) with the
          // tree still alive — fire-and-forget left the agent's wait_for_exit
          // pending forever. Fall back to a direct signal so the exit listeners
          // always eventually fire. (An already-gone tree errors too, but then
          // exitCode is set and the signal is skipped; a signal racing a
          // just-died wrapper is a harmless no-op.)
          if (err && t.exitCode == null) {
            try {
              t.proc.kill("SIGTERM");
            } catch {
              /* ignore */
            }
          }
        });
      } else if (plan.kind === "group") {
        // ONLY WHILE THE WRAPPER IS ALIVE.
        //
        // Two previous versions each got half of this. Signalling whenever we
        // are asked can reach a pid the OS has recycled and kill somebody
        // else's work. Probing first with signal 0 does not help: it proves
        // that *a* group holds that id, not that it is OURS — an empty group
        // releases its id and the next one to get it answers the probe just as
        // happily.
        //
        // The wrapper's own liveness is the one thing that settles it. While it
        // is running, its group exists and is unambiguously ours, so the signal
        // is safe. Once it has exited we cannot tell our surviving descendants
        // from a stranger's group, and killing a stranger is the worse mistake.
        //
        // The cost is a command deliberately detached from its shell —
        // `nohup job &`, `disown` — which outlives the wrapper and is neither
        // tracked nor killed. That is what detaching MEANS, and it is a leak we
        // can see rather than a signal we cannot aim.
        if (t.exitCode != null) return;
        const killImpl = this.deps.killImpl ?? ((p: number, sig: NodeJS.Signals | 0) => process.kill(p, sig));
        try {
          killImpl(-plan.pid, plan.signal);
        } catch {
          // Never became a group leader — a stub in a test, or a platform that
          // refused `detached`. The child self-guards against being exited.
          try { t.proc.kill(plan.signal); } catch { /* already gone */ }
        }
      } else {
        t.proc.kill(plan.signal);
      }
    } catch {
      /* ignore */
    }
  }

  release(terminalId: string): void {
    this.kill(terminalId);
    this.terminals.delete(terminalId);
  }

  disposeAll(): void {
    for (const id of Array.from(this.terminals.keys())) this.release(id);
  }

  /**
   * Is any command still running?
   *
   * Asked by the keep-awake rules, and it is the only HONEST answer to "is this
   * machine still doing something". Session status cannot answer it: the agent
   * can start a twenty-five-minute build and then ask a question, at which
   * point the session says it is waiting for a person while the build carries
   * on. On a cloud machine, believing the status there freezes the build.
   *
   * `exitCode === null` is precisely "has not exited". A released terminal has
   * already left the map.
   */
  anyRunning(): boolean {
    for (const t of this.terminals.values()) if (t.exitCode === null) return true;
    return false;
  }

  private required(terminalId: string): TerminalEntry {
    const t = this.terminals.get(terminalId);
    if (!t) throw new Error(`unknown terminalId: ${terminalId}`);
    return t;
  }

  private envFromParams(envParam: TerminalCreateParams["env"]): NodeJS.ProcessEnv {
    const env = { ...process.env };
    if (Array.isArray(envParam)) {
      for (const e of envParam) env[e.name] = e.value;
    }
    return env;
  }
}
