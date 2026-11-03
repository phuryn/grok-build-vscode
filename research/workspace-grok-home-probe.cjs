// Manual, real-CLI probe. No credentials are read, copied or printed.
// All homes, working directories and explicit leader sockets are throwaways.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ROOT = fs.mkdtempSync(path.resolve('.tmp-grok-home-probe-'));
const BIN = process.env.GROK_BIN || path.join(process.env.USERPROFILE || process.env.HOME || require('node:os').homedir(),
  '.grok', 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok');
const profile = path.join(ROOT, 'profile');
const homeA = path.join(profile, '.grok');
const homeB = path.join(ROOT, 'account-b');
fs.mkdirSync(homeA, { recursive: true });
fs.mkdirSync(homeB, { recursive: true });
const baseEnv = { ...process.env, HOME: profile, USERPROFILE: profile,
  XAI_API_KEY: '', GROK_API_KEY: '', GROK_CODE_XAI_API_KEY: '', CI: '1', NO_COLOR: '1' };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const spawnedLeaderPids = new Set();
function pipes() {
  if (process.platform !== 'win32') return [];
  try { return fs.readdirSync('\\\\.\\pipe\\').filter((name) => /grok-leader/.test(name)); } catch { return []; }
}
function rememberLeaders(file) {
  if (!fs.existsSync(file)) return '';
  const log = fs.readFileSync(file, 'utf8');
  for (const match of log.matchAll(/Spawned leader subprocess pid=(\d+)/g)) spawnedLeaderPids.add(Number(match[1]));
  return log;
}
function run(args, home, ms = 4000, input) {
  return new Promise((resolve) => {
    const child = spawn(BIN, args, { env: { ...baseEnv, GROK_HOME: home }, cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (b) => output += b);
    child.stderr.on('data', (b) => output += b);
    child.on('error', (e) => resolve({ code: null, error: e.code }));
    const timer = setTimeout(() => child.kill(), ms);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, output }); });
    if (input) child.stdin.write(input);
    else child.stdin.end();
  });
}
function safeResult(result) {
  return { code: result.code, error: result.error,
    notSignedIn: /not (?:signed|logged) in|sign.?in required|authentication required|no.*credentials/i.test(result.output || ''),
    refusedNetwork: /connect|network|dns|resolve|fetch|request.*fail|os error/i.test(result.output || '') };
}
async function main() {
  console.log('throwaway root:', ROOT);
  console.log('version:', (await run(['--version'], homeA)).output.trim());
  // The control leader always has an explicit throwaway socket; the second
  // home's implicit leader is compared against it under the simulated profile.
  const socket = path.join(homeA, 'leader.sock');
  const debug = path.join(ROOT, 'leader.log');
  const beforePipes = pipes();
  const leader = spawn(BIN, ['agent', 'leader', '--leader-socket', socket,
    '--no-exit-on-disconnect', '--relay-on-demand', '--no-auto-update', '--debug', '--debug-file', debug],
    { env: { ...baseEnv, GROK_HOME: undefined }, cwd: ROOT, windowsHide: true, stdio: 'ignore' });
  leader.on('error', () => {});
  try {
    await pause(2500);
    const leaderPipes = pipes().filter((p) => !beforePipes.includes(p));
    console.log('default-profile leader pipes:', leaderPipes);
    const infoA = await run(['leader', 'info', '--json', '--leader-socket', socket], homeA);
    // Read-only discovery in a simulated default profile. Do not print CLI
    // payloads: info may include environment/config fields.
    const infoB = await run(['leader', 'info', '--json'], homeB);
    function identity(result) {
      try {
        const data = JSON.parse(result.output);
        return { code: result.code, pid: data.pid, socket: data.socket_path || data.socketPath || data.socket };
      } catch { return { ...safeResult(result), noLeader: /no.*leader|not found|not running/i.test(result.output || ''), diagnostic: (result.output || '').slice(0, 500) }; }
    }
    console.log('explicit throwaway leader:', identity(infoA));
    console.log('other GROK_HOME implicit discovery:', identity(infoB));
    const rpc = [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'home-probe', version: '0' } } },
      { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: ROOT, mcpServers: [] } }].map(JSON.stringify).join('\n') + '\n';
    const controlDebug = path.join(ROOT, 'control.log');
    await run(['agent', '--leader', '--leader-socket', socket, '--debug', '--debug-file', controlDebug, 'stdio'], homeA, 4000, rpc);
    const controlLog = rememberLeaders(controlDebug);
    console.log('same-home control:', { attachedExisting: /Connected to (?:existing )?leader/.test(controlLog), spawned: /Spawned leader subprocess/.test(controlLog) });
    const implicitDebug = path.join(ROOT, 'implicit.log');
    const implicit = await run(['agent', '--leader', '--debug', '--debug-file', implicitDebug, 'stdio'], homeB, 6000, rpc);
    const implicitLog = rememberLeaders(implicitDebug);
    console.log('other home implicit leader agent:', safeResult(implicit));
    console.log('other-home default leader:', { spawnedSeparateLeader: /Spawned leader subprocess/.test(implicitLog),
      ownLock: fs.existsSync(path.join(homeB, 'leader.lock')), pipes: pipes().filter((p) => !beforePipes.includes(p) && !leaderPipes.includes(p)) });
    const plainDebug = path.join(ROOT, 'plain.log');
    await run(['agent', '--debug', '--debug-file', plainDebug, 'stdio'], homeB, 4000, rpc);
    const plainLog = rememberLeaders(plainDebug);
    console.log('plain agent stdio policy:', { usedLeader: /use_leader=true/.test(plainLog), attached: /Connected to (?:existing )?leader/.test(plainLog) });
    const missing = path.join(ROOT, 'missing', 'account');
    console.log('missing folder before:', fs.existsSync(missing));
    const isolatedDebug = path.join(ROOT, 'isolated.log');
    const session = await run(['agent', '--no-leader', '--debug', '--debug-file', isolatedDebug, 'stdio'], missing, 7000, rpc);
    console.log('isolated agent in missing home:', safeResult(session));
    console.log('missing folder after:', fs.existsSync(missing));
    console.log('auth present after empty-home session:', fs.existsSync(path.join(missing, 'auth.json')));
    const login = await run(['login', '--device-auth'], missing, 7000);
    console.log('panel device sign-in command:', safeResult(login));
    console.log('panel terminal sign-in command:', safeResult(await run(['login'], missing, 7000)));
    // Only presence is inspected. Never read or manufacture auth.json.
    console.log('auth present after sign-in attempt:', fs.existsSync(path.join(missing, 'auth.json')));
    console.log('panel sign-out command:', safeResult(await run(['logout'], missing, 5000)));
    console.log('auth present after sign-out:', fs.existsSync(path.join(missing, 'auth.json')));
    // Report only path/connection lines from our own debug log, never complete logs.
    for (const file of [debug, controlDebug, implicitDebug, plainDebug, isolatedDebug]) {
      if (!fs.existsSync(file)) continue;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      console.log(path.basename(file), lines.filter((l) => /leader mode resolved|listening|named pipe|socket path|connect.*leader|leader.*connect|use_leader/i.test(l)).map((l) => l.replaceAll(ROOT, '<throwaway>')).slice(0, 18));
    }
  } finally {
    await run(['leader', 'kill', '--leader-socket', socket], homeA, 3000);
    await run(['leader', 'kill', '--leader-socket', path.join(homeB, 'leader.sock')], homeB, 3000);
    // Windows can hold leader.lock exclusively and leader info/kill can fail
    // discovery. Only kill PIDs our own throwaway client logs say it spawned.
    for (const file of ['control.log', 'implicit.log', 'plain.log']) rememberLeaders(path.join(ROOT, file));
    for (const pid of spawnedLeaderPids) { try { process.kill(pid); } catch {} }
    leader.kill();
  }
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; });
