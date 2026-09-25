# Muse Code adapter

`MuseBackend` starts `out/muse-adapter/main.mjs` with Node semantics and an explicitly located Muse executable. The adapter uses `@muse-code/sdk` 1.3.0 to run that executable as `muse serve`. Its NodeNext build is separate from the extension's CommonJS build. Diagnostics and child stderr never enter ACP stdout.

`ACP_PROVIDERS` and `isAcpProvider` retain the three legacy ids. `INTERNAL_PROVIDERS` includes Muse. Renderers expose Muse only after a host `providerState` advertises it, and guard outgoing provider messages as well. Availability comes from the execution host. CLI discovery uses `grok.museCliPath`, `MUSE_CODE_EXECUTABLE`, PATH, then the official installer's default target: `~/.local/bin/muse` on POSIX or `%LOCALAPPDATA%\Programs\muse\muse.cmd` on Windows. Meta provides both a [POSIX installer](https://dev.meta.ai/install.sh) and a [PowerShell installer](https://dev.meta.ai/install.ps1); the latter also adds its directory to the user PATH. The Windows target fallback works before a running editor inherits that PATH change. `findCliOnPath` holds its `where` fallback to PATHEXT names so an extensionless POSIX launcher on PATH is never handed to a spawn that cannot run it. Custom installer targets can be configured through `grok.museCliPath` or `MUSE_CODE_EXECUTABLE`.

Desk installation uses the distinct `runMuseInstallCmd` message, advertised by `installMuse`, validated on desktop, and classified `host-local`. The host confirms and runs a fixed Meta installer in a visible terminal. Installation does not grant consent; Re-check locates the CLI and offers Connect. A missing Connect reply targets the requesting remote client or local view and retains a missing-Muse dialog above Settings or a conversation. Remote views show the missing state without an installer button.

Sign-in runs `muse login`: the shared device-login runner displays Meta's URL and code in the connect wizard while the CLI polls on plain pipes. At the desk, the host also opens that URL in the browser; remote sign-in leaves opening it to the person on their device. Unlike the bare binary, `login` loads no workspace and cannot reach the workspace-trust gate (measured with launcher 1.3.0; `grok-remote/scripts/install-muse-cli.mjs`, `AUTH` block). Settings places Muse after Claude and before GitHub, with the same Status/Remote row pair and capability gates as the other providers. Successful device-login exit plus presence of `~/.config/muse/auth.json` confirms that a credential landed; only `existsSync` is used, never credential contents. MSP exposes no credential-status operation: a successful model catalog or history read is not proof of authentication. Actual credential failures remain visible through the normal conversation error path.

`probeMuseVersion` reads the installed binary with `muse --version` on connection and startup, and Providers refresh re-reads it. About requires both a connected Muse entry and its `cliVersion`, so older hosts without a version produce no placeholder row. The version command is documented in [Meta's plugin quickstart](https://meta-models.github.io/muse-code-sdk/next/guides/plugins/quickstart/). The installed 1.3.0 launcher answers `Muse Code 1.3.0 (1.3.0-R3401.1)`, measured on a cloud host, so the output carries two version-like tokens; the parser prefers the parenthesised build.

The adapter requests no granted capabilities and declines user-input dialogs. It forwards text, tool calls and output, server-minted approval choices, cancellation, workspace-scoped session listing and explicit resume history. Model descriptions and the vendor's default selection are preserved. The model picker uses the advertised eight-tier reasoning-effort menu; changes flow through `session/set_config_option` to MSP's `session/setReasoningEffort`, with provider-scoped preferences for new sessions. It does not offer steering, mode changes, deletion or compaction. Images, embedded resources and user-input dialogs remain unsupported.

## Provider enumeration audit

Agent identity and implemented operations are separate sets. `providerState` establishes host availability; it does not establish that a provider supports an action. The desktop validator ships with its host and accepts `INTERNAL_PROVIDERS`. Config handlers still reject providers without a config file.

| Enumeration | Muse decision |
| --- | --- |
| `acp-backend.ts`: `INTERNAL_PROVIDERS`, `isInternalProvider`, capability table | Included as an agent; every capability is explicit. History listing is supported; deletion, compaction, mode switching, client MCP and per-call occupancy are not. Grok history deletion is filesystem-based, distinct from ACP session deletion. |
| `acp-backend.ts`: `ACP_PROVIDERS`, `isAcpProvider` | Legacy vocabulary remains frozen at three. |
| `desktop/webview-msg-validate.ts`: provider-bearing messages | Included through the shared identity predicate. `github` remains exclusive to device-login cancellation. |
| `provider-ui.ts`: order, connections, model caches, names, onboarding and history | Included. `adapterActivityAt` retains the measured Codex/Claude timestamp policy; Muse uses reported activity with host observations. |
| `sidebar.ts`: locator, backend factory, advertised state, history caches, model/default selection, credential checks | Included. Adapter iteration derives from the shared provider set and history capability. Legacy connection migration leaves new providers unconnected. |
| `sidebar.ts`: clear-history and single-row deletion | Excluded by capability. Clear-history reports why Muse conversations were not cleared, preserves its processes/cache, and does not call that an empty history. |
| `media/webview-helpers.js`, `chat.js`, `projects-rail.js`: provider identity and actions | Shared action catalog includes Muse with deletion and compaction disabled. Both renderers omit Delete; chat omits Compact. All clear-history dialogs name only supported providers. Muse availability still requires host advertisement, including when served against an older host. |
| `media/settings.js`: provider rows, labels and routine options | Included; the Muse row requires advertisement. Config-file rows remain the three supported files. Glyph catalogs retain Muse's text mark separately from SVG paths. |
| `remote-frames.ts`: config read/write; `protocol.ts`, `provider-config.ts`: config types, paths and stubs | Excluded deliberately: Muse has no editable provider config. Remote read/write literal lists remain unchanged; session restart uses full agent identity. |
| `mcp-connectors.ts`: client MCP provider types | Excluded: Muse has no implemented client MCP capability. |
| `cli-update-plan.ts`, sidebar version/update paths, settings update rows | Muse reports its installed CLI version; existing CLI update operations only. Muse installation invokes Meta's fixed installer after a desk confirmation; updating remains CLI-owned. |
| `telemetry.ts`: allowed provider identities | Included through `INTERNAL_PROVIDERS`. The three historical connection booleans in telemetry/sidebar are fixed event fields, not the identity allowlist. |
| `subscription-usage.ts`, voice routing and backend normalizers | Muse already has explicit CLI-owned/unsupported handling or the shared credential fallback. Provider-specific metrics and protocol translations are not agent allowlists. |
| `scripts/acp-smoke.mjs`, adapter packaging | The ACP smoke remains specific to the two external ACP adapters; Muse has its separate probe and NodeNext packaging path. |

`provider-enumerations.test.ts` compares the shared renderer catalog, settings rows, host advertisement, locator coverage, backend/history routing, telemetry and desktop validation against `INTERNAL_PROVIDERS`, while pinning config exclusions. DOM tests exercise both renderers and the model picker. Host tests cover Muse-only and mixed clear-history and the actual compact send path for all four providers. `matchSlashCommand` retains its empty-list timing fallback; `matchProviderSlashCommand` applies compaction capability before any compact accounting or success message.

A prompt waits for its matching terminal notification, not admission. Projection retains per-item emitted text across turns, suppresses duplicates and stale revisions, and logs prefix rewrites that ACP's append-only text channel cannot represent. Reminder items never contribute answer text. Approval presentation receipts are separate from decision commands; only offered choice ids may be sent.

Resume projects inline items or snapshot state explicitly, with paged durable revisions as the fallback. Incoming live events are buffered until history is projected. The host's shared history process starts in the home directory and is reused per provider. Path changes, failed starts and disconnects drain owned processes; the adapter awaits its SDK child before reporting `MUSE_CHILD_EXIT`.

Build and binary-free validation:

```sh
npm run compile
npx tsc -p . --noEmit
npm test
npm run check:vsix
```

The separate real-CLI proof runs on macOS or Linux after CLI sign-in:

```sh
node research/muse-acp-probe.cjs /absolute/path/to/muse /absolute/workspace
```

The probe also accepts `MUSE_CODE_EXECUTABLE` and `MUSE_PROBE_WORKSPACE`. It prints a new session, two checked answers in that session, and evidence of both process exits. It requires no TTY.
