# Host-owned MCP connectors (Tier 1)

One connector list, handed to whichever agent is active through ACP
`session/new` / `session/load` `mcpServers`. OAuth tokens stay in `~/.mcp-auth`
(`mcp-remote`). Key-auth tokens (GitHub PAT) live in `HostSecrets`
(`mcpConnectorSecretKey`) and reach mcp-remote as `AUTH_HEADER` in env —
never argv, never `grok.mcpConnectors`, never PersistedState. The host store
records ids, endpoints, and optional `readOnly`.

## Catalog (verified 2026-08-19; Figma measured out 2026-08-20)

| id | endpoint | vendor source |
|---|---|---|
| linear | `https://mcp.linear.app/mcp` | [linear.app/docs/mcp](https://linear.app/docs/mcp) (DCR; `/sse` deprecated) |
| notion | `https://mcp.notion.com/mcp` | [developers.notion.com/guides/mcp](https://developers.notion.com/guides/mcp/get-started-with-mcp) |
| atlassian | `https://mcp.atlassian.com/v1/mcp/authv2` | [Atlassian Rovo getting started](https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/). Brief listed `/v1/sse`; that path was retired 2026-06-30 |
| canva | `https://mcp.canva.com/mcp` | [canva.dev/docs/mcp](https://www.canva.dev/docs/mcp/) (DCR still available; CIMD preferred) |
| stripe | `https://mcp.stripe.com` | [docs.stripe.com/mcp](https://docs.stripe.com/mcp) |
| sentry | `https://mcp.sentry.dev/mcp` | [mcp.sentry.dev](https://mcp.sentry.dev/) |
| cloudflare | `https://observability.mcp.cloudflare.com/mcp` | [Cloudflare's own MCP servers](https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/). Brief listed `/sse`; official catalog now lists `/mcp` |
| calendly | `https://mcp.calendly.com` | [developer.calendly.com/calendly-mcp-server](https://developer.calendly.com/calendly-mcp-server). Default mcp-remote scopes reach authorize; no `oauthScope` (Calendly advertises `mcp:scheduling:*` — do not infer) |
| airtable | `https://mcp.airtable.com/mcp` | [Airtable MCP server](https://support.airtable.com/docs/using-the-airtable-mcp-server). Default mcp-remote scopes reach authorize; no `oauthScope` |
| github | `https://api.githubcopilot.com/mcp/` | Key-auth (`auth: "key"`). GitHub refuses DCR; PAT as `Authorization: Bearer`. Fine-grained recommended. |

**Checked (2026-08-20), so nobody re-tests them to put Figma back:** linear, notion, atlassian, and stripe are connected on the owner's machine; sentry and cloudflare reach the authorize step (owner + probe); canva registers cleanly. Calendly and Airtable reach the authorize step through mcp-remote with default scopes. Figma is the only OAuth vendor that cannot.

**Key-auth (GitHub).** GitHub staff (2026): "We don't support DCR and we are not going to be able to do so." The remote server accepts a PAT. `mcp-remote --header "Authorization:${AUTH_HEADER}"` with `AUTH_HEADER` in env is the vehicle — measured: the header wins over OAuth discovery, so we do not send a direct HTTP `mcpServers` entry (that would put the token in ACP `session/new` params as a header). A bad PAT is sent, GitHub rejects it, mcp-remote falls through to OAuth and dies with `Incompatible auth server: does not support dynamic client registration`. That classifies as `key-rejected`, not `oauth-incompatible` (the two are opposite advice). Optional `X-MCP-Readonly:true` is a checkbox on the same `--header` plumbing (`ConnectedConnectorRecord.readOnly`).

`grok.mcpConnectors` is machine-shared (`PersistedState` / `~/.grok/client-state/`). HostSecrets are not — VS Code, Cursor, and the desktop app each have their own. `connected` is the shared record; `keySet` is this host's secret. The record is re-read from disk on every `connectedConnectorStore`; `hostMcpServersFor` then re-reads this host's own HostSecrets into `mcpConnectorKeys` so a Connect or replace in another editor is picked up without a restart. The secret itself never leaves that host. A host that cannot find a key (absent or a failed secret read) skips that row in `hostMcpServers` and leaves the record alone. Disconnect is the only deletion.

Figma (`https://mcp.figma.com/mcp`) advertises a `registration_endpoint` (`https://api.figma.com/v1/oauth/mcp/register`) and then answers HTTP 403 Forbidden. Measured twice through mcp-remote itself, including with `--static-oauth-client-metadata {"scope":"mcp:connect"}` — the scope Figma's AS metadata advertises. This is not Stripe's missing-scope refusal: DCR is claimed and then refused. That is Tier 2 (we would have to pre-register an OAuth client and ship the client id), not one-click. A Connect button that cannot succeed is worse than no row; do not re-add on the strength of advertised metadata.

Google / Slack / Microsoft stay out of scope (pre-registered OAuth client or enterprise app).

## Dedup

`mcpServers: []` does **not** suppress file-discovered servers. Before send,
drop a host entry whose name (including `managed_gateway:<id>`) or HTTPS
endpoint is already in the provider's config / last grok `_x.ai/mcp/list`.
Theirs wins. grok.com managed Canva is the load-bearing case.

## Connect

`authorizeMcpRemote` is a one-shot `mcp-remote` spawn. A live Grok session
already running that endpoint holds the OAuth callback port pinned in
`client_info.json` (Windows skips mcp-remote's lockfile, so a second instance
cannot see the first). `EADDRINUSE` is reported as already signed in and in
use; it is never retried on a different port. Changing ports would delete
the shared registration and force every host to re-authorize. Neither
Connect nor `buildMcpRemoteEntry` overrides the registered port.

Stripe is the only catalog vendor that rejects mcp-remote's default DCR
scopes (`openid, email, profile`). Its `oauthScope` is `"mcp"` — measured
against `https://access.stripe.com/mcp`, not inferred from
`scopes_supported` (Notion advertises only `default` and Atlassian
advertises none; both accept the defaults). Connect and `session/new` pass
`--static-oauth-client-metadata @<file>` with `{"scope":"mcp"}`. Inline JSON
is not used: Windows Connect spawns with `shell: true`, which mangles
`{...}`. A DCR client-metadata rejection classifies as `oauth-incompatible`
(`summarizeConnectOutput` never surfaces `at …` frames or `file:///` paths).

See `research/mcp-orphan-probe.cjs`.

## Remote

`mcpConnectors` is mirrored (ids, names, connected, keySet — no tokens).
`mcpServers` is `allowlist`-projected (`projectMcpServerForRemote`: page
fields only, never the launch recipe). `scopeName` is on that allowlist
(the team name in the grok.com section). `tag` and `configFile` are not.
Project-file servers are omitted from this list (`mcpSettingsVisible`);
the session still loads them. Classification for that inventory always
runs against Grok config files for the workspace the catalog was
read from (`mcpServersCwd` / `mcpSettingsServersForCwd` → `mcpNameCatalogFor`
→ `mcpConfigPaths` with `provider: "grok"`), never the receiving or
focused session's cwd or provider. The classified global-only view is
stored (`mcpServersView`) and rendered anywhere; project-file rows
never enter it.
`connectMcpConnector`, `disconnectMcpConnector`, and
`completeMcpConnectorOAuth` are inbound `full`, without a bound-session
requirement. A remote can set or replace a HostSecrets key; no response
returns it. The existing `mcpConnectors` frame advertises `remoteConnect: true`.
Settings enables remote controls only when that field is present; an older
host's frame leaves the catalog read-only.

Remote OAuth uses `authorizeMcpRemote.onAuthorization`. The host captures
the printed consent URL and the callback listener's actual port, then broadcasts
`mcpConnectorAuthorization`. Pending consent belongs to the workspace, so
`postMcpConnectors` and `buildRemoteSnapshot` replay it for reloaded tabs.
This outbound frame is `mirror` / project auth `none` and routes device-wide.
It carries `id`, `attemptId`, `status` (`waiting`, `submitted`, or
`finished`), and optional `url` / `error`. The client opens the URL on its own
device. After vendor consent the loopback page may fail to load; the person
copies that full address and sends `{type: "completeMcpConnectorOAuth", id,
attemptId, redirectUrl}`. The host checks the connector id and attempt, allowing
another tab of the same authenticated user to complete it -- which is what makes
a phone reload survivable: the new tab is re-sent the live link and finishes the
attempt already running. A second Connect on the same connector is refused and
says so, because there is nothing to restart; a different connector stays blocked
until the current attempt ends.
`parseMcpOAuthRedirect` requires the issued hostname (`localhost` or
`127.0.0.1`), exact port, `/oauth/callback`, one nonempty code, and matching
state. It rejects URL repairs and malformed encodings. Completion constructs
a new numeric-loopback URL using only that known port, code, and state;
redirects are refused and the pasted URL is never fetched. Errors are
actionable and targeted; subprocess output containing consent URLs is not
mirrored in failure messages. Startup uses `MCP_REMOTE_CONNECT_TIMEOUT_MS`;
the consent link hands the deadline to `MCP_REMOTE_AUTHORIZATION_TIMEOUT_MS`.

The pinned [mcp-remote OAuth provider](https://github.com/geelen/mcp-remote/blob/v0.1.37/src/lib/node-oauth-client-provider.ts)
bundles `open` and has no headless flag. `writeMcpRemoteHeadlessPreload`
writes a temporary CommonJS preload and adds it to this spawn's
`NODE_OPTIONS`. It suppresses child spawning only inside the resolved
`mcp-remote/dist/proxy.js` entry (its browser launch), leaving npm's launcher
alone. A real temporary file works outside Electron's `app.asar`; it is
removed when the attempt finishes. Desktop OAuth and session proxies do not
receive the preload. `MCP_REMOTE_PACKAGE` and `REMOTE_PROTO_VERSION` stay pinned.
The relay must add `completeMcpConnectorOAuth` to its inbound type list;
outbound HostMsg frames are opaque and require no relay change.

Disconnect removes our connected record and a key connector's HostSecrets
entry. It does not revoke vendor access, clear `~/.mcp-auth`, or remove tools
from already running sessions. Settings states these limits on every surface.

Settings also retains the live Grok inventory and a grok.com/connectors Open
in the grok.com section header.
Local Grok connectors show a header Open on the desk (`openGlobalConfig`,
even when the section is empty) and a sentence on remote; there is no
per-row Open. A host-injected echo is omitted from Local. `listMcpServers` is inbound view
so a phone can refresh that inventory without the desk opening the page.

## Settings display

`sortConnectorsForDisplay` (`media/settings.js`) orders On this computer:
connected, then disconnected, each A–Z by display name (case-insensitive).
`TIER1_CONNECTORS` order is unchanged — `hostMcpServers` walks that array.

Vendor marks live in `media/connector-logos/<id>.webp` and render only on
On this computer rows that have one (`CONNECTOR_LOGO_IDS` in
`media/settings.js`). They sit in a white chip and desaturate when
disconnected. A missing or failed image is omitted — no empty box.
Calendly and Airtable have no mark; the row is a plain title. Grok.com /
Local rows are CLI-named and get no mark.

Local header Open uses the lucide `settings` gear (`ICON_SETTINGS`, same
path as `chat.js` `ICON.gear`). Grok.com Open keeps the external-link icon.
