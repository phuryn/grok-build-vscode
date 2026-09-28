# Muse native modes (#192)

## Behavior

The public mode ids remain `agent` and `yolo`. Muse's narrow
`supportsApprovalModeSwitching` capability leaves `supportsModeSwitching`
false, so it cannot enable Plan. `museNativeModes` advertises the new menu
wording to renderers; older hosts retain their previous wording and behavior.

For a new conversation, the host passes its selected mode and Agent settings
to the adapter in `GROK_MUSE_POSTURE`. Auto accept selects `allowAll` on
`session/start` and spawns `serve --disable-sandbox --trust-workspace`.
Agent explicitly selects `promptUnmatched`. Its process defaults remain
sandbox on, network proxy-only, and no explicit trust flag. The host never
reads or writes Muse's trust file to promote trust.

The three host settings are `grok.museShellSandbox`,
`grok.museSandboxNetwork`, and `grok.museTrustWorkspaces`. They configure new
Agent conversations, are available on desktop and the separate VS Code
Settings webview, and have defaults `true`, `"proxy-only"`, and `false`.
No cloud-specific defaults or boot scripts change.

A live switch sends `session/setApprovalMode` and does not restart the
process. Sandbox and trust change at the next process start. Each
conversation keeps its original Agent settings and its latest selected mode
in `SessionMetaOverride.musePosture`, independently of `grok.defaultMode`.
Reopening uses that saved posture before spawning, then lets Muse's replayed
approval mode drive the badge. A history with no host record starts with
conservative flags; the replayed mode is saved for its next reopen.

Accepted native full access disables the host's one-time approval path.
If Muse rejects a live switch to Auto accept, the host warns and retains the
once-only fallback. A rejected switch to Agent leaves the previous mode
visible. MSP documents that a mode switch does not retroactively answer a
pending approval: such cards remain answerable by the person. Replayed mode
is published before pending approvals are forwarded, preventing the fallback
from granting them during reopen.

## Step 0: attempted on 2026-09-28, blocked

These are access failures, **not measurements of Muse behavior**:

1. `gh issue view 192 -R phuryn/grok-build-vscode --json body` failed with a
   forbidden socket access error. The web fetch also failed. Implementation
   used the issue description included in the task; the issue body was not
   independently retrieved.
2. `Get-Content "$env:USERPROFILE/.config/muse/trust.json" -Encoding UTF8`
   failed with access denied. No trust file was modified.
3. The CLI check was attempted from a new temporary directory:

   ```powershell
   $probeDir = Join-Path $env:TEMP ('muse-mode-probe-' + [guid]::NewGuid().ToString('N'))
   New-Item -ItemType Directory -Path $probeDir | Out-Null
   Push-Location $probeDir
   try { & "$env:LOCALAPPDATA/Programs/muse/muse.cmd" serve --help } finally { Pop-Location }
   ```

   The sandbox could not resolve/access that executable. No Muse process,
   MSP session, or model turn ran. No other repository was accessed.

Consequently, **whether `serve` inherits terminal trust and the actual default
MSP approval mode remain unverified**. The Settings description does not claim
trust inheritance. `promptUnmatched` is an explicit implementation choice
based on the owner's supplied local observation, not a new measurement.
Nothing in the brief was disproved by a live probe. The pending-approval
semantics above come from the installed SDK's `SessionSetApprovalModeResult`
documentation.

## Validation

Node/npm were initially absent from the effective PATH. A readable installation
was found under `C:\Program Files\nodejs`. Commands use its `.cmd` launchers
to avoid PowerShell's npm wrapper probing the inaccessible user npm prefix:

```powershell
$env:PATH = 'C:\Program Files\nodejs;' + $env:PATH
npx.cmd tsc -p . --noEmit
npm.cmd run compile:muse-adapter
npx.cmd vitest run C:/GitHub/grok-build-vscode/test/protocol.test.ts C:/GitHub/grok-build-vscode/test/muse-session.test.ts C:/GitHub/grok-build-vscode/test/muse-backend.test.ts C:/GitHub/grok-build-vscode/test/muse-mode.test.ts C:/GitHub/grok-build-vscode/test/muse-mode.dom.test.ts C:/GitHub/grok-build-vscode/test/mode-prefs.test.ts C:/GitHub/grok-build-vscode/test/settings-surface.dom.test.ts C:/GitHub/grok-build-vscode/test/session-start-retry.test.ts C:/GitHub/grok-build-vscode/test/muse-effort-request.test.ts
```

Both TypeScript commands passed. The final focused run passed all **382 tests
in 9 files** (9.53 seconds). `git diff --check` also passed.

The adapter tests inject fake MSP connections. They cover Windows/Linux spawn
arguments, startup approval modes, live changes, refused/missing effective
modes, replay, and pending-approval ordering. Host tests cover per-conversation
persistence and replay authority. DOM tests cover Settings messages and live
refresh in the actual standalone boot script, plus old-host and phone behavior.

`npm.cmd test > .verification/muse-x4-npm-test.log 2>&1` was attempted in full.
Three protocol-registry failures found there were fixed and passed in the
focused rerun. Two existing lifecycle tests failed; 308 of 310 files reported
before the run stalled and was interrupted. The unfinished files were
`acp-integration.test.ts` and `remote-preview.dom.test.ts`.

Additional isolation commands:

```powershell
npx.cmd vitest run C:/GitHub/grok-build-vscode/test/lifecycle-host.test.ts
npx.cmd vitest run C:/GitHub/grok-build-vscode/test/acp-integration.test.ts -t 'lifecycle: spawn'
npx.cmd vitest run C:/GitHub/grok-build-vscode/test/remote-preview.dom.test.ts
```

Lifecycle: 11 passed, 2 failed. A disposable Node-child reproduction confirmed
`taskkill /T /F /PID <owned-child>` returns `ERROR: Access denied`, exit 1, in
this sandbox. The ACP test's prompt succeeds but cleanup fails with `EBUSY`
because its child retains the temporary workspace: 1 failed, 24 unselected.
Remote preview: 1 passed in isolation. These files were not modified.

A second full-suite attempt ran:

```powershell
npm.cmd test -- --maxWorkers=2 > .verification/muse-x4-npm-test-final.log 2>&1
```

It reproduced the two lifecycle failures and again stopped reporting at
**308 of 310 files**. After more than eight minutes, with the same ACP and
remote-preview files unreported, it was interrupted (exit 1). Reducing worker
contention did not resolve the stall. Both full runs are incomplete; there is
**no passing full-suite result**. The ACP cleanup and lifecycle failures have
the isolated evidence above; the remote-preview full-run stall is unexplained.
The final 382-test focused run includes the pending-approval ordering fix.

No `test:integration`, `test:live`, `smoke:*`, VS Code, Electron, browser,
commit, push, install, or release was run. The package version was left at the
current development version; the task's release label was not treated as a
request to publish or bump it. `docs/subagents-and-workflows.md` was read and
left unchanged because it does not describe Muse's permission posture.

## Files changed

- Adapter: `adapters/muse/main.mts`, `adapters/muse/session.mts`.
- Host mode, process, and persistence: `src/muse-backend.ts`,
  `src/acp-backend.ts`, `src/acp.ts`, `src/mode-prefs.ts`, `src/sidebar.ts`,
  `src/session.ts`, `src/sessions.ts`.
- Settings and compatibility: `package.json`, `src/desktop/config-store.ts`,
  `src/desktop/webview-msg-validate.ts`, `src/protocol.ts`,
  `src/remote-policy.ts`, `media/chat.js`, `media/settings.js`,
  `media/webview-helpers.js`.
- Tests: `test/protocol.test.ts`, `test/muse-session.test.ts`,
  `test/muse-backend.test.ts`, `test/muse-mode.test.ts`,
  `test/muse-mode.dom.test.ts`, `test/mode-prefs.test.ts`,
  `test/settings-surface.dom.test.ts`, `test/session-start-retry.test.ts`,
  `test/muse-effort-request.test.ts`.
- Documentation: `README.md`, generated `README.marketplace.md`, `CLAUDE.md`,
  `research/muse-adapter.md`, and this report. Marketplace text was refreshed
  with `node scripts/gen-marketplace-readme.cjs`.
