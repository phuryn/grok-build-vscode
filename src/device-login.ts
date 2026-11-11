/**
 * Device-code sign-in — the pure half.
 *
 * `runGrokLogin` has always opened an interactive terminal on the desk. That is
 * the right thing on a desk (the CLI opens the browser for you) and it is why
 * the capability was `host-local`: a phone can neither see that terminal nor
 * type into it, and opening one on someone's machine from elsewhere is not
 * something a remote should be able to do.
 *
 * The CLIs have since grown headless flows that print a URL and a short code
 * and then poll. That is the whole flow a phone needs — display two strings,
 * wait. So the remote path runs the CLI with pipes and renders what it printed
 * into the transcript, and the desk path is untouched.
 *
 * WHAT WAS MEASURED, because two of the three surprised us:
 *
 *   grok 1.0.5    `grok login --device-auth`   works on pipes. Prints the URL
 *                 and the code to STDERR (not stdout), keeps polling, exits 0
 *                 when the browser approves. Device-code: we display, it polls.
 *   claude 2.1.251 `claude auth login`         works on a plain pipe — no pty.
 *                 Prints one URL (paste-code `redirect_uri` on
 *                 platform.claude.com) and waits on stdin for the code the
 *                 person copies from Anthropic's page. `claude setup-token`
 *                 is a different command (an Ink TUI); it is not this flow.
 *                 Success is `claude auth status` → `{ loggedIn: true }`.
 *   codex 0.149.0 `codex login --device-auth`  the flag does not exist in this
 *                 build. OpenAI documents it, and it is additionally gated on
 *                 an account setting ("Allow device code login") that a
 *                 workspace admin can withhold.
 *   muse 1.3.0   `muse login`                works on pipes, prints Meta's URL
 *                 and code, then polls. The login subcommand loads no workspace;
 *                 the bare binary hits the workspace-trust gate instead.
 *
 * So this module does NOT hardcode "grok works, the others don't". It asks the
 * CLI and believes the answer: {@link deviceLoginPlan} says which command to
 * try and whether the person must paste a code back, the runner tries it, and
 * {@link classifyDeviceLoginFailure} turns whatever came back into something a
 * person can act on. Capability detection, never version numbers.
 */
import type { AcpProvider } from "./acp-backend";

/** How long to let a headless login sit before giving up on it. Device codes
 *  from every vendor we have looked at expire inside 15 minutes, so waiting
 *  longer only holds a dead child process open. */
export const DEVICE_LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

/** How long to wait for the URL before concluding the CLI is not going to
 *  print one. Generous: it covers a cold binary and a slow first HTTPS round
 *  trip, and the cost of being wrong is telling someone "no" who could have
 *  had a yes. A TUI that prints nothing on a pipe is still the thing this
 *  separates from a slow-but-working print, so 25 s leaves room. */
export const DEVICE_LOGIN_PROMPT_TIMEOUT_MS = 25_000;

export interface DeviceLoginPlan {
  /** Argv after the CLI path. */
  args: string[];
  /** The person must paste a code back into the CLI's stdin. Grok, Codex and Muse
   *  print a code and poll on their own; Claude's paste-code flow does not.
   *  Explicit on the plan, not inferred from a missing printed code. */
  needsCode?: boolean;
}

/**
 * The headless login command to try for a provider, or undefined when we know
 * of none to try.
 *
 * The plan is the argv and the flow shape. Claude is paste-code (`needsCode`);
 * Grok, Codex and Muse are device-code (the CLI polls). A provider without a command
 * we know to try stays undefined, and {@link deviceLoginUnavailable} /
 * {@link noRemoteSignInMessage} explain that to the panel.
 */
export function deviceLoginPlan(provider: AcpProvider): DeviceLoginPlan | undefined {
  if (provider === "grok") return { args: ["login", "--device-auth"] };
  if (provider === "codex") return { args: ["login", "--device-auth"] };
  if (provider === "claude") return { args: ["auth", "login"], needsCode: true };
  if (provider === "muse") return { args: ["login"] };
  return undefined;
}

/** Why a provider has no remote sign-in, in a sentence a person can act on. */
export function deviceLoginUnavailable(
  _provider: AcpProvider,
  _opts: { isCloud?: boolean } = {},
): string | undefined {
  return undefined;
}

/**
 * The sentence for a provider that cannot be signed in from here at all.
 *
 * Split out of the sidebar so it is testable, and because its cloud branch is
 * the whole point: "connect it at your computer" is good advice at a desk and a
 * DEAD END in a cloud environment, where there is no computer to walk to.
 */
export function noRemoteSignInMessage(
  displayName: string,
  opts: { isCloud?: boolean } = {},
): string {
  if (opts.isCloud) {
    return `${displayName} has no sign-in that works from here yet.`;
  }
  return `${displayName} has no sign-in that works without a terminal. Connect it at your computer.`;
}

/**
 * What to tell somebody BEFORE they start a sign-in that is likely to fail.
 *
 * Codex device-code login is **off by default on every account**. OpenAI
 * disables it deliberately — a device code is more social-engineerable than a
 * browser redirect — so the first attempt fails for almost everyone, and the
 * error arrives after a wait, in the middle of a flow they had already
 * committed to.
 *
 * A person can fix it in about fifteen seconds, and only if they are told
 * where. So this is shown BEFORE the button does anything, not after it fails.
 *
 * Cloud only, and that is the whole point of the flag: at a desk the browser
 * flow works and this setting never comes up. Showing it there would be a
 * warning about a problem the reader does not have.
 */
export interface DeviceLoginPreflight {
  /** Heading for the step, e.g. "Step 1 of 2 — …". */
  title?: string;
  /** Label for the button that starts the sign-in. */
  continueLabel?: string;
  /** One sentence on why this is here. */
  reason: string;
  /** The exact path through the vendor's settings. */
  steps: readonly string[];
  /** Where to go and do it. */
  url?: string;
}

/**
 * What to say next to the code itself, per provider.
 *
 * OpenAI's device page shows a security warning: device codes are used in
 * phishing attacks, only continue if the sign-in was started in the Codex CLI.
 * That warning is correct and we cannot suppress it — so the honest move is
 * to name it first, and tell the reader the one thing the warning asks them to
 * confirm: yes, the Codex CLI on this machine started this (owner, with a
 * screenshot of the warning, 2026-08-31).
 */
export function deviceLoginCodeNote(provider: AcpProvider): string | undefined {
  if (provider !== "codex") return undefined;
  return "OpenAI will show a **security warning** about device codes. That is expected here: "
    + "the Codex CLI on this machine started this sign-in, and the code below is the one it printed. "
    + "Never use a code you did not start yourself.";
}

export function deviceLoginPreflight(
  provider: AcpProvider,
  opts: { isCloud?: boolean } = {},
): DeviceLoginPreflight | undefined {
  if (!opts.isCloud) return undefined;
  if (provider !== "codex") return undefined;
  return {
    title: "Step 1 of 2 — turn on device sign-in",
    reason:
      "Codex needs one setting turned on before a code will be accepted. It is "
      + "off by default for everyone — OpenAI disables device-code sign-in "
      + "unless you ask for it.",
    steps: [
      "[Open ChatGPT](https://chatgpt.com/#settings/Security) and go to Settings → Security",
      // The setting sits at the very BOTTOM of a long page, and people reported
      // not finding it. `**` is rendered as bold by the panel.
      "Turn on \"Device code authorization for Codex\" **at the very bottom**",
    ],
    url: "https://chatgpt.com/#settings/Security",
    continueLabel: "Done — continue",
  };
}

// Explicit escapes, not literal control bytes: an ESC written straight into
// a source file survives an editor but not reliably a patch, and this repo
// has already repaired one regex byte-level for exactly that reason.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const OSC = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g;

/** Strip terminal control sequences. The CLIs colour their output even when
 *  stdout is a pipe, so a naive URL match drags an escape code along with it. */
export function stripAnsi(text: string): string {
  return text.replace(OSC, "").replace(ANSI, "");
}

export interface DeviceLoginPrompt {
  url: string;
  code?: string;
  /** Set from the plan, never inferred from a missing printed code. */
  needsCode?: boolean;
}

// Trailing punctuation is not part of a URL when the CLI wrapped it in prose.
const URL_RE = /https?:\/\/[^\s<>"')\]]+/;
// Vendors print codes as two short groups. Matched on the STRIPPED text, and
// deliberately not `\w+` — that swallows ordinary words like "Waiting".
const BARE_CODE_RE = /\b([A-Z0-9]{4,8}-[A-Z0-9]{4,8})\b/;

/**
 * Pull the URL and code out of whatever the CLI has printed so far.
 *
 * Order matters. The code is read from the URL's own query string first
 * (`?user_code=SDCN-9XZS`, which is what grok emits) because that pairing is
 * unambiguous; the bare-token scan is the fallback for a CLI that prints them
 * on separate lines and nothing else code-shaped. Reversing those two lets a
 * stray uppercase hyphenate elsewhere in the banner win.
 *
 * Returns undefined until a URL exists — a code with nowhere to type it is not
 * a prompt worth showing.
 */
export function parseDeviceLoginPrompt(raw: string): DeviceLoginPrompt | undefined {
  const text = stripAnsi(raw);
  const url = text.match(URL_RE)?.[0];
  if (!url) return undefined;
  const trimmed = url.replace(/[.,;:]+$/, "");
  const fromUrl = codeFromLoginUrl(trimmed);
  const code = fromUrl ?? text.match(BARE_CODE_RE)?.[1];
  return code ? { url: trimmed, code } : { url: trimmed };
}

/** Device-code query params only. `code=true` on Claude's authorize URL is a
 *  boolean flag for the paste-code flow, not a user code to display. */
function codeFromLoginUrl(url: string): string | undefined {
  const user = url.match(/[?&]user_code=([^&#\s]+)/i)?.[1];
  if (user) return decodeURIComponent(user);
  const raw = url.match(/[?&]code=([^&#\s]+)/i)?.[1];
  if (!raw) return undefined;
  const decoded = decodeURIComponent(raw);
  return BARE_CODE_RE.test(decoded) ? decoded : undefined;
}

/**
 * `claude auth status` JSON. `loggedIn: true` is the success signal for a
 * paste-code sign-in; an exit code alone has been unreliable across CLIs here.
 * Returns undefined when the output is not that JSON, so a caller can fall
 * back rather than invent a verdict.
 */
export function parseClaudeAuthStatus(raw: string): boolean | undefined {
  const text = stripAnsi(raw).trim();
  const read = (value: string): boolean | undefined => {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object" && typeof (parsed as { loggedIn?: unknown }).loggedIn === "boolean") {
        return (parsed as { loggedIn: boolean }).loggedIn;
      }
    } catch {
      /* not JSON */
    }
    return undefined;
  };
  const direct = read(text);
  if (direct !== undefined) return direct;
  const blob = text.match(/\{[\s\S]*\}/);
  return blob ? read(blob[0]) : undefined;
}

export type DeviceLoginFailure =
  /** The provider's sign-in window elapsed. */
  | "expired"
  /** The CLI rejected the flag — an older build that predates the flow. */
  | "unsupported"
  /** The account or workspace has device-code login switched off. */
  | "not-permitted"
  /** Ran, printed no URL. Almost always a TTY-only flow. */
  | "no-prompt"
  /** Ran, printed a URL, and then failed or was never approved. */
  | "failed";

/**
 * What went wrong, from the CLI's own output and exit code.
 *
 * `sawPrompt` is the discriminator that matters: a run that never printed a URL
 * failed at a different place than one that printed a URL and then gave up, and
 * conflating them produced the least useful message available ("sign-in
 * failed") for the case with the most obvious fix.
 */
export function classifyDeviceLoginFailure(
  output: string,
  sawPrompt: boolean,
): DeviceLoginFailure {
  const text = stripAnsi(output).toLowerCase();
  // clap and friends: "unexpected argument '--device-auth' found".
  if (/unexpected argument|unknown (?:option|flag|argument)|unrecognized option/.test(text)) {
    return "unsupported";
  }
  if (/device[- ]code (?:login|auth)[^.]*(?:disabled|not enabled|not allowed)|contact your (?:workspace )?admin|enable device code/.test(text)) {
    return "not-permitted";
  }
  return sawPrompt ? "failed" : "no-prompt";
}

/** The failure, said to the person who pressed the button. */
export function deviceLoginFailureText(
  provider: AcpProvider,
  failure: DeviceLoginFailure,
  displayName: string,
): string {
  if (failure === "expired") return "This sign-in expired after five minutes. Start again.";
  // Antigravity signs in through Google's page.
  if (provider === "agy" && failure === "failed") {
    return "Google sign-in for Antigravity did not finish. If the browser window was closed or the page timed out, try again.";
  }
  switch (failure) {
    case "unsupported":
      return `This version of the ${displayName} CLI has no headless sign-in. `
        + "Update it, or connect this agent at your computer.";
    case "not-permitted":
      return `${displayName} device-code sign-in is switched off for this account. `
        + (provider === "codex"
          ? "Turn on \"Allow device code login\" in ChatGPT → Settings → Security, then try again."
          : "Enable it in your account settings, then try again.");
    case "no-prompt":
      return `The ${displayName} CLI did not offer a sign-in code, which usually means its `
        + "sign-in needs a real terminal. Connect this agent at your computer instead.";
    case "failed":
      return `${displayName} sign-in did not complete. The code may have expired — try again.`;
  }
}

/**
 * Environment for a headless login.
 *
 * Every one of these says the same thing in a different dialect: there is
 * nobody here to answer a prompt. Without them a CLI that decides it is
 * interactive blocks forever on a read that will never return, and the symptom
 * is not an error — it is a spinner on someone's phone until the timeout.
 */
export function deviceLoginEnv(
  base: NodeJS.ProcessEnv,
  opts: { needsCode?: boolean } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    TERM: "dumb",
    NO_COLOR: "1",
    // Nothing may open a browser on the host: the whole point is that the
    // person is somewhere else, and a window opening on an unattended desk is
    // at best litter.
    BROWSER: "none",
    GIT_TERMINAL_PROMPT: "0",
  };
  // Paste-code must wait on stdin. `CI=1` is how a CLI decides nobody is
  // here to answer; leaving it set would skip the prompt this flow needs.
  if (!opts.needsCode) env.CI = "1";
  return env;
}
