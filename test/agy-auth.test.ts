import { EventEmitter } from "node:events";
import * as path from "node:path";
import * as http from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  AGY_SIGN_IN_METHOD, AGY_SIGN_IN_TIMEOUT_MS, AGY_PASTE_ADDRESS_ERROR, AGY_REDIRECT_TIMEOUT_MS, MAX_AGY_API_KEY_CHARS, agyGatewayAuth, agyGatewayEnv, agyGoogleAuth,
  agyGoogleSignInPresent, agySignInCallback, agySignInUrl, isAgySignInMethod, normalizeAgyApiKey, runAgySignIn,
} from "../src/agy-auth";

import { deviceLoginFailureText } from "../src/device-login";

const home = "/home/me";
const acp = path.join(home, ".gemini", "antigravity-acp");

function probe(files: Record<string, string>, extra: Record<string, unknown> = {}) {
  return { env: {}, home, platform: "linux" as NodeJS.Platform, exists: (file: string) => file in files, ...extra };
}

describe("Antigravity stored Google sign-in", () => {
  const token = { [path.join(acp, "acp_token.json")]: "{}" };

  // The method in the server's settings.json no longer counts: that file is
  // shared with other ACP clients and a key sign-in rewrites it, so every
  // start authenticates with the way chosen here.
  it("is the token, whatever settings.json says", async () => {
    expect(await agyGoogleSignInPresent(probe(token))).toBe(true);
    expect(await agyGoogleSignInPresent(probe({ [path.join(acp, "settings.json")]: JSON.stringify({ auth: { type: "oauth-personal" } }) }))).toBe(false);
  });

  it("asks the macOS keychain only when there is no token file and file storage is not forced", async () => {
    const keychainEntry = vi.fn(async () => true);
    expect(await agyGoogleSignInPresent(probe({}, { platform: "darwin", keychainEntry }))).toBe(true);
    expect(keychainEntry).toHaveBeenCalledTimes(1);
    expect(await agyGoogleSignInPresent(probe({}, { platform: "darwin", keychainEntry, env: { AGY_ACP_FORCE_FILE_STORAGE: "1" } }))).toBe(false);
    expect(await agyGoogleSignInPresent(probe({}, { platform: "win32", keychainEntry }))).toBe(false);
    expect(keychainEntry).toHaveBeenCalledTimes(1);
  });

  it("honours GEMINI_HOME", async () => {
    const custom = path.join("/data", "g", "antigravity-acp");
    expect(await agyGoogleSignInPresent(probe({ [path.join(custom, "acp_token.json")]: "{}" },
      { env: { GEMINI_HOME: path.join("/data", "g") } }))).toBe(true);
  });
});

describe("Antigravity sign-in methods", () => {
  it("authenticates Google as oauth-personal, and a key's server as a gateway at the relay", () => {
    expect(agyGoogleAuth()).toEqual({ methodId: AGY_SIGN_IN_METHOD });
    expect(agyGatewayAuth("http://127.0.0.1:5000/p")).toEqual({ methodId: "gateway", meta: { gateway: { baseUrl: "http://127.0.0.1:5000/p" } } });
  });

  it("turns gateway mode on in the spawn environment and leaves the person's own untouched", () => {
    const own = { PATH: "/bin", GEMINI_API_KEY: "their-own" };
    expect(agyGatewayEnv(own)).toEqual({ PATH: "/bin", GEMINI_API_KEY: "their-own", AGY_ACP_ENABLE_GATEWAY_AUTH: "1" });
    expect(own).not.toHaveProperty("AGY_ACP_ENABLE_GATEWAY_AUTH");
  });

  it("takes a pasted key trimmed, and says plainly why it is not one", () => {
    expect(normalizeAgyApiKey("  AIza-test \n")).toEqual({ key: "AIza-test" });
    expect(normalizeAgyApiKey("   ")).toEqual({ error: "Paste a Gemini API key." });
    expect(normalizeAgyApiKey(undefined)).toEqual({ error: "Paste a Gemini API key." });
    expect(normalizeAgyApiKey("two words")).toEqual({ error: "That does not look like a Gemini API key." });
    expect(normalizeAgyApiKey("k".repeat(MAX_AGY_API_KEY_CHARS + 1))).toEqual({ error: "That does not look like a Gemini API key." });
  });

  it("knows its two methods", () => {
    expect(["google", "api-key", "vertex", undefined].map(isAgySignInMethod)).toEqual([true, true, false, false]);
  });
});

describe("Antigravity sign-in runner", () => {
  it("finds the link the server prints while it waits", () => {
    expect(agySignInUrl("I1014 noise\nOpen the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?x=1&y=2\n"))
      .toBe("https://accounts.google.com/o/oauth2/v2/auth?x=1&y=2");
    expect(agySignInUrl("Open the following link to authenticate the ACP server: http://evil")).toBeUndefined();
  });

  function fakeClient(authenticate: () => Promise<unknown>) {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
      start: vi.fn(async () => {}),
      authenticate: vi.fn(authenticate),
      dispose: vi.fn(async () => {}),
    });
  }

  it("reports the link once, then success, and always stops the server", async () => {
    let resolve!: () => void;
    const client = fakeClient(() => new Promise<void>((r) => { resolve = r; }));
    const onPrompt = vi.fn();
    const onDone = vi.fn();
    runAgySignIn(client, { onPrompt, onDone });
    await vi.waitFor(() => expect(client.authenticate).toHaveBeenCalledWith(AGY_SIGN_IN_METHOD, AGY_SIGN_IN_TIMEOUT_MS));
    client.emit("stderr", "Open the following link to authenticate the ACP");
    client.emit("stderr", " server: https://accounts.google.com/auth?a=1\n");
    client.emit("stderr", "Open the following link to authenticate the ACP server: https://accounts.google.com/auth?a=2\n");
    expect(onPrompt).toHaveBeenCalledTimes(1);
    expect(onPrompt).toHaveBeenCalledWith({ url: "https://accounts.google.com/auth?a=1" });
    resolve();
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith({ ok: true, output: "" }));
    await vi.waitFor(() => expect(client.dispose).toHaveBeenCalled());
  });

  it("reports a refused or timed-out sign-in as failed with the server's reason", async () => {
    const client = fakeClient(async () => { throw { code: -32000, message: "Authentication required", data: { message: "Onboarding failed: x" } }; });
    const onDone = vi.fn();
    runAgySignIn(client, { onPrompt: vi.fn(), onDone });
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith({ ok: false, failure: "failed", output: "Onboarding failed: x" }));
  });

  it("settles a cancel at once and stops the server, ignoring what follows", async () => {
    let reject!: (error: Error) => void;
    const client = fakeClient(() => new Promise((_r, j) => { reject = j; }));
    const onDone = vi.fn();
    const handle = runAgySignIn(client, { onPrompt: vi.fn(), onDone });
    await vi.waitFor(() => expect(client.authenticate).toHaveBeenCalled());
    handle.cancel();
    expect(onDone).toHaveBeenCalledWith({ ok: false, cancelled: true, output: "" });
    expect(client.dispose).toHaveBeenCalled();
    reject(new Error("server exited"));
    await new Promise((r) => setTimeout(r, 10));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  const oauthUrl = (port = 43210) => "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    redirect_uri: `http://127.0.0.1:${port}/`, state: "this-run", code_challenge: "pkce",
  });
  const pasted = "http://127.0.0.1:43210/?state=this-run&code=sentinel-auth-code&scope=email";

  it.each([
    pasted.replace(":43210", ":43211"),
    pasted.replace("127.0.0.1", "example.com"),
    pasted.replace("http:", "https:"),
    pasted.replace("&code=sentinel-auth-code", ""),
    pasted.replace("this-run", "another-run"),
    pasted.replace("state=this-run&", ""),
    pasted + "&state=this-run",
    pasted + "&code=another-code",
    pasted.replace("127.0.0.1", "user:pass@127.0.0.1"),
    "not an address",
  ])("rejects a mismatched paste without ending the run (%s)", async invalid => {
    const client = fakeClient(() => new Promise(() => {}));
    const onDone = vi.fn(), onPrompt = vi.fn(), onInputRejected = vi.fn();
    const requestCallback = vi.fn(async () => {});
    const handle = runAgySignIn(client, { onPrompt, onDone, onInputRejected }, { pasteRedirect: true, requestCallback });
    await vi.waitFor(() => expect(client.authenticate).toHaveBeenCalled());
    client.emit("stderr", `Open the following link to authenticate the ACP server: ${oauthUrl()}\n`);
    expect(onPrompt).toHaveBeenCalledWith({ url: oauthUrl(), needsCode: true });
    expect(handle.submitCode(invalid)).toBe(false);
    expect(onInputRejected.mock.calls).toEqual([[AGY_PASTE_ADDRESS_ERROR]]);
    expect(onDone).not.toHaveBeenCalled();
    expect(requestCallback).not.toHaveBeenCalled();
    expect(handle.submitCode(pasted)).toBe(true);
    expect(requestCallback).toHaveBeenCalledTimes(1);
    handle.cancel();
  });

  it("takes localhost but sends only the path and query to the printed port, exactly once", async () => {
    const client = fakeClient(() => new Promise(() => {}));
    const requestCallback = vi.fn(async (_target: { port: number; path: string }, _signal: AbortSignal) => {});
    const handle = runAgySignIn(client, { onPrompt: vi.fn(), onDone: vi.fn() }, { pasteRedirect: true, requestCallback });
    await vi.waitFor(() => expect(client.authenticate).toHaveBeenCalled());
    client.emit("stderr", `Open the following link to authenticate the ACP server: ${oauthUrl()}\n`);
    const address = pasted.replace("127.0.0.1", "localhost").replace("/?", "/callback?");
    expect(handle.submitCode(address)).toBe(true);
    expect(handle.submitCode(address)).toBe(false);
    expect(requestCallback.mock.calls).toEqual([[{ port: 43210, path: new URL(address).pathname + new URL(address).search }, expect.any(AbortSignal)]]);
    const signal = requestCallback.mock.calls[0][1];
    handle.cancel();
    expect(signal.aborted).toBe(true);
  });

  it("makes one real HTTP request to 127.0.0.1 on the printed port and completes authentication", async () => {
    let authenticate!: () => void;
    const client = fakeClient(() => new Promise<void>(resolve => { authenticate = resolve; }));
    const onDone = vi.fn();
    const requests: string[] = [];
    const server = http.createServer((req, res) => {
      requests.push(req.url!);
      expect(req.headers.host).toBe(`127.0.0.1:${(server.address() as any).port}`);
      res.end("Signed in");
      authenticate();
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const handle = runAgySignIn(client, { onPrompt: vi.fn(), onDone }, { pasteRedirect: true });
    try {
      await vi.waitFor(() => expect(client.authenticate).toHaveBeenCalled());
      const port = (server.address() as any).port;
      client.emit("stderr", `Open the following link to authenticate the ACP server: ${oauthUrl(port)}\n`);
      const address = pasted.replace(":43210", `:${port}`).replace("127.0.0.1", "localhost");
      expect(handle.submitCode(address)).toBe(true);
      expect(handle.submitCode(address)).toBe(false);
      await vi.waitFor(() => expect(onDone.mock.calls).toEqual([[{ ok: true, output: "" }]]));
      expect(requests).toEqual([new URL(address).pathname + new URL(address).search]);
    } finally {
      handle.cancel();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("does not follow a callback response redirect", async () => {
    const redirected = vi.fn((_req, res: http.ServerResponse) => res.end());
    const other = http.createServer(redirected);
    const server = http.createServer((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${(other.address() as any).port}/?code=sentinel-auth-code` });
      res.end();
    });
    for (const listener of [other, server]) await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
    const client = fakeClient(() => new Promise(() => {}));
    const onInputRejected = vi.fn();
    const handle = runAgySignIn(client, { onPrompt: vi.fn(), onDone: vi.fn(), onInputRejected }, { pasteRedirect: true });
    try {
      await vi.waitFor(() => expect(client.authenticate).toHaveBeenCalled());
      const port = (server.address() as any).port;
      client.emit("stderr", `Open the following link to authenticate the ACP server: ${oauthUrl(port)}\n`);
      handle.submitCode(pasted.replace(":43210", `:${port}`));
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(redirected).not.toHaveBeenCalled();
      expect(onInputRejected).not.toHaveBeenCalled();
    } finally {
      handle.cancel();
      for (const listener of [server, other]) await new Promise<void>(resolve => listener.close(() => resolve()));
    }
  });

  it("never echoes callback or server errors containing the pasted code, and allows retry", async () => {
    let reject!: (error: Error) => void;
    const client = fakeClient(() => new Promise((_resolve, fail) => { reject = fail; }));
    const onDone = vi.fn(), onInputRejected = vi.fn();
    const requestCallback = vi.fn(async () => { throw new Error(pasted); });
    const handle = runAgySignIn(client, { onPrompt: vi.fn(), onDone, onInputRejected }, { pasteRedirect: true, requestCallback });
    await vi.waitFor(() => expect(client.authenticate).toHaveBeenCalled());
    client.emit("stderr", `Open the following link to authenticate the ACP server: ${oauthUrl()}\n`);
    handle.submitCode(pasted);
    await vi.waitFor(() => expect(onInputRejected).toHaveBeenCalled());
    expect(JSON.stringify(onInputRejected.mock.calls)).not.toContain("sentinel-auth-code");
    expect(onDone).not.toHaveBeenCalled();
    expect(handle.submitCode(pasted)).toBe(true);
    reject(new Error(pasted));
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith({ ok: false, failure: "failed", output: "" }));
    expect(handle.submitCode(pasted)).toBe(false);
  });

  it("expires after the server's five-minute window and rejects late pastes", async () => {
    vi.useFakeTimers();
    const client = fakeClient(() => new Promise(() => {}));
    const onDone = vi.fn(), requestCallback = vi.fn(async () => {});
    const handle = runAgySignIn(client, { onPrompt: vi.fn(), onDone }, { pasteRedirect: true, requestCallback });
    try {
      await Promise.resolve();
      client.emit("stderr", `Open the following link to authenticate the ACP server: ${oauthUrl()}\n`);
      await vi.advanceTimersByTimeAsync(AGY_REDIRECT_TIMEOUT_MS - 1);
      expect(onDone).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(onDone.mock.calls).toEqual([[{ ok: false, failure: "expired", output: "" }]]);
      expect(client.dispose).toHaveBeenCalled();
      expect(deviceLoginFailureText("agy", "expired", "Antigravity")).toBe("This sign-in expired after five minutes. Start again.");
      expect(handle.submitCode(pasted)).toBe(false);
      expect(requestCallback).not.toHaveBeenCalled();
    } finally { handle.cancel(); vi.useRealTimers(); }
  });

  it("reports a server timeout as expired without returning its error text", async () => {
    const client = fakeClient(async () => { throw new Error(`Onboarding timed out: ${pasted}`); });
    const onDone = vi.fn();
    runAgySignIn(client, { onPrompt: vi.fn(), onDone }, { pasteRedirect: true });
    await vi.waitFor(() => expect(onDone.mock.calls).toEqual([[{ ok: false, failure: "expired", output: "" }]]));
  });

  it("rejects a printed redirect that is not a loopback port", () => {
    for (const redirect_uri of ["http://example.com:43210/", "https://127.0.0.1:43210/", "http://127.0.0.1/"]) {
      const url = new URL(oauthUrl()); url.searchParams.set("redirect_uri", redirect_uri);
      expect(agySignInCallback(pasted, url.href)).toBeUndefined();
    }
  });
});
