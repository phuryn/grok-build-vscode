/**
 * Host-owned MCP connector catalog (Tier 1) and the session/new `mcpServers`
 * builder. OAuth tokens stay in `~/.mcp-auth` (`mcp-remote`). Key-auth tokens
 * (GitHub PAT) live in `HostSecrets` (`mcpConnectorSecretKey`) and reach
 * mcp-remote as `AUTH_HEADER` in env — never argv, never `grok.mcpConnectors`,
 * never PersistedState.
 *
 * Our list is additive, not authoritative: `mcpServers: []` does not suppress
 * servers the provider already loads from config.toml / `.mcp.json` /
 * `~/.claude.json` / `~/.cursor/mcp.json`. Sending the same name twice produces
 * two identical tool sets, so we drop ours when theirs already claims the name
 * or the same HTTPS endpoint. grok.com managed gateways (`managed_gateway:canva`)
 * are the same collision, just under a prefix.
 */

export const MCP_CONNECTORS_KEY = "grok.mcpConnectors";

/**
 * **Pinned on purpose — do not float this back to bare `mcp-remote`.**
 *
 * mcp-remote namespaces its OAuth cache by its OWN version:
 * `getConfigDir()` returns `<MCP_REMOTE_CONFIG_DIR | ~/.mcp-auth>/mcp-remote-${version}`,
 * and the version segment is appended unconditionally — the env var overrides
 * only the base, so it cannot be used to stabilise this.
 *
 * With a floating spec, `npx -y mcp-remote` resolves to whatever npm calls
 * latest AT SPAWN TIME. Every upstream publish therefore lands the next spawn
 * in an empty token directory and silently re-runs OAuth for every connected
 * service. Measured on one machine, 2026-08-22: `~/.mcp-auth` held six version
 * directories; 0.1.37 had 7 working tokens while 0.1.43, created that morning,
 * had 4 client registrations, ~60 abandoned `code_verifier_<pid>` files and
 * zero tokens — six connectors mid-reauthorisation at once, which also blew
 * Codex's 30s `startup_timeout_sec` and surfaced as "MCP server failed to
 * start". Three versions shipped in 24 hours, each a silent re-auth.
 *
 * The pin is also what makes connectors shared between the desktop app and the
 * editor hosts: the connected list (`mcp-connectors.json`) and `~/.mcp-auth`
 * are already machine-wide, so a single version is the only remaining thing
 * keeping both hosts in one token directory.
 *
 * **Bumping is a deliberate release decision that costs every user one
 * re-authorisation per connector.** That is the point: it is chosen rather than
 * inflicted by an upstream publish.
 *
 * **The directory name does NOT track this spec.** Measured 2026-08-24:
 * `mcp-remote@0.1.37` bundles the literal `"0.1.36"` as its own version, so
 * `getConfigDir()` returns `~/.mcp-auth/mcp-remote-0.1.36` — an upstream build
 * mismatch, not ours. The `mcp-remote-0.1.37` directory on that machine held
 * seven unused tokens from an older build that reported itself correctly.
 *
 * Two consequences for whoever bumps this next. The re-auth cost cannot be
 * predicted from the spec — read the bundled string before promising anything.
 * And a version whose string is correct moves the directory even if the number
 * looks adjacent, so 0.1.36 -> 0.1.38 could cost a re-auth that 0.1.36 -> 0.1.37
 * did not.
 */
export const MCP_REMOTE_PACKAGE = "mcp-remote@0.1.37";

/**
 * The version segment `mcp-remote@0.1.37` actually writes under `~/.mcp-auth`.
 *
 * MEASURED, not derived — that is the whole point. 0.1.37 bundles the literal
 * string `"0.1.36"` as its own version, so `getConfigDir()` returns
 * `mcp-remote-0.1.36` and the spec above does not name the directory. Measured
 * 2026-08-24 and again 2026-08-30, when every live token on the dev box was
 * found there.
 *
 * **Re-measure this whenever MCP_REMOTE_PACKAGE moves.** Read the bundled
 * string; do not assume it follows the spec, because it demonstrably does not.
 * Anything that reads the token store must use THIS directory and no other: the
 * proxy reads exactly one, derived from its own embedded version, and never
 * looks at siblings. A token in any other version directory is unreachable to
 * it, so it proves nothing about whether a connector can be used.
 */
export const MCP_REMOTE_STORE_VERSION = "0.1.36";

/** The package name without a version, for recognising an existing invocation. */
export const MCP_REMOTE_NAME = "mcp-remote";

/** mcp-remote flag. Value is `@<absolute path>` to a JSON file we write (not inline JSON — Windows Connect uses `shell: true`). */
export const STATIC_OAUTH_CLIENT_METADATA_FLAG = "--static-oauth-client-metadata";
export const STATIC_OAUTH_CLIENT_INFO_FLAG = "--static-oauth-client-info";

/** mcp-remote `--header`. Value is `Name:${ENV}` (no spaces) so the secret stays in env. */
export const MCP_REMOTE_HEADER_FLAG = "--header";

/** Env var mcp-remote substitutes into `Authorization:${AUTH_HEADER}`. */
export const MCP_REMOTE_AUTH_HEADER_ENV = "AUTH_HEADER";

/** Header template. The Bearer token is the env value, never this string. */
export const MCP_REMOTE_AUTH_HEADER_TEMPLATE = `Authorization:\${${MCP_REMOTE_AUTH_HEADER_ENV}}`;

/** GitHub MCP read-only header. Constant, not a secret — argv is fine. */
export const MCP_REMOTE_READONLY_HEADER = "X-MCP-Readonly:true";

/**
 * What a connector says when we are deliberately holding it back.
 *
 * Not an error the user caused, and not a failure of the last thing they did —
 * so it explains the trade rather than apologising: the prompt is gone, and
 * reconnecting is how it comes back.
 */
export const CONNECTOR_REAUTH_MESSAGE =
  "Sign-in expired, so this is paused. Reconnect when you want it back — nothing will open a browser until you do.";

export const MCP_CONNECTOR_SECRET_KEY_PREFIX = "grok.mcpConnector.";

/** Paste field / SecretStorage cap. Fine-grained PATs are long; this is abuse-sized. */
export const MAX_CONNECTOR_KEY_CHARS = 8192;

/**
 * Ceiling on the part WE control: npx resolving the package, the proxy booting,
 * and the authorization link appearing. Not a spinner.
 */
export const MCP_REMOTE_CONNECT_TIMEOUT_MS = 180_000;

/**
 * Ceiling once the link exists, replacing the one above. From that moment the
 * clock belongs to a person reading a consent screen -- on a phone, on their
 * own time, often signing in to the vendor first. Three minutes measured from
 * `npx` is not that budget: Airtable's flow alone (sign in, choose a base,
 * approve) routinely outruns it, and when it does we kill the proxy out from
 * under a sign-in the user is still being told to finish.
 */
export const MCP_REMOTE_AUTHORIZATION_TIMEOUT_MS = 900_000;

export type ConnectorAuth = "oauth" | "key";

export type ConnectorId =
  | "linear"
  | "notion"
  | "atlassian"
  | "canva"
  | "stripe"
  | "sentry"
  | "cloudflare"
  | "calendly"
  | "airtable"
  | "github"
  | "zapier";

export interface ConnectorDef {
  id: ConnectorId;
  name: string;
  endpoint: string;
  description: string;
  /**
   * OAuth scope for mcp-remote DCR (`--static-oauth-client-metadata`).
   * Set only when a vendor is measured to reject mcp-remote's default
   * `openid, email, profile` scopes. Do not infer this from
   * `scopes_supported` — Notion advertises only `default` and Atlassian
   * advertises none, and both accept the defaults. Stripe is the one
   * that validates and refuses.
   */
  oauthScope?: string;
  /** Default `oauth`. `key` is a user-pasted secret via `--header` + env. */
  auth?: ConnectorAuth;
  /** Where to mint the token. Key connectors only; never the token itself. */
  keyHint?: string;
  /** Vendor page that issues the token. Key connectors only. */
  keyDocsUrl?: string;
}

/**
 * ACP stdio `mcpServers` entry. Command/args match the vendor mcp-remote snippets.
 *
 * `env` is REQUIRED, not decorative. grok's `session/new` deserializes this into
 * an untagged `McpServer` enum, and an entry without `env` matches no variant:
 * the whole request comes back `-32602 Invalid params — data did not match any
 * variant of untagged enum McpServer`, so the session never starts. Measured
 * against grok 1.0.5 (research/mcp-connectors.md § Wire shape): `{name, command,
 * args}` is refused, `{name, command, args, env: []}` is accepted. Codex and
 * Claude accept both, which is why this stayed invisible — and it stayed
 * invisible on grok too only because a store with no connectors sends `[]` and
 * there is nothing to reject.
 */
export interface AcpMcpStdioServer {
  name: string;
  command: string;
  args: string[];
  /** ACP `EnvVariable[]`. Empty is valid; omitted is not. */
  env: { name: string; value: string }[];
}

export interface ConnectedConnectorRecord {
  endpoint: string;
  /** GitHub `X-MCP-Readonly`. Preference, not a credential. */
  readOnly?: boolean;
}

export type ConnectedConnectorStore = Record<string, ConnectedConnectorRecord>;

export type ConnectorStatus = "idle" | "connecting" | "error";

export interface ConnectorView {
  id: ConnectorId;
  name: string;
  description: string;
  endpoint: string;
  /** Shared `grok.mcpConnectors` record. Independent of this host's secret. */
  connected: boolean;
  status: ConnectorStatus;
  error?: string;
  auth: ConnectorAuth;
  /** Key-auth only: this host has a secret. Never the secret itself. */
  keySet?: boolean;
  keyHint?: string;
  keyDocsUrl?: string;
  readOnly?: boolean;
}

export type ConnectFailureKind =
  | "npx-missing"
  | "cancelled"
  | "timeout"
  | "port-conflict"
  | "endpoint-refused"
  | "oauth-incompatible"
  | "key-rejected"
  | "failed";

export interface McpRemoteHeaderOpts {
  authorization?: boolean;
  readOnly?: boolean;
}

export interface ReservedMcpIdentity {
  names: string[];
  urls: string[];
}

export const TIER1_CONNECTORS: readonly ConnectorDef[] = [
  {
    id: "linear",
    name: "Linear",
    endpoint: "https://mcp.linear.app/mcp",
    description: "Issues, projects, and comments in your Linear workspace.",
  },
  {
    id: "notion",
    name: "Notion",
    endpoint: "https://mcp.notion.com/mcp",
    description: "Search and edit pages in your Notion workspace.",
  },
  {
    id: "atlassian",
    name: "Atlassian",
    // `/v1/sse` was retired 2026-06-30. Current Atlassian docs use authv2.
    endpoint: "https://mcp.atlassian.com/v1/mcp/authv2",
    description: "Jira, Confluence, and Bitbucket through Atlassian Rovo.",
  },
  {
    id: "canva",
    name: "Canva",
    endpoint: "https://mcp.canva.com/mcp",
    description: "Search, create, and export Canva designs.",
  },
  {
    id: "stripe",
    name: "Stripe",
    endpoint: "https://mcp.stripe.com",
    description: "Look up customers, payments, and Stripe documentation.",
    oauthScope: "mcp",
  },
  {
    id: "sentry",
    name: "Sentry",
    endpoint: "https://mcp.sentry.dev/mcp",
    description: "Query errors and issues from your Sentry projects.",
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    // Official catalog now lists `/mcp`. Historical `/sse` is an alias, not SSE.
    endpoint: "https://observability.mcp.cloudflare.com/mcp",
    description: "Workers logs and analytics for your Cloudflare account.",
  },
  {
    id: "calendly",
    name: "Calendly",
    endpoint: "https://mcp.calendly.com",
    description: "Schedule meetings and manage availability in your Calendly account.",
  },
  {
    id: "airtable",
    name: "Airtable",
    endpoint: "https://mcp.airtable.com/mcp",
    description: "Search, read, and update records in your Airtable bases.",
  },
  {
    id: "github",
    name: "GitHub",
    endpoint: "https://api.githubcopilot.com/mcp/",
    description: "Repos, issues, and pull requests in your GitHub account.",
    auth: "key",
    keyHint: "Paste a GitHub personal access token. Fine-grained tokens are recommended; classic tokens also work.",
    keyDocsUrl: "https://github.com/settings/personal-access-tokens",
  },
  {
    id: "zapier",
    name: "Zapier",
    endpoint: "https://mcp.zapier.com/api/v1/connect",
    // Deliberately describes the shape rather than listing apps: what this
    // reaches is whatever the user turned on in their own Zapier server, and a
    // fixed list here would be wrong for everyone the day after it was written.
    description: "Run the apps you have added to your own Zapier MCP server — Gmail, Calendar, Slack and thousands more.",
    // OAuth, not a pasted token — measured, not inferred. The endpoint answers
    // an unauthenticated initialize with
    //   401 www-authenticate: Bearer resource_metadata="…"
    // and its authorization server advertises a registration_endpoint, so
    // mcp-remote registers itself dynamically like every other Tier-1 row.
    // `scopes_supported` is exactly openid/profile/email — mcp-remote's own
    // defaults — so there is no oauthScope override to make either.
    //
    // Sources that said "per-user Bearer token" describe an older path; this
    // was checked against the live endpoint on 2026-08-24.
  },
];

const CONNECTOR_BY_ID = new Map<string, ConnectorDef>(
  TIER1_CONNECTORS.map((connector) => [connector.id, connector]),
);

export function isConnectorId(value: string): value is ConnectorId {
  return CONNECTOR_BY_ID.has(value);
}

export function connectorById(id: string): ConnectorDef | undefined {
  return CONNECTOR_BY_ID.get(id);
}

export function connectorAuth(connector: Pick<ConnectorDef, "auth"> | undefined): ConnectorAuth {
  return connector?.auth === "key" ? "key" : "oauth";
}

export function isKeyConnector(connector: Pick<ConnectorDef, "auth"> | undefined): boolean {
  return connectorAuth(connector) === "key";
}

/** SecretStorage / desktop HostSecrets key. Not a PersistedState / grok.mcpConnectors key. */
export function mcpConnectorSecretKey(id: ConnectorId): string {
  return `${MCP_CONNECTOR_SECRET_KEY_PREFIX}${id}.key`;
}

/** `Authorization` value. Accepts a raw PAT or an already-prefixed `Bearer …`. */
export function bearerAuthorizationHeader(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) return "";
  const match = trimmed.match(/^bearer\s+(.+)$/i);
  const value = (match ? match[1] : trimmed).trim();
  return value ? `Bearer ${value}` : "";
}

export function withAuthHeaderEnv(
  env: NodeJS.ProcessEnv | undefined,
  token: string,
): NodeJS.ProcessEnv {
  const header = bearerAuthorizationHeader(token);
  const out: NodeJS.ProcessEnv = { ...env };
  if (header) out[MCP_REMOTE_AUTH_HEADER_ENV] = header;
  return out;
}

export function mcpRemoteHeaderArgs(headers?: McpRemoteHeaderOpts): string[] {
  if (!headers) return [];
  const args: string[] = [];
  if (headers.authorization) {
    args.push(MCP_REMOTE_HEADER_FLAG, MCP_REMOTE_AUTH_HEADER_TEMPLATE);
  }
  if (headers.readOnly) {
    args.push(MCP_REMOTE_HEADER_FLAG, MCP_REMOTE_READONLY_HEADER);
  }
  return args;
}

export function mcpRemoteHeadersFromArgs(args: readonly string[]): McpRemoteHeaderOpts | undefined {
  let authorization = false;
  let readOnly = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== MCP_REMOTE_HEADER_FLAG) continue;
    const value = args[i + 1];
    if (!value || value.startsWith("-")) continue;
    if (value === MCP_REMOTE_AUTH_HEADER_TEMPLATE || value.includes(`\${${MCP_REMOTE_AUTH_HEADER_ENV}}`)) {
      authorization = true;
    }
    if (value === MCP_REMOTE_READONLY_HEADER || /^x-mcp-readonly:/i.test(value)) {
      readOnly = true;
    }
  }
  if (!authorization && !readOnly) return undefined;
  return { authorization, readOnly };
}

export function isUsableListenPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

/** Compact JSON mcp-remote reads from `--static-oauth-client-metadata @file`. */
export function oauthClientMetadataJson(scope: string): string {
  return JSON.stringify({ scope });
}

export function mcpRemoteOAuthClientMetadataArgs(filePath: string): string[] {
  const trimmed = filePath.trim();
  if (!trimmed) return [];
  const value = trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
  return [STATIC_OAUTH_CLIENT_METADATA_FLAG, value];
}

/** Absolute path from a previous `mcpRemoteArgs` invocation, without the `@`. */
export function mcpRemoteOAuthClientMetadataPath(args: readonly string[]): string | undefined {
  const idx = args.indexOf(STATIC_OAUTH_CLIENT_METADATA_FLAG);
  if (idx < 0) return undefined;
  const value = args[idx + 1];
  if (!value || value.startsWith("-")) return undefined;
  return value.startsWith("@") ? value.slice(1) : value;
}

/**
 * `npx -y mcp-remote <url> [port] [--static-oauth-client-metadata @file]`.
 * The optional port is mcp-remote's second positional argument
 * (`specifiedPort`): when it differs from the registered OAuth callback
 * port, mcp-remote deletes `client_info.json` and re-registers. The
 * metadata flag is a later option, never a substitute for that port —
 * mcp-remote always reads `args[1]` as the port.
 */
export function mcpRemoteArgs(
  endpoint: string,
  callbackPort?: number,
  oauthClientMetadataPath?: string,
  headers?: McpRemoteHeaderOpts,
  oauthClientInfoPath?: string,
): string[] {
  const args = ["-y", MCP_REMOTE_PACKAGE, endpoint];
  if (callbackPort != null && isUsableListenPort(callbackPort)) args.push(String(callbackPort));
  args.push(...mcpRemoteHeaderArgs(headers));
  if (oauthClientMetadataPath) args.push(...mcpRemoteOAuthClientMetadataArgs(oauthClientMetadataPath));
  if (oauthClientInfoPath) args.push(STATIC_OAUTH_CLIENT_INFO_FLAG, `@${oauthClientInfoPath}`);
  return args;
}

/** Rebuild `mcpRemoteArgs` with a callback port, keeping static OAuth metadata. `undefined` if `args` is not an mcp-remote invocation. */
export function withMcpRemoteCallbackPort(
  args: readonly string[],
  callbackPort: number,
): string[] | undefined {
  // Match the package by name, not by the exact pinned spec: an args array may
  // legitimately carry a different pin (or none) and an exact compare would
  // silently return undefined here, which reads to the caller as "not an
  // mcp-remote invocation" and skips the retry rather than failing loudly.
  const idx = args.findIndex((a) => a === MCP_REMOTE_PACKAGE || a === MCP_REMOTE_NAME || a.startsWith(MCP_REMOTE_NAME + "@"));
  const endpoint = idx >= 0 ? args[idx + 1] : undefined;
  if (!endpoint || /^\d+$/.test(endpoint)) return undefined;
  return mcpRemoteArgs(
    endpoint,
    callbackPort,
    mcpRemoteOAuthClientMetadataPath(args),
    mcpRemoteHeadersFromArgs(args),
  );
}

export function buildMcpRemoteEntry(
  name: string,
  endpoint: string,
  oauthClientMetadataPath?: string,
  keyAuth?: { token: string; readOnly?: boolean },
): AcpMcpStdioServer {
  const header = keyAuth?.token ? bearerAuthorizationHeader(keyAuth.token) : "";
  return {
    name,
    command: "npx",
    args: mcpRemoteArgs(
      endpoint,
      undefined,
      oauthClientMetadataPath,
      header ? { authorization: true, readOnly: !!keyAuth?.readOnly } : undefined,
    ),
    // Inherited from the host process at spawn; we add nothing unless a key
    // connector supplies AUTH_HEADER. Present because grok refuses the entry
    // outright without env — see AcpMcpStdioServer.
    env: header ? [{ name: MCP_REMOTE_AUTH_HEADER_ENV, value: header }] : [],
  };
}

export function normalizeMcpName(name: string): string {
  return name.trim().toLowerCase().replace(/^managed_gateway:/, "");
}

export function normalizeMcpUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

function isHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Persist shape: `{ linear: { endpoint } }`. Unknown ids, non-HTTPS URLs, and any credential fields drop. */
export function parseConnectedConnectorStore(value: unknown): ConnectedConnectorStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: ConnectedConnectorStore = {};
  for (const [id, record] of Object.entries(value as Record<string, unknown>)) {
    if (!isConnectorId(id) || !record || typeof record !== "object" || Array.isArray(record)) continue;
    const rec = record as Record<string, unknown>;
    const endpoint = typeof rec.endpoint === "string" ? rec.endpoint.trim() : "";
    if (!isHttpsUrl(endpoint)) continue;
    const parsed: ConnectedConnectorRecord = { endpoint };
    if (rec.readOnly === true) parsed.readOnly = true;
    out[id] = parsed;
  }
  return out;
}

export function connectConnector(
  store: ConnectedConnectorStore,
  id: ConnectorId,
  endpoint = connectorById(id)?.endpoint,
  readOnly?: boolean,
): ConnectedConnectorStore {
  if (!endpoint || !isHttpsUrl(endpoint)) return store;
  const record: ConnectedConnectorRecord = { endpoint };
  if (readOnly) record.readOnly = true;
  return { ...store, [id]: record };
}

export function disconnectConnector(
  store: ConnectedConnectorStore,
  id: ConnectorId,
): ConnectedConnectorStore {
  if (!(id in store)) return store;
  const next = { ...store };
  delete next[id];
  return next;
}

export function connectorAliases(connector: ConnectorDef): string[] {
  return [connector.id, connector.name, `managed_gateway:${connector.id}`];
}

export function reservedConflictsConnector(
  connector: ConnectorDef,
  endpoint: string,
  reserved: ReservedMcpIdentity,
): boolean {
  const aliases = new Set(connectorAliases(connector).map(normalizeMcpName));
  for (const name of reserved.names) {
    if (aliases.has(normalizeMcpName(name))) return true;
  }
  const ours = normalizeMcpUrl(endpoint);
  return reserved.urls.some((url) => normalizeMcpUrl(url) === ours);
}

/**
 * Host `mcpServers` payload. File-discovered / managed names win: we skip a
 * convenience entry rather than duplicate their tools. A key-auth row with a
 * store record but no local token is skipped, not deleted — `grok.mcpConnectors`
 * is shared across hosts; HostSecrets are not.
 */
export function hostMcpServers(
  store: ConnectedConnectorStore,
  reserved: ReservedMcpIdentity = { names: [], urls: [] },
  oauthClientMetadataPaths: Readonly<Partial<Record<string, string>>> = {},
  keyAuthById: Readonly<Partial<Record<string, string>>> = {},
  /**
   * OAuth connectors whose token store is empty, which we must NOT hand to the
   * CLI. See the skip below; an empty set (the default) keeps the old behaviour.
   */
  lapsed: ReadonlySet<string> = new Set(),
): AcpMcpStdioServer[] {
  const out: AcpMcpStdioServer[] = [];
  const seen = new Set<string>();
  for (const connector of TIER1_CONNECTORS) {
    const record = store[connector.id];
    if (!record) continue;
    const endpoint = record.endpoint || connector.endpoint;
    if (reservedConflictsConnector(connector, endpoint, reserved)) continue;
    const name = normalizeMcpName(connector.id);
    if (seen.has(name)) continue;
    if (isKeyConnector(connector)) {
      const token = keyAuthById[connector.id];
      if (!token) continue;
      seen.add(name);
      out.push(buildMcpRemoteEntry(connector.id, endpoint, undefined, {
        token,
        readOnly: record.readOnly === true,
      }));
      continue;
    }
    // An OAuth connector with NO token cannot refresh, so mcp-remote starts a
    // full authorization and OPENS A BROWSER — on session start, unprompted, and
    // again on every session after it, because nothing about the failure is
    // recorded. One connector in that state reads to the user as the app
    // demanding sign-ins at random (owner, 2026-08-30). Withholding it is the
    // quiet outcome: the row says why, and the browser opens only when the
    // person clicks Connect.
    //
    // Deliberately NOT keyed on expiry. These tokens live 1-24 hours and carry a
    // refresh_token that mcp-remote uses silently; treating an expired ACCESS
    // token as failure would disconnect connectors that work perfectly. Only a
    // missing token file means there is nothing left to refresh.
    if (lapsed.has(connector.id)) continue;
    seen.add(name);
    const metadataPath = connector.oauthScope?.trim()
      ? oauthClientMetadataPaths[connector.id]
      : undefined;
    out.push(buildMcpRemoteEntry(connector.id, endpoint, metadataPath));
  }
  return out;
}

export function connectorViews(
  store: ConnectedConnectorStore,
  opts: {
    connectingId?: string;
    errorId?: string;
    error?: string;
    keySet?: ReadonlySet<string>;
    /** OAuth connectors being withheld from `mcpServers` — see hostMcpServers. */
    lapsed?: ReadonlySet<string>;
  } = {},
): ConnectorView[] {
  return TIER1_CONNECTORS.map((connector) => {
    const auth = connectorAuth(connector);
    const keySet = auth === "key" && !!opts.keySet?.has(connector.id);
    const connected = !!store[connector.id];
    const connecting = opts.connectingId === connector.id;
    const failed = opts.errorId === connector.id && !!opts.error;
    // A withheld connector reports as NOT connected, with the reason where its
    // description goes. That is the row the settings page already knows how to
    // draw — no green dot, an explanation, and a Connect button that runs
    // exactly the flow we stopped running on the user's behalf. The store record
    // is untouched, so reconnecting keeps any endpoint override.
    const lapsed = auth === "oauth" && connected && !connecting && !failed
      && !!opts.lapsed?.has(connector.id);
    return {
      id: connector.id,
      name: connector.name,
      description: connector.description,
      endpoint: store[connector.id]?.endpoint || connector.endpoint,
      connected: lapsed ? false : connected,
      status: connecting ? "connecting" : (failed || lapsed) ? "error" : "idle",
      auth,
      ...(failed ? { error: opts.error } : lapsed ? { error: CONNECTOR_REAUTH_MESSAGE } : {}),
      ...(auth === "key" ? {
        keySet,
        ...(connector.keyHint ? { keyHint: connector.keyHint } : {}),
        ...(connector.keyDocsUrl ? { keyDocsUrl: connector.keyDocsUrl } : {}),
        readOnly: store[connector.id]?.readOnly === true,
      } : {}),
    };
  });
}

/**
 * Grok's live inventory, as "someone else already provides this".
 *
 * `store` is REQUIRED and is what we ourselves injected. Grok reports the servers
 * we passed in `session/new` right back to us on `_x.ai/mcp/list`, so without
 * this exclusion our own connector reads as pre-existing configuration on the
 * NEXT session and `hostMcpServers` drops it — the user connects Linear, it works
 * once, and then quietly stops existing. Self-poisoning, and invisible until the
 * second session.
 */
export function reservedFromMcpInventory(
  servers: readonly { name?: string; displayName?: string; url?: string; enabled?: boolean }[],
  store: ConnectedConnectorStore,
): ReservedMcpIdentity {
  // Match on the RAW name, and on nothing else. We inject a server named exactly
  // the connector id (`canva`). grok.com's managed gateway for the same app is a
  // DIFFERENT server called `managed_gateway:canva`, with displayName "Canva" and
  // a url. Comparing via normalizeMcpName (which strips `managed_gateway:`), or
  // via url, or via displayName, treats that managed server as ours — it drops
  // out of the reserved set and we inject a second Canva beside it, two identical
  // tool sets, the exact collision this dedup exists to prevent. Someone
  // connected both ways is a real case, not a hypothetical.
  //
  // Deliberately NOT also requiring "no url": whether grok echoes a url for an
  // injected stdio server is unverified, and guessing wrong there brings back the
  // self-poisoning this function was written to stop. Raw-name equality alone is
  // enough to separate the two, and does not depend on the unknown.
  const ownNames = new Set<string>();
  for (const connector of TIER1_CONNECTORS) {
    if (store[connector.id]) ownNames.add(normalizeMcpName(connector.id));
  }
  const isOurEcho = (server: { name?: string }) =>
    typeof server.name === "string" && ownNames.has(server.name.trim().toLowerCase());
  const names: string[] = [];
  const urls: string[] = [];
  for (const server of servers) {
    if (isOurEcho(server)) continue;
    // A server that is listed but switched OFF provides no tools, so it cannot
    // stand in for ours. Reserving its name meant a user who had disabled Canva
    // at grok.com and then connected Canva here saw the row as connected and got
    // no Canva tools at all — which is a plausible order to do those two things
    // in. Only an explicit `false` counts: an absent field (older CLI, or an
    // inventory that never reports it) must not read as disabled.
    if (server.enabled === false) continue;
    if (typeof server.name === "string" && server.name.trim()) names.push(server.name);
    if (typeof server.displayName === "string" && server.displayName.trim()) names.push(server.displayName);
    if (typeof server.url === "string" && isHttpsUrl(server.url)) urls.push(server.url);
  }
  return { names, urls };
}

export function mergeReserved(
  ...parts: readonly ReservedMcpIdentity[]
): ReservedMcpIdentity {
  const names = new Set<string>();
  const urls = new Set<string>();
  for (const part of parts) {
    for (const name of part.names) {
      const normalized = normalizeMcpName(name);
      if (normalized) names.add(name);
    }
    for (const url of part.urls) {
      if (isHttpsUrl(url)) urls.add(url);
    }
  }
  return { names: [...names], urls: [...urls] };
}

const JSON_SERVER_KEYS = ["mcpServers", "servers", "mcp_servers"];

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function pushServerIdentity(
  into: ReservedMcpIdentity,
  name: unknown,
  spec: unknown,
): void {
  if (typeof name === "string" && name.trim()) into.names.push(name);
  const item = record(spec);
  if (!item) return;
  if (typeof item.name === "string" && item.name.trim()) into.names.push(item.name);
  const url = item.url || item.serverUrl || item.server_url;
  if (typeof url === "string" && isHttpsUrl(url)) into.urls.push(url);
  if (Array.isArray(item.args)) {
    for (const arg of item.args) {
      if (typeof arg === "string" && isHttpsUrl(arg)) into.urls.push(arg);
    }
  }
}

function collectJsonServers(value: unknown, into: ReservedMcpIdentity, depth = 0): void {
  if (depth > 4 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      const rec = record(item);
      if (rec) pushServerIdentity(into, rec.name, rec);
      else collectJsonServers(item, into, depth + 1);
    }
    return;
  }
  const obj = record(value);
  if (!obj) return;
  for (const key of JSON_SERVER_KEYS) {
    if (obj[key] === undefined) continue;
    const group = obj[key];
    if (Array.isArray(group) || record(group)) collectJsonServers(group, into, depth + 1);
  }
  // `{ "linear": { url } }` maps used by Cursor / Claude / `.mcp.json`.
  const looksLikeServerMap = Object.values(obj).some((item) => {
    const rec = record(item);
    return !!rec && (typeof rec.url === "string" || typeof rec.command === "string" || Array.isArray(rec.args));
  });
  if (looksLikeServerMap) {
    for (const [name, spec] of Object.entries(obj)) {
      if (JSON_SERVER_KEYS.includes(name)) continue;
      pushServerIdentity(into, name, spec);
    }
  }
}

const TOML_TABLE = /^\s*\[(?:mcp_servers|mcp\.servers)\.([^\]]+)\]\s*$/i;
const TOML_NAME = /^\s*name\s*=\s*"([^"]+)"\s*$/i;
const TOML_URL = /^\s*(?:url|serverUrl|server_url)\s*=\s*"?(https:\/\/[^"\s]+)"?\s*$/i;
const TOML_ARG_URL = /https:\/\/[^\s",]+/i;

/**
 * Names and HTTPS endpoints already configured by the user. Used to skip our
 * convenience entry. Best-effort: comments and unknown TOML stay ignored.
 */
export function collectReservedMcpIdentity(text: string): ReservedMcpIdentity {
  const into: ReservedMcpIdentity = { names: [], urls: [] };
  const trimmed = text.trim();
  if (!trimmed) return into;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      collectJsonServers(JSON.parse(trimmed), into);
      return into;
    } catch {
      // Fall through to the line scanner for JSON-looking but invalid files.
    }
  }
  let inMcpTable = false;
  for (const raw of trimmed.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const table = line.match(/^\[\[?\s*([^\]]+?)\s*\]\]?$/);
    if (table) {
      const heading = table[1].trim();
      const named = heading.match(TOML_TABLE) || heading.match(/^(?:mcp_servers|mcp\.servers)\.([^\].]+)/i);
      inMcpTable = heading === "mcp_servers" || heading === "mcp.servers"
        || heading.startsWith("mcp_servers.")
        || heading.startsWith("mcp.servers.");
      if (named) {
        const id = named[1].split(".")[0]?.trim();
        if (id) into.names.push(id);
      }
      continue;
    }
    if (!inMcpTable) continue;
    const name = line.match(TOML_NAME);
    if (name) into.names.push(name[1]);
    const url = line.match(TOML_URL);
    if (url && isHttpsUrl(url[1])) into.urls.push(url[1]);
    if (/\bargs\b/i.test(line)) {
      const argUrl = line.match(TOML_ARG_URL);
      if (argUrl && isHttpsUrl(argUrl[0])) into.urls.push(argUrl[0]);
    }
  }
  return into;
}

export function mcpConfigPaths(opts: {
  cwd: string;
  provider: "grok" | "codex" | "claude";
  grokHome: string;
  userHome: string;
}): string[] {
  const cwd = opts.cwd.replace(/[\\/]+$/, "");
  const paths: string[] = [];
  // `.mcp.json` is Claude's project-scope format, which grok also reads for
  // compatibility. The bundled Codex adapter does NOT — it discovers servers
  // only from Codex's own `mcp_servers` config layers. Scanning it for codex
  // suppressed our connector on the grounds that a file codex never opens
  // already provided it, so codex got neither and the tools were missing in
  // exactly the repos that carry a `.mcp.json`.
  if (opts.provider !== "codex") paths.push(`${cwd}/.mcp.json`);
  if (opts.provider === "grok") {
    paths.push(
      `${opts.grokHome}/config.toml`,
      `${cwd}/.grok/config.toml`,
      `${opts.userHome}/.cursor/mcp.json`,
      // Grok loads Claude's user-level MCP map as a compatibility source.
      `${opts.userHome}/.claude.json`,
    );
  }
  if (opts.provider === "claude") {
    paths.push(`${opts.userHome}/.claude.json`);
  }
  if (opts.provider === "codex") {
    paths.push(`${opts.userHome}/.codex/config.toml`);
  }
  return paths;
}

export type McpConfigLayer = "project" | "user";

/**
 * Which config file a path from {@link mcpConfigPaths} is. Project files are
 * the checkout's `.mcp.json` and `.grok/config.toml`; everything else in that
 * list is user-level. Settings → Connectors lists a local row only when
 * its name is in a user-level layer (`mcpSettingsVisible`); project-file
 * and host-injected echo names are omitted. User-level files stamp
 * `configFile` via {@link collectMcpNameFiles}. Compared against the same
 * strings `mcpConfigPaths` returns, so Windows mixed separators still match.
 */
export function mcpConfigLayer(
  filePath: string,
  opts: { cwd: string; provider: "grok" | "codex" | "claude" },
): McpConfigLayer {
  const cwd = opts.cwd.replace(/[\\/]+$/, "");
  if (filePath === `${cwd}/.mcp.json` || filePath === `${cwd}/.grok/config.toml`) {
    return "project";
  }
  return "user";
}

/**
 * Name → layer. A name in both a user file and a project file is project
 * (more specific). Keys are lowercased so they match `_x.ai/mcp/list` names.
 */
export function collectMcpNameLayers(
  files: readonly { layer: McpConfigLayer; names: readonly string[] }[],
): Map<string, McpConfigLayer> {
  const out = new Map<string, McpConfigLayer>();
  for (const file of files) {
    if (file.layer !== "user") continue;
    for (const name of file.names) {
      const key = name.trim().toLowerCase();
      if (key) out.set(key, "user");
    }
  }
  for (const file of files) {
    if (file.layer !== "project") continue;
    for (const name of file.names) {
      const key = name.trim().toLowerCase();
      if (key) out.set(key, "project");
    }
  }
  return out;
}

/**
 * Name → user-level config path. Later user files overwrite earlier ones
 * (same walk order as {@link mcpConfigPaths}). Project files are ignored —
 * those rows never reach Settings. Keys are lowercased.
 */
export function collectMcpNameFiles(
  files: readonly { layer: McpConfigLayer; path: string; names: readonly string[] }[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of files) {
    if (file.layer !== "user") continue;
    for (const name of file.names) {
      const key = name.trim().toLowerCase();
      if (key) out.set(key, file.path);
    }
  }
  return out;
}

export function connectFailureMessage(kind: ConnectFailureKind, detail?: string): string {
  switch (kind) {
    case "npx-missing":
      return "Node.js / npx was not found. Install Node.js and make sure npx is on PATH.";
    case "cancelled":
      return "Sign-in did not finish. If you closed the browser, try Connect again.";
    case "timeout":
      return "Sign-in timed out. Complete the browser prompt within three minutes, then try again.";
    case "port-conflict":
      // All we actually observed is that this connector's deterministic sign-in
      // port is taken. The usual holder is our own proxy for the same connector
      // in another conversation, which does mean it is signed in — but saying
      // so outright told the owner "already signed in, nothing to do" about a
      // connector he had never connected, with no way forward from a red dot.
      // So: report the observation, cover both readings, and always end on
      // something the person can do.
      return "This connector's sign-in port is already in use on this computer, usually by the same connector running in another conversation or editor window. If it is connected there, nothing needs doing. Otherwise close those windows and press Connect again.";
    case "endpoint-refused":
      return detail
        ? `The app refused the connection: ${detail}`
        : "The app refused the connection. Check the endpoint is reachable, then try again.";
    case "oauth-incompatible":
      return "This app's sign-in is not compatible with this connector.";
    case "key-rejected":
      return "The token was rejected. Check it and try again. Fine-grained personal access tokens are recommended.";
    case "failed":
      return detail
        ? `Could not connect: ${detail}`
        : "Could not connect. See the host log for details.";
  }
}

export function classifyConnectFailure(input: {
  spawnError?: { code?: string; message?: string };
  timedOut?: boolean;
  exitCode?: number | null;
  output?: string;
  auth?: ConnectorAuth;
}): ConnectFailureKind {
  const output = (input.output || "").toLowerCase();
  const spawnMessage = (input.spawnError?.message || "").toLowerCase();
  const spawnCode = input.spawnError?.code;
  if (
    spawnCode === "ENOENT"
    || /not recognized as an internal or external command/.test(spawnMessage)
    || /npx(?:\.cmd)?: not found/.test(spawnMessage)
    || /npx(?:\.cmd)?: command not found/.test(output)
    || /'npx' is not recognized/.test(output)
  ) {
    return "npx-missing";
  }
  if (
    spawnCode === "EADDRINUSE"
    || connectOutputLooksLikePortConflict(output)
    || connectOutputLooksLikePortConflict(spawnMessage)
  ) {
    return "port-conflict";
  }
  if (input.timedOut) return "timeout";
  if (
    /\baccess_denied\b/.test(output)
    || /user denied/.test(output)
    || /authori[sz]ation (was )?cancell?ed/.test(output)
    || /browser (was )?closed/.test(output)
    || /closed the browser/.test(output)
  ) {
    return "cancelled";
  }
  if (connectOutputLooksLikeOAuthIncompatible(input.output || "") || connectOutputLooksLikeOAuthIncompatible(input.spawnError?.message || "")) {
    return input.auth === "key" ? "key-rejected" : "oauth-incompatible";
  }
  if (
    /enotfound|econnrefused|eai_again|getaddrinfo|status code 4\d\d|http 4\d\d|404 not found|connection refused|unable to connect|certificate/.test(output)
  ) {
    return "endpoint-refused";
  }
  return "failed";
}

export function connectOutputLooksLikePortConflict(output: string): boolean {
  const text = output.toLowerCase();
  return /\beaddrinuse\b/.test(text) || /address already in use/.test(text);
}

/** Vendor DCR / client-metadata rejection. Not the user's fault and not fixed by retrying.
 *  On a key-auth connector the same text means the key was rejected — GitHub
 *  falls through to OAuth discovery after a bad PAT and dies here. */
export function connectOutputLooksLikeOAuthIncompatible(output: string): boolean {
  const text = output.toLowerCase();
  return /invalidclientmetadataerror/.test(text)
    || /\binvalid_client_metadata\b/.test(text)
    || /not supported:\s*openid/.test(text)
    || /incompatible auth server/.test(text)
    || /does not support dynamic client registration/.test(text);
}

export function connectOutputLooksSuccessful(output: string): boolean {
  const text = output.toLowerCase();
  return /authentication (completed|successful)/.test(text)
    || /successfully authenticated/.test(text)
    || /authori[sz]ation successful/.test(text)
    || /connected to remote server/.test(text)
    || /credentials (saved|cached)/.test(text);
}

const CONNECT_LOG_PREFIX =
  /^(?:Connection error|Error from remote server|Error from local client|Authorization error):\s+/i;
// Node's own crashes read `Error [ERR_MODULE_NOT_FOUND]: …` — a bracketed
// code between the name and the colon, which the original pattern missed.
// That is how a broken npx install surfaced as "Could not connect: Node.js
// v20.19.0": the only informative line did not match, so the fallback took
// the last line, which is Node's version footer.
const CONNECT_ERROR_TEXT = /(?:[A-Za-z_$][\w$]*Error|Error)(?:\s+\[[^\]]+\])?:\s+\S/;

function normalizeConnectLine(line: string): string {
  return line
    .replace(/^\[\d+\]\s+/, "")
    .replace(CONNECT_LOG_PREFIX, "")
    .trim();
}

function isConnectStackNoise(line: string): boolean {
  if (!line) return true;
  if (/^npm\s+warn/i.test(line)) return true;
  // The footer Node prints after an uncaught exception. Never a diagnosis, and
  // being the LAST line it beat every real message to the fallback.
  if (/^Node\.js\s+v?\d+\./i.test(line)) return true;
  // The rest of that footer: the caret rule, the closing brace of the dumped
  // error object, and its `code:` / `errno:` fields.
  if (/^\^+$/.test(line)) return true;
  if (/^[}\])]+,?$/.test(line)) return true;
  if (/^(?:code|errno|syscall|requireStack):\s/.test(line)) return true;
  if (/^at\s+/.test(line)) return true;
  if (/^file:\/\//i.test(line)) return true;
  if (/file:\/\//i.test(line) && !CONNECT_ERROR_TEXT.test(line)) return true;
  return false;
}

function connectErrorText(line: string): string {
  const cut = line.replace(/\s+at\s+[\s\S]*$/, "").replace(/\s*file:\/\/\/\S+/g, "").trim();
  const match = cut.match(/((?:[A-Za-z_$][\w$]*Error|Error):\s+\S.*)$/);
  return (match?.[1] ?? cut).replace(/\s+/g, " ").trim();
}

/**
 * One user-facing line from mcp-remote's stderr. Prefers an `*Error:` line
 * (e.g. `InvalidClientMetadataError: Not supported: openid, email, profile`)
 * and drops `at …` frames and `file:///` paths. Empty means the generic
 * fallback — never a stack dump.
 */
export function summarizeConnectOutput(output: string, max = 240): string {
  const lines: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = normalizeConnectLine(raw.trim());
    if (isConnectStackNoise(line)) continue;
    lines.push(line);
  }
  let picked = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    if (CONNECT_ERROR_TEXT.test(lines[i])) {
      picked = connectErrorText(lines[i]);
      break;
    }
  }
  if (!picked) {
    const last = lines[lines.length - 1] || "";
    picked = isConnectStackNoise(last) ? "" : connectErrorText(last);
    if (/^at\s+/.test(picked) || /file:\/\//i.test(picked)) picked = "";
  }
  if (!picked) return "";
  return picked.length > max ? `${picked.slice(0, max - 1)}…` : picked;
}

export function parseInitializeResult(line: string): boolean | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as { id?: unknown; result?: unknown; error?: unknown };
    if (parsed.id !== 1) return undefined;
    if (parsed.error) return false;
    if (parsed.result !== undefined) return true;
  } catch {
    return undefined;
  }
  return undefined;
}

export const MCP_INITIALIZE_REQUEST = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "grok-build-vscode", version: "0" },
  },
}) + "\n";
