#!/usr/bin/env node
/* ローカルNIP-46手順の補助例。ブラウザ操作・合否判定は手動で行う。 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');

const source = path.resolve(process.argv[2] || process.cwd());
const ports = { app: 3321, helper: 3322, relay: 10549 };
const appUrl = `http://127.0.0.1:${ports.app}`;
const helperUrl = `http://127.0.0.1:${ports.helper}`;
const relayUrl = `ws://127.0.0.1:${ports.relay}`;
const expectedContent = 'Local NIP-46 E2E test: signed by nak, localhost only.';
const children = [];
let runDir, webDir, server, observer, secretKey, pairing = '', stopping = false;
const state = { source, appUrl, helperUrl, relayUrl, expectedContent,
  signerMethods: [], receivedNotes: [], errors: [], stopped: false };

function save() {
  if (runDir) fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(state, null, 2), { mode: 0o600 });
}
function start(name, command, args, options = {}) {
  const env = { ...process.env };
  delete env.NOSTR_SECRET_KEY; delete env.NOSTR_CLIENT_KEY;
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], ...options, env: { ...env, ...options.env } });
  children.push(child);
  state[`${name}Pid`] = child.pid;
  child.on('error', error => { state.errors.push(`${name}: ${error.message}`); save(); void stop(1); });
  child.on('exit', (code, signal) => {
    state[`${name}Exit`] = { code, signal }; save();
    if (!stopping && name !== 'install') {
      state.errors.push(`${name} exited before cleanup`); void stop(1);
    }
  });
  return child;
}
function copyApp(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (['node_modules', '.next', '.git', '.vercel', 'coverage'].includes(entry.name) || entry.name.startsWith('.env')) continue;
    if (entry.isSymbolicLink()) throw new Error(`Symlink is not copied: ${path.join(from, entry.name)}`);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyApp(path.join(from, entry.name), dest);
    else if (entry.isFile()) fs.copyFileSync(path.join(from, entry.name), dest);
  }
}
function editOnce(relative, pattern, replacement) {
  const file = path.join(webDir, relative);
  const input = fs.readFileSync(file, 'utf8');
  if ((input.match(pattern) || []).length !== 1) throw new Error(`Expected exactly one test configuration target: ${relative}`);
  fs.writeFileSync(file, input.replace(pattern, replacement));
}
function freePort(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createServer(); socket.once('error', reject);
    socket.listen(port, '127.0.0.1', () => socket.close(resolve));
  });
}
async function waitFor(check, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (stopping) throw new Error('Test setup stopped');
    try { if (await check()) return; } catch { /* 起動中は再確認する。 */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function stop(code = 0) {
  if (stopping) return;
  stopping = true; pairing = ''; secretKey?.fill(0); observer?.close();
  server?.close();
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 1000));
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  state.stopped = true; save();
  console.log(`Stopped. Non-secret results remain in ${runDir || '(setup did not start)'}`);
  process.exit(code);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

async function main() {
  if (!fs.existsSync(path.join(source, 'apps/web/package-lock.json'))) throw new Error('Pass the repository root as the only argument');
  // 実鍵・既存bunker設定は読まない。nakの存在と対応オプションだけ確認する。
  state.nakVersion = execFileSync('nak', ['--version'], { encoding: 'utf8' }).trim();
  execFileSync('nak', ['serve', '--help'], { stdio: 'ignore' });
  execFileSync('nak', ['bunker', '--help'], { stdio: 'ignore' });
  state.nodeVersion = process.version;
  state.sourceCommit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  state.sourceAppStatus = execFileSync('git', ['-C', source, 'status', '--short', '--', 'apps/web'], { encoding: 'utf8' }).trim();
  await Promise.all(Object.values(ports).map(freePort));
  runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostr-nip46-e2e-'));
  webDir = path.join(runDir, 'web');
  copyApp(path.join(source, 'apps/web'), webDir);
  save(); console.log(`Temporary test directory: ${runDir}`);

  // アプリ、署名器の待受リレー、ブラウザの通信許可先をすべてlocalhostにする。
  editOnce('app/lib/constants.ts', /export const BOOTSTRAP_RELAYS = \[[\s\S]*?\];/g,
    `export const BOOTSTRAP_RELAYS = [${JSON.stringify(relayUrl)}];`);
  editOnce('app/lib/nostrLogin.ts', /  prepareRemoteProvider\(host\);/g,
    `  // ローカルE2E専用。一時コピー以外には保存しない。\n` +
    `  (host as NostrWindow & { wnjParams?: unknown }).wnjParams = ${JSON.stringify({
      nostrConnectRelays: [relayUrl], appMetadata: { name: 'Local E2E', image: `${appUrl}/icon.svg`, url: appUrl }
    })};\n  prepareRemoteProvider(host);`);
  const csp = `default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${relayUrl} ws://127.0.0.1:${ports.app}; img-src 'self' data: blob:; font-src 'self' data:; frame-src 'none'; form-action 'self'; base-uri 'self'`;
  // 既存headersがあれば上書きせず停止する。将来の設定変更は手順を再確認する。
  if (/\bheaders\s*(?:\(|:)/.test(fs.readFileSync(path.join(webDir, 'next.config.ts'), 'utf8'))) throw new Error('next.config.ts already defines headers; review the isolation patch first');
  editOnce('next.config.ts', /const nextConfig: NextConfig = \{/g,
    `const nextConfig: NextConfig = {\n  async headers() { return [{ source: '/:path*', headers: [{ key: 'Content-Security-Policy', value: ${JSON.stringify(csp)} }] }]; },`);
  fs.writeFileSync(path.join(webDir, 'public/e2e-cleanup.html'), `<!doctype html><meta charset="utf-8"><title>Local E2E cleanup</title><button id="cleanup">Clear local test credentials</button><p id="result">Only this test origin will be cleared.</p><script>document.getElementById('cleanup').onclick=async()=>{Object.keys(localStorage).filter(k=>k.startsWith('wnj:')||k.startsWith('nostr-relay:')).forEach(k=>localStorage.removeItem(k));await navigator.clipboard.writeText('');document.getElementById('result').textContent='Local test credentials and pairing clipboard cleared.';};</script>`);

  const installLog = fs.createWriteStream(path.join(runDir, 'install.log'), { mode: 0o600 });
  const install = start('install', 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', path.join(runDir, 'npm-cache')], { cwd: webDir });
  install.stdin.end(); install.stdout.pipe(installLog); install.stderr.pipe(installLog);
  const installCode = await new Promise(resolve => install.once('exit', resolve));
  if (installCode !== 0) throw new Error('npm ci failed; inspect install.log');
  const { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } = createRequire(path.join(webDir, 'package.json'))('nostr-tools');
  secretKey = generateSecretKey(); state.pubkey = getPublicKey(secretKey);
  const now = Math.floor(Date.now() / 1000);
  const fixtures = [
    { kind: 0, content: JSON.stringify({ name: 'Local E2E Test', display_name: 'Local E2E Test' }), tags: [] },
    { kind: 3, content: '', tags: [['p', state.pubkey]] },
    { kind: 10002, content: '', tags: [['r', relayUrl]] },
    { kind: 1, content: 'Local relay fixture: browser E2E ready', tags: [] }
  ].map(event => finalizeEvent({ ...event, created_at: now }, secretKey));
  const relay = start('relay', 'nak', ['serve', '--hostname', '127.0.0.1', '--port', String(ports.relay)]);
  relay.stdin.end(fixtures.map(event => JSON.stringify(event)).join('\n') + '\n');
  relay.stdout.resume(); relay.stderr.resume();
  await waitFor(async () => (await fetch(`http://127.0.0.1:${ports.relay}`, { headers: { Accept: 'application/nostr+json' } })).ok, 'local relay');

  // 秘密鍵は引数・ファイル・ログに出さない。--persistと--profileは使用しない。
  const signer = start('signer', 'nak', ['bunker', relayUrl], {
    env: { NOSTR_SECRET_KEY: Buffer.from(secretKey).toString('hex') }
  });
  // 追加シナリオは鍵を破棄する前に署名し、テスト用イベントだけ保持する。
  const scenarioFixtures = {
    burst: Array.from({ length: 8 }, (_, index) => finalizeEvent({
      kind: 1, created_at: now + index + 1, tags: [],
      content: `Local stream fixture ${index + 1}: ` + 'Variable-height canvas verification. '.repeat(index * 5 + 1)
    }, secretKey)),
    emptyFollow: [finalizeEvent({ kind: 3, created_at: now + 30, content: '', tags: [] }, secretKey)]
  };
  const scenarioUsed = new Set();
  const scenarioTimers = new Set();
  function sendScenario(name) {
    if (scenarioUsed.has(name)) return false;
    scenarioUsed.add(name);
    scenarioFixtures[name].forEach((event, index) => {
      const timer = setTimeout(() => {
        scenarioTimers.delete(timer);
        if (stopping || observer.readyState !== WebSocket.OPEN) return;
        observer.send(JSON.stringify(['EVENT', event]));
        state.scenarioSent ||= [];
        state.scenarioSent.push({ scenario: name, id: event.id, kind: event.kind }); save();
      }, name === 'burst' ? 5000 + index * 800 : 0);
      scenarioTimers.add(timer);
    });
    return true;
  }
  secretKey.fill(0);
  let signerBuffer = '';
  signer.stdout.resume();
  signer.stderr.on('data', data => {
    signerBuffer += data.toString().replace(/\x1b\[[0-9;]*m/g, '');
    const lines = signerBuffer.split('\n');
    signerBuffer = lines.pop();
    for (const line of lines) {
      // 認可後にnakが更新する一度限りのURLも、常に最新のものを使う。
      const match = line.match(/bunker:\s*(bunker:\/\/[^\s]+)/);
      if (match) pairing = match[1];
      const method = line.match(/"method":\s*"([^"]+)"/);
      if (method) state.signerMethods.push(method[1]);
    }
    save();
  });
  await waitFor(() => Boolean(pairing), 'nak pairing URL');
  observer = new WebSocket(relayUrl);
  observer.onopen = () => observer.send(JSON.stringify(['REQ', 'local-e2e-observe', { kinds: [1], authors: [state.pubkey] }]));
  observer.onmessage = message => {
    try {
      const [type, , event] = JSON.parse(message.data);
      if (type !== 'EVENT' || state.receivedNotes.some(note => note.id === event.id)) return;
      state.receivedNotes.push({ id: event.id, pubkey: event.pubkey, content: event.content, signatureValid: verifyEvent(event) }); save();
    } catch { state.errors.push('Invalid local relay event'); save(); }
  };
  observer.onerror = () => { state.errors.push('Local relay observer error'); save(); };

  const app = start('app', process.execPath, [path.join(webDir, 'node_modules/next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', String(ports.app)], {
    cwd: webDir, env: { NEXT_TELEMETRY_DISABLED: '1' }
  });
  app.stdin.end();
  const appLog = fs.createWriteStream(path.join(runDir, 'app.log'), { mode: 0o600 });
  app.stdout.pipe(appLog); app.stderr.pipe(appLog);
  await waitFor(async () => {
    const response = await fetch(appUrl);
    if (response.headers.get('content-security-policy') !== csp) throw new Error('Isolation CSP missing');
    return response.ok;
  }, 'app with localhost-only CSP', 60000);
  server = http.createServer((request, response) => {
    // localhost以外のHostを拒否し、ペアリング情報にCORSを付与しない。
    if (request.headers.host !== `127.0.0.1:${ports.helper}`) { response.writeHead(403); return response.end(); }
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'none'; base-uri 'none'");
    if (request.url === '/scenario/burst' || request.url === '/scenario/empty-follow') {
      // 他originからフォーム送信されても実行しない。補助ページ内のPOSTだけ許可する。
      if (request.method !== 'POST' || request.headers.origin !== helperUrl) { response.writeHead(403); return response.end(); }
      const name = request.url === '/scenario/burst' ? 'burst' : 'emptyFollow';
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return response.end(sendScenario(name) ? (name === 'burst' ? 'Eight fixtures scheduled: starts in 5 seconds.' : 'Empty follow fixture sent. Reload the app to test connection.') : 'This scenario has already run. Restart for another run.');
    }
    if (request.url === '/status') { response.setHeader('Content-Type', 'application/json'); return response.end(JSON.stringify(state)); }
    if (request.url === '/pairing-value') { response.setHeader('Content-Type', 'text/plain; charset=utf-8'); return response.end(pairing); }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><title>Local NIP-46 E2E</title><h1>Local test signer</h1><p>Relay: ${relayUrl}</p><button id="copy">Copy local test signer URL</button><p id="result"></p><h2>Optional fixture scenarios</h2><p>Each runs once. Burst starts after 5 seconds. Empty follows changes only this disposable account.</p><button id="burst">Schedule eight stream fixtures</button><button id="empty">Replace with empty follows</button><p id="scenario-result"></p><p><a href="${appUrl}">Open app</a> | <a href="/status">Read non-secret result</a> | <a href="${appUrl}/e2e-cleanup.html">Clear test credentials</a></p><script>for(const [id,name] of [['burst','burst'],['empty','empty-follow']])document.getElementById(id).onclick=async()=>{document.getElementById('scenario-result').textContent=await(await fetch('/scenario/'+name,{method:'POST'})).text();};document.getElementById('copy').onclick=async()=>{await navigator.clipboard.writeText(await(await fetch('/pairing-value')).text());document.getElementById('result').textContent='Test pairing URL copied';};</script>`);
  });
  await new Promise((resolve, reject) => {
    // 起動中のポート競合もmainのエラー処理へ戻し、子プロセスを片付ける。
    server.once('error', reject);
    server.listen(ports.helper, '127.0.0.1', () => {
      server.removeListener('error', reject);
      server.on('error', error => { state.errors.push(`helper: ${error.message}`); void stop(1); });
      resolve();
    });
  });
  save();
  console.log(`Ready: ${helperUrl}\nApp: ${appUrl}\nPost exactly: ${expectedContent}\nResult: ${path.join(runDir, 'result.json')}\nAfter browser cleanup, press Ctrl+C here. No private key or pairing URL is printed.`);
}
main().catch(error => { state.errors.push(error.message); console.error(error.message); void stop(1); });
