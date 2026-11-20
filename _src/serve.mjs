#!/usr/bin/env node
/* 静态服务 + 自动备份接口
   HTTP  8000  （日常使用）
   HTTPS 8443  （语音等需要安全上下文的场景）
   自动把对话快照写到 backups/，浏览器数据被清也能找回。 */
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CERTS = path.join(HERE, '.certs');
const BACKUP = path.join(ROOT, 'backups');
const HTTP_PORT = Number(process.env.PORT || 8000);
const HTTPS_PORT = Number(process.env.TLS_PORT || 8443);
const MAX_BODY = 24 * 1024 * 1024;

function lanIP() {
  const nets = os.networkInterfaces();
  for (const name of ['en0', 'en1']) {
    for (const n of nets[name] || []) if (n.family === 'IPv4' && !n.internal) return n.address;
  }
  for (const list of Object.values(nets)) {
    for (const n of list || []) if (n.family === 'IPv4' && !n.internal) return n.address;
  }
  return '127.0.0.1';
}
const HOST = lanIP();

/* ---------- 证书 ---------- */
function ensureCerts() {
  fs.mkdirSync(CERTS, { recursive: true });
  const caKey = path.join(CERTS, 'ca.key');
  const caCrt = path.join(CERTS, 'ca.crt');
  const srvKey = path.join(CERTS, 'server.key');
  const srvCrt = path.join(CERTS, 'server.crt');
  const run = (a) => execFileSync('openssl', a, { stdio: 'pipe' });

  if (!fs.existsSync(caKey) || !fs.existsSync(caCrt)) {
    run([
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-sha256',
      '-days',
      '3650',
      '-nodes',
      '-keyout',
      caKey,
      '-out',
      caCrt,
      '-subj',
      '/CN=DeepSeek Local CA/O=deepseek-chat'
    ]);
  }
  if (!fs.existsSync(srvKey) || !fs.existsSync(srvCrt)) {
    const csr = path.join(CERTS, 'server.csr');
    run([
      'req',
      '-newkey',
      'rsa:2048',
      '-sha256',
      '-nodes',
      '-keyout',
      srvKey,
      '-out',
      csr,
      '-subj',
      `/CN=${HOST}`
    ]);
    const ext = path.join(CERTS, 'san.cnf');
    fs.writeFileSync(ext, `subjectAltName=IP:${HOST},IP:127.0.0.1,DNS:localhost\n`);
    run([
      'x509',
      '-req',
      '-in',
      csr,
      '-CA',
      caCrt,
      '-CAkey',
      caKey,
      '-CAcreateserial',
      '-out',
      srvCrt,
      '-days',
      '825',
      '-sha256',
      '-extfile',
      ext
    ]);
    fs.unlinkSync(csr);
  }
  return {
    key: fs.readFileSync(srvKey),
    cert: fs.readFileSync(srvCrt),
    ca: fs.readFileSync(caCrt)
  };
}

/* ---------- 备份 ---------- */
const PRIMARY = path.join(ROOT, 'backups');
const AUTO = path.join(PRIMARY, 'auto');

// 多份落盘：项目目录、文稿、iCloud（存在才用），互为冗余
const MIRRORS = [];
if (process.env.DSH_BACKUP_DIRS) {
  process.env.DSH_BACKUP_DIRS.split(':')
    .filter(Boolean)
    .forEach((d) => MIRRORS.push(d));
} else {
  MIRRORS.push(PRIMARY);
  MIRRORS.push(path.join(os.homedir(), 'Documents', 'DeepSeek 对话备份'));
  const ICLOUD = path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  if (fs.existsSync(ICLOUD)) MIRRORS.push(path.join(ICLOUD, 'DeepSeek 对话备份'));
}

for (const d of MIRRORS) {
  try {
    fs.mkdirSync(path.join(d, 'auto'), { recursive: true });
  } catch (e) {}
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** 原子写：临时文件 → fsync → rename，断电也不会留下半个文件 */
function writeAtomic(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, '.' + path.basename(file) + '.tmp');
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function readLatestHash() {
  const f = path.join(PRIMARY, 'latest.json');
  try {
    return sha256(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    return '';
  }
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function parseStamp(name) {
  const m = /^chat-(\d{8})-(\d{6})/.exec(name);
  if (!m) return 0;
  const y = +m[1].slice(0, 4),
    mo = +m[1].slice(4, 6) - 1,
    d = +m[1].slice(6, 8);
  const h = +m[2].slice(0, 2),
    mi = +m[2].slice(2, 4),
    se = +m[2].slice(4, 6);
  return new Date(y, mo, d, h, mi, se).getTime();
}

function listSnapshots(dir = AUTO) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /^chat-\d{8}-\d{6}(-[0-9a-f]{8})?\.json$/.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { name: f, size: st.size, at: parseStamp(f) };
      })
      .sort((a, b) => b.at - a.at);
  } catch (e) {
    return [];
  }
}

/** 保留策略：最近 24 小时全留；更早的每天留最后一份；总数不超过 120 */
function prune(dir) {
  const all = listSnapshots(dir)
    .slice()
    .sort((a, b) => a.at - b.at);
  const now = Date.now();
  const keep = new Set();
  const byDay = new Map();
  for (const s of all) {
    if (now - s.at < 24 * 3600e3) keep.add(s.name);
    else byDay.set(new Date(s.at).toISOString().slice(0, 10), s.name);
  }
  for (const n of byDay.values()) keep.add(n);
  const kept = [...keep].sort();
  while (kept.length > 120) kept.shift();
  const keepSet = new Set(kept);
  for (const s of all) {
    if (!keepSet.has(s.name)) {
      try {
        fs.unlinkSync(path.join(dir, s.name));
      } catch (e) {}
    }
  }
}

function saveBackup(text) {
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.convs)) throw new Error('缺少 convs');

  const hash = sha256(text);
  if (hash === readLatestHash()) {
    return { unchanged: true, hash: hash.slice(0, 8) };
  }

  const name = `chat-${stamp()}-${hash.slice(0, 8)}.json`;
  const written = [];

  for (const dir of MIRRORS) {
    try {
      writeAtomic(path.join(dir, 'auto', name), text);
      writeAtomic(path.join(dir, 'latest.json'), text);
      // 回读校验，确认落盘内容完整
      const back = fs.readFileSync(path.join(dir, 'latest.json'), 'utf8');
      if (sha256(back) !== hash) throw new Error('校验失败');
      prune(path.join(dir, 'auto'));
      written.push(dir);
    } catch (e) {
      console.error('[backup] ' + dir + ' 写入失败: ' + e.message);
    }
  }

  if (!written.length) throw new Error('所有位置都写入失败');
  return { name, size: Buffer.byteLength(text), hash: hash.slice(0, 8), locations: written.length };
}

/* ---------- 静态资源 ---------- */
const ALLOW = new Set([
  '/',
  '/index.html',
  '/icon-180.png',
  '/icon-512.png',
  '/icon-1024.png',
  '/avatar.jpg',
  '/ca.crt',
  '/favicon.ico'
]);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.crt': 'application/x-x509-ca-cert'
};

function handler(req, res, ca) {
  const url = (req.url || '/').split('?')[0];

  // 记录每个请求：地址、协议、来源。独立 App 的 UA 里没有 Safari 标记，便于区分。
  if (url !== '/api/backup') {
    const ua = req.headers['user-agent'] || '';
    const isIOS = /iPhone|iPad|iPod/.test(ua);
    const standalone = isIOS && !/Safari\//.test(ua) ? ' [独立App]' : '';
    console.log(
      `${new Date().toISOString()} ${req.headers.host || ''} ${req.method} ${url}${standalone}`
    );
  }

  if (url === '/api/backup' && req.method === 'POST') {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const info = saveBackup(text);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, ...info, at: new Date().toISOString() }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (url === '/api/backup/latest' && req.method === 'GET') {
    const file = path.join(BACKUP, 'latest.json');
    if (!fs.existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '还没有备份' }));
      return;
    }
    const body = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }

  if (url === '/api/backup/list') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(
      JSON.stringify({
        ok: true,
        locations: MIRRORS.length,
        snapshots: listSnapshots().slice(0, 30)
      })
    );
    return;
  }

  if (url.startsWith('/api/backup/get')) {
    const name = new URL(req.url, 'http://x').searchParams.get('name') || '';
    if (!/^chat-\d{8}-\d{6}(-[0-9a-f]{8})?\.json$/.test(name)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '文件名不合法' }));
      return;
    }
    try {
      const body = fs.readFileSync(path.join(AUTO, name));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '没有这个快照' }));
    }
    return;
  }

  if (url === '/ca.crt') {
    res.writeHead(200, {
      'Content-Type': 'application/x-x509-ca-cert',
      'Content-Disposition': 'attachment; filename="deepseek-local-ca.crt"',
      'Cache-Control': 'no-store'
    });
    res.end(ca);
    return;
  }

  let p = decodeURIComponent(url);
  if (p === '/') p = '/index.html';
  if (!ALLOW.has(p)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  fs.readFile(path.join(ROOT, p), (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(p)] || 'application/octet-stream',
      'Cache-Control': p === '/index.html' ? 'no-store' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(buf);
  });
}

const { key, cert, ca } = ensureCerts();

http
  .createServer((req, res) => handler(req, res, ca))
  .listen(HTTP_PORT, '0.0.0.0', () => {
    console.log('────────────────────────────────────────');
    console.log(` 普通版  http://${HOST}:${HTTP_PORT}`);
    console.log(` 语音版  https://${HOST}:${HTTPS_PORT}`);
    console.log(` 自动备份 → ${MIRRORS.length} 处落盘，最近 24 小时全留、更早的按天留`);
    MIRRORS.forEach((d) => console.log('   · ' + d.replace(os.homedir(), '~')));
    console.log('────────────────────────────────────────');
  });

https
  .createServer({ key, cert }, (req, res) => handler(req, res, ca))
  .listen(HTTPS_PORT, '0.0.0.0');
