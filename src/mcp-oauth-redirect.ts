/** Only the host-issued challenge can choose a callback destination. */
export interface McpOAuthChallenge {
  url: string;
  hostname: "localhost" | "127.0.0.1";
  port: number;
  state: string;
}

function strictUrl(value: string): URL {
  // WHATWG URL silently repairs whitespace, backslashes, numeric hosts and
  // dot segments. Check the original authority/path too; refuse repairs.
  if (typeof value !== "string" || !value || /[\s\\\x00-\x1f\x7f]/.test(value)) {
    throw new Error("Paste the complete callback address from your browser's address bar.");
  }
  try {
    decodeURI(value); // Reject malformed percent encoding instead of replacing it.
    return new URL(value);
  } catch {
    throw new Error("That is not a URL. Copy the complete failed address from your browser.");
  }
}

function callbackAddress(value: string, hostname: string, port: number): URL {
  const url = strictUrl(value);
  if (url.protocol !== "http:" || url.username || url.password || url.hash) {
    throw new Error("Use the original http callback address, without a login or fragment.");
  }
  const raw = /^http:\/\/([^/?#]+)([^?#]*)/.exec(value);
  if (url.hostname !== hostname || raw?.[1].split(":")[0] !== hostname) {
    throw new Error(`This sign-in expects a callback on ${hostname}. Copy the failed address from this sign-in.`);
  }
  if (raw?.[1] !== `${hostname}:${port}`) {
    throw new Error(`This sign-in expects port ${port}. Copy the address from the current sign-in, not an earlier attempt.`);
  }
  if (raw[2] !== "/oauth/callback") {
    throw new Error("The callback path must be /oauth/callback. Copy the complete failed address.");
  }
  return url;
}

/** Called only with mcp-remote's printed URL and its actual listener port. */
export function mcpOAuthChallenge(url: string, port: number): McpOAuthChallenge {
  const authorize = strictUrl(url);
  if (authorize.protocol !== "https:" || authorize.username || authorize.password
    || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("The connector did not issue a valid sign-in link. Try connecting again.");
  }
  const redirects = authorize.searchParams.getAll("redirect_uri");
  const states = authorize.searchParams.getAll("state");
  if (redirects.length !== 1 || states.length !== 1 || !states[0]) {
    throw new Error("The connector's sign-in link is missing its callback or state. Try connecting again.");
  }
  const hostname = strictUrl(redirects[0]).hostname;
  if (hostname !== "localhost" && hostname !== "127.0.0.1") {
    throw new Error("The connector did not issue a loopback callback. Try connecting again.");
  }
  callbackAddress(redirects[0], hostname, port);
  return { url, hostname, port, state: states[0] };
}

/** Never returns a remote-supplied URL, only the two OAuth parameters. */
export function parseMcpOAuthRedirect(
  value: string,
  challenge: McpOAuthChallenge,
): { code: string; state: string } {
  const url = callbackAddress(value, challenge.hostname, challenge.port);
  const codes = url.searchParams.getAll("code");
  if (codes.length !== 1 || !codes[0].trim()) {
    throw new Error("The callback must contain one authorization code. Approve access, then copy the failed address.");
  }
  const states = url.searchParams.getAll("state");
  if (states.length !== 1 || states[0] !== challenge.state) {
    throw new Error("This callback belongs to a different sign-in (state does not match). Use the current sign-in link.");
  }
  return { code: codes[0], state: states[0] };
}

export async function completeMcpOAuthCallback(
  challenge: McpOAuthChallenge,
  pasted: string,
  request: typeof fetch = fetch,
): Promise<void> {
  const params = parseMcpOAuthRedirect(pasted, challenge);
  // No DNS, pasted origins/paths, or redirects. Only our known listener.
  const callback = new URL(`http://127.0.0.1:${challenge.port}/oauth/callback`);
  callback.search = new URLSearchParams(params).toString();
  try {
    const response = await request(callback, { redirect: "error", signal: AbortSignal.timeout(10_000) });
    await response.body?.cancel();
    if (!response.ok) throw new Error("Callback refused");
  } catch {
    throw new Error("The host could not complete its sign-in callback. Check that sign-in is still running and try again.");
  }
}
