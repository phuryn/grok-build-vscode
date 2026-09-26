# Signing agents in

Grok Build drives three command-line agents, and it never holds their
credentials. Each one signs you in itself, stores its own token in its own
directory, and talks to its own vendor. The extension's job is to start the
right command in the right place.

That matters more than it sounds, because it decides what is possible from a
phone and on a machine with no screen.

## What the app does today

It depends on where you press the button, and the difference is deliberate.

**At the computer** — VS Code, Cursor, or the desktop app — **Connect** (the
agent chooser, or **Settings → Providers**) first checks whether the agent's CLI
is already signed in. If it is, that sign-in is used and nothing opens. If it is
not, the agent's sign-in panel appears, and only its sign-in button opens a
terminal there and runs the agent's own login command:

| Agent | Command | Credential lands in |
|---|---|---|
| Grok Build | `grok login` | `~/.grok/auth.json` |
| Codex | `codex login` | `~/.codex/auth.json` |
| Claude Code | `claude auth login` | `~/.claude/` (or the OS keychain) |

A terminal is the better affordance there, because the CLI opens your browser
for you — after you have pressed the button that asks it to. Muse Code has no
terminal step: its sign-in card shows the vendor's link and code, and the link
opens when you click it.

**From a phone or browser**, there is no terminal to look at, so the same button
runs the agent's **headless device-code flow** instead and shows you the URL and
the short code it prints. You open the link, confirm the code, and the page
finishes on its own. The credential still lands on the computer running the
extension — nothing is stored in the browser, and the relay never sees it.

Signing in is classified `"full"` in
[`src/remote-policy.ts`](../src/remote-policy.ts). It was `host-local` until remote
sign-in shipped, and what changed was the implementation rather than the policy:
a remote request no longer opens a terminal on your desk. It can only *add* a credential
that you obtain yourself, in your own browser, from the vendor.

GitHub is a Settings → Providers row as well as the clone form. Connection
state comes from `gh api user --jq .login` (`githubState`): exit 0 and a
non-empty login is connected; a failed call with `GH_TOKEN` or `GITHUB_TOKEN`
set on the host is the named "env token in force and not working" case.
Device-code sign-in is the same runner as before (`setupGithubCli` is
`"full"`). Sign-out is `host-local` on a desk (same class as agent `logout`)
and admitted on a cloud machine, where the remote is the only surface. A
pasted token (`githubLoginWithToken`) is `"full"`: the secret crosses the
relay once, is never echoed, and `gh auth login --with-token` stores it. If
an env token is already in force, the paste is refused rather than stored
behind a credential that would not be used.

**Signing out stays `host-local`.** The asymmetry is intentional — connecting
adds an option, disconnecting takes one away from every other surface at once.

Not every agent can do this, and the app tells you which:

| Agent | From a phone? | Why |
|---|---|---|
| Grok Build | yes | `grok login --device-auth` prints a URL and a code and polls |
| Codex | if your CLI and account allow it | needs `--device-auth` in your build **and** "Allow device code login" on the account |
| Claude Code | yes | `claude auth login` prints a URL on a plain pipe; you paste the code Anthropic shows you back into the page |

The app does not decide this from a version number. It runs the command and
reports what came back, so a CLI that gains the flow starts working with no
update here. Two shapes, not one: Grok and Codex are **device-code** (the CLI
polls); Claude Code is **paste-code** (the page writes the code to the CLI's
stdin). The plan names that shape (`needsCode`); it is not inferred from a
missing printed code.

## Signing in without a browser on that machine

Every one of the three has a headless path, and they are not the same shape.
Verified against the versions below — check `--help` on yours before relying on
any of it, because two of these are recent.

### Grok Build — device code

```bash
grok login --device-auth      # alias: --device-code
```

Prints a URL and a short code. Open the URL on any device, enter the code, and
the CLI polls until it is confirmed. Present in `grok 1.0.5`.

`GROK_HOME` overrides `~/.grok`, so pointing it at a persistent volume keeps a
container's login across restarts.

There is also an API-key path: set `XAI_API_KEY` (a console.x.ai key). Two traps
if you use it — the CLI reads it internally as `GROK_CODE_XAI_API_KEY`, and **a
cached OAuth session shadows the env key**, so `grok logout` is needed before an
API key takes effect. The extension detects that second case and says so.

### Codex — device code, in beta

```bash
codex login --device-auth
```

Documented by OpenAI as the preferred path for headless environments, and gated
behind a ChatGPT security setting you have to enable first — **Settings →
Security → "Allow device code login"** on a personal account, or the equivalent
workspace permission, which only an admin can turn on.

**Still not present in `codex-cli 0.149.0`** (re-checked 2026-08-26: `codex
login` offers `--with-api-key` and `--with-access-token` and no device flag), so
check yours before planning around it. Grok Build tries it anyway and reports
what the CLI said, so it will start working the moment your build has it. Until
then there are three fallbacks:

- run `codex login` on a machine with a browser and copy `~/.codex/auth.json`
  across (documented, with the obvious warning — the file is a password);
- `printenv OPENAI_API_KEY | codex login --with-api-key`;
- `CODEX_HOME` to relocate the whole directory.

### Claude Code — paste-code

```bash
claude auth login
```

The default (`--claudeai`, a Claude subscription). Measured on a real cloud
machine, claude 2.1.251, through a **plain pipe** — no pty, no `script`, no
native module:

```
Opening browser to sign in…
If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=…&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=…&code_challenge=…&state=…
Paste code here if prompted >
```

Exactly one URL, no ANSI, no redraw. Its `redirect_uri` is
`platform.claude.com/oauth/code/callback` — the paste-code flow: open that URL
anywhere, sign in, Anthropic shows a code, write the code back to the CLI's
stdin. `claude auth status` prints JSON (`{"loggedIn": true, …}`); that is the
success signal, not the process exit code.

`claude setup-token` is a different command: an Ink TUI that printed **zero
bytes** on a pipe (measured 2026-08-26 on 2.1.246). Grok Build does not use it.
The ACP adapter never takes a credential from us — Anthropic's CLI stores it.

Claude Code additionally accepts `ANTHROPIC_API_KEY` for anyone with API access,
which is billed separately from a subscription.

## Running Claude Code somewhere we host

Anthropic states this explicitly, so it is worth quoting rather than
paraphrasing. From [Claude Code's legal and compliance
page](https://code.claude.com/docs/en/legal-and-compliance):

> Nor does it prevent an end user from signing in to the unmodified Claude Code
> binary with their own Claude subscription, including where a platform hosts
> Claude Code.

Hosting is permitted, with conditions: the binary must be unmodified, no
built-in authentication method may be removed or restricted, the host must
agree to Anthropic's Commercial Terms, and — the one that shapes the design —

> Customers may not pay for, resell, or intermediate Claude usage on their end
> users' behalf.

and

> developers may not collect, store, or intermediate Claude.ai credentials or
> session tokens — sign-in to a Claude account must complete through Anthropic's
> own flow.

**So "log in at your desk and copy the token to the server" is not an option for
Claude**, however convenient it looks. The sign-in has to complete where the
agent runs. That is a constraint on us, not on you: it is why any hosted
environment would run the login inside the environment rather than forwarding
anything from your machine.

The same principle is worth applying to all three even where it is only good
practice rather than a rule. A token that never moves is a token that cannot
leak in transit.

## What this means for remote control

A phone can do almost everything the desk can — start conversations, answer
permission prompts, schedule routines, browse and edit project files. It can now
also **connect an agent**, for the agents whose CLI offers a device-code flow
(see the table above).

What a phone still cannot do is sign an agent **out** (except on a cloud
machine, where the remote is the only surface). Connecting Claude Code from
the browser is the paste-code flow above; there is no computer to walk to.

If you are setting up a machine you will only ever reach remotely, connecting
from the browser is enough for all three agents. A token still never leaves
the machine the CLI runs on.

## Where the credentials live

Nothing in this list is ever read, copied, or transmitted by the extension or by
the AFK Pilot relay. They are listed so you know what to protect and what to
delete.

| Agent | Path | Override |
|---|---|---|
| Grok Build | `~/.grok/auth.json` | `GROK_HOME` |
| Codex | `~/.codex/auth.json` | `CODEX_HOME` |
| Claude Code | `~/.claude/` or the OS keychain | — |

`~/.grok/auth.json` is refused by name everywhere the extension serves files,
and the relay never sees any of them. See [Privacy](privacy.md).

## Signing out

`grok logout`, `codex logout`, `claude auth logout` — or **Settings → Providers
→ Sign out**, which runs the same command. Signing out of Grok is also the fix
for a cached OAuth session shadowing an `XAI_API_KEY` you would rather use.
