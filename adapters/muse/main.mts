import { Readable, Writable } from "node:stream";
import { agent, ndJsonStream } from "@agentclientprotocol/sdk";
import { MuseSession, REASONING_EFFORTS } from "./session.mjs";

const log = (message: string) => { process.stderr.write(`${message}\n`); };
let session: MuseSession;
let shutdown: Promise<void> | undefined;
const stop = (error?: unknown): Promise<void> => {
  if (error) { log(String(error)); process.exitCode = 1; }
  return shutdown ??= Promise.resolve().then(async () => {
    try { await session?.close(); }
    catch (failure) { log(String(failure)); process.exitCode = 1; }
    finally { connection.close(); process.stdin.destroy(); }
  });
};

const app = agent()
  .onConnect(connection => { session = new MuseSession(connection.client, log, error => { void stop(error); }); })
  .onRequest("initialize", async () => {
    let models;
    try { await session.initialize(); models = await session.models(); }
    catch (error) { void stop(error); throw error; }
    return { _meta: { models }, protocolVersion: 1, agentInfo: { name: "muse_adapter", version: "1" },
      agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} }, promptCapabilities: { image: false, embeddedContext: false } } };
  })
  .onRequest("session/new", ({ params }) => session.newSession(params.cwd, params.mcpServers))
  .onRequest("session/load", ({ params }) => session.loadSession(params.sessionId, params.cwd, params.mcpServers))
  .onRequest("session/list", ({ params }) => session.listSessions(params.cwd ?? undefined, params.cursor))
  .onRequest("session/set_mode", ({ params }) => session.setMode(params.sessionId, params.modeId))
  .onRequest("session/set_model", (value: unknown) => {
    const p = value as Record<string, unknown>;
    if (!p || typeof p.sessionId !== "string" || typeof p.modelId !== "string") throw new Error("Invalid model selection");
    return { sessionId: p.sessionId, modelId: p.modelId };
  }, ({ params }) => session.setModel(params.sessionId, params.modelId))
  .onRequest("session/set_config_option", (value: unknown) => {
    const p = value as Record<string, unknown>;
    const effort = REASONING_EFFORTS.find(level => level === p?.value);
    if (!p || typeof p.sessionId !== "string" || p.configId !== "reasoning_effort" || !effort) {
      throw new Error("Invalid Muse reasoning effort selection");
    }
    return { sessionId: p.sessionId, value: effort };
  }, ({ params }) => session.setReasoningEffort(params.sessionId, params.value))
  .onRequest("session/prompt", ({ params }) => session.prompt(params.sessionId, params.prompt))
  .onNotification("session/cancel", async ({ params }) => {
    try { await session.cancel(params.sessionId); } catch (error) { void stop(error); }
  });

const connection = app.connect(ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
));
process.stdin.on("end", () => { void stop(); });
process.stdin.on("error", error => { void stop(error); });
process.stdout.on("error", error => { void stop(error); });
process.on("SIGTERM", () => { void stop(); });
process.on("SIGINT", () => { void stop(); });
void connection.closed.then(() => stop());
