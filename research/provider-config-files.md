# Provider config files

**Provider config files** is the last entry in Settings → Providers. Expanding
it reveals Grok, Codex, and Claude with their config paths. Desktop and remote
Settings invoke the chat mount's callback to open the shared file panel;
VS Code's separate Settings webview posts `openProviderConfig` and opens the
host-resolved file in the real editor. The choice belongs to the requesting
surface, never to the connected host's editor capability. The gear has no
config entry. Advanced retains Open project config; Open global config is
folded into the Grok row, with its host operation retained for other callers.
The entry requires both `editProviderConfigFiles` and `editProjectFiles` in the
host capabilities. Older hosts expose no entry point.

`src/provider-config.ts` selects exactly `~/.grok/config.toml`,
`~/.codex/config.toml`, or `~/.claude/settings.json` from a provider ID. There is
no directory-list message and no caller-supplied path. The panel's three rows
are a static display list. `GROK_HOME` and `CODEX_HOME` are honored by both routes.
A missing read remains `ok:false`, `reason:"not found"`, with additive `absPath`,
starter `text`, and a missing-file stamp (`mtimeMs:0`, `size:-1`). Path arrival
enables an editable unsaved buffer; an old host's miss without a path remains
an error tab. Reads never create files or directories.

Save creates the config using `ensureConfigToml` and then the existing guarded
writer. Grok's starter is `GLOBAL_CONFIG_STUB`, Codex's is empty, and Claude's
is `{}`. Exclusive creation returns whether this call created the file; a file
that appeared meanwhile keeps the missing stamp and fails the writer's normal
version check. Existing project-file writes still cannot create files. Native
opening is host-local and uses the same resolver and stubs.

Each config is a `TreeRoot` containing one file. `resolveTreePath` accepts only
its exact basename and checks that its canonical target is that named file,
including at the existing use-time rechecks. A symlink to an auth sibling is
refused. Reads, wire shaping, writes, stamps, file identity, and conflict UI all
use the existing shared file machinery.

`openProviderConfig` is `host-local`; `readProviderConfig` is `view`; `writeProviderConfig` and
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
