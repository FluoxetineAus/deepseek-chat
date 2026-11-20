#!/usr/bin/env node
/* 本地 HTTPS 服务（语音功能需要安全上下文）
   第一次运行会自动生成自签 CA 与服务器证书，全部在本机，不外传。 */
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CERTS = path.join(HERE, '.certs');
const PORT = Number(process.env.PORT || 8443);

function ip() {
  const nets = os.networkInterfaces();
  for (const name of ['en0', 'en1']) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) return n.address;
    }
  }
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) return n.address;
    }
  }
  return '127.0.0.1';
}

const HOST = ip();

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: 'pipe', ...opts });
}

function ensureCerts() {
  fs.mkdirSync(CERTS, { recursive: true });
  const caKey = path.join(CERTS, 'ca.key');
  const caCrt = path.join(CERTS, 'ca.crt');
  const srvKey = path.join(CERTS, 'server.key');
  const srvCrt = path.join(CERTS, 'server.crt');

  if (!fs.existsSync(caKey) || !fs.existsSync(caCrt)) {
    console.log('生成自签 CA…');
    sh('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '3650', '-nodes',
      '-keyout', caKey, '-out', caCrt, '-subj', '/CN=DeepSeek Local CA/O=deepseek-chat']);
  }
  if (!fs.existsSync(srvKey) || !fs.existsSync(srvCrt)) {
    console.log('生成服务器证书…');
    const csr = path.join(CERTS, 'server.csr');
    sh('openssl', ['req', '-newkey', 'rsa:2048', '-sha256', '-nodes',
      '-keyout', srvKey, '-out', csr, '-subj', `/CN=${HOST}`]);
    const ext = path.join(CERTS, 'san.cnf');
    fs.writeFileSync(ext, `subjectAltName=IP:${HOST},IP:127.0.0.1,DNS:localhost\n`);
    sh('openssl', ['x509', '-req', '-in', csr, '-CA', caCrt, '-CAkey', caKey,
      '-CAcreateserial', '-out', srvCrt, '-days', '825', '-sha256', '-extfile', ext]);
    fs.unlinkSync(csr);
  }
  return {
    key: fs.readFileSync(srvKey),
    cert: fs.readFileSync(srvCrt),
    ca: fs.readFileSync(caCrt)
  };
}

const { key, cert, ca } = ensureCerts();

const ALLOW = new Set([
  '/', '/index.html', '/icon-180.png', '/icon-512.png', '/icon-1024.png',
  '/avatar.jpg', '/ca.crt', '/favicon.ico'
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.crt': 'application/x-x509-ca-cert'
};

function handler(req, res) {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  if (!ALLOW.has(p)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  if (p === '/ca.crt') {
    res.writeHead(200, {
      'Content-Type': 'application/x-x509-ca-cert',
      'Content-Disposition': 'attachment; filename="deepseek-local-ca.crt"',
      'Cache-Control': 'no-store'
    });
    res.end(ca);
    return;
  }
  const file = path.join(ROOT, p);
  fs.readFile(file, (err, buf) => {
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

https.createServer({ key, cert }, handler).listen(PORT, '0.0.0.0', () => {
  console.log('────────────────────────────────────────');
  console.log(' HTTPS 已启动（语音功能需要它）');
  console.log('   手机打开：https://' + HOST + ':' + PORT);
  console.log('');
  console.log(' 首次会提示证书不受信任。二选一：');
  console.log('  A. 直接点「高级 → 继续访问」，多数功能可用');
  console.log('  B. 安装证书更稳妥：');
  console.log('     1) 手机访问 http://' + HOST + ':8000/ca.crt 下载');
  console.log('     2) 设置 → 通用 → VPN与设备管理 → 安装描述文件');
  console.log('     3) 设置 → 通用 → 关于本机 → 证书信任设置 → 打开它');
  console.log('────────────────────────────────────────');
});

// 顺便在 8080 提供一个 http 版，方便下载证书
http.createServer((req, res) => {
  if ((req.url || '').split('?')[0] === '/ca.crt') {
    res.writeHead(200, {
      'Content-Type': 'application/x-x509-ca-cert',
      'Content-Disposition': 'attachment; filename="deepseek-local-ca.crt"'
    });
    res.end(ca);
    return;
  }
  res.writeHead(302, { Location: 'https://' + HOST + ':' + PORT + (req.url || '/') });
  res.end();
}).listen(8080, '0.0.0.0');
