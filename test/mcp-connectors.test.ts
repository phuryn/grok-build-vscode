import { describe, expect, it } from "vitest";
import {
  CONNECTOR_REAUTH_MESSAGE,
  TIER1_CONNECTORS,
  connectorById,
  isConnectorId,
  isKeyConnector,
  buildMcpRemoteEntry,
  bearerAuthorizationHeader,
  classifyConnectFailure,
  collectReservedMcpIdentity,
  connectConnector,
  connectFailureMessage,
  connectOutputLooksLikeOAuthIncompatible,
  connectOutputLooksLikePortConflict,
  connectOutputLooksSuccessful,
  connectorViews,
  disconnectConnector,
  hostMcpServers,
  mcpConfigLayer,
  mcpConfigPaths,
  collectMcpNameFiles,
  collectMcpNameLayers,
  mcpConnectorSecretKey,
  mcpRemoteArgs,
  mcpRemoteHeadersFromArgs,
  oauthClientMetadataJson,
  parseConnectedConnectorStore,
  parseInitializeResult,
  reservedConflictsConnector,
  reservedFromMcpInventory,
  withAuthHeaderEnv,
  MCP_REMOTE_AUTH_HEADER_ENV,
  MCP_REMOTE_AUTH_HEADER_TEMPLATE,
  MCP_REMOTE_HEADER_FLAG,
  MCP_REMOTE_READONLY_HEADER,
  STATIC_OAUTH_CLIENT_METADATA_FLAG,
  summarizeConnectOutput,
  withMcpRemoteCallbackPort,
  MCP_REMOTE_PACKAGE } from "../src/mcp-connectors";

const GITHUB_ENDPOINT = "https://api.githubcopilot.com/mcp/";
const PLANTED_PAT = "ghp_TESTSECRET_do_not_store";

function assertNoSecretMaterial(value: unknown, planted = PLANTED_PAT) {
  const json = JSON.stringify(value);
  expect(json).not.toContain(planted);
  expect(json).not.toContain("github_pat_");
  expect(json).not.toMatch(/Bearer ghp_/);
}

describe("a broken npx install must name itself", () => {
  // Verbatim from a real failure: `open@10.2.0` reached the npx cache without
  // its `wsl-utils` dependency, so every OAuth connector died here. The user
  // saw "Could not connect: Node.js v20.19.0" — the LAST line, and the only
  // one carrying no information at all.
  const CRASH = [
    "node:internal/modules/esm/resolve:873",
    "  throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);",
    "        ^",
    "",
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'wsl-utils' imported from /npm-cache/_npx/open/index.js",
    "    at packageResolve (node:internal/modules/esm/resolve:873:9)",
    "    at moduleResolve (node:internal/modules/esm/resolve:946:18)",
    "  code: 'ERR_MODULE_NOT_FOUND'",
    "}",
    "",
    "Node.js v20.19.0",
  ].join("\n");

  it("reports the module error, not Node's version footer", () => {
    const summary = summarizeConnectOutput(CRASH);
    expect(summary).toContain("ERR_MODULE_NOT_FOUND");
    expect(summary).toContain("wsl-utils");
    expect(summary).not.toContain("Node.js v20.19.0");
  });

  it("never falls back to the crash footer's furniture", () => {
    for (const noise of ["Node.js v20.19.0", "^", "}", "code: 'ERR_MODULE_NOT_FOUND'"]) {
      expect(summarizeConnectOutput(noise), noise).toBe("");
    }
  });

  it("still reports a plain Error: line", () => {
    expect(summarizeConnectOutput("TypeError: fetch failed")).toContain("fetch failed");
  });
});

describe("Tier-1 connector catalog", () => {
  it("ships only vendor-documented HTTPS endpoints and unique ids", () => {
    const ids = TIER1_CONNECTORS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("github");
    expect(ids).not.toContain("figma");
    for (const connector of TIER1_CONNECTORS) {
      expect(connector.endpoint.startsWith("https://")).toBe(true);
      expect(connector.description.length).toBeGreaterThan(10);
    }
    expect(TIER1_CONNECTORS.find((c) => c.id === "linear")?.endpoint).toBe("https://mcp.linear.app/mcp");
    expect(TIER1_CONNECTORS.find((c) => c.id === "atlassian")?.endpoint).toBe(
      "https://mcp.atlassian.com/v1/mcp/authv2",
    );
    expect(TIER1_CONNECTORS.find((c) => c.id === "cloudflare")?.endpoint).toBe(
      "https://observability.mcp.cloudflare.com/mcp",
    );
    expect(TIER1_CONNECTORS.find((c) => c.id === "stripe")?.endpoint).toBe("https://mcp.stripe.com");
    expect(TIER1_CONNECTORS.find((c) => c.id === "stripe")?.oauthScope).toBe("mcp");
    expect(TIER1_CONNECTORS.find((c) => c.id === "calendly")?.endpoint).toBe("https://mcp.calendly.com");
    expect(TIER1_CONNECTORS.find((c) => c.id === "airtable")?.endpoint).toBe("https://mcp.airtable.com/mcp");
    expect(TIER1_CONNECTORS.find((c) => c.id === "github")?.endpoint).toBe(GITHUB_ENDPOINT);
    expect(TIER1_CONNECTORS.find((c) => c.id === "github")?.auth).toBe("key");
    expect(TIER1_CONNECTORS.find((c) => c.id === "zapier")?.endpoint).toBe(
      "https://mcp.zapier.com/api/v1/connect",
    );
    // OAuth via DCR, like every other Tier-1 row: the live endpoint answers a
    // 401 Bearer challenge and its authorization server publishes a
    // registration_endpoint, so there is nothing to paste and nothing to
    // pre-register. Sources claiming a per-user token describe an older path.
    expect(TIER1_CONNECTORS.find((c) => c.id === "zapier")?.auth).toBeUndefined();
    expect(TIER1_CONNECTORS.find((c) => c.id === "zapier")?.keyHint).toBeUndefined();
    expect(TIER1_CONNECTORS.find((c) => c.id === "zapier")?.oauthScope).toBeUndefined();
    expect(TIER1_CONNECTORS.filter((c) => c.oauthScope).map((c) => c.id)).toEqual(["stripe"]);
    expect(TIER1_CONNECTORS.filter((c) => c.auth === "key").map((c) => c.id)).toEqual(["github"]);
    // Append-only walk order: new ids go at the end, not alphabetically.
    expect(TIER1_CONNECTORS.map((c) => c.id).slice(-3)).toEqual(["airtable", "github", "zapier"]);
  });

  it("resolves calendly and airtable by id with no scope override", () => {
    expect(isConnectorId("calendly")).toBe(true);
    expect(isConnectorId("airtable")).toBe(true);
    expect(connectorById("calendly")).toMatchObject({
      id: "calendly",
      name: "Calendly",
      endpoint: "https://mcp.calendly.com",
    });
    expect(connectorById("airtable")).toMatchObject({
      id: "airtable",
      name: "Airtable",
      endpoint: "https://mcp.airtable.com/mcp",
    });
    expect(connectorById("calendly")?.oauthScope).toBeUndefined();
    expect(connectorById("airtable")?.oauthScope).toBeUndefined();
  });

  it("builds the stdio mcp-remote entry vendors document", () => {
    expect(buildMcpRemoteEntry("linear", "https://mcp.linear.app/mcp")).toEqual({
      name: "linear",
      command: "npx",
      args: ["-y", MCP_REMOTE_PACKAGE, "https://mcp.linear.app/mcp"],
      // This assertion previously pinned the entry WITHOUT env, which is what
      // made the bug look intentional. grok refuses that shape outright — see
      // the wire-shape test at the bottom of this file.
      env: [],
    });
  });

  it("appends a callback port only when it is a usable TCP port", () => {
    expect(mcpRemoteArgs("https://mcp.linear.app/mcp")).toEqual(
      ["-y", MCP_REMOTE_PACKAGE, "https://mcp.linear.app/mcp"],
    );
    expect(mcpRemoteArgs("https://mcp.linear.app/mcp", 22227)).toEqual(
      ["-y", MCP_REMOTE_PACKAGE, "https://mcp.linear.app/mcp", "22227"],
    );
    expect(mcpRemoteArgs("https://mcp.linear.app/mcp", 0)).toEqual(
      ["-y", MCP_REMOTE_PACKAGE, "https://mcp.linear.app/mcp"],
    );
    expect(mcpRemoteArgs("https://mcp.linear.app/mcp", 70000)).toEqual(
      ["-y", MCP_REMOTE_PACKAGE, "https://mcp.linear.app/mcp"],
    );
    expect(withMcpRemoteCallbackPort(
      ["-y", MCP_REMOTE_PACKAGE, "https://mcp.linear.app/mcp"],
      54321,
    )).toEqual(["-y", MCP_REMOTE_PACKAGE, "https://mcp.linear.app/mcp", "54321"]);
    expect(withMcpRemoteCallbackPort(["-y", "something-else"], 54321)).toBeUndefined();
  });

  it("does not pin a callback port on the session/new entry", () => {
    expect(buildMcpRemoteEntry("linear", "https://mcp.linear.app/mcp").args)
      .toEqual(["-y", MCP_REMOTE_PACKAGE, "https://mcp.linear.app/mcp"]);
  });

  it("attaches static OAuth client metadata only when a scoped connector has a file", () => {
    expect(oauthClientMetadataJson("mcp")).toBe('{"scope":"mcp"}');
    const meta = "/tmp/stripe-oauth.json";
    expect(mcpRemoteArgs("https://mcp.stripe.com", undefined, meta)).toEqual([
      "-y", MCP_REMOTE_PACKAGE, "https://mcp.stripe.com",
      STATIC_OAUTH_CLIENT_METADATA_FLAG, "@/tmp/stripe-oauth.json",
    ]);
    expect(mcpRemoteArgs("https://mcp.stripe.com", 22227, meta)).toEqual([
      "-y", MCP_REMOTE_PACKAGE, "https://mcp.stripe.com", "22227",
      STATIC_OAUTH_CLIENT_METADATA_FLAG, "@/tmp/stripe-oauth.json",
    ]);
    expect(mcpRemoteArgs("https://mcp.linear.app/mcp")).not.toContain(STATIC_OAUTH_CLIENT_METADATA_FLAG);
    expect(buildMcpRemoteEntry("stripe", "https://mcp.stripe.com", meta).args)
      .toContain(STATIC_OAUTH_CLIENT_METADATA_FLAG);
    expect(buildMcpRemoteEntry("linear", "https://mcp.linear.app/mcp").args)
      .not.toContain(STATIC_OAUTH_CLIENT_METADATA_FLAG);

    const servers = hostMcpServers({
      stripe: { endpoint: "https://mcp.stripe.com" },
      linear: { endpoint: "https://mcp.linear.app/mcp" },
    }, { names: [], urls: [] }, { stripe: meta });
    const stripe = servers.find((s) => s.name === "stripe");
    const linear = servers.find((s) => s.name === "linear");
    expect(stripe?.args).toEqual([
      "-y", MCP_REMOTE_PACKAGE, "https://mcp.stripe.com",
      STATIC_OAUTH_CLIENT_METADATA_FLAG, "@/tmp/stripe-oauth.json",
    ]);
    expect(linear?.args).toEqual(["-y", MCP_REMOTE_PACKAGE, "https://mcp.linear.app/mcp"]);
    expect(linear?.args).not.toContain(STATIC_OAUTH_CLIENT_METADATA_FLAG);

    const unscoped = hostMcpServers({
      calendly: { endpoint: "https://mcp.calendly.com" },
      airtable: { endpoint: "https://mcp.airtable.com/mcp" },
    });
    expect(unscoped.map((s) => s.name)).toEqual(["calendly", "airtable"]);
    for (const server of unscoped) {
      expect(server.env).toEqual([]);
      expect(server.args).not.toContain(STATIC_OAUTH_CLIENT_METADATA_FLAG);
    }
  });

  it("keeps static OAuth metadata when rebuilding args with a callback port", () => {
    expect(withMcpRemoteCallbackPort(
      ["-y", MCP_REMOTE_PACKAGE, "https://mcp.stripe.com", STATIC_OAUTH_CLIENT_METADATA_FLAG, "@/tmp/stripe-oauth.json"],
      54321,
    )).toEqual([
      "-y", MCP_REMOTE_PACKAGE, "https://mcp.stripe.com", "54321",
      STATIC_OAUTH_CLIENT_METADATA_FLAG, "@/tmp/stripe-oauth.json",
    ]);
  });

  it("emits the raw metadata path even when it contains spaces", () => {
    const meta = "C:\\Users\\Jane Doe\\AppData\\Local\\Temp\\oauth-client-metadata.json";
    const raw = `@${meta}`;
    expect(mcpRemoteArgs("https://mcp.stripe.com", undefined, meta)).toEqual([
      "-y", MCP_REMOTE_PACKAGE, "https://mcp.stripe.com",
      STATIC_OAUTH_CLIENT_METADATA_FLAG, raw,
    ]);
    expect(mcpRemoteArgs("https://mcp.stripe.com", 22227, meta)).toEqual([
      "-y", MCP_REMOTE_PACKAGE, "https://mcp.stripe.com", "22227",
      STATIC_OAUTH_CLIENT_METADATA_FLAG, raw,
    ]);
    const stripe = hostMcpServers(
      { stripe: { endpoint: "https://mcp.stripe.com" } },
      { names: [], urls: [] },
      { stripe: meta },
    )[0];
    expect(stripe?.args).toEqual([
      "-y", MCP_REMOTE_PACKAGE, "https://mcp.stripe.com",
      STATIC_OAUTH_CLIENT_METADATA_FLAG, raw,
    ]);
    expect(stripe?.args.some((arg) => arg.includes('"'))).toBe(false);
    expect(withMcpRemoteCallbackPort(
      ["-y", MCP_REMOTE_PACKAGE, "https://mcp.stripe.com", STATIC_OAUTH_CLIENT_METADATA_FLAG, raw],
      54321,
    )).toEqual([
      "-y", MCP_REMOTE_PACKAGE, "https://mcp.stripe.com", "54321",
      STATIC_OAUTH_CLIENT_METADATA_FLAG, raw,
    ]);
  });
});

describe("connected store", () => {
  it("keeps catalog ids and HTTPS endpoints, never tokens", () => {
    const parsed = parseConnectedConnectorStore({
      linear: { endpoint: "https://mcp.linear.app/mcp" },
      github: { endpoint: GITHUB_ENDPOINT, token: PLANTED_PAT, key: PLANTED_PAT, authorization: `Bearer ${PLANTED_PAT}` },
      figma: { endpoint: "https://mcp.figma.com/mcp" },
      notion: { endpoint: "not-a-url" },
      canva: { token: "secret" },
    });
    expect(parsed).toEqual({
      linear: { endpoint: "https://mcp.linear.app/mcp" },
      github: { endpoint: GITHUB_ENDPOINT },
    });
    assertNoSecretMaterial(parsed);
    expect(JSON.stringify(parsed)).not.toMatch(/"token"|"key"|"authorization"/);
  });

  it("connects and disconnects by id", () => {
    const connected = connectConnector({}, "canva");
    expect(connected.canva?.endpoint).toBe("https://mcp.canva.com/mcp");
    expect(disconnectConnector(connected, "canva")).toEqual({});
  });

  it("persists GitHub as connected with optional readOnly, never a key", () => {
    const connected = connectConnector({}, "github", GITHUB_ENDPOINT, true);
    expect(connected).toEqual({ github: { endpoint: GITHUB_ENDPOINT, readOnly: true } });
    assertNoSecretMaterial(connected);
    expect(connectConnector({}, "github")).toEqual({ github: { endpoint: GITHUB_ENDPOINT } });
    expect(parseConnectedConnectorStore({
      github: { endpoint: GITHUB_ENDPOINT, readOnly: true, token: PLANTED_PAT },
    })).toEqual({ github: { endpoint: GITHUB_ENDPOINT, readOnly: true } });
  });
});

describe("key-auth connectors", () => {
  it("GitHub is the only key-auth row and stores secrets under HostSecrets, not grok.mcpConnectors", () => {
    const github = connectorById("github")!;
    expect(isKeyConnector(github)).toBe(true);
    expect(isKeyConnector(connectorById("linear"))).toBe(false);
    expect(mcpConnectorSecretKey("github")).toBe("grok.mcpConnector.github.key");
    expect(mcpConnectorSecretKey("github")).not.toBe("grok.mcpConnectors");
  });

  it("puts the PAT in AUTH_HEADER env and never in argv", () => {
    const entry = buildMcpRemoteEntry("github", GITHUB_ENDPOINT, undefined, {
      token: PLANTED_PAT,
      readOnly: true,
    });
    expect(entry.args).toEqual([
      "-y", MCP_REMOTE_PACKAGE, GITHUB_ENDPOINT,
      MCP_REMOTE_HEADER_FLAG, MCP_REMOTE_AUTH_HEADER_TEMPLATE,
      MCP_REMOTE_HEADER_FLAG, MCP_REMOTE_READONLY_HEADER,
    ]);
    expect(entry.args.join(" ")).not.toContain(PLANTED_PAT);
    expect(entry.args.some((arg) => arg.includes(" "))).toBe(false);
    expect(entry.env).toEqual([{ name: MCP_REMOTE_AUTH_HEADER_ENV, value: `Bearer ${PLANTED_PAT}` }]);
    expect(bearerAuthorizationHeader(`Bearer ${PLANTED_PAT}`)).toBe(`Bearer ${PLANTED_PAT}`);
    expect(withAuthHeaderEnv({ PATH: "/usr/bin" }, PLANTED_PAT)).toEqual({
      PATH: "/usr/bin",
      [MCP_REMOTE_AUTH_HEADER_ENV]: `Bearer ${PLANTED_PAT}`,
    });
  });

  it("does not inject GitHub without the in-memory key, and does not mutate the shared record", () => {
    const store = Object.freeze({ github: Object.freeze({ endpoint: GITHUB_ENDPOINT }) });
    expect(hostMcpServers(store)).toEqual([]);
    expect(store).toEqual({ github: { endpoint: GITHUB_ENDPOINT } });
    const servers = hostMcpServers(store, { names: [], urls: [] }, {}, { github: PLANTED_PAT });
    expect(servers).toHaveLength(1);
    expect(servers[0]?.name).toBe("github");
    expect(servers[0]?.args).not.toContain(PLANTED_PAT);
    expect(servers[0]?.env).toEqual([{ name: MCP_REMOTE_AUTH_HEADER_ENV, value: `Bearer ${PLANTED_PAT}` }]);
    expect(store).toEqual({ github: { endpoint: GITHUB_ENDPOINT } });
  });

  it("a host without a key leaves the shared record for a host that has one", () => {
    const store = { github: { endpoint: GITHUB_ENDPOINT } };
    expect(hostMcpServers(store)).toEqual([]);
    expect(connectorViews(store, { keySet: new Set() }).find((v) => v.id === "github")).toMatchObject({
      connected: true,
      keySet: false,
    });
    expect(store).toEqual({ github: { endpoint: GITHUB_ENDPOINT } });
    const servers = hostMcpServers(store, { names: [], urls: [] }, {}, { github: PLANTED_PAT });
    expect(servers).toHaveLength(1);
    expect(servers[0]?.name).toBe("github");
    expect(connectorViews(store, { keySet: new Set(["github"]) }).find((v) => v.id === "github")).toMatchObject({
      connected: true,
      keySet: true,
    });
  });

  it("keeps --header flags when rebuilding args with a callback port", () => {
    const args = mcpRemoteArgs(GITHUB_ENDPOINT, undefined, undefined, { authorization: true, readOnly: true });
    expect(mcpRemoteHeadersFromArgs(args)).toEqual({ authorization: true, readOnly: true });
    expect(withMcpRemoteCallbackPort(args, 54321)).toEqual([
      "-y", MCP_REMOTE_PACKAGE, GITHUB_ENDPOINT, "54321",
      MCP_REMOTE_HEADER_FLAG, MCP_REMOTE_AUTH_HEADER_TEMPLATE,
      MCP_REMOTE_HEADER_FLAG, MCP_REMOTE_READONLY_HEADER,
    ]);
  });

  it("views report connected from the store and keySet from this host, never the secret", () => {
    const views = connectorViews(
      { github: { endpoint: GITHUB_ENDPOINT, readOnly: true } },
      { keySet: new Set(["github"]) },
    );
    const github = views.find((v) => v.id === "github")!;
    expect(github).toMatchObject({
      auth: "key",
      connected: true,
      keySet: true,
      readOnly: true,
    });
    expect(github).not.toHaveProperty("key");
    expect(github).not.toHaveProperty("token");
    assertNoSecretMaterial(github);
    assertNoSecretMaterial(views);

    const missingKey = connectorViews(
      { github: { endpoint: GITHUB_ENDPOINT } },
      { keySet: new Set() },
    ).find((v) => v.id === "github")!;
    expect(missingKey.connected).toBe(true);
    expect(missingKey.keySet).toBe(false);
    expect(missingKey).not.toHaveProperty("key");
    expect(missingKey).not.toHaveProperty("token");
    assertNoSecretMaterial(missingKey);

    const linear = views.find((v) => v.id === "linear")!;
    expect(linear.auth).toBe("oauth");
    expect(linear.keySet).toBeUndefined();
  });
});

describe("dedup prefers the user's config", () => {
  const canva = TIER1_CONNECTORS.find((c) => c.id === "canva")!;
  const store = { canva: { endpoint: canva.endpoint }, linear: { endpoint: "https://mcp.linear.app/mcp" } };

  it("skips a host entry whose name already exists, including grok.com managed prefixes", () => {
    expect(reservedConflictsConnector(canva, canva.endpoint, {
      names: ["managed_gateway:canva"],
      urls: [],
    })).toBe(true);
    expect(hostMcpServers(store, { names: ["Canva"], urls: [] }).map((s) => s.name)).toEqual(["linear"]);
  });

  it("skips a host entry whose endpoint is already configured under another name", () => {
    expect(hostMcpServers(store, {
      names: ["linear-server"],
      urls: ["https://mcp.linear.app/mcp/"],
    }).map((s) => s.name)).toEqual(["canva"]);
  });

  it("emits connected servers when nothing conflicts", () => {
    expect(hostMcpServers(store, { names: ["docs"], urls: [] })).toEqual([
      buildMcpRemoteEntry("linear", "https://mcp.linear.app/mcp"),
      buildMcpRemoteEntry("canva", canva.endpoint),
    ]);
  });

  it("reads reserved names from grok inventory including managed Canva", () => {
    expect(reservedFromMcpInventory([
      { name: "managed_gateway:canva", displayName: "Canva", url: "https://mcp.canva.com/mcp" },
      { name: "docs" },
    ], {})).toEqual({
      names: ["managed_gateway:canva", "Canva", "docs"],
      urls: ["https://mcp.canva.com/mcp"],
    });
  });

  // Grok echoes the servers we injected back on _x.ai/mcp/list. Counting those
  // as pre-existing config made hostMcpServers drop our own connector from the
  // NEXT session: connect Linear, it works once, then silently stops existing.
  it("never treats a server we injected ourselves as someone else's", () => {
    const store = { linear: { endpoint: "https://mcp.linear.app/mcp" } };
    const reserved = reservedFromMcpInventory([
      { name: "linear", url: "https://mcp.linear.app/mcp" },
      { name: "docs" },
    ], store);
    expect(reserved).toEqual({ names: ["docs"], urls: [] });
    // ...so the connector still goes out on the next session.
    expect(hostMcpServers(store, reserved).map((s) => s.name)).toEqual(["linear"]);
  });

  // Round-2 regression: the first version of the echo filter matched on the
  // NORMALIZED name, and normalizeMcpName strips `managed_gateway:` — so
  // grok.com's managed Canva looked like our own injection, fell out of the
  // reserved set, and we injected a second Canva beside it.
  it("keeps grok.com's managed gateway reserved even when we connect the same app", () => {
    const store = { canva: { endpoint: "https://mcp.canva.com/mcp" } };
    const reserved = reservedFromMcpInventory([
      { name: "managed_gateway:canva", displayName: "Canva", url: "https://mcp.canva.com/mcp" },
    ], store);
    expect(reserved.names).toContain("managed_gateway:canva");
    expect(hostMcpServers(store, reserved)).toEqual([]);
  });

  it("still drops our own stdio echo when both are connected", () => {
    const store = { canva: { endpoint: "https://mcp.canva.com/mcp" }, linear: { endpoint: "https://mcp.linear.app/mcp" } };
    const reserved = reservedFromMcpInventory([
      { name: "managed_gateway:canva", displayName: "Canva", url: "https://mcp.canva.com/mcp" },
      { name: "linear" },
    ], store);
    // Canva stays suppressed (managed already provides it); linear still goes.
    expect(hostMcpServers(store, reserved).map((s) => s.name)).toEqual(["linear"]);
  });

  // Round-3 regression: a listed-but-disabled managed server provides no tools,
  // so it must not stand in for ours. The user disables Canva at grok.com,
  // connects it here, and would otherwise see "connected" with no Canva tools.
  it("does not let a disabled managed server suppress the connector", () => {
    const store = { canva: { endpoint: "https://mcp.canva.com/mcp" } };
    const reserved = reservedFromMcpInventory([
      { name: "managed_gateway:canva", displayName: "Canva", url: "https://mcp.canva.com/mcp", enabled: false },
    ], store);
    expect(reserved).toEqual({ names: [], urls: [] });
    expect(hostMcpServers(store, reserved).map((s) => s.name)).toEqual(["canva"]);
  });

  it("an inventory that reports no enabled field still reserves", () => {
    const store = { canva: { endpoint: "https://mcp.canva.com/mcp" } };
    const reserved = reservedFromMcpInventory([
      { name: "managed_gateway:canva", displayName: "Canva", url: "https://mcp.canva.com/mcp" },
    ], store);
    expect(hostMcpServers(store, reserved)).toEqual([]);
  });

  it("still defers to a genuinely pre-existing server of the same name", () => {
    const store = { notion: { endpoint: "https://mcp.notion.com/mcp" } };
    const reserved = reservedFromMcpInventory([{ name: "notion" }], {});
    expect(hostMcpServers(store, reserved)).toEqual([]);
  });
});

describe("config identity collection", () => {
  it("parses Claude / Cursor JSON maps and grok TOML tables", () => {
    expect(collectReservedMcpIdentity(JSON.stringify({
      mcpServers: {
        linear: { url: "https://mcp.linear.app/mcp" },
        notes: { command: "npx", args: ["-y", MCP_REMOTE_PACKAGE, "https://mcp.notion.com/mcp"] },
      },
    }))).toEqual({
      names: ["linear", "notes"],
      urls: ["https://mcp.linear.app/mcp", "https://mcp.notion.com/mcp"],
    });

    const toml = `
[ui]
permission_mode = "default"

[mcp_servers.canva]
command = "npx"
args = ["-y", MCP_REMOTE_PACKAGE, "https://mcp.canva.com/mcp"]

[mcp_servers.other.env]
FOO = "bar"
`;
    expect(collectReservedMcpIdentity(toml)).toEqual({
      names: ["canva", "other"],
      urls: ["https://mcp.canva.com/mcp"],
    });
  });

  it("scopes config paths to the provider that actually loads them", () => {
    expect(mcpConfigPaths({
      cwd: "/proj", provider: "grok", grokHome: "/home/.grok", userHome: "/home",
    })).toEqual([
      "/proj/.mcp.json",
      "/home/.grok/config.toml",
      "/proj/.grok/config.toml",
      "/home/.cursor/mcp.json",
      "/home/.claude.json",
    ]);
    expect(mcpConfigPaths({
      cwd: "/proj", provider: "claude", grokHome: "/home/.grok", userHome: "/home",
    })).toEqual(["/proj/.mcp.json", "/home/.claude.json"]);
    // NOT /proj/.mcp.json — the bundled Codex adapter never reads it, so
    // scanning it suppressed our connector for a file codex cannot see, and
    // codex ended up with neither server.
    expect(mcpConfigPaths({
      cwd: "/proj", provider: "codex", grokHome: "/home/.grok", userHome: "/home",
    })).toEqual(["/home/.codex/config.toml"]);
  });

  it("classifies project files vs user files from the same path list", () => {
    const grok = { cwd: "/proj", provider: "grok" as const, grokHome: "/home/.grok", userHome: "/home" };
    expect(mcpConfigLayer("/proj/.mcp.json", grok)).toBe("project");
    expect(mcpConfigLayer("/proj/.grok/config.toml", grok)).toBe("project");
    expect(mcpConfigLayer("/home/.grok/config.toml", grok)).toBe("user");
    expect(mcpConfigLayer("/home/.cursor/mcp.json", grok)).toBe("user");
    expect(mcpConfigLayer("/home/.claude.json", grok)).toBe("user");
    const layers = collectMcpNameLayers([
      { layer: "user", names: ["notes", "shared"] },
      { layer: "project", names: ["docs", "shared"] },
    ]);
    expect(layers.get("docs")).toBe("project");
    expect(layers.get("notes")).toBe("user");
    expect(layers.get("shared")).toBe("project");
  });

  it("maps user-level names to the declaring file and ignores project files", () => {
    const files = collectMcpNameFiles([
      { layer: "user", path: "/home/.grok/config.toml", names: ["notes", "shared"] },
      { layer: "user", path: "/home/.cursor/mcp.json", names: ["cursor-docs", "shared"] },
      { layer: "project", path: "/proj/.mcp.json", names: ["docs"] },
    ]);
    expect(files.get("notes")).toBe("/home/.grok/config.toml");
    expect(files.get("cursor-docs")).toBe("/home/.cursor/mcp.json");
    expect(files.get("shared")).toBe("/home/.cursor/mcp.json");
    expect(files.get("docs")).toBeUndefined();
  });
});

describe("connect failure taxonomy", () => {
  it("maps missing npx, closed browser, timeout, port conflict, and refused endpoint separately", () => {
    expect(classifyConnectFailure({ spawnError: { code: "ENOENT", message: "spawn npx ENOENT" } })).toBe("npx-missing");
    expect(classifyConnectFailure({ output: "Authorization cancelled by the user" })).toBe("cancelled");
    expect(classifyConnectFailure({ timedOut: true })).toBe("timeout");
    expect(classifyConnectFailure({
      output: "Error: listen EADDRINUSE: address already in use 127.0.0.1:22227",
    })).toBe("port-conflict");
    expect(classifyConnectFailure({
      spawnError: { code: "EADDRINUSE", message: "listen EADDRINUSE" },
    })).toBe("port-conflict");
    expect(classifyConnectFailure({
      timedOut: true,
      output: "Error: listen EADDRINUSE: address already in use :::22227",
    })).toBe("port-conflict");
    expect(classifyConnectFailure({ output: "getaddrinfo ENOTFOUND mcp.example.invalid" })).toBe("endpoint-refused");
    expect(classifyConnectFailure({ exitCode: 1, output: "boom" })).toBe("failed");
    expect(connectOutputLooksLikePortConflict("Error: listen EADDRINUSE: address already in use")).toBe(true);
    expect(connectFailureMessage("npx-missing")).toMatch(/npx/i);
    expect(connectFailureMessage("cancelled")).toMatch(/browser/i);
    expect(connectFailureMessage("timeout")).toMatch(/timed out/i);
    // A conflict is USUALLY the good case — the same connector signed in and
    // running elsewhere on this machine — so the copy must not read as a
    // failure to repair. But it is an observation about a port, not a reading
    // of the token store, and asserting "already signed in, nothing to do"
    // about a connector the owner had never connected left him at a red dot
    // with nowhere to go. It must always end on something he can do.
    expect(connectFailureMessage("port-conflict")).toMatch(/press connect again/i);
    expect(connectFailureMessage("port-conflict")).not.toMatch(/EADDRINUSE/i);
    expect(connectFailureMessage("port-conflict")).not.toMatch(/couldn.t|failed/i);
    expect(connectFailureMessage("port-conflict")).not.toMatch(/nothing to do/i);
    expect(classifyConnectFailure({
      output: "InvalidClientMetadataError: Not supported: openid, email, profile",
    })).toBe("oauth-incompatible");
    expect(connectOutputLooksLikeOAuthIncompatible(
      "Connection error: InvalidClientMetadataError: Not supported: openid, email, profile",
    )).toBe(true);
    expect(connectFailureMessage("oauth-incompatible")).toMatch(/not compatible/i);
    expect(connectFailureMessage("oauth-incompatible")).not.toMatch(/try again/i);
    expect(classifyConnectFailure({
      output: "Connection error: Incompatible auth server: does not support dynamic client registration",
    })).toBe("oauth-incompatible");
    expect(classifyConnectFailure({
      output: "Connection error: Incompatible auth server: does not support dynamic client registration",
      auth: "key",
    })).toBe("key-rejected");
    expect(classifyConnectFailure({
      output: "InvalidClientMetadataError: Not supported: openid, email, profile",
      auth: "key",
    })).toBe("key-rejected");
    expect(connectFailureMessage("key-rejected")).toMatch(/token was rejected/i);
    expect(connectFailureMessage("key-rejected")).not.toMatch(/not compatible/i);
  });

  it("summarises a stack-trace blob to the error line, not frames", () => {
    const blob = `Discovered authorization server: https://access.stripe.com/mcp
[18536] Connection error: InvalidClientMetadataError: Not supported: openid, email, profile
    at registerClient (file:///C:/Users/foo/AppData/Local/npm-cache/_npx/chunk.js:12:3)
    at async auth (file:///C:/Users/foo/chunk-65X3S4HB.js:18536:12)
    at async StreamableHTTPClientTransport.send (file:///C:/Users/foo/chunk.js:99:5)`;
    expect(summarizeConnectOutput(blob)).toBe(
      "InvalidClientMetadataError: Not supported: openid, email, profile",
    );
    expect(summarizeConnectOutput(blob)).not.toMatch(/\bat\s+/);
    expect(summarizeConnectOutput(blob)).not.toMatch(/file:\/\//);

    const framesOnly = `at async auth (file:///C:/Users/foo/chunk-65X3S4HB.js:18536:12)
at async StreamableHTTPClientTransport.send (file:///C:/Users/foo/chunk.js:99:5)`;
    expect(summarizeConnectOutput(framesOnly)).toBe("");
    expect(connectFailureMessage("failed", summarizeConnectOutput(framesOnly)))
      .toBe("Could not connect. See the host log for details.");
  });

  it("treats mcp-remote auth-success logs and initialize results as connected", () => {
    expect(connectOutputLooksSuccessful("Authentication successful. Caching credentials...")).toBe(true);
    expect(parseInitializeResult('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05"}}')).toBe(true);
    expect(parseInitializeResult('{"jsonrpc":"2.0","id":1,"error":{"code":-32000}}')).toBe(false);
    expect(parseInitializeResult("not json")).toBeUndefined();
  });
});

describe("settings views", () => {
  it("renders every catalog row with live connecting/error state", () => {
    const views = connectorViews(
      { linear: { endpoint: "https://mcp.linear.app/mcp" } },
      { connectingId: "notion", errorId: "sentry", error: "Sign-in timed out." },
    );
    expect(views).toHaveLength(TIER1_CONNECTORS.length);
    expect(views.find((v) => v.id === "linear")).toMatchObject({ connected: true, status: "idle" });
    expect(views.find((v) => v.id === "notion")).toMatchObject({ connected: false, status: "connecting" });
    expect(views.find((v) => v.id === "sentry")).toMatchObject({
      connected: false, status: "error", error: "Sign-in timed out.",
    });
    // Display sort lives in settings.js. The catalog walk order is load-bearing
    // for hostMcpServers; do not alphabetize TIER1_CONNECTORS itself.
    expect(views.map((v) => v.id)).toEqual(TIER1_CONNECTORS.map((c) => c.id));
  });
});

describe("ACP stdio wire shape", () => {
  // grok's session/new deserializes mcpServers into an untagged McpServer enum.
  // Probed against grok 1.0.5: {name, command, args} is refused with
  // "-32602 ... did not match any variant of untagged enum McpServer" and the
  // session never starts; adding env makes it accepted. Codex and Claude accept
  // either, so only grok fails — and only once a connector is actually
  // connected, since an empty store sends [] and nothing is rejected.
  it("always carries env, because grok refuses the entry without it", () => {
    const entry = buildMcpRemoteEntry("linear", "https://mcp.linear.app/mcp");
    expect(entry.env).toEqual([]);
    expect(Object.keys(entry).sort()).toEqual(["args", "command", "env", "name"]);
  });

  it("every server hostMcpServers hands a session carries env", () => {
    const servers = hostMcpServers({ linear: { endpoint: "https://mcp.linear.app/mcp" } });
    expect(servers.length).toBeGreaterThan(0);
    for (const s of servers) expect(Array.isArray(s.env)).toBe(true);
  });

  it("emits env: [] for calendly and airtable", () => {
    const servers = hostMcpServers({
      calendly: { endpoint: "https://mcp.calendly.com" },
      airtable: { endpoint: "https://mcp.airtable.com/mcp" },
    });
    expect(servers).toHaveLength(2);
    for (const s of servers) {
      expect(s.env).toEqual([]);
      expect(Object.keys(s).sort()).toEqual(["args", "command", "env", "name"]);
    }
  });
});

describe("a connector with no OAuth token is withheld, not handed to the CLI", () => {
  const store = {
    linear: { endpoint: "https://mcp.linear.app/mcp" },
    notion: { endpoint: "https://mcp.notion.com/mcp" },
  };

  it("keeps the lapsed one out of session/new entirely", () => {
    // Passing it would make the CLI spawn mcp-remote, which starts a full
    // authorization and opens a browser nobody clicked for — every session.
    const names = hostMcpServers(store, { names: [], urls: [] }, {}, {}, new Set(["linear"]))
      .map((s) => s.name);
    expect(names).toEqual(["notion"]);
    expect(hostMcpServers(store).map((s) => s.name).sort()).toEqual(["linear", "notion"]);
  });

  it("reports it as disconnected, with the reason, so the row is not a silent hole", () => {
    const views = connectorViews(store, { lapsed: new Set(["linear"]) });
    const linear = views.find((v) => v.id === "linear");
    const notion = views.find((v) => v.id === "notion");
    expect(linear?.connected).toBe(false);
    expect(linear?.status).toBe("error");
    expect(linear?.error).toBe(CONNECTOR_REAUTH_MESSAGE);
    expect(notion?.connected).toBe(true);
    expect(notion?.status).toBe("idle");
  });

  it("does not shout over a real failure the user just caused", () => {
    // A live connect error is about the thing they just did; the lapse is not.
    const views = connectorViews(store, {
      lapsed: new Set(["linear"]),
      errorId: "linear",
      error: "Sign-in timed out.",
    });
    expect(views.find((v) => v.id === "linear")?.error).toBe("Sign-in timed out.");
    expect(views.find((v) => v.id === "linear")?.connected).toBe(true);
  });

  it("leaves a connector that is not in the store alone", () => {
    const views = connectorViews({}, { lapsed: new Set(["linear"]) });
    expect(views.find((v) => v.id === "linear")?.status).toBe("idle");
    expect(views.find((v) => v.id === "linear")?.connected).toBe(false);
  });
});
