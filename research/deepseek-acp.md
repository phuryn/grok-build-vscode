# DeepSeek through the official dsh harness

Experimental, desk only. Enable `grok.experimentalDeepSeek`, then connect under
Settings > Providers. Install and key entry are host-local. A phone may chat
with an already connected desk. Cloud hosts never advertise this provider.

`deepseek` belongs to `INTERNAL_PROVIDERS`, never the frozen `ACP_PROVIDERS`.
Every renderer gates it on the host's `providerState`. Its action row enables
adapter history and client-side one-shot auto acceptance only. Plan, native
mode switching, manual compaction, deletion, steering, client MCP, and forks are
unavailable. The context popup explains the manual compaction limit. Minimal suppresses approval controls entirely, with a persistent
full-access notice. The official harness owns all agent execution.

## Compositions and native runtime

The provider mark comes from dsh-web-frontend's MIT-licensed favicon; its notice
is included in resources/deepseek/LICENSE.

The pin is `@deepseek-ai/dsh@0.2.1-rc.5`. Default uses `--profile acp`.
Minimal uses `--profile sdk-minimal --patch <minimal-acp.patch.yml>`; the
overlay in `resources/deepseek/` disables SDK startup/JSON-RPC and inserts
the official ACP startup and bridge. It retains the shipped minimal tool tree,
persona and compaction. The Web UI's preset registry is not on ACP's session
creation path. No composed replacement for dsh-base and no SDK adapter is used.

The two profiles have separate persistent `deepseek-home/default` and
`deepseek-home/minimal` directories in host storage. The overlay is copied
there before launch so external Node can read it even from packaged Electron.
Default on Windows uses `windows-shell.patch.yml` to select the official
`dsh-pwsh-local` executor. The file-tool policy and approval services stay
composed; clients show that shell commands run without a sandbox. Minimal
retains its persistent full-access terminal. Inherited DSH composition overrides
are removed. The homes are separate from
the person's normal `~/.dsh` configuration.

Source inspection of the installed pin, **not a live measurement**, establishes:

- Minimal's persistent shell calls the terminal service, which reaches
  `dsh-subprocess-local`'s lazy `node-pty` require and `spawn`.
- Default includes subprocess-local and JSONL persistence. Windows process
  containment calls `dsh-win32-process`, which loads Koffi; POSIX JSONL locking
  calls `@deepseek-ai/node-addon-system/flock` and its native `system.node`.
- Windows minimal's tool is named `pwsh`. Its resolver tries PowerShell 7,
  then falls back to Windows PowerShell 5.1 (`powershell.exe`). It does not
  require the user to install `pwsh`.
- The subprocess service strips sensitive environment names before spawning
  agent shell commands, including `DEEPSEEK_API_KEY`. This needs to be checked
  again on every pin update.

The private runtime is official Node 22.23.4. Installation downloads its archive
and `SHASUMS256.txt` from nodejs.org, checks SHA-256 before extraction, then runs
that Node's own npm with `ci` against the checked-in lockfile. Native install
scripts run under that Node, not Electron. The global Node installation stays
unchanged. Antigravity's installer panel/progress frames are shared. DeepSeek
uses the tool rows' blinking dots; percentages appear only during download.

`grok.deepseekPath` optionally names an installation directory containing
`node/` (the extracted official distribution) and `runtime/` (package.json,
package-lock.json and the installed dsh tree). The installation must contain the pinned dsh version. An explicit path wins outright;
otherwise only the current managed pin is located. No PATH or older-pin
adoption. The installer does not run during extension installation or tests.

Node release provenance: https://nodejs.org/en/blog/release/v22.23.4
Upstream: https://github.com/deepseek-ai/deepseek-harness

## Conversations and credentials

After choosing a DeepSeek model, open the context popup and choose Harness:
Default / Minimal (the same location and row shape as Grok context-window
selection). Before the first message the choice replaces the untouched process,
keeping the model and draft. Thereafter the row is disabled and reads
"Start a new session to use a different DeepSeek harness."
Host checks bind each choice to session id, model and generation,
and recheck that no first send won the race. The selected harness is fixed; a cold reopen restores `SessionMetaOverride.deepseekHarness`
from the existing `grok.sessionMeta` store. That store already owns custom
renames, first-prompt `autoName`, activity, provider and project metadata. No
new title store and no parsing of dsh's unstable JSONL format.

History uses `session/list` in both homes and `session/resume`, never
`session/load`. The catalog only returns id and cwd, and excludes the live session on the same
connection. The host retains the id from session/new and includes its known
live sessions independently of the catalog. Warm host buffers remain
visible. A cold reopen explains that dsh retained context but earlier messages
are unavailable in this view. Context occupancy comes from `usage_update`;
no cost or subscription figures are invented.

Connected hosts warm the model catalog with `session/new` before the first
message, including when another provider owns the visible conversation. Key
replacement invalidates the cache and aborts older reads before rediscovery.
The throwaway is never prompted and is excluded from AFK Pilot history. Names
are formatted for display; descriptions, supplied release tags and opaque tuple
values are preserved. Catalog discovery can consult dsh's authenticated model
listing; it is not a credential check.

Key priority: `DEEPSEEK_API_KEY`, then `HostSecrets`' `grok.deepseekApiKey`.
Only source/presence is advertised; no key is read back by a remote. Connect
records consent after local key submission/adoption. `authenticate` is a no-op,
so it is never used to prove a credential. A rejected key stays attributed to
DeepSeek and never triggers token recovery or an automatic resend. Disconnect
keeps the saved key; explicit host logout removes it, and cannot unset a parent
process's environment variable.

## Verification and the manual probe

`test/fixtures/fake-deepseek-acp.cjs` implements the source-shaped ACP contract:
no load/modes/delete, list id/cwd only, no-op authenticate, one-shot permissions,
config options, cancellation, and resume without replay. Unit/DOM/host tests use
only this fixture and fake downloads. They cannot prove real persistent-shell
cancellation or approval coverage.

Owner-run measurements on **2026-11-01**, dsh 0.2.1-rc.5, Node 24.11,
Windows 11 (not run by this implementation agent):

- Both compositions answered ACP; Minimal's transport overlay worked keyless
  and live. Minimal exposed exactly pwsh, read_image and working_directory.
  Windows PowerShell 5.1 was sufficient.
- Initialize took about 6.7-7.6 seconds for Default, 1.5-2.1 seconds for Minimal.
  It reported no auth methods, no image prompts, close/list/resume and HTTP MCP.
  v1 still disables client MCP. Image attachments are refused before sending.
- Model values are opaque JSON tuple strings. The original names below were
  supplied by dsh; the client now formats their labels. Keyless listed only deepseek-v4-flash; keyed added DeepSeek-V4.1-Flash
  (deepseek-flash) and DeepSeek-V4-Pro. Efforts: off, low, high, max; default high.
- Both shells ran echo without asking permission. Default permission coverage
  remains unobserved. Its 25-tool tree remains upstream-owned.
- Tool title pwsh, kind other, rawInput.command and completed text content are
  rendered as a command row. Common file/search tools use the title fallback
  for kind other; existing subagent cards display the description.
- usage_update reports size 1000000. A live session was absent from list;
  an earlier closed, empty session was present.

`research/deepseek-acp-probe.cjs` is manual and requires `--run`. Build first,
then pass the runtime directory and an empty scratch directory with
`DEEPSEEK_API_KEY` in the environment. It covers:
Default file-write permission (reports UNOBSERVED if none), Stop during an
actual long shell command then a successful shell prompt in both modes,
switching to another advertised opaque model value, close and resume in a
**fresh process** using the retained id, child-process cleanup, and a rejected
key. It uses at most eight tiny prompts, sets effort off, does not retry, and
does not repeat tool inventory or shell-persistence questions. The implementation agent has not run dsh or the probe. The owner subsequently
ran it against the real managed Node 22.23.4 installation on Windows: Stop and
the next prompt, model switching, fresh-process resume, child cleanup, and
rejected-key checks all passed. The installer completed in about 5.5 minutes.
Default write again requested no permission, so live approval coverage remains
**unobserved**. The owner also exercised connect, the context-popup harness
picker, a Minimal live turn, and the subsequent lock in VS Code 1.142.

Revisit the composition, native dependencies, cancellation/cleanup, and credential
scrubbing whenever updating the pinned preview. Default permission requests are
still covered only by source-shaped fixtures, not by a live observed request.

## Review fixes

DeepSeek restarts preserve the held transcript, including a failed send, because
resume supplies no replay. Only a genuine cold open shows the missing-transcript
notice. Cold resume cannot prove an empty conversation and keeps the harness
locked. The host retains its session id if a warm startup fails before resume.

Approval cards use the tool-row input/label helpers for full shell commands and
file paths, with the existing diff preview. A carried image is refused before
the composer consumes text or enters busy; the host also restores the sender's
text and ends busy if an older renderer sends it. Environment-key connection
offers only Connect. Subscription placeholders and unsupported connector tips
are hidden. The rail glyph names DeepSeek.

The context popup is right-anchored and capped to its panel width; locked copy
wraps. Happy DOM tests cover the positioning
bound and wrapping rules, but cannot measure rendered CSS geometry. Verify the
locked popup visually in a narrow VS Code panel.

## First-test feedback: source evidence

This pass read the published **dsh-v0.2.1-rc.5** source as a fallback: the
execution sandbox denied reading the installed runtime directory. No installed
files were changed. Published source cannot prove a compiled installation's
behavior; all automated runs use our fake ACP fixture, with no DeepSeek API calls.

### Windows shell

The [base composition](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/bundle/base/cordis.patch.yml#L235)
mounts the sandboxed PowerShell executor on Windows. Before spawn,
[`sandbox-local`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/sandbox/sandbox-local/src/index.ts#L381)
grants the canonical session workspace, then a private `os.tmpdir()/dsh-*`
directory. Changing only the temp path cannot fix the workspace grant.
[`acl.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/sandbox/sandbox-windows-acl/src/acl.ts#L243)
calls `SetNamedSecurityInfoW` with DACL and mandatory-label edits together.
It needs ownership/WRITE_DAC and WRITE_OWNER for the Low label. Modify access
does not suffice. This workspace's ACL showed inherited Modify for authenticated
users, consistent with this failure. The abbreviated owner error does not prove
which grant path or Win32 code failed; retain the full diagnostic if it recurs.

Supported alternatives are the wrapper's `danger-full-access` policy or the
official [`dsh-pwsh-local`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/shell/pwsh-local/src/index.ts)
component. Our Windows-only Default overlay selects the latter, retaining the
normal subprocess manager, file-tool policy and approval services. No ACL repair,
elevated launch, temp-path workaround or vendor edit is needed. Minimal already
uses a persistent full-access terminal. Muse's precedent is commit `40f793c`;
its launch rule is unchanged.

### Catalog, Compact and child results

The [model controller](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/acp/acp/src/model-control.ts#L145)
returns names/descriptions and inserts a raw selected id when discovery omits it.
Its exact tuple values are validated when selecting models.
[API-key discovery](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/llm/llm-deepseek-api-key/src/index.ts#L102)
depends on credential presence and may follow a model listing. This accounts for
the measured keyless fallback and keyed choices. The
[built-in catalog](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/llm/llm-deepseek/src/models.ts)
contains `deepseek-flash` / `DeepSeek-V4.1-Flash` and `deepseek-v4-pro` /
`DeepSeek-V4-Pro`, with a descriptive Pro blurb and no release-date field or
`1017` suffix. The client formats supplied names and preserves any supplied tag
without inventing a version or parsing opaque values for display.

The [ACP contract](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/acp/acp/README.md#L70)
omits commands. Its [prompt path](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/acp/acp/src/session.ts#L266)
queues a user message through `agent.followup`, without human-command dispatch.
No commands are advertised. A `/compact` prompt therefore does not establish
native compaction or fresh compacted occupancy. Compact stays disabled and the
popup explains why; the fake also treats slash text as ordinary prompt text.
The [compact plugin contract](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/compaction/command-compact/README.md#L56)
explicitly leaves automation surfaces without command adapters on automatic
condensation only.

The [subagent tool](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/subagent/tool-subagent/src/index.ts#L252)
returns an activation id and renders `started subagent <id>`. Internal
`subagent/start` and `subagent/end` events exist, but the
[ACP event path](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/acp/acp/src/index.ts#L124)
projects owned root-session assistant/tool events, not child lifecycle or parent
inbox messages. No individual child terminal result is projected in the inspected
path. `list_agents` reports activity, not a task result; inactive residency must
not be treated as completion. Parent tools remain visible as ordinary tools.
The [runtime contract](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/subagent/subagent/README.md#L137)
describes results delivered as user-role parent notices; those notices are not
among the ACP mapper's forwarded event types.
A DeepSeek launch receipt leaves the card "in background", with an explanation
and no duration: the child reports to its parent agent, never on this tool call.
A launch failure still shows its error; parent completion does not finish a card.

Measured live on Windows, 2026-11-02/03 (Flash, one prompt each). The first
overlay (`- id: pwsh-sandbox` with `name: '@deepseek-ai/dsh-pwsh-local'`) was
silently skipped: dsh's `applyEntryPatches` treats a row's `name` as a match
guard (`dsh-app-boot`, "name mismatch ... skipping"), so the sandbox stayed. A
plain `Get-ChildItem` in a fresh temp folder could not tell the difference; a
write outside the workspace could: denied with that overlay, `ok` with the
current one (disable `pwsh-sandbox`, insert `dsh-pwsh-local`). The keyed
catalog read "DeepSeek V4 Flash", "DeepSeek V4.1 Flash 1017"
(dsh's own `ui-deepseek-model-label-1017` badge, mirrored under its condition)
and "DeepSeek V4 Pro"; the launch receipt was exactly
`started subagent <uuid>`, and the parent's next reply carried the child's
result. dsh never answered `initialize` while it inherited `VSCODE_IPC_HOOK`
(>90 s; about 15 s warm without it), so the backend strips `VSCODE_*`.

### Remaining owner-run checks

After rebuilding and installing this working tree:

1. Leave a fresh install card open through npm dependency installation: dots
   animate, download percentages disappear after download, Cancel still works.
2. Connect DeepSeek while another provider is selected. Before sending, open
   the picker and check the keyed catalog and clean names. Without an environment
   key, replace the saved key via Connect and check that an old keyless catalog
   is replaced. Reload the host and check discovery again.
3. Select DeepSeek, type a draft, switch Minimal then Default before sending.
   Check that the draft and model survive. After a send, check the disabled
   selector and exact new-session note, with no new-conversation button.
4. In Default on Windows, check the shell notice, ask for `Get-ChildItem -Force`
   in the project, then Stop a long command and run a short command again. Repeat
   a short command in Minimal. Keep any full Win32 error, including its path.
5. After a turn, open the context popup on desk and phone: manual Compact is
   unavailable and explained. No `/compact` prompt should be generated by the UI.
6. Delegate a small read-only task in Default. Check the running launch card,
   task title and expanded explanation on desk, phone and reconnect. If a later
   parent tool carries a correlated result, capture the raw ACP update for a
   source-backed mapping. Check that launch failures remain visible.

No elapsed install clock was added: the shared animation needs no timer lifecycle,
and npm supplies no honest install percentage. No live DeepSeek request was run.
