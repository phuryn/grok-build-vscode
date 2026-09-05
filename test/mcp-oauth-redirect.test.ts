import { describe, expect, it, vi } from "vitest";
import { completeMcpOAuthCallback, mcpOAuthChallenge, parseMcpOAuthRedirect } from "../src/mcp-oauth-redirect";

const base = "http://127.0.0.1:22227/oauth/callback";
const authorize = `https://vendor.example/authorize?redirect_uri=${encodeURIComponent(base)}&state=attempt-1`;
const challenge = mcpOAuthChallenge(authorize, 22227);
const callback = `${base}?code=a%2Bb%26c&state=attempt-1`;

describe("manual MCP OAuth redirect", () => {
  it("extracts only code and state from the issued callback", () => {
    expect(parseMcpOAuthRedirect(callback + "&next=https://internal.example", challenge))
      .toEqual({ code: "a+b&c", state: "attempt-1" });
  });

  it.each([
    [callback.replace("attempt-1", "other"), /state/],
    [callback.replace("127.0.0.1", "evil.example"), /127\.0\.0\.1/],
    [callback.replace("22227", "22228"), /port 22227/],
    [`${base}?state=attempt-1`, /code/],
    ["not a URL", /complete callback address/],
    ["not-a-url", /not a URL/],
    [callback.replace("/oauth/callback", "/admin"), /path/],
    [callback.replace("http:", "https:"), /http/],
    [callback.replace("127.0.0.1", "2130706433"), /127\.0\.0\.1/],
    [callback.replace("127.0.0.1", "127.1"), /127\.0\.0\.1/],
    [callback.replace("127.0.0.1", "localhost"), /127\.0\.0\.1/],
    [callback.replace("22227", "022227"), /port/],
    [callback.replace("/oauth/callback", "/other/../oauth/callback"), /path/],
    [callback + "&code=second", /one authorization code/],
    [callback + "&state=attempt-1", /state/],
    [callback.replace("a%2Bb%26c", ""), /code/],
    [callback.replace("&state=attempt-1", ""), /state/],
    [callback + "#fragment", /fragment/],
    [callback.replace("127.0.0.1", "user@127.0.0.1"), /login/],
    [callback.replace("/oauth", "\\oauth"), /complete callback address/],
    [callback.replace("a%2Bb%26c", "%ZZ"), /not a URL/],
    [callback.replace("a%2Bb%26c", "%ff"), /not a URL/],
  ])("refuses %s", (url, message) => {
    expect(() => parseMcpOAuthRedirect(url, challenge)).toThrow(message);
  });

  it("accepts localhost only when that is the hostname this attempt issued", () => {
    const local = mcpOAuthChallenge(authorize.replace("127.0.0.1", "localhost"), 22227);
    expect(parseMcpOAuthRedirect(callback.replace("127.0.0.1", "localhost"), local).state).toBe("attempt-1");
  });

  it("requires the printed authorize URL to match the actual listener port", () => {
    expect(() => mcpOAuthChallenge(authorize, 12345)).toThrow(/port 12345/);
    expect(() => mcpOAuthChallenge(authorize.replace("127.0.0.1", "foreign.example"), 22227)).toThrow(/loopback/);
    expect(() => mcpOAuthChallenge(authorize.replace("&state=attempt-1", ""), 22227)).toThrow(/state/);
  });

  it("reconstructs a numeric loopback request with only OAuth parameters and no redirects", async () => {
    const request = vi.fn().mockResolvedValue(new Response("ok"));
    const local = mcpOAuthChallenge(authorize.replace("127.0.0.1", "localhost"), 22227);
    await completeMcpOAuthCallback(local, callback.replace("127.0.0.1", "localhost") + "&next=https://internal.example", request);
    expect(request).toHaveBeenCalledOnce();
    const [url, opts] = request.mock.calls[0];
    expect(url.href).toBe(callback);
    expect(opts).toMatchObject({ redirect: "error", signal: expect.any(AbortSignal) });
  });

  it("does not make any request for a refused URL", async () => {
    const request = vi.fn();
    await expect(completeMcpOAuthCallback(challenge, callback.replace("127.0.0.1", "169.254.169.254"), request)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["network", "timeout", "redirect", "http", "body"])("reports an actionable %s failure without callback secrets", async (failure) => {
    const request = vi.fn();
    if (failure === "http") request.mockResolvedValue(new Response("", { status: 400 }));
    else if (failure === "body") request.mockResolvedValue({ ok: true, body: { cancel: () => Promise.reject(new Error(callback)) } });
    else request.mockRejectedValue(new Error(callback));
    await expect(completeMcpOAuthCallback(challenge, callback, request)).rejects.toThrow("Check that sign-in is still running");
  });
});
