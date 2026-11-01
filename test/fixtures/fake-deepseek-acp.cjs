// Source-shaped dsh 0.2.1-rc.5 ACP contract. No vendor code or network.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const home = process.env.DSH_HOME;
fs.mkdirSync(home, { recursive: true });
const db = path.join(home, 'fake-sessions.json');
let stored = fs.existsSync(db) ? JSON.parse(fs.readFileSync(db, 'utf8')) : {};
const live = new Set();
const pending = new Map();
const permissions = new Map();
const write = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const update = (sessionId, value) => write({ method: 'session/update', params: { sessionId, update: value } });
const save = () => fs.writeFileSync(db, JSON.stringify(stored));
const model = name => JSON.stringify(['deepseek-official', 'deepseek-v4-' + name]);
const modelOptions = [{ name: 'deepseek-v4-flash', value: model('flash') }, ...(process.env.DEEPSEEK_API_KEY ? [
  { name: 'DeepSeek-V4.1-Flash', value: JSON.stringify(['deepseek-official', 'deepseek-flash']) },
  { name: 'DeepSeek-V4-Pro', value: model('pro') },
] : [])];
const config = s => [
  { id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: s.model, options: [{ group: 'deepseek-official', name: 'DeepSeek', options: modelOptions }] },
  { id: 'reasoning_effort', name: 'Reasoning effort', type: 'select', currentValue: s.effort, options: ['off','low','high','max'].map(value => ({ name: value, value })) },
];
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async line => {
  const m = JSON.parse(line), p = m.params || {};
  if (!m.method) { permissions.get(m.id)?.(m.result); permissions.delete(m.id); return; }
  if (process.env.FAKE_DSH_SINK) fs.appendFileSync(process.env.FAKE_DSH_SINK, JSON.stringify({ method: m.method, params: p }) + '\n');
  const ok = result => { if (m.id !== undefined) write({ id: m.id, result }); };
  const fail = (message, data, code = -32603) => write({ id: m.id, error: { code, message, data } });
  switch (m.method) {
    case 'initialize': return ok({ protocolVersion: 1, agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' }, authMethods: [], agentCapabilities: { promptCapabilities: { image: false }, sessionCapabilities: { list: {}, resume: {}, close: {} }, mcpCapabilities: { http: true } } });
    case 'authenticate': return ok({}); // Deliberately succeeds even with a rejected key.
    case 'session/new': {
      if (!path.isAbsolute(p.cwd) || p.mcpServers.length) return fail('Bad session parameters');
      const sessionId = 'dsh-' + require('node:crypto').randomUUID();
      stored[sessionId] = { cwd: p.cwd, model: model('flash'), effort: 'high' }; live.add(sessionId); save();
      return ok({ sessionId, configOptions: config(stored[sessionId]) });
    }
    case 'session/list': return ok({ sessions: Object.entries(stored).filter(([id,s]) => !live.has(id) && (!p.cwd || p.cwd === s.cwd)).map(([sessionId,s]) => ({ sessionId, cwd: s.cwd })) });
    case 'session/resume':
      if (!stored[p.sessionId]) return fail('Unknown session');
      live.add(p.sessionId); return ok({ configOptions: config(stored[p.sessionId]) }); // No replay, no id.
    case 'session/close': live.delete(p.sessionId); return ok({});
    case 'session/set_config_option': {
      const s = stored[p.sessionId];
      if (p.configId === 'model') s.model = p.value;
      else if (p.configId === 'reasoning_effort') s.effort = p.value;
      else return fail('Unknown config');
      save(); update(p.sessionId, { sessionUpdate: 'config_option_update', configOptions: config(s) }); return ok({ configOptions: config(s) });
    }
    case 'session/cancel': {
      const id = pending.get(p.sessionId); pending.delete(p.sessionId);
      if (id !== undefined) write({ id, result: { stopReason: 'cancelled' } });
      return;
    }
    case 'session/prompt': {
      if (process.env.DEEPSEEK_API_KEY === 'rejected') return fail('Internal error', 'turn failed: AuthenticationError: 401 Invalid API key');
      const text = p.prompt.map(v => v.text || '').join('');
      if (text === 'long') { pending.set(p.sessionId, m.id); return; }
      if (text === 'permission' && !process.argv.includes('sdk-minimal')) {
        const id = 'permission-1';
        const answer = new Promise(resolve => permissions.set(id, resolve));
        write({ id, method: 'session/request_permission', params: { sessionId: p.sessionId, toolCall: { toolCallId: 'tool-1', title: 'write', kind: 'other', rawInput: { file_path: 'probe.txt', content: 'ok' } }, options: [{ kind: 'allow_once', optionId: 'allow-once', name: 'Allow once' }, { kind: 'reject_once', optionId: 'reject-once', name: 'Reject' }] } });
        await answer;
      }
      if (text === 'shell') {
        update(p.sessionId, { sessionUpdate: 'tool_call', toolCallId: 'shell-1', title: 'pwsh', kind: 'other', status: 'in_progress', rawInput: { command: 'echo 42', description: 'Print 42' } });
        update(p.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'shell-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '42' } }] });
      }
      update(p.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } });
      update(p.sessionId, { sessionUpdate: 'usage_update', used: 123, size: 1000000 });
      return ok({ stopReason: 'end_turn' });
    }
    default: return fail('Method not found', undefined, -32601); // Includes session/load, modes, delete, fork.
  }
});
rl.on('close', () => process.exit(0));
