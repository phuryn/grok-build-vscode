# Workspace Grok account home (#219)

`grok.homeDirectory` is a window-scoped VS Code setting intended for Workspace
settings. `configureWorkspaceGrokHome` runs synchronously at the start of
`activate`, before `GrokSidebar` or any home-dependent readers are constructed.
It expands `~`, requires a fully absolute path, and warns visibly while ignoring
invalid input. An unset or invalid setting preserves the inherited environment.
On Windows, drive-relative and current-drive-rooted paths are rejected.

Setting `process.env.GROK_HOME` once keeps the existing history, config, usage,
credential watchers and child processes on the same home. Account terminals need
an explicit `TerminalOptions.env` too: VS Code creates them outside the extension
host. The latched setting also wins over a `GROK_HOME` in the project's `.env`
when `buildEnv` prepares a session. Changes offer Reload Window and leave both
the environment and launch policy latched until reload. This setting is not read by desktop/cloud hosts or
exposed in the AFK Pilot Settings panel. The manifest keeps its existing absence
of `capabilities.untrustedWorkspaces`, so the extension is disabled in Restricted
Mode. A multi-root VS Code window shares one account home; this is a window setting.

Configured Grok ACP sessions use `agent --no-leader … stdio`. Although the tested
CLI separates leaders by home, explicitly avoiding the shared leader makes the
account boundary independent of implicit socket selection and user leader config.
Without this setting, existing launch arguments are preserved.

## Manual verification, 2026-11-03

Ran `node research/workspace-grok-home-probe.cjs` on native Windows with real
`grok 1.0.70 (f50904eaee6c)`. The probe creates throwaway homes and a simulated
default profile entirely inside the repository's ignored `.tmp-*` tree. It never
reads, copies or prints `auth.json`, and never uses the real default home.
Only the CLI executable itself is located under the installed `.grok/bin`.

| Check | Result |
| --- | --- |
| Leader in the throwaway default profile, explicit socket `<profile>/.grok/leader.sock` | Started and listened on `grok-leader-46c7b33639130624`. |
| Same-home ACP client with that socket | Attached to the existing leader; no new leader spawned. |
| ACP client with another `GROK_HOME`, no socket override, `--leader` | Spawned a separate leader, created its own `leader.lock`, and listened on `grok-leader-5814a552f5cb51d6`. The implicit Windows pipe follows `GROK_HOME` in this CLI. |
| Plain `grok agent stdio` with the second home and its leader already running | The clean 1.0.70 config selected `use_leader=false` and did not attach. The forced-leader check above covers configurations that enable sharing. |
| ACP client in a third home with the shipped `--no-leader` policy | Debug log reported `use_leader=false`, with no leader attachment. Empty-home session reported not logged in. |
| Nonexistent nested home | Grok created it, including config/session directories. No authentication file appeared. |
| Panel terminal command `grok login`, and device command `grok login --device-auth`, with that home | Both attempted sign-in and failed at the sandbox network restriction; no authentication file appeared. |
| Panel command `grok logout`, with that home | Exited 0; home remained unauthenticated. |

`grok leader info/kill` could not discover even the reachable explicit leader
(`no reachable leader found for target …`), so they are not the evidence for
isolation. The same-home attachment control, separate pipe names, spawned-leader
log and separate home lock are. The probe cleans up the explicit process and
the exact subprocess PIDs recorded by its own throwaway client logs.

Unit tests cover path resolution on Windows/POSIX, application before readers,
the actual backend spawn policy, VS Code terminal environment for login/logout,
and reload acceptance/dismissal/removal without live switching. The CLI probe
stays outside `npm test`, which remains real-provider-CLI-free.

Not verified: completed browser/device authentication or removal of an actual
credential (network was blocked, and no credentials were copied into the probe),
two authenticated accounts, macOS/Linux leader behavior, or a live VS Code panel
interaction. For a new account folder, reload then sign in from AFK Pilot.
