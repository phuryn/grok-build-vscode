/** Host-owned authorization-code flow. mcp-remote owns all subsequent refreshes. */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { mcpAuthRoot, mcpRemoteStoreDir, mcpServerUrlHash } from "./mcp-connector-auth";
import { MCP_INITIALIZE_REQUEST, MCP_REMOTE_AUTHORIZATION_TIMEOUT_MS, MCP_REMOTE_CONNECT_TIMEOUT_MS,
  MCP_REMOTE_STORE_VERSION, type ConnectorDef } from "./mcp-connectors";
import { httpBaseFromRelayUrl } from "./remote-frames";

export interface OAuthSecrets {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
}

export interface OAuthClientInformation extends Record<string, unknown> {
  client_id: string;
  client_secret?: string;
  redirect_uris: string[];
  token_endpoint_auth_method?: string;
}

interface Registration {
  endpoint: string;
  issuer: string;
  client: OAuthClientInformation;
  /** DCR alone must never change the client used with an existing legacy token. */
  active: boolean;
}

interface AuthorizationMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  token_endpoint_auth_methods_supported?: string[];
  code_challenge_methods_supported?: string[];
}

export class McpOAuthError extends Error {}

export function mcpOAuthUrls(relayUrl: string): { origin: string; callback: string; result: string } {
  const origin = new URL(httpBaseFromRelayUrl(relayUrl)).origin;
  return { origin, callback: `${origin}/mcp/oauth/callback`, result: `${origin}/mcp/oauth/result` };
}

export function mcpOAuthRegistrationKey(id: string, relayUrl: string): string {
  return `grok.mcpConnector.${id}.oauth.${createHash("sha256").update(mcpOAuthUrls(relayUrl).origin).digest("hex")}`;
}

export function generateMcpOAuthChallenge(): { state: string; verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { state: randomBytes(32).toString("base64url"), verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validClient(value: unknown, callback: string): value is OAuthClientInformation {
  return isObject(value) && typeof value.client_id === "string" && !!value.client_id
    && (value.client_secret === undefined || typeof value.client_secret === "string")
    && Array.isArray(value.redirect_uris) && value.redirect_uris.includes(callback);
}

async function readRegistration(secrets: OAuthSecrets, id: string, endpoint: string, relayUrl: string): Promise<Registration | undefined> {
  const raw = await secrets.get(mcpOAuthRegistrationKey(id, relayUrl));
  if (!raw) return undefined;
  const value: unknown = JSON.parse(raw);
  if (!isObject(value) || value.endpoint !== endpoint || typeof value.issuer !== "string"
    || !validClient(value.client, mcpOAuthUrls(relayUrl).callback)) return undefined;
  return value as unknown as Registration;
}

/** No registration (or an abandoned migration) means the untouched legacy argv. */
export async function ownedMcpOAuthClient(secrets: OAuthSecrets, id: string, endpoint: string, relayUrl: string): Promise<OAuthClientInformation | undefined> {
  try {
    const registration = await readRegistration(secrets, id, endpoint, relayUrl);
    return registration?.active === true ? registration.client : undefined;
  } catch {
    // Failing open could refresh an owned token with a legacy client ID.
    throw new McpOAuthError("Could not read the connector registration from secure storage.");
  }
}

export function writeOAuthClientInfoFile(client: OAuthClientInformation, tmpRoot = tmpdir()): { path: string; dispose: () => void } {
  // mkdtemp creates a private directory (0700 on POSIX; inherited user temp ACL on Windows).
  const dir = mkdtempSync(join(tmpRoot, "grok-mcp-client-"));
  const path = join(dir, "client-info.json");
  const dispose = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } };
  try { writeFileSync(path, JSON.stringify(client), { encoding: "utf8", mode: 0o600, flag: "wx" }); }
  catch (error) { dispose(); throw error; }
  return { path, dispose };
}

export function mcpOAuthTokenPath(endpoint: string, env = process.env, home = homedir()): string {
  const root = mcpAuthRoot(env, home);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // Create the measured store, then resolve it using the same helper as token-presence checks.
  mkdirSync(join(root, `mcp-remote-${MCP_REMOTE_STORE_VERSION}`), { recursive: true, mode: 0o700 });
  const versionDir = mcpRemoteStoreDir(readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()));
  if (!versionDir) throw new McpOAuthError("Could not find the connector token store.");
  return join(root, versionDir, `${mcpServerUrlHash(endpoint)}_tokens.json`);
}

function replacePrivateFile(path: string, data: string | Buffer): void {
  const temporary = `${path}.${randomBytes(16).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, data, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

export function seedMcpOAuthTokens(path: string, tokens: Record<string, unknown>, now = Date.now()): void {
  if (typeof tokens.access_token !== "string" || !tokens.access_token || typeof tokens.token_type !== "string"
    || typeof tokens.expires_in !== "number" || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) {
    throw new McpOAuthError("The provider did not return a usable access token with an expiry.");
  }
  replacePrivateFile(path, JSON.stringify({ ...tokens, expires_at: now + tokens.expires_in * 1000 }));
}

function secureUrl(value: unknown): string {
  if (typeof value !== "string") throw new McpOAuthError("The provider returned incomplete OAuth metadata.");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new McpOAuthError("The provider returned an invalid OAuth endpoint.");
  }
  return url.href;
}

async function jsonResponse(response: Response, operation: string): Promise<Record<string, unknown>> {
  if (!response.ok) throw new McpOAuthError(`${operation} failed (HTTP ${response.status}). Try connecting again.`);
  const value: unknown = await response.json();
  if (!isObject(value)) throw new McpOAuthError(`${operation} returned an invalid response.`);
  return value;
}

async function discover(endpoint: string, request: typeof fetch): Promise<{ metadata: AuthorizationMetadata; resource: string; scope?: string }> {
  const server = new URL(secureUrl(endpoint));
  const probe = await request(server, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: MCP_INITIALIZE_REQUEST });
  const authenticate = probe.headers.get("www-authenticate") ?? "";
  await probe.body?.cancel();
  const advertised = /\bresource_metadata="([^"]+)"/i.exec(authenticate)?.[1];
  const challengedScope = /\bscope="([^"]+)"/i.exec(authenticate)?.[1];
  const resourceUrls = advertised ? [secureUrl(advertised)] : [...new Set([
    `${server.origin}/.well-known/oauth-protected-resource${server.pathname.replace(/\/$/, "")}`,
    `${server.origin}/.well-known/oauth-protected-resource`,
  ])];
  let resourceMetadata: Record<string, unknown> | undefined;
  for (const url of resourceUrls) {
    const response = await request(url);
    if (response.status === 404) { await response.body?.cancel(); continue; }
    resourceMetadata = await jsonResponse(response, "Resource discovery");
    break;
  }
  if (!resourceMetadata || !Array.isArray(resourceMetadata.authorization_servers) || !resourceMetadata.authorization_servers.length) {
    throw new McpOAuthError("The connector did not advertise an authorization server.");
  }
  const issuer = new URL(secureUrl(resourceMetadata.authorization_servers[0]));
  const path = issuer.pathname.replace(/\/$/, "");
  const metadataUrls = [...new Set([
    `${issuer.origin}/.well-known/oauth-authorization-server${path}`,
    `${issuer.origin}/.well-known/openid-configuration${path}`,
    `${issuer.origin}${path}/.well-known/openid-configuration`,
  ])];
  for (const url of metadataUrls) {
    const response = await request(url);
    if (response.status === 404) { await response.body?.cancel(); continue; }
    const metadata = await jsonResponse(response, "Authorization discovery");
    if (secureUrl(metadata.issuer) !== issuer.href) throw new McpOAuthError("The authorization server issuer does not match its metadata.");
    for (const key of ["authorization_endpoint", "token_endpoint", "registration_endpoint"]) secureUrl(metadata[key]);
    if (Array.isArray(metadata.code_challenge_methods_supported) && !metadata.code_challenge_methods_supported.includes("S256")) {
      throw new McpOAuthError("The provider does not support S256 sign-in.");
    }
    const scopes = resourceMetadata.scopes_supported;
    return { metadata: metadata as unknown as AuthorizationMetadata,
      resource: secureUrl(resourceMetadata.resource ?? endpoint),
      scope: challengedScope ?? (Array.isArray(scopes) && scopes.every((s) => typeof s === "string") ? scopes.join(" ") : undefined) };
  }
  throw new McpOAuthError("The connector's authorization metadata could not be found.");
}

const timeoutError = () => new McpOAuthError("Sign-in timed out. Connect again to get a new link.");

/** Unknown states are expected: polling usually starts before the browser callback. */
export async function pollMcpOAuthResult(opts: {
  relayUrl: string; state: string; fetch?: typeof fetch; timeoutMs?: number; signal?: AbortSignal; pollIntervalMs?: number;
}): Promise<string> {
  const url = new URL(mcpOAuthUrls(opts.relayUrl).result);
  url.searchParams.set("state", opts.state);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? MCP_REMOTE_AUTHORIZATION_TIMEOUT_MS);
  const abort = () => controller.abort();
  opts.signal?.addEventListener("abort", abort, { once: true });
  if (opts.signal?.aborted) controller.abort();
  try {
    while (!controller.signal.aborted) {
      // Do not retry failed network requests: an outcome may already have been consumed.
      const response = await (opts.fetch ?? fetch)(url, { signal: controller.signal, headers: { "Cache-Control": "no-store" }, redirect: "error" });
      if (response.status === 204) {
        await delay(opts.pollIntervalMs ?? 250, undefined, { signal: controller.signal });
        continue;
      }
      if (response.status === 400) throw new McpOAuthError("This sign-in expired or was already used. Connect again to get a new link.");
      if (response.status !== 200) throw new McpOAuthError(`Sign-in relay failed (HTTP ${response.status}). Connect again.`);
      const outcome = await jsonResponse(response, "Sign-in relay");
      if (controller.signal.aborted) throw timeoutError();
      if (typeof outcome.error === "string") {
        // Provider descriptions are untrusted and can contain credentials. Never reflect them.
        throw new McpOAuthError(outcome.error === "access_denied" ? "Sign-in was cancelled. Connect again when ready." : "The provider could not authorize this connector. Try connecting again.");
      }
      if (typeof outcome.code !== "string" || !outcome.code) throw new McpOAuthError("The sign-in relay returned an invalid outcome. Connect again.");
      return outcome.code;
    }
    throw timeoutError();
  } catch (error) {
    if (controller.signal.aborted) throw timeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", abort);
  }
}

export async function authorizeMcpConnectorOAuth(opts: {
  connector: ConnectorDef; endpoint: string; relayUrl: string; secrets: OAuthSecrets;
  onAuthorization(url: string): void | Promise<void>;
  fetch?: typeof fetch; env?: NodeJS.ProcessEnv; home?: string;
  timeoutMs?: number; authorizationTimeoutMs?: number; pollIntervalMs?: number;
}): Promise<OAuthClientInformation> {
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? MCP_REMOTE_CONNECT_TIMEOUT_MS);
  const request: typeof fetch = (url, init) => (opts.fetch ?? fetch)(url, { ...init, signal: init?.signal ?? controller.signal, redirect: "error" });
  try {
    const { metadata, resource, scope: discoveredScope } = await discover(opts.endpoint, request);
    const scope = opts.connector.oauthScope?.trim() || discoveredScope;
    const { callback } = mcpOAuthUrls(opts.relayUrl);
    const key = mcpOAuthRegistrationKey(opts.connector.id, opts.relayUrl);
    let registration = await readRegistration(opts.secrets, opts.connector.id, opts.endpoint, opts.relayUrl);
    if (!registration || registration.issuer !== metadata.issuer) {
      const client = await jsonResponse(await request(metadata.registration_endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "AFK Pilot", redirect_uris: [callback], response_types: ["code"],
          grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "none", ...(scope ? { scope } : {}) }),
      }), "Client registration");
      if (!validClient(client, callback)) throw new McpOAuthError("The provider did not accept our sign-in callback.");
      registration = { endpoint: opts.endpoint, issuer: metadata.issuer, client, active: false };
      await opts.secrets.store(key, JSON.stringify(registration));
    }
    const { state, verifier, challenge } = generateMcpOAuthChallenge();
    const authorization = new URL(metadata.authorization_endpoint);
    const params = { response_type: "code", client_id: registration.client.client_id, redirect_uri: callback,
      code_challenge: challenge, code_challenge_method: "S256", state, resource, ...(scope ? { scope } : {}) };
    for (const [name, value] of Object.entries(params)) authorization.searchParams.set(name, value);
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), opts.authorizationTimeoutMs ?? MCP_REMOTE_AUTHORIZATION_TIMEOUT_MS);
    await opts.onAuthorization(authorization.href);
    const code = await pollMcpOAuthResult({ relayUrl: opts.relayUrl, state, fetch: request,
      signal: controller.signal, timeoutMs: opts.authorizationTimeoutMs, pollIntervalMs: opts.pollIntervalMs });
    const body = new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier,
      redirect_uri: callback, resource });
    const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
    const client = registration.client;
    if (client.client_secret) {
      const method = client.token_endpoint_auth_method;
      const supported = metadata.token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
      if (method === "client_secret_post" || ((!method || method === "none") && !supported.includes("client_secret_basic") && supported.includes("client_secret_post"))) {
        body.set("client_id", client.client_id);
        body.set("client_secret", client.client_secret);
      } else {
        const encode = (s: string) => new URLSearchParams({ v: s }).toString().slice(2);
        headers.Authorization = `Basic ${Buffer.from(`${encode(client.client_id)}:${encode(client.client_secret)}`).toString("base64")}`;
      }
    } else body.set("client_id", client.client_id);
    const tokens = await jsonResponse(await request(metadata.token_endpoint, { method: "POST", headers, body }), "Token exchange");
    if (controller.signal.aborted) throw timeoutError();
    const tokenPath = mcpOAuthTokenPath(opts.endpoint, opts.env, opts.home);
    let previous: Buffer | undefined;
    try { previous = readFileSync(tokenPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    seedMcpOAuthTokens(tokenPath, tokens);
    try {
      await opts.secrets.store(key, JSON.stringify({ ...registration, active: true }));
    } catch (error) {
      // A failed SecretStorage write must not leave a legacy spawn refreshing our token.
      if (previous) replacePrivateFile(tokenPath, previous);
      else rmSync(tokenPath, { force: true });
      throw error;
    }
    return client;
  } catch (error) {
    if (controller.signal.aborted) throw timeoutError();
    if (error instanceof McpOAuthError) throw error;
    throw new McpOAuthError("Could not complete connector sign-in. Try connecting again.");
  } finally { clearTimeout(timer); }
}
