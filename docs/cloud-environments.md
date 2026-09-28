# Running in a cloud environment

A **cloud environment** — a **Cloud machine**, in the product — is a machine AFK
Pilot runs for you, rather than one you own. The same host runs there as on your
desk: this repository's code, the same agent CLIs, the same projects and
routines, reached from a phone or any browser.

This page is about what the *host* does differently when it is hosted.

## How the host knows

One environment variable, read in one place:

```bash
GROK_CLOUD_ENVIRONMENT=1
```

`isCloudEnvironment()` in [`src/remote-frames.ts`](../src/remote-frames.ts) is
the only reader. Deliberately not inferred from the platform or the relay URL —
both of those have other reasons to look cloud-shaped, and a host that guesses
wrong about what it is will guess wrong about what it may do.

## What changes

### It says what it is

The device picker shows a **cloud** kind with "(by afkpilot.com)", not "Desktop
app, Linux". Both of those are true and neither is any use: nobody installed a
desktop app, and the operating system of a machine you do not administer is not
information. See [Signing agents in](provider-login.md) for the same principle
applied to sign-in.

### It tells the relay when to wake up

A routine fires on a laptop because somebody opened the laptop. A hosted machine
has nobody to open it, so `nextWakeAt()` in [`src/routines.ts`](../src/routines.ts)
reduces the whole schedule to a single timestamp and posts it to
`/api/environment/wake-at` whenever the schedule changes.

**The relay is told when, never what.** Not the cadence, not the routine's name,
not the prompt — one number. Teaching the relay about routines would put
schedules in a database that deliberately holds no payloads.

`null` is a real value: pausing or deleting your last routine clears the standing
wake, or the machine starts up nightly for something that no longer exists.

Best-effort. A relay that is unreachable or older than the endpoint gets silence,
because a failure here **delays** a routine and never loses one — catch-up is
arithmetic, so a missed window still runs when the machine next comes up.

### Connectors work here, and it is worth saying why

It reads like they could not. Connecting an MCP connector is a browser OAuth
flow at the vendor, and a hosted machine has no browser — nor, unlike a desk,
any computer to walk over to.

But the consent does not happen *here*. It happens in the browser of whoever
asked, and the relay callback hands the code back to this host. Nobody is
completing somebody else's OAuth: the person doing it is the one holding the
phone.

So nothing is withheld. `mcpSettings` is advertised exactly as on a desk —
`canShowMcpSettings` is true on both hosts and has no cloud branch — and
`connectMcpConnector` / `disconnectMcpConnector` are `full` for any capable
remote.

### Signing in, and signing out

Connecting an agent uses the device-code flow that any remote client uses
(shipped 3.19.0 — see [Signing agents in](provider-login.md)). It has to work:
there is no desk to fall back to, so a cloud environment with nothing connected
could otherwise never be made usable.

Signing **out** was classified `host-local` by reasoning about a desk: revoking
a credential affects every other surface using it. Here the environment *is* the
only surface, so the argument inverts — and `CLOUD_DISPOSITION` in
[`src/remote-policy.ts`](../src/remote-policy.ts) now says so: `logout` and
`githubSignOut` are `full` on a cloud host and `host-local` everywhere else.
`refreshProviders`, `setTelemetryEnabled` and `setThumbsFeedback` re-home for
the same reason — each is withheld from a desk because the desk owner has
another surface, and meaningless to withhold where the browser is the only one.

## What does not change

Almost everything. The host is the same binary running the same code: chat,
sessions, projects, file browse and edit, routines and permission prompts all
behave exactly as they do on a desk, because none of them ever depended on who
owned the machine.

The capability policy is the exception, and `CLOUD_DISPOSITION` is the whole of
it. Three things are worth knowing:

- **Worktrees do not re-home.** `newWorktreeSession`, `applyWorktree` and
  `removeWorktree` stay `host-local` and are absent from that table, and the
  rail hides apply and remove on a remote. On a cloud machine the remote is the
  only client there is, so those controls are not reachable by the person using
  it at all. `removeProjectFolder` is host-local here for the same reason.
- **`keep-awake.ts` never starts.** `shouldKeepAwake` returns false as soon as
  the host is a cloud one, so the OS wake lock is skipped rather than attempted.
  That is deliberate and not a failure: a wake lock cannot stop a hypervisor
  pausing the machine, and what holds a cloud environment up is the uplink's
  `working` heartbeat. Silent spawn-failure is the desk path, not this one.
- **Your agent credentials live in the environment.** Sign-in completes there,
  against the vendor, and nothing transits the relay. That is required for Claude
  and good practice for the rest — a token that never moves cannot leak in
  transit — and it means the environment is a credential store.

## The Linux AppImage

This repo publishes a **Linux AppImage** that serves two audiences. A cloud
machine has nobody to walk up to and install anything, so it fetches a built
artifact rather than compiling one: building this app from source on such a
machine was measured at 25 minutes, against seconds to download. It is
unsigned, because there is nothing to sign it for.

The same file is the Linux desktop download offered at
`https://afkpilot.com/desktop`. The two uses do not collide, because a cloud
machine **extracts** the AppImage and execs `squashfs-root` while a desk runs
the file itself — and `electron-updater`'s `AppImageUpdater` refuses to run
unless `process.env.APPIMAGE` is set, which only the second case has. So a
cloud machine never touches the update feed and cannot self-update out from
under the relay's refresh tooling, while a desk user gets real in-place
updates. There is deliberately no cloud check in the updater path: the
property is structural, and a check would be one more thing to keep true.

There is **exactly one AppImage per release**, and the relay's boot script,
`refresh-sprite-hosts.mjs` and `patch-sprite-host.mjs` all select it by the
`.AppImage` extension alone. Attaching a second one would make every one of
those selectors ambiguous. Do not add a variant without changing them first.
The Debian package attached beside it (`Grok-Build-Desktop-<version>-linux-amd64.deb`)
is not an AppImage, so those selectors stay unambiguous. The process inside
the AppImage is named `grok-build-desktop`. Hosts that run the AppImage file,
or `AppRun` after extracting it, do not depend on that inner name.
