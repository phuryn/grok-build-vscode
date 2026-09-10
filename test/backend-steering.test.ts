import { describe, expect, it, vi } from "vitest";
import { AcpClient, type PromptContentBlock } from "../src/acp";
import type { AcpBackend } from "../src/acp-backend";
import { grokBackend } from "../src/grok-backend";
import { CodexBackend } from "../src/codex-backend";
import { ClaudeBackend } from "../src/claude-backend";

const advertised = { _meta: { steering: { supported: true } } };
const verifiedGrok = { grokVersion: "1.0.5", grokVersionVerified: true };
const content: PromptContentBlock[] = [
  { type: "text", text: "look at [Image #1]" },
  { type: "image", mimeType: "image/png", data: "cGl4ZWxz" },
];
const backends: AcpBackend[] = [grokBackend, new CodexBackend(), new ClaudeBackend()];

describe("backend steering", () => {
  it("preserves Grok's legacy text params and additive image content", () => {
    expect(grokBackend.interject("s", "hello")).toEqual({
      method: "_x.ai/interject", params: { sessionId: "s", text: "hello" },
    });
    expect(grokBackend.interject("s", "look", content)).toEqual({
      method: "_x.ai/interject", params: { sessionId: "s", text: "look", content },
    });
  });

  it("uses Codex's ACP prompt array for text and attachments", () => {
    const backend = new CodexBackend();
    expect(backend.interject("s", "hello")).toEqual({
      method: "_session/steering", params: { sessionId: "s", prompt: [{ type: "text", text: "hello" }] },
    });
    expect(backend.interject("s", "look", content)).toEqual({
      method: "_session/steering", params: { sessionId: "s", prompt: content },
    });
    expect(backend.interject("s", "hello", []).params.prompt).toEqual([{ type: "text", text: "hello" }]);
  });

  it("has no Claude steering method", () => {
    expect(backends[2].interject("s", "hello", content)).toBeNull();
  });

  it.each([undefined, {}, { _meta: {} }, { _meta: { steering: {} } },
    { _meta: { steering: { supported: false } } }, { _meta: { steering: { supported: "true" } } },
  ])("requires Codex's positive advertisement, regardless of version (%j)", (init) => {
    expect(backends[1].steeringCapabilities(init, verifiedGrok)).toEqual({ supported: false, acceptsContent: false });
  });

  it("advertises both Codex text and images without a version probe", () => {
    expect(backends[1].steeringCapabilities(advertised, {})).toEqual({ supported: true, acceptsContent: true });
  });

  it.each([{}, { grokVersion: "1.0.5" }, { grokVersion: "0.2.117", grokVersionVerified: true }])(
    "keeps Grok text optimistic while refusing unverified/legacy images (%j)", (options) => {
      expect(grokBackend.steeringCapabilities(undefined, options)).toEqual({ supported: true, acceptsContent: false });
    },
  );

  it("accepts verified Grok images and ignores advertisements for Claude", () => {
    expect(grokBackend.steeringCapabilities(undefined, verifiedGrok)).toEqual({ supported: true, acceptsContent: true });
    expect(backends[2].steeringCapabilities(advertised, verifiedGrok)).toEqual({ supported: false, acceptsContent: false });
  });
});

describe("connection steering contract", () => {
  function connection(backend: AcpBackend, init: any = advertised, options = verifiedGrok) {
    const client = new AcpClient({ cliPath: "x", cwd: "/", log: () => {}, backend, ...options });
    client.sessionId = "s";
    // Unit seam; the fake-adapter integration test exercises initialize itself.
    (client as any).steering = backend.steeringCapabilities(init, options);
    const request = vi.fn(async (_method: string, _params: any, onAck?: () => void) => { onAck?.(); return {}; });
    (client as any).request = request;
    return { client, request };
  }

  it.each(backends)("routes content support through the %s backend", async (backend) => {
    const { client, request } = connection(backend);
    const capable = backend.provider !== "claude";
    expect(client.honorsInterjectContent()).toBe(capable);
    const onQueued = vi.fn();
    await expect(client.interject("look", onQueued, content)).resolves.toBe(capable ? "ok" : "unsupported");
    expect(request).toHaveBeenCalledTimes(capable ? 1 : 0);
    expect(onQueued).toHaveBeenCalledTimes(capable ? 1 : 0);
    if (capable) {
      const call = backend.interject("s", "look", content)!;
      expect(request).toHaveBeenCalledWith(call.method, call.params, expect.any(Function));
    }
  });

  it("never hands images to a text-only backend, and still allows text afterward", async () => {
    const interject = vi.fn(grokBackend.interject);
    const { client, request } = connection({ ...grokBackend, interject }, undefined, {
      grokVersion: "0.2.117", grokVersionVerified: true,
    });
    await expect(client.interject("look", undefined, content)).resolves.toBe("unsupported");
    expect(interject).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    await expect(client.interject("keep my text")).resolves.toBe("ok");
    expect(interject).toHaveBeenCalledWith("s", "keep my text", undefined);
  });

  it.each([new CodexBackend(), new ClaudeBackend()])("does not probe an unavailable backend (%s)", async (backend) => {
    const { client, request } = connection(backend, {});
    const onQueued = vi.fn();
    await expect(client.interject("keep my text", onQueued)).resolves.toBe("unsupported");
    expect(request).not.toHaveBeenCalled();
    expect(onQueued).not.toHaveBeenCalled();
  });

  it.each(backends.slice(0, 2))("latches method-not-found and returns unsupported (%s)", async (backend) => {
    const { client, request } = connection(backend);
    request.mockRejectedValueOnce({ code: -32601, message: "Method not found" });
    const onQueued = vi.fn();
    await expect(client.interject("first", onQueued)).resolves.toBe("unsupported");
    await expect(client.interject("second", onQueued)).resolves.toBe("unsupported");
    expect(request).toHaveBeenCalledTimes(1);
    expect(onQueued).not.toHaveBeenCalled();
    expect(client.supportsInterject()).toBe(false);
    expect(client.honorsInterjectContent()).toBe(false);
  });

  it("preserves other failures for the caller's queue recovery without latching", async () => {
    const { client, request } = connection(new CodexBackend());
    request.mockRejectedValueOnce(new Error("transport lost"));
    await expect(client.interject("keep my text")).rejects.toThrow("transport lost");
    expect(client.supportsInterject()).toBe(true);
  });
});
