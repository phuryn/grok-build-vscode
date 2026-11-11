/**
 * The Antigravity key relay against an injected upstream: a local HTTP server
 * stands in for Google, and the injected request function records the URL the
 * relay asked for, which must always be Google's own origin.
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AGY_RELAY_UPSTREAM, AgyKeyRelay, type AgyUpstreamRequest } from "../src/agy-key-relay";

const KEY = "AIza-relay-test-key-0123456789";
const SECRET = "s3cr3t-prefix";

interface Seen { url: string; method: string; headers: http.IncomingHttpHeaders; body: string }

let fake: http.Server | undefined;
let relay: AgyKeyRelay | undefined;
afterEach(async () => {
  await relay?.close();
  await new Promise<void>((resolve) => fake ? fake.close(() => resolve()) : resolve());
  fake = undefined;
  relay = undefined;
});

async function setup(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void) {
  const seen: Seen[] = [];
  const targets: URL[] = [];
  fake = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      seen.push({ url: req.url ?? "", method: req.method ?? "", headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => fake!.listen(0, "127.0.0.1", () => resolve()));
  const port = (fake.address() as AddressInfo).port;
  const upstream: AgyUpstreamRequest = (url, options) => {
    targets.push(url);
    return http.request({ host: "127.0.0.1", port, path: url.pathname + url.search, method: options.method, headers: options.headers });
  };
  const lines: string[] = [];
  relay = new AgyKeyRelay({ upstream, secret: SECRET, log: (line) => lines.push(line) });
  return { seen, targets, lines };
}

function send(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request(url, { method: init.method ?? "GET", headers: init.headers }, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(init.body);
  });
}

describe("the Antigravity key relay", () => {
  it("presents the real key in place of the harness's, and forwards only to Google", async () => {
    const { seen, targets } = await setup((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); });
    const lease = await relay!.acquire(KEY);
    expect(lease.baseUrl).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+/${SECRET}/[\\w-]+$`));
    const answer = await send(`${lease.baseUrl}/v1beta/models/gemini-4-argon:streamGenerateContent?alt=sse&key=leaked`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": "dummy_api_key", authorization: "Bearer dummy", "user-agent": "harness" },
      body: '{"contents":[]}',
    });
    expect(answer).toMatchObject({ status: 200, body: '{"ok":true}' });
    expect(targets.map(String)).toEqual([`${AGY_RELAY_UPSTREAM}/v1beta/models/gemini-4-argon:streamGenerateContent?alt=sse`]);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/v1beta/models/gemini-4-argon:streamGenerateContent?alt=sse", body: '{"contents":[]}' });
    expect(seen[0].headers["x-goog-api-key"]).toBe(KEY);
    expect(seen[0].headers.authorization).toBeUndefined();
    expect(seen[0].headers["user-agent"]).toBe("harness");
  });

  it("refuses a request without its prefix, and asks Google nothing", async () => {
    const { seen, targets } = await setup((_req, res) => res.end());
    const lease = await relay!.acquire(KEY);
    const origin = new URL(lease.baseUrl).origin;
    for (const path of ["/v1beta/models", "/wrong/v1beta/models", `/${SECRET}x/v1beta/models`, `/${SECRET}`, `/${SECRET}/unknown/v1beta/models`]) {
      expect((await send(`${origin}${path}`)).status).toBe(403);
    }
    expect(targets).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("keeps a path that looks like another host on Google's origin", async () => {
    const { targets } = await setup((_req, res) => res.end());
    const lease = await relay!.acquire(KEY);
    await send(`${lease.baseUrl}//evil.example/steal`);
    expect(targets).toHaveLength(1);
    expect(targets[0].origin).toBe(AGY_RELAY_UPSTREAM);
  });

  it("streams each event as it arrives, and carries concurrent turns", async () => {
    let releaseSecond!: () => void;
    const secondMayGo = new Promise<void>((resolve) => { releaseSecond = resolve; });
    await setup((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\r\n\r\n");
      void secondMayGo.then(() => res.end("data: second\r\n\r\n"));
    });
    const lease = await relay!.acquire(KEY);
    const firstChunk = await new Promise<string>((resolve, reject) => {
      const req = http.request(`${lease.baseUrl}/v1beta/models/x:streamGenerateContent?alt=sse`, { method: "POST" }, (res) => {
        res.once("data", (d) => resolve(String(d)));
      });
      req.on("error", reject);
      req.end("{}");
    });
    // The upstream has not finished: the relay did not buffer the response.
    expect(firstChunk).toBe("data: first\r\n\r\n");
    const turns = Promise.all([1, 2, 3].map(() => send(`${lease.baseUrl}/v1beta/models/x:streamGenerateContent?alt=sse`, { method: "POST", body: "{}" })));
    releaseSecond();
    expect((await turns).map((turn) => turn.body)).toEqual(Array(3).fill("data: first\r\n\r\ndata: second\r\n\r\n"));
  });

  it("passes Google's own error status and body through", async () => {
    const refusal = '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}';
    await setup((_req, res) => { res.writeHead(400, { "content-type": "application/json" }); res.end(refusal); });
    const lease = await relay!.acquire(KEY);
    expect(await send(`${lease.baseUrl}/v1beta/models/x:streamGenerateContent`, { method: "POST", body: "{}" }))
      .toMatchObject({ status: 400, body: refusal });
  });

  it("answers 502 when Google cannot be reached", async () => {
    const lines: string[] = [];
    relay = new AgyKeyRelay({
      secret: SECRET,
      log: (line) => lines.push(line),
      upstream: (_url, options) => http.request({ host: "127.0.0.1", port: 1, path: "/", method: options.method, headers: options.headers }),
    });
    const lease = await relay.acquire(KEY);
    const answer = await send(`${lease.baseUrl}/v1beta/models`);
    expect(answer.status).toBe(502);
    expect(answer.body).not.toContain(KEY);
    expect(lines.at(-1)).toMatch(/^\[agy-relay\] 502 GET \/v1beta\/models \(ECONNREFUSED\)$/);
  });

  it("logs status, method and path only: never the key, the prefix, a query or a body", async () => {
    const { lines } = await setup((_req, res) => { res.writeHead(200); res.end("secret response text"); });
    const lease = await relay!.acquire(KEY);
    await send(`${lease.baseUrl}/v1beta/models/x:generateContent?key=${KEY}&alt=sse`, { method: "POST", body: "secret prompt text" });
    await send(`${lease.baseUrl.replace(SECRET, "guess")}/v1beta/models`);
    expect(lines).toEqual(["[agy-relay] 200 POST /v1beta/models/x:generateContent level=default", "[agy-relay] 403 GET"]);
    const all = lines.join("\n");
    for (const secret of [KEY, SECRET, "alt=sse", "secret prompt", "secret response"]) expect(all).not.toContain(secret);
    expect(relay!.redact(`baseUrl ${lease.baseUrl}`)).not.toContain(SECRET);
  });

  describe("the model listing", () => {
    const LISTING = '{"models":[{"name":"models/gemini-4-argon","supportedGenerationMethods":["generateContent"],"thinking":true}]}';
    const FRESH = '{"models":[{"name":"models/gemini-5","supportedGenerationMethods":["generateContent"]}]}';
    const PATH = "/v1beta/models?pageSize=1000";

    function store() {
      const saved: { value?: import("../src/agy-key-relay").AgyModelListing } = {};
      return { saved, listings: { get: () => saved.value, set: (next: NonNullable<typeof saved.value>) => { saved.value = next; } } };
    }

    async function setupWith(listings: ReturnType<typeof store>["listings"], handler: Parameters<typeof setup>[0]) {
      const ctx = await setup(handler);
      const upstream: AgyUpstreamRequest = (url, options) => {
        ctx.targets.push(url);
        const port = (fake!.address() as AddressInfo).port;
        return http.request({ host: "127.0.0.1", port, path: url.pathname + url.search, method: options.method, headers: options.headers });
      };
      relay = new AgyKeyRelay({ upstream, secret: SECRET, log: (line) => ctx.lines.push(line), listings });
      ctx.targets.length = 0;
      return ctx;
    }

    const until = async (check: () => boolean) => {
      for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
      expect(check()).toBe(true);
    };

    it("answers a later start at once from the last listing, and refreshes it from Google behind", async () => {
      const { saved, listings } = store();
      let body = LISTING;
      let hold = false;
      const held: Array<() => void> = [];
      const { seen, lines } = await setupWith(listings, (_req, res) => {
        const answer = () => { res.writeHead(200, { "content-type": "application/json" }); res.end(body); };
        if (hold) held.push(answer); else answer();
      });
      const lease = await relay!.acquire(KEY);
      expect(await send(`${lease.baseUrl}${PATH}`)).toMatchObject({ status: 200, body: LISTING });
      expect(saved.value?.body).toBe(LISTING);
      expect(lease.supportsThinking("gemini-4-argon")).toBe(true);
      expect(JSON.stringify(saved.value)).not.toContain(KEY);

      // Google is now slow: the answer must not wait for it.
      hold = true;
      body = FRESH;
      expect(await send(`${lease.baseUrl}${PATH}`)).toMatchObject({ status: 200, body: LISTING });
      expect(lease.supportsThinking("gemini-4-argon")).toBe(true);
      await until(() => held.length === 1);
      expect(seen.at(-1)?.headers["x-goog-api-key"]).toBe(KEY);
      held[0]();
      await until(() => saved.value?.body === FRESH);
      expect(lines).toContain("[agy-relay] 200 GET /v1beta/models (remembered)");
      expect(lines).toContain("[agy-relay] 200 GET /v1beta/models (refresh)");
    });

    it("keeps a listing that lands after the server has given up", async () => {
      const { saved, listings } = store();
      let answer!: () => void;
      await setupWith(listings, (_req, res) => { answer = () => { res.writeHead(200); res.end(LISTING); }; });
      const lease = await relay!.acquire(KEY);
      await new Promise<void>((resolve) => {
        const req = http.request(`${lease.baseUrl}${PATH}`);
        req.on("error", () => resolve());
        req.end();
        void until(() => answer !== undefined).then(() => { req.destroy(); resolve(); });
      });
      // Let the relay see the hang-up before Google answers, as at 08:58:15.
      await new Promise((r) => setTimeout(r, 150));
      answer();
      await until(() => saved.value?.body === LISTING);
    });

    it("never shows one key's listing to another, and remembers only a real listing", async () => {
      const { saved, listings } = store();
      let body = LISTING;
      const { seen } = await setupWith(listings, (_req, res) => { res.writeHead(200); res.end(body); });
      const lease = await relay!.acquire(KEY);
      await send(`${lease.baseUrl}${PATH}`);
      const before = seen.length;
      await relay!.acquire("another-key");
      expect(lease.supportsThinking("gemini-4-argon")).toBe(false);
      body = FRESH;
      expect((await send(`${lease.baseUrl}${PATH}`)).body).toBe(FRESH);
      expect(seen.length).toBe(before + 1);

      saved.value = undefined;
      body = '{"error":"nope"}';
      await send(`${lease.baseUrl}${PATH}`);
      body = "";
      await send(`${lease.baseUrl}${PATH}`);
      expect(saved.value).toBeUndefined();
    });
  });

  it("closes with its last lease, and the newest key wins while it is open", async () => {
    const { seen } = await setup((_req, res) => res.end());
    const first = await relay!.acquire("first-key");
    const second = await relay!.acquire("second-key");
    expect(new URL(second.baseUrl).origin).toBe(new URL(first.baseUrl).origin);
    expect(second.baseUrl).not.toBe(first.baseUrl);
    await send(`${first.baseUrl}/v1beta/models`);
    expect(seen.at(-1)?.headers["x-goog-api-key"]).toBe("second-key");
    first.release();
    first.release();
    expect(relay!.active).toBe(true);
    expect((await send(`${first.baseUrl}/v1beta/models`)).status).toBe(403);
    second.release();
    expect(relay!.active).toBe(false);
    await expect(send(`${first.baseUrl}/v1beta/models`)).rejects.toThrow();
    const again = await relay!.acquire("third-key");
    await send(`${again.baseUrl}/v1beta/models`);
    expect(seen.at(-1)?.headers["x-goog-api-key"]).toBe("third-key");
  });

  describe("thinking levels", () => {
    const MODEL = "gemini-4-carbon";
    const PATH = `/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`;
    const LISTING = JSON.stringify({ models: [
      { name: `models/${MODEL}`, thinking: true },
      { name: "models/gemini-4-argon", thinking: true },
      { name: "models/gemini-3.8-flash", thinking: false },
    ] });
    const BODY = JSON.stringify({ contents: [{ role: "user", parts: [{ text: "secret prompt 🐈" }, { inlineData: { mimeType: "image/png", data: "secret-image" } }] }],
      generationConfig: { temperature: 0.7, thinkingConfig: { thinkingLevel: "minimal", thinkingBudget: 10 } } });

    async function thinkingSetup(handler: Parameters<typeof setup>[0] = (_req, res) => res.end("ok")) {
      const ctx = await setup((req, res, body) => {
        if (req.method === "GET") { res.setHeader("content-type", "application/json"); res.end(LISTING); }
        else handler(req, res, body);
      });
      const lease = await relay!.acquire(KEY, "high");
      await send(`${lease.baseUrl}/v1beta/models`);
      return { ...ctx, lease };
    }

    it("pins two concurrent leases independently, preserves contents/images, and changes the next request", async () => {
      const { seen, lines, lease } = await thinkingSetup();
      const low = await relay!.acquire(KEY, "low");
      await Promise.all([
        send(`${lease.baseUrl}${PATH}`, { method: "POST", body: BODY, headers: { "content-length": String(Buffer.byteLength(BODY)), "content-type": "application/json" } }),
        send(`${low.baseUrl}${PATH}`, { method: "POST", body: BODY, headers: { "transfer-encoding": "chunked" } }),
      ]);
      const posts = seen.filter((r) => r.method === "POST");
      expect(posts.map((r) => JSON.parse(r.body).generationConfig.thinkingConfig.thinkingLevel).sort()).toEqual(["high", "low"]);
      for (const request of posts) {
        expect(JSON.parse(request.body)).toMatchObject({ contents: JSON.parse(BODY).contents, generationConfig: { temperature: 0.7 } });
        expect(Object.keys(JSON.parse(request.body).generationConfig.thinkingConfig)).toEqual(["thinkingLevel"]);
        expect(request.headers["content-length"]).toBe(String(Buffer.byteLength(request.body)));
        expect(request.headers["transfer-encoding"]).toBeUndefined();
      }
      low.setThinkingLevel("medium");
      await send(`${low.baseUrl}${PATH}`, { method: "POST", body: '{"contents":[]}' });
      expect(JSON.parse(seen.at(-1)!.body).generationConfig.thinkingConfig).toEqual({ thinkingLevel: "medium" });
      expect(lease.thinkingLevel).toBe("high");
      expect(lines).toContain(`[agy-relay] 200 POST /v1beta/models/${MODEL}:streamGenerateContent level=high`);
      for (const secret of [KEY, SECRET, "secret prompt", "secret-image", "alt=sse", "temperature"]) expect(lines.join("\n")).not.toContain(secret);
    });

    it("leaves non-thinking/unknown models, other endpoints, malformed JSON and unchosen config alone", async () => {
      const { seen, lease } = await thinkingSetup();
      const plain = '{"contents":[]}';
      for (const path of ["/v1beta/models/gemini-3.8-flash:streamGenerateContent", "/v1beta/models/unknown:generateContent", `/v1beta/models/${MODEL}:countTokens`]) {
        await send(`${lease.baseUrl}${path}`, { method: "POST", body: plain });
        expect(seen.at(-1)?.body).toBe(plain);
      }
      await send(`${lease.baseUrl}${PATH}`, { method: "POST", body: "not JSON" });
      expect(seen.at(-1)?.body).toBe("not JSON");
      const unchosen = await relay!.acquire(KEY);
      await send(`${unchosen.baseUrl}${PATH}`, { method: "POST", body: BODY });
      expect(seen.at(-1)?.body).toBe(BODY);
    });

    it.each([null, [], "invalid", 1])("creates generationConfig when its incoming value is %j", async (generationConfig) => {
      const { seen, lease } = await thinkingSetup();
      await send(`${lease.baseUrl}${PATH}`, { method: "POST", body: JSON.stringify({ contents: [], generationConfig }) });
      expect(JSON.parse(seen.at(-1)!.body)).toEqual({ contents: [], generationConfig: { thinkingConfig: { thinkingLevel: "high" } } });
    });

    it("retries an unsupported tier once without thinkingConfig, remembers only that model/tier across leases", async () => {
      const { seen, lines, lease } = await thinkingSetup((_req, res, body) => {
        const level = JSON.parse(body).generationConfig?.thinkingConfig?.thinkingLevel;
        if (level === "high") { res.writeHead(400); res.end(JSON.stringify({ error: { message: "Thinking level HIGH is not supported for this model." } })); }
        else res.end("accepted");
      });
      expect(await send(`${lease.baseUrl}${PATH}`, { method: "POST", body: BODY })).toMatchObject({ status: 200, body: "accepted" });
      expect(seen.filter((r) => r.method === "POST")).toHaveLength(2);
      const fallback = JSON.parse(seen.at(-1)!.body);
      expect(fallback).toEqual({ contents: JSON.parse(BODY).contents, generationConfig: { temperature: 0.7 } });
      const another = await relay!.acquire(KEY, "high");
      await send(`${another.baseUrl}${PATH}`, { method: "POST", body: BODY });
      expect(seen.filter((r) => r.method === "POST")).toHaveLength(3);
      expect(JSON.parse(seen.at(-1)!.body)).toEqual(fallback);
      lease.setThinkingLevel("low");
      await send(`${lease.baseUrl}${PATH}`, { method: "POST", body: BODY });
      expect(JSON.parse(seen.at(-1)!.body).generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
      // A different model still tries high, then falls back once.
      await send(`${another.baseUrl}/v1beta/models/gemini-4-argon:generateContent`, { method: "POST", body: BODY });
      expect(seen.filter((r) => r.method === "POST")).toHaveLength(6);
      expect(lines).toContain(`[agy-relay] 200 POST /v1beta/models/${MODEL}:streamGenerateContent level=default`);
    });

    it.each([
      [400, "API key not valid."], [400, "Invalid thinking level BOGUS."], [400, "Thinking budget is not supported."],
      [429, "Thinking level HIGH is not supported for this model."], [500, "Thinking level HIGH is not supported for this model."],
    ])("passes through %s %s without a retry", async (status, message) => {
      const error = JSON.stringify({ error: { message } });
      const { seen, lease } = await thinkingSetup((_req, res) => { res.writeHead(status, { "content-type": "application/json", "x-test": "kept" }); res.end(error); });
      expect(await send(`${lease.baseUrl}${PATH}`, { method: "POST", body: BODY })).toMatchObject({ status, body: error, headers: { "x-test": "kept" } });
      expect(seen.filter((r) => r.method === "POST")).toHaveLength(1);
    });

    it("returns a failed fallback without a second retry", async () => {
      const error = JSON.stringify({ error: { message: "Thinking level HIGH is not supported for this model." } });
      const { seen, lease } = await thinkingSetup((_req, res) => { res.writeHead(400); res.end(error); });
      expect(await send(`${lease.baseUrl}${PATH}`, { method: "POST", body: BODY })).toMatchObject({ status: 400, body: error });
      expect(seen.filter((r) => r.method === "POST")).toHaveLength(2);
    });

    it("streams large 400 responses unchanged instead of buffering them for a retry", async () => {
      const error = "x".repeat(100_000);
      const { seen, lease } = await thinkingSetup((_req, res) => { res.writeHead(400); res.write(error.slice(0, 70_000)); res.end(error.slice(70_000)); });
      expect(await send(`${lease.baseUrl}${PATH}`, { method: "POST", body: BODY })).toMatchObject({ status: 400, body: error });
      expect(seen.filter((r) => r.method === "POST")).toHaveLength(1);
    });

    it.each([false, true])("reports an upstream disconnect while inspecting a 400 or retrying (retry=%s)", async (retry) => {
      let attempts = 0;
      const { lease, lines } = await thinkingSetup((_req, res) => {
        attempts += 1;
        if (retry && attempts === 1) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: { message: "Thinking level HIGH is not supported for this model." } }));
        } else if (retry) res.destroy();
        else {
          res.writeHead(400);
          res.write('{"error":');
          setImmediate(() => res.destroy());
        }
      });
      expect(await send(`${lease.baseUrl}${PATH}`, { method: "POST", body: BODY })).toMatchObject({ status: 502 });
      expect(attempts).toBe(retry ? 2 : 1);
      expect(lines.at(-1)).toContain(`level=${retry ? "default" : "high"}`);
      expect(lines.join("\n")).not.toContain("secret prompt");
    });

    it("keeps non-generate request bodies streaming before the upload finishes", async () => {
      const { lease } = await thinkingSetup();
      fake!.removeAllListeners("request");
      let first!: (chunk: string) => void;
      const arrived = new Promise<string>((resolve) => { first = resolve; });
      fake!.on("request", (req, res) => {
        req.once("data", (chunk) => first(String(chunk)));
        req.on("end", () => res.end("ok"));
      });
      const req = http.request(`${lease.baseUrl}/v1beta/models/${MODEL}:countTokens`, { method: "POST" });
      const done = new Promise<void>((resolve, reject) => {
        req.on("response", (res) => { res.resume(); res.on("end", resolve); });
        req.on("error", reject);
      });
      req.write("first");
      expect(await arrived).toBe("first");
      req.end("last");
      await done;
    });

    it.each([false, true])("still streams rewritten turns and cancels Google's stream when the client hangs up (retry=%s)", async (retry) => {
      let closed!: () => void;
      const upstreamClosed = new Promise<void>((resolve) => { closed = resolve; });
      const { lease } = await thinkingSetup((_req, res, body) => {
        if (retry && JSON.parse(body).generationConfig?.thinkingConfig) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: { message: "Thinking level HIGH is not supported for this model." } }));
          return;
        }
        res.on("close", closed);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: first\n\n");
      });
      const first = await new Promise<string>((resolve, reject) => {
        const req = http.request(`${lease.baseUrl}${PATH}`, { method: "POST" }, (res) => {
          res.once("data", (chunk) => { resolve(String(chunk)); res.destroy(); });
        });
        req.on("error", reject);
        req.end(BODY);
      });
      expect(first).toBe("data: first\n\n");
      await upstreamClosed;
    });
  });
});
