#!/usr/bin/env node
/** Zero-dependency static file server for local development. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent(new URL(req.url, `http://x`).pathname);
    if (urlPath.endsWith('/')) urlPath += 'index.html';
    const file = path.join(ROOT, path.normalize(urlPath).replace(/^([.][.][/\\])+/, ''));
    if (!file.startsWith(ROOT)) throw Object.assign(new Error('forbidden'), { code: 'EACCES' });
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch (err) {
    res.writeHead(err.code === 'ENOENT' ? 404 : 403);
    res.end(err.message);
  }
}).listen(PORT, () => {
  console.log(`serving ${ROOT} → http://localhost:${PORT}`);
});
