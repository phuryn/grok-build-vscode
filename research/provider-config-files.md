# Provider config files

The chat gear's **Provider config files** entry opens the shared file panel on
VS Code, desktop, and remote browsers, including phones. It is not a Settings
row: VS Code's separate Settings webview needs no cross-webview forwarding.
The entry requires both `editProviderConfigFiles` and `editProjectFiles` in the
host capabilities. Older hosts expose no entry point.

`src/provider-config.ts` selects exactly `~/.grok/config.toml`,
`~/.codex/config.toml`, or `~/.claude/settings.json` from a provider ID. There is
no directory-list message and no caller-supplied path. The panel's three rows
are a static display list. A missing file is reported through the existing
reader; this feature does not create files.

Each config is a `TreeRoot` containing one file. `resolveTreePath` accepts only
its exact basename and checks that its canonical target is that named file,
including at the existing use-time rechecks. A symlink to an auth sibling is
refused. Reads, wire shaping, writes, stamps, file identity, and conflict UI all
use the existing shared file machinery.

`readProviderConfig` is `view`; `writeProviderConfig` and
`restartProviderSession` are `propose`. These are new message types, so an old
host drops them instead of resolving an unknown value on a project message.
Replies go only to the requester. Config operations are independent of a
conversation; restart requires the requesting client's bound session and
checks its provider, ID, generation, and idle state before replacing its CLI.
The existing session-start path reloads the conversation's saved history.

The panel explains that the CLI reads config at startup and offers to restart
the matching current session after saving. It does not restart automatically
or restart other running sessions. No retention keys or provider schemas are
encoded here. This editor does not establish the cause of disappearing history
in #137/#138 or claim to fix it.

The three files on the development machine were parsed as TOML/JSON and their
nested keys checked for credential-shaped names; none were found. Auth files
were not opened. This observation describes those files at inspection time,
not a guarantee about content a person might later add.

Decision coverage: `test/provider-config.test.ts`,
`test/provider-config-host.test.ts`, and `test/provider-config.dom.test.ts`.
