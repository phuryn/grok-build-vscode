# Muse native approval modes (#192)

## Mode dictionary

Muse's installed SDK defines a closed four-value ApprovalMode union in
node_modules/@muse-code/sdk/dist/src/msp.d.ts. The menu uses the owner's
selected Muse names and the CLI descriptions supplied in the brief; the SDK
has no better per-mode descriptions. Terminal permission profiles are outside
serve's selectable dictionary. Muse has no Plan.

The SDK dictionary is retained below, but Deny unmatched is temporarily not
offered. Desktop offers Allow all, Prompt unmatched and On request; cloud
offers Allow all and Prompt unmatched.

| Wire id | Muse approvalMode | Label | Description |
|---|---|---|---|
| yolo | allowAll | Allow all | No prompts; everything runs. |
| agent | promptUnmatched | Prompt unmatched | Prompt for anything no rule matches (the interactive default). |
| onRequest | onRequest | On request | Tools run sandboxed; prompt only on explicit permission requests. |
| denyUnmatched | denyUnmatched | Deny unmatched (hidden) | Anything no rule matches is denied. |

The existing agent and yolo ids retain their meanings in saved postures,
shared settings, telemetry, and other providers. session/start.approvalMode
selects the initial mode; session/setApprovalMode changes it live. Muse's
SDK documents that a switch applies from the next action, is durable and
replays on resume; it does not resolve an already pending approval.

## Deny unmatched hold — 2026-09-28

Reported upstream as [meta-models/muse-code-sdk#63](https://github.com/meta-models/muse-code-sdk/issues/63);
re-enable the mode when a Muse release closes it.

Owner-supplied measurement from Muse's own session log on a cloud machine:
after every turn, Muse starts its background `verify-reminder` agent. Its
internal `submit_reminder_decision` call is denied with
`deny_unmatched: no policy rule allows this action`. The agent retries and
Muse's end-of-turn gate waits until it gives up: **`eot_gate_ms: 62806`**.
The answer is visible but the conversation remains busy for about a minute,
and the next message waits in the queue. This is a Muse bug; the owner chose
to hide Deny unmatched on every host until a Muse release fixes it.

`musePosture` maps remembered defaults and saved Deny unmatched postures to
Prompt unmatched, preserving the conversation's other preferences. The
adapter also normalizes startup posture. On resume (including a buffered
mode notification), `publishMode` calls `session/setApprovalMode` with
`promptUnmatched`, verifies acceptance, then publishes `agent`. Pending
approvals and prompts wait for that repair. The host saves the effective
mode and its badge follows. A refused repair fails resume instead of running
another turn in the broken mode. Stale direct Deny unmatched picks are not
applied. The wire id, validators, telemetry and native dictionary stay valid.

To re-enable after verifying an upstream fix against the reminder and a
queued follow-up: restore `denyUnmatched` to both `sessionModes` lists in
`src/mode-prefs.ts` and remove the adapter's `modes` filter for it. Remove
the Deny unmatched normalization in `musePosture` and adapter `initialize`,
the adapter `setMode` refusal, the `publishMode` repair and its prompt wait.
Restore the Settings/README mode lists and the corresponding tests. Keep
the renderer's native-order label detection: dropping a mode must not change
the remaining modes' names. Converted conversations remain Prompt unmatched
unless the owner selects another mode; there is no migration to reverse.

## Desktop process and persistence decisions

- Allow all starts serve with --disable-sandbox --trust-workspace.
- Prompt unmatched uses the conversation's shell sandbox,
  sandbox network and workspace trust preferences.
- On request always starts with the shell sandbox enabled, even when the
  host's Shell sandbox setting is off. Network and trust remain configured
  preferences; this mode does not implicitly grant workspace trust.
- Sandbox and trust are launch flags. Live approval changes do not restart
  Muse or alter those flags. Session.museShellSandbox records the launch
  fact separately from the mutable SessionMetaOverride.musePosture.mode.
- The host offers On request but disables it with a reason while that process
  has no sandbox. The host and adapter also reject direct requests for that
  unsafe switch. Switching an unsandboxed Allow all process to Prompt
  unmatched does not make On request available. Switch to Prompt unmatched,
  enable Shell sandbox under Settings > Providers > Muse Code, then start a
  new conversation to obtain a sandboxed process.
- The last successful Muse selection is remembered in host memento state
  under grok.defaultMuseMode, independently of grok.defaultMode. This lets
  a new Muse conversation start in On request without leaking it into
  another provider's defaults. Until Muse has its own preference, the shared
  default remains the fallback. Choosing agent/yolo still writes those values
  to grok.defaultMode; onRequest never does. A stored denyUnmatched defaults to agent.
- Reopening uses the conversation's saved posture rather than either default.
  The badge and saved posture follow the effective native mode after any
  Deny unmatched repair.
  Unknown/terminal-created histories start with conservative launch flags.
  If stale saved launch flags are unsandboxed but Muse replays On request,
  the adapter publishes that fact and fails closed before forwarding pending
  approvals or admitting a prompt. The host saves On request for that resume
  id even before ACP load completes; reopening again launches sandboxed.
- Refused switches change neither the badge nor saved posture/defaults. The
  old one-time host approval fallback has been removed: Allow all means Muse
  accepted allowAll. The host does not auto-answer Muse's pending cards.

The host-local Settings rows name the offered modes and explain the sandbox
exception. They remain unavailable to phones. Boot scripts, terminal
permission profiles and trust files are unchanged.

## Cloud rule: the VM is the sandbox

The host decides cloud-ness using isCloudEnvironment(). Conversation and
catalog MuseBackend instances pass that launch fact in GROK_MUSE_POSTURE;
it is never inferred by the renderer or saved in the conversation's posture.
The isolated cloud VM supplies the boundary. Every cloud Muse process uses
--disable-sandbox and omits --sandbox-network. Prompt unmatched keeps its
native prompts. Workspace trust is unchanged:
Allow all forces it; the other modes use the saved preference.

The cloud host advertises only Allow all and Prompt unmatched,
with no disabled On request row. Direct requests for On request are also
refused. Session.museCloud and sessionModeMessage carry the same restriction
through live messages and reconnect snapshots. Desktop mode advertisement,
launch rules and sandbox guards are unchanged.

Existing On request conversations are **refused**, rather than silently
changing their durable mode. The adapter reads session/read before attaching
on cloud and returns a clear ACP error if its durable mode is On request;
the resume and live-notification guards also refuse it if the effective mode
changes after that read. No pending approval or prompt is admitted. This
preserves the conversation's desktop mode. Opening it on a desktop and
changing its mode permits a later cloud resume, even with stale host metadata.
A remembered On request default seeds a **new** cloud conversation as Prompt
unmatched; that safe startup default never overrides an existing history.
On request is never run without Muse's sandbox.

The three Muse Settings rows are host-local, and host-local rows never render on
a remote. A cloud machine is only ever seen from a remote, so no cloud-specific
visibility rule is needed: the rows cannot appear there. On cloud the launch
rule above decides sandbox and network, whatever the stored settings say.

## Receiver and compatibility audit

This extends the existing mode plumbing; it is not a second picker or policy
system. New values on setMode/modeChanged are **not inherently additive**.

- protocol.ts uses ModeId for setMode.modeId and modeChanged.modes. The
  current modeId remains a string to tolerate a future host. Optional
  disabledModes carries per-process reasons.
- chat.js offers only the ids advertised in modes. Muse names activate when
  the native menu starts with yolo, agent: three choices on desktop and
  two on cloud. This existing order distinguishes the native menu from old
  hosts advertising agent/yolo, which retain Agent mode / Auto accept and their existing descriptions,
  including the museNativeModes capability's earlier wording. No modes frame
  retains the old hidden Muse button. Unknown current ids show Unknown mode;
  unknown offered ids are not selectable. Grok, Codex and Claude keep their
  existing menus and labels.
- The desktop validator and remote parser accept exactly the known ModeId
  vocabulary. The remote parser previously passed setMode through its default
  known-message branch without inspecting the value; it now validates and
  reconstructs that payload. The host also rejects Muse-only ids for every
  other provider, including the VS Code path that casts renderer messages.
- remote-policy.ts already proposes setMode against the bound conversation
  and mirrors modeChanged whole. No policy row changes are needed. Both live
  messages and sessionUiSnapshot use sessionModeMessage, preserving disabled
  reasons on desktop refresh and phone reconnect.
- telemetry.ts accepts the two new ids; modeToRemember returns null for them.
  displayMode uses Muse's reported mode, while other providers retain the
  host's existing Plan/auto-approval state logic.

REMOTE_PROTO_VERSION remains 1 because the current renderer never sends a
new mode value to an older host: the host's modes advertisement gates the
choices. This is deliberate capability negotiation, not an assumption that
adding enum values is compatible. No claim is made that an old receiver
accepts a new value.

## Local probe limitation - 2026-09-28

Attempted from this repository:

    & "$env:LOCALAPPDATA/Programs/muse/muse.cmd" serve --help

PowerShell reported that C:\Users\Dell\AppData\Local/Programs/muse/muse.cmd
was not recognized as a command. The executable is inaccessible/unresolvable
in this sandbox. No Muse process, MSP session or model turn ran, and no trust
file was accessed. This is an access failure, not a measurement of Muse's
behavior. The SDK schema and injected connection tests verify mapping and
launch flags; they cannot establish actual runtime sandbox enforcement.

## First real cloud measurement - 2026-09-28

Measured on an AFK Pilot Cloud sprite, Linux, Muse 1.4.0; results supplied by
the owner in the follow-up brief, not measured by this local agent:

- System bwrap failed for plain, user-namespace and net-namespace sandboxes:
  "bwrap: Unexpected capabilities but not setuid, old file caps config?"
  Muse had no usable embedded fallback.
- With the sandbox on, muse exec --approval-mode never **failed closed**.
  Its shell tool reported "environment failure: sandbox enforcement
  unavailable" and "Bubblewrap is unavailable for linux", followed by
  "The execution environment is broken: the command was never started and
  every later command will fail the same way." No command ran.
- Consequently, sandboxed Prompt unmatched, On request and Deny unmatched
  could not execute shell commands there. Allow all worked because it
  disabled Muse's sandbox. The default sandbox had also blocked cloud Muse
  before the four-mode change.

This supersedes the earlier unmeasured-cloud caveat. The owner's decision is
the launch and visibility rule above: the VM is the cloud sandbox. These
measurements are specific to that cloud environment and Muse version; they
are not a claim that Muse's desktop sandbox is unavailable.

No substantive error in the supplied four-mode dictionary or protocol brief
was found. The docs audit did find older architecture prose claiming Muse
had no mode command; that prose and the older two-label descriptions have
been replaced. Commits 8be0ec8, 6bf651a and 4e26215 were reviewed as the
starting behavior, including refused-switch persistence and launch timing.

## Verification

The focused tests cover offered starts, switches and replays, Deny unmatched
default/saved-posture normalization and durable resume repair; the SDK's
closed dictionary; Windows/Linux spawn arguments; sandbox-off settings;
refused switches; stale-posture resume recovery; defaults and telemetry;
VS Code/desktop/phone DOM behavior; older hosts; unknown current ids;
non-Muse menus; desktop/remote validation; reconnect restrictions; and
host-local Settings copy. Connections are injected doubles, not real CLIs.

Initial four-mode validation passed on 2026-09-28:

- npx.cmd tsc -p . --noEmit
- npm.cmd run compile:muse-adapter
- npm.cmd run compile (extension and Electron host TypeScript, plus adapter)
- Focused Vitest run: **799 tests in 15 files passed**, with --maxWorkers=2.
  Files: muse-mode.test.ts, muse-mode.dom.test.ts, muse-session.test.ts,
  mode-prefs.test.ts, session-start-retry.test.ts, muse-backend.test.ts,
  settings-surface.dom.test.ts, protocol.test.ts, remote-frames.test.ts,
  desktop-host-pure.test.ts, telemetry.test.ts, provider-enumerations.test.ts,
  session-ui-snapshot.test.ts, marketplace-readme.test.ts,
  muse-effort-request.test.ts (all under test/).
- git diff --check.

Node/npm use C:\Program Files\nodejs on PATH and the .cmd launchers.
README.marketplace.md was regenerated from README.md with the repository's
script. Earlier focused failures were outdated fallback/snapshot expectations;
the final run above is passing.

The cloud follow-up additionally verifies all cloud launch postures, the
three advertised native choices, pre-attach refusal and replay refusal of
On request, safe startup defaults, restoration after a desktop mode change,
and hidden sandbox settings in host and standalone Settings surfaces. The
desktop mode and sandbox tests run alongside them. The focused command uses
the first seven files above plus session-ui-snapshot.test.ts and
marketplace-readme.test.ts; temporary files and the npm cache stay inside
the repository's ignored .verification directory.

Cloud follow-up validation on 2026-09-28: **461 tests in 9 files passed**;
npx.cmd tsc -p . --noEmit, npm.cmd run compile:muse-adapter and
git diff --check also passed.

npm.cmd run package rebuilt the host and adapter successfully, then stopped
in check:vsix: npm list reported ELSPROBLEMS for builder-util-runtime@9.7.0
and js-yaml@4.3.0. Their installed versions match both lockfiles; the cloud
change does not alter dependency versions or overrides. No dependency repair
or packaging-check bypass was attempted. No new VSIX was produced.

No full npm test,
VS Code/Electron/browser launch, install, commit, push or release is part of
this task. Changes remain uncommitted at the existing package version.
