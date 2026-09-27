// Offline-testable facts used by the page driver. No Playwright/main-process state.
import assert from "node:assert/strict";
import path from "node:path";
import webviewHelpers from "../media/webview-helpers.js";

export function desktopLaunch(root, executablePath, workspace, profile, output, inheritedEnv) {
  const env = { ...inheritedEnv };
  delete env.NODE_ENV;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.GROK_DESKTOP_TEST_ALLOW_MULTIPLE;
  delete env.ACP_SMOKE_RENDER_PROFILE;
  env.ACP_SMOKE_RENDER_OUTPUT = output;
  // Playwright deletes NODE_OPTIONS. Electron's -r is a passive Node preload;
  // the next positional argument remains the real application entry.
  delete env.NODE_OPTIONS;
  return { executablePath, args: ["-r", path.join(root, "scripts/smoke-desktop-trace.cjs"), path.join(root, "out/desktop/main.js"),
    `--workspace=${workspace}`, `--user-data-dir=${profile}`, `--config-json=${path.join(profile, "config.json")}`], env };
}

export function parseTrace(text) {
  // Concurrent append: only a complete final line is evidence; malformed complete
  // records and I/O errors fail the run instead of silently truncating the audit.
  return text.slice(0, text.lastIndexOf("\n") + 1).split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

export function desktopFacts(events) {
  const session = events.findLast(e => e.direction === "host-to-webview" && e.message.type === "session")?.message;
  if (!session) return undefined;
  const client = events.findLast(e => e.direction === "client-state" && e.provider === session.provider && e.message.sessionId === session.sessionId);
  return client && { ...client.message, provider: client.provider, clientId: client.clientId };
}

export function promptCompletion(events, from, clientId, sessionId) {
  const sent = events.slice(from).find(e => e.direction === "send" && e.clientId === clientId
    && e.message.method === "session/prompt" && e.message.params?.sessionId === sessionId);
  const reply = sent && events.slice(events.indexOf(sent) + 1).find(e => e.direction === "receive"
    && e.clientId === clientId && e.message.id === sent.message.id && !e.message.method);
  if (!reply) return false;
  assert(!reply.message.error, `prompt refused/failed: ${JSON.stringify(reply.message.error)}`);
  assert.equal(reply.message.result?.stopReason, "end_turn", "desktop prompt did not complete normally");
  return reply;
}

export function modelRowIndex(rows, model, provider) {
  // Mirrors chat.js and its shipped label helper. Muse contributor versions
  // share one description, so title alone is not an identity.
  const label = webviewHelpers.modelPickerLabel(model) || model.modelId;
  const displayed = label.length > 28 ? label.slice(0, 28) + "…" : label;
  const matches = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.provider === provider
    && row.title === (model.description || model.modelId) && row.name === displayed);
  assert.equal(matches.length, 1, `expected one visible picker row for ${provider}/${model.modelId}, found ${matches.length}`);
  return matches[0].index;
}

export function deliveryChunk(events, from, clientId, sessionId, now = Date.now()) {
  const completed = promptCompletion(events, from, clientId, sessionId);
  if (!completed) return undefined;
  const after = events.indexOf(completed);
  const done = events.slice(from).some(e => e.direction === "host-to-webview" && e.message.type === "runProgress"
    && e.message.update?.done && !e.message.update.failed && !e.message.update.cancelled);
  if (!done) return undefined;
  return events.slice(after + 1).findLast(e => e.direction === "receive" && e.clientId === clientId
    && e.message.params?.sessionId === sessionId && e.message.params.update?.sessionUpdate === "agent_message_chunk"
    && e.message.params.update.content?.text?.trim() && now - Date.parse(e.at) <= 1000);
}
