import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MuseBackend } from "../src/muse-backend";

const boundary = vi.hoisted(() => ({
  requests: new Map<string, any[]>(),
  setReasoningEffort: vi.fn(async () => ({})),
  setMode: vi.fn(async () => ({ _meta: { modes: { currentModeId: "yolo" } } })),
  connect: undefined as undefined | ((connection: any) => void),
}));
vi.mock("node:stream", () => ({ Readable: { toWeb: vi.fn() }, Writable: { toWeb: vi.fn() } }));
vi.mock("@agentclientprotocol/sdk", () => ({
  ndJsonStream: vi.fn(),
  agent: () => {
    const app = {
      onConnect(fn: any) { boundary.connect = fn; return app; },
      onRequest(method: string, ...handlers: any[]) { boundary.requests.set(method, handlers); return app; },
      onNotification() { return app; },
      connect() {
        boundary.connect!({ client: {} });
        return { closed: new Promise(() => {}), close: vi.fn() };
      },
    };
    return app;
  },
}));
vi.mock("../adapters/muse/session.mts", async importOriginal => ({
  ...await importOriginal<typeof import("../adapters/muse/session.mts")>(),
  MuseSession: class { setReasoningEffort = boundary.setReasoningEffort; setMode = boundary.setMode; },
}));

beforeAll(async () => {
  // Import the real entry point without attaching process lifecycle handlers.
  const spies = [vi.spyOn(process.stdin, "on").mockReturnThis(),
    vi.spyOn(process.stdout, "on").mockReturnThis(), vi.spyOn(process, "on").mockReturnThis()];
  try { await import("../adapters/muse/main.mts"); }
  finally { for (const spy of spies) spy.mockRestore(); }
});
afterAll(() => vi.restoreAllMocks());

describe("Muse effort ACP registration", () => {
  it("registers the standard Agent/Auto accept mode command and preserves its effective mode", async () => {
    const backend = new MuseBackend();
    const call = backend.setMode("session", "yolo");
    const [handle] = boundary.requests.get(call.method)!;
    const response = await handle({ params: call.params });
    expect(boundary.setMode).toHaveBeenCalledWith("session", "yolo");
    expect(backend.configState(response, { modeId: "agent" }).modeId).toBe("yolo");
  });
  it("registers the backend method and forwards its validated params to the session", async () => {
    const call = new MuseBackend().setReasoningEffort("session", "model", "ultra");
    const registration = boundary.requests.get(call.method);
    expect(registration).toBeDefined();
    const [validate, handle] = registration!;
    await expect(handle({ params: validate(call.params) })).resolves.toEqual({});
    expect(boundary.setReasoningEffort).toHaveBeenCalledWith("session", "ultra");
  });

  it("rejects invalid config keys, sessions and effort values at the ACP boundary", () => {
    const [validate] = boundary.requests.get("session/set_config_option")!;
    for (const params of [null, {}, { sessionId: 7, configId: "reasoning_effort", value: "low" },
      { sessionId: "s", configId: "model", value: "low" },
      { sessionId: "s", configId: "reasoning_effort", value: "invalid" }]) {
      expect(() => validate(params)).toThrow("Invalid Muse reasoning effort selection");
    }
    for (const value of ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]) {
      expect(validate({ sessionId: "s", configId: "reasoning_effort", value })).toEqual({ sessionId: "s", value });
    }
  });
});
