// SwitchBot API v1.1 を中継する小さなサーバー（依存パッケージなし / Node 22+）
// トークンとシークレットはサーバー側だけで持ち、ブラウザには渡さない。
import { createServer } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

const TOKEN = process.env.SWITCHBOT_TOKEN;
const SECRET = process.env.SWITCHBOT_SECRET;
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const API = 'https://api.switch-bot.com/v1.1';
// 1 にするとスマートロックの解錠コマンドをサーバー側で拒否する
const UNLOCK_ENABLED = process.env.DISABLE_UNLOCK !== '1';
// 1 にするとダミーデータで動く（トークン不要・実際の家電には一切アクセスしない）
const DEMO = process.env.DEMO === '1';

if (!DEMO && (!TOKEN || !SECRET)) {
  console.error('SWITCHBOT_TOKEN と SWITCHBOT_SECRET を .env に設定してください（.env.example を参照）');
  process.exit(1);
}
if (HOST === '0.0.0.0' || HOST === '::') {
  console.warn('⚠️  HOST が全インターフェースになっています。同じネットワーク上の誰でも家電を操作できます。');
}

function authHeaders() {
  const t = String(Date.now());
  const nonce = randomUUID();
  const sign = createHmac('sha256', SECRET).update(TOKEN + t + nonce).digest('base64');
  return {
    Authorization: TOKEN,
    sign,
    t,
    nonce,
    'Content-Type': 'application/json; charset=utf-8',
  };
}

async function switchbot(path, init = {}) {
  const res = await fetch(API + path, { ...init, headers: authHeaders() });
  const body = await res.json().catch(() => ({}));
  // SwitchBot は HTTP 200 でも statusCode で失敗を返すことがある（100 が成功）
  if (!res.ok || body.statusCode !== 100) {
    const err = new Error(body.message || `HTTP ${res.status}`);
    err.status = res.ok ? 502 : res.status;
    err.detail = body;
    throw err;
  }
  return body.body;
}

const demo = DEMO ? await import('./demo.mjs') : null;
const backend = DEMO ? demo.demoApi : switchbot;

// デバイス一覧は 1 分キャッシュ（API は 1 日 10,000 回まで）
let deviceCache = { at: 0, data: null };
async function getDevices(force) {
  if (!force && deviceCache.data && Date.now() - deviceCache.at < 60_000) return deviceCache.data;
  const data = await backend('/devices');
  deviceCache = { at: Date.now(), data };
  return data;
}

// 赤外線リモコンは状態を取得できないので、最後に送った操作を覚えておく（PC と iPad で共有）
const statePath = join(__dirname, 'state.json');
let lastCommands = {};
if (DEMO) lastCommands = demo.demoLastCommands();
else {
  try { lastCommands = JSON.parse(await readFile(statePath, 'utf8')); } catch { /* 初回は空 */ }
}
function rememberCommand(id, command, parameter) {
  const prev = lastCommands[id] || {};
  // 音量などの操作で電源状態が消えないよう、power と ac（エアコン設定）は引き継ぐ
  let power = prev.power;
  if (command === 'turnOn') power = 'on';
  else if (command === 'turnOff') power = 'off';
  else if (command === 'setAll') power = String(parameter).split(',')[3];
  const ac = command === 'setAll' ? parameter : prev.ac;
  lastCommands[id] = { command, parameter, power, ac, at: Date.now() };
  if (!DEMO) writeFile(statePath, JSON.stringify(lastCommands, null, 2)).catch(e => console.error('state.json 保存失敗', e.message));
  return lastCommands[id];
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw Object.assign(new Error('body too large'), { status: 413 });
  }
  return raw ? JSON.parse(raw) : {};
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const STATIC_FILES = {
  '/favicon.svg': 'image/svg+xml',
  '/apple-touch-icon.png': 'image/png',
  '/icon-192.png': 'image/png',
  '/icon-512.png': 'image/png',
  '/og.png': 'image/png',
  '/manifest.webmanifest': 'application/manifest+json',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean);

  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      // og:image などは絶対 URL が必要なので、アクセスされたホストで埋め込む
      const host = /^[A-Za-z0-9.\-:[\]]+$/.test(req.headers.host || '') ? req.headers.host : `${HOST}:${PORT}`;
      const html = (await readFile(join(__dirname, 'public', 'index.html'), 'utf8')).replaceAll('__ORIGIN__', `http://${host}`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    // 静的ファイルはホワイトリストのものだけ返す
    if (req.method === 'GET' && STATIC_FILES[url.pathname]) {
      const body = await readFile(join(__dirname, 'public', url.pathname.slice(1)));
      res.writeHead(200, { 'Content-Type': STATIC_FILES[url.pathname], 'Cache-Control': 'public, max-age=86400' });
      return res.end(body);
    }

    if (parts[0] !== 'api') return send(res, 404, { error: 'not found' });

    // 他サイトからのリクエストで勝手に家電を動かされないよう、POST は同一オリジンだけ許可
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) return send(res, 403, { error: 'forbidden origin' });
    }

    // GET /api/devices
    if (req.method === 'GET' && parts.length === 2 && parts[1] === 'devices') {
      return send(res, 200, await getDevices(url.searchParams.has('refresh')));
    }

    // GET /api/config  画面に必要な設定
    if (req.method === 'GET' && parts.length === 2 && parts[1] === 'config') {
      return send(res, 200, { unlockEnabled: UNLOCK_ENABLED, demo: DEMO });
    }

    // GET /api/last  最後に送った操作の一覧
    if (req.method === 'GET' && parts.length === 2 && parts[1] === 'last') {
      return send(res, 200, lastCommands);
    }

    // GET /api/devices/:id/status
    if (req.method === 'GET' && parts.length === 4 && parts[1] === 'devices' && parts[3] === 'status') {
      if (!ID_RE.test(parts[2])) return send(res, 400, { error: 'bad id' });
      return send(res, 200, await backend(`/devices/${parts[2]}/status`));
    }

    // POST /api/devices/:id/commands  { command, parameter?, commandType? }
    if (req.method === 'POST' && parts.length === 4 && parts[1] === 'devices' && parts[3] === 'commands') {
      if (!ID_RE.test(parts[2])) return send(res, 400, { error: 'bad id' });
      const { command, parameter = 'default', commandType = 'command' } = await readJson(req);
      if (typeof command !== 'string' || !command) return send(res, 400, { error: 'command is required' });
      if (command === 'unlock' && !UNLOCK_ENABLED) return send(res, 403, { error: '解錠は無効化されています（DISABLE_UNLOCK=1）' });
      await backend(`/devices/${parts[2]}/commands`, {
        method: 'POST',
        body: JSON.stringify({ command, parameter, commandType }),
      });
      console.log(new Date().toISOString(), parts[2], command, parameter);
      return send(res, 200, { last: rememberCommand(parts[2], command, parameter) });
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e.message, e.detail ?? '');
    send(res, e.status || 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`SwitchBot Panel${DEMO ? '（デモモード）' : ''}: http://${HOST}:${PORT}/`);
});
