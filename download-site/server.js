'use strict';
/**
 * Zero-dependency static + installer download HTTP server for Brief.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DOWNLOADS_DIR = path.join(PUBLIC_DIR, 'downloads');
const ASSETS_DIR = path.join(ROOT, 'assets');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.zip': 'application/zip',
  '.exe': 'application/vnd.microsoft.portable-executable'
};

function fileMeta(filename) {
  const full = path.join(DOWNLOADS_DIR, filename);
  if (!fs.existsSync(full)) return { exists: false, size: 0, sha256: '' };
  const st = fs.statSync(full);
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(full, 'r');
  try {
    const buf = Buffer.alloc(65536);
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return { exists: true, size: st.size, sha256: hash.digest('hex'), updatedAt: st.mtime.toISOString() };
}

let cachedReleaseInfo = null;
let cachedReleaseAt = 0;

function getReleaseInfo() {
  const now = Date.now();
  if (!cachedReleaseInfo || now - cachedReleaseAt > 5000) {
    cachedReleaseInfo = {
      name: 'Brief',
      version: '1.0.2',
      platform: 'Windows 10 / 11 (64-bit)',
      installer: Object.assign({ filename: 'Brief-Setup.exe', url: '/download/Brief-Setup.exe' }, fileMeta('Brief-Setup.exe')),
      archive: Object.assign({ filename: 'brief-package.zip', url: '/download/brief-package.zip' }, fileMeta('brief-package.zip'))
    };
    cachedReleaseAt = now;
  }
  return cachedReleaseInfo;
}

function sendDownloadFile(req, res, filename, downloadAs, mimeType) {
  const full = path.join(DOWNLOADS_DIR, filename);
  if (!fs.existsSync(full)) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: filename + ' has not been built yet. Run: node scripts/build-installer.js' }));
    return;
  }
  const st = fs.statSync(full);
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Disposition', 'attachment; filename="' + downloadAs + '"');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-cache');

  const range = req.headers && req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? Math.min(st.size - 1, parseInt(m[2], 10)) : st.size - 1;
      if (start >= 0 && start <= end && end < st.size) {
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${st.size}`,
          'Content-Length': String(end - start + 1)
        });
        fs.createReadStream(full, { start, end }).pipe(res);
        return;
      }
    }
  }
  res.writeHead(200, { 'Content-Length': String(st.size) });
  fs.createReadStream(full).pipe(res);
}

function serveStaticFile(res, baseDir, relPath) {
  const normalized = path.normalize(relPath).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(baseDir, normalized);
  if (!full.startsWith(baseDir) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    return false;
  }
  const ext = path.extname(full).toLowerCase();
  const st = fs.statSync(full);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': String(st.size)
  });
  fs.createReadStream(full).pipe(res);
  return true;
}

function createDownloadServer() {
  return http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/health') {
      const body = JSON.stringify({ ok: true, host: HOST, port: PORT });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    if (urlPath === '/api/release-info') {
      const body = JSON.stringify(getReleaseInfo());
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    if (urlPath === '/download/Brief-Setup.exe') {
      sendDownloadFile(req, res, 'Brief-Setup.exe', 'Brief-Setup.exe', 'application/vnd.microsoft.portable-executable');
      return;
    }
    if (urlPath === '/download/brief-package.zip') {
      sendDownloadFile(req, res, 'brief-package.zip', 'Brief-Portable-Windows.zip', 'application/zip');
      return;
    }
    if (urlPath.startsWith('/assets/')) {
      if (serveStaticFile(res, ASSETS_DIR, urlPath.slice('/assets/'.length))) return;
    }
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    if (serveStaticFile(res, PUBLIC_DIR, rel)) return;
    serveStaticFile(res, PUBLIC_DIR, 'index.html');
  });
}

function startServer(port = PORT, host = HOST) {
  const srv = createDownloadServer();
  srv.listen(port, host, () => {
    console.log('Brief Download Website running at http://' + host + ':' + srv.address().port);
  });
  return srv;
}

if (require.main === module) {
  startServer(PORT);
}

module.exports = { createDownloadServer, startServer, getReleaseInfo };
