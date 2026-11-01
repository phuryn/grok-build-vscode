#!/usr/bin/env node
// MANUAL ONLY. Never imported by tests. Build first: npm run compile
// node research/deepseek-acp-probe.cjs <managed-install-dir> <empty-scratch-dir> --run
// DEEPSEEK_API_KEY is required for the remaining live checks. At most eight tiny prompts; no retries.
// This probe intentionally exercises full-access shell commands in scratch.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, execFileSync } = require('node:child_process');
const { DeepSeekBackend } = require('../out/deepseek-backend.js');
const { isDeepSeekCredentialError } = require('../out/deepseek-auth.js');

const [runtime, scratch, consent] = process.argv.slice(2);
assert.equal(consent, '--run', 'Explicit --run required; this probe executes the real dsh harness.');
assert.ok(runtime && scratch && path.isAbsolute(runtime) && path.isAbsolute(scratch), 'Supply absolute runtime and empty scratch paths.');
fs.mkdirSync(scratch, { recursive: true });
assert.equal(fs.readdirSync(scratch).length, 0, 'Scratch must be empty (no project .env or instructions).');
const key = process.env.DEEPSEEK_API_KEY || '';
const redacted = text => key ? String(text).split(key).join('[redacted]') : String(text);
const report = (label, value) => console.log(label, redacted(JSON.stringify(value)));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, ms = 15000) {
  const end = Date.now() + ms;
  while (!test()) { if (Date.now() > end) throw new Error('Observation timed out'); await delay(50); }
}
function descendants(root) {
  const rows = process.platform === 'win32'
    ? JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true }))
      .map(v => [v.ProcessId, v.ParentProcessId])
    : execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map(v => v.trim().split(/\s+/).map(Number));
  const pids = new Set([root]);
  for (let before = -1; before !== pids.size;) { before = pids.size; for (const [pid, parent] of rows) if (pids.has(parent)) pids.add(pid); }
  return [...pids];
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } }

function launch(harness, credential) {
  const backend = new DeepSeekBackend({ storageRoot: path.join(scratch, 'state'), harness });
  const spec = backend.spawn({ cliPath: runtime, cwd: scratch, env: { ...process.env, DEEPSEEK_API_KEY: credential } });
  const child = spawn(spec.command, spec.args, { cwd: scratch, env: spec.env, stdio: ['pipe','pipe','pipe'], windowsHide: true });
  const pending = new Map(); let seq = 0; let text = ''; let exited = false;
  const failPending = error => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  const tools = []; let permissionCount = 0;
  const observedPids = new Set();
  const write = value => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
  child.stderr.on('data', value => process.stderr.write(redacted(value)));
  child.once('exit', () => { exited = true; failPending(new Error('dsh exited')); });
  child.once('error', failPending);
  child.stdin.on('error', failPending);
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', line => {
    let msg; try { msg = JSON.parse(line); } catch { report('NON-JSON STDOUT', line); return; }
    if (msg.method === 'session/request_permission') {
      permissionCount++;
      if (!msg.params.options.every(o => ['allow_once','reject_once'].includes(o.kind))) {
        failPending(new Error('Only one-shot approvals expected')); return;
      }
      const allow = msg.params.options.find(o => o.kind === 'allow_once');
      write({ id: msg.id, result: { outcome: allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' } } });
    } else if (msg.method === 'session/update') {
      const u = msg.params.update;
      if (u.sessionUpdate === 'agent_message_chunk') text += u.content.text || '';
      if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') { tools.push(u); report('OBSERVED TOOL', u); }
    } else if (msg.id !== undefined && pending.has(msg.id)) {
      const item = pending.get(msg.id); pending.delete(msg.id); clearTimeout(item.timer);
      if (msg.error) item.reject(Object.assign(new Error(msg.error.message), msg.error)); else item.resolve(msg.result);
    }
  });
  return {
    request(method, params = {}, timeout = 120000) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeout);
        pending.set(id, { resolve, reject, timer }); write({ id, method, params });
      });
    },
    notify(method, params) { write({ method, params }); },
    text: () => text, reset: () => { text = ''; tools.length = 0; }, tools,
    permissions: () => permissionCount,
    snapshotChildren() { for (const pid of descendants(child.pid)) observedPids.add(pid); },
    async stop() {
      let observationError;
      try { for (const pid of descendants(child.pid)) observedPids.add(pid); } catch (error) { observationError = error; }
      const pids = [...observedPids];
      child.stdin.end();
      try { await until(() => exited && pids.every(pid => !alive(pid)), 15000); }
      catch (error) {
        report('SURVIVING PIDS', pids.filter(alive));
        // A failed cleanup check stays a failure even if emergency teardown works.
        if (!exited && child.pid && process.platform === 'win32') {
          try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 }); } catch {}
        }
        if (!exited) child.kill();
        for (const pid of pids) { if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} } }
        throw error;
      }
      finally { rl.close(); failPending(new Error('Probe stopped')); }
      if (observationError) throw observationError;
      report('PASS child-process cleanup', pids);
    },
  };
}
const toolOutput = client => client.tools.flatMap(tool => tool.content || [])
  .filter(item => item.type === 'content' && item.content?.type === 'text')
  .map(item => item.content.text).join('\n');
const initialize = client => client.request('initialize', { protocolVersion: 1, clientInfo: { name: 'afk-dsh-probe', version: '1' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
const newSession = client => client.request('session/new', { cwd: scratch, mcpServers: [] });
const prompt = (client, sessionId, text) => { client.reset(); return client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }); };

function options(config) {
  return (config?.options || []).flatMap(option => Array.isArray(option.options) ? option.options : [option]);
}
async function main() {
  if (!key) return report('SKIP live checks', 'Set DEEPSEEK_API_KEY; handshake and compositions were already measured by the owner.');
  for (const harness of ['default','minimal']) {
    const c = launch(harness, key);
    let id;
    try {
      await initialize(c);
      const session = await newSession(c); id = session.sessionId;
      // Already measured; keep reasoning short to conserve the limited dev key.
      await c.request('session/set_config_option', { sessionId: id, configId: 'reasoning_effort', value: 'off' });
      if (harness === 'default') {
        const before = c.permissions();
        await prompt(c, id, 'Use write to create probe.txt containing only ok. No explanation.');
        assert.equal(fs.readFileSync(path.join(scratch, 'probe.txt'), 'utf8').trim(), 'ok');
        report('Default permission request', c.permissions() > before
          ? 'OBSERVED one-shot request, allowed once'
          : 'UNOBSERVED: write succeeded without requesting permission. Do not infer approval coverage.');
      }
      const marker = '.afk-probe-running-' + harness;
      const long = process.platform === 'win32'
        ? `Set-Content -LiteralPath '${marker}' -Value started; Start-Sleep -Seconds 90`
        : `printf started > '${marker}'; sleep 90`;
      const turn = prompt(c, id, `Run once, no explanation: ${long}`);
      void turn.catch(() => {}); // Marker failure must still reach teardown.
      await until(() => fs.existsSync(path.join(scratch, marker)), 60000);
      c.snapshotChildren();
      c.notify('session/cancel', { sessionId: id });
      assert.equal((await turn).stopReason, 'cancelled');
      await prompt(c, id, 'Run echo 42. No explanation.');
      assert.ok(toolOutput(c).includes('42'), 'A shell command after Stop must work');
      report(`PASS ${harness} Stop and next prompt`, 'Cancelled during a running shell command; next shell call returned 42.');

      const model = session.configOptions.find(v => v.id === 'model');
      const alternative = options(model).find(option => option.value !== model.currentValue);
      assert.ok(alternative, 'A keyed catalog must offer another model');
      const changed = await c.request('session/set_config_option', { sessionId: id, configId: 'model', value: alternative.value });
      assert.equal(changed.configOptions.find(v => v.id === 'model').currentValue, alternative.value);
      report(`PASS ${harness} model switch`, { value: alternative.value, name: alternative.name });
      await c.request('session/close', { sessionId: id });
      if (harness === 'minimal') assert.equal(c.permissions(), 0, 'Minimal must not pretend to offer approvals');
    } finally { await c.stop(); }

    // Deliberately a NEW process, same mode home. Never use list to rediscover
    // a live conversation; retain the id returned by session/new.
    const resumed = launch(harness, key);
    try {
      await initialize(resumed);
      await resumed.request('session/resume', { sessionId: id, cwd: scratch, mcpServers: [] });
      assert.equal(resumed.text(), '', 'Resume must not be mistaken for transcript replay');
      await resumed.request('session/set_config_option', { sessionId: id, configId: 'reasoning_effort', value: 'off' });
      await prompt(resumed, id, 'Reply only 42.');
      assert.match(resumed.text(), /42/);
      await resumed.request('session/close', { sessionId: id });
      report(`PASS ${harness} resume in a fresh process`, id);
    } finally { await resumed.stop(); }
  }
  const rejected = launch('default', 'deliberately-invalid-afk-probe-key');
  try {
    await initialize(rejected); await rejected.request('authenticate', { methodId: 'no-op' });
    const { sessionId } = await newSession(rejected);
    const error = await prompt(rejected, sessionId, 'Reply hello.').then(() => null, e => e);
    assert.ok(error && isDeepSeekCredentialError(error), 'Rejected key must be a DeepSeek credential error');
    report('PASS rejected key', 'authenticate succeeded but the model refused the key; no retry');
  } finally { await rejected.stop(); }
}
main().catch(error => { console.error(redacted(error.stack || error)); process.exitCode = 1; });
