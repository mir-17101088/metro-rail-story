/**
 * Zero-dependency production server: serves the built story from dist/ and
 * the /api/mapbox-token endpoint. Suitable for a VPS, Docker or any Node host.
 *
 *   npm run build && npm start
 *
 * Environment: PORT (default 8080), HOST (default 0.0.0.0), plus the variables
 * in .env.example. A .env.local / .env file next to package.json is read if
 * present; real environment variables always win.
 */
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { brotliCompress, gzip, constants as zlib } from 'node:zlib';
import { promisify } from 'node:util';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleMapboxToken } from './mapbox-token.mjs';
import { SECURITY_HEADERS } from './security-headers.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = join(ROOT, 'dist');

loadEnvFiles(['.env.local', '.env']);

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('dist/index.html not found. Run "npm run build" first.');
  process.exit(1);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt']);
const cache = new Map(); // path|encoding -> Promise<Buffer>
const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname.endsWith('/api/mapbox-token')) {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(key, value);
        else if (Array.isArray(value)) headers.set(key, value.join(', '));
      }
      const response = await handleMapboxToken(new Request(url, { method: req.method, headers }), process.env);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(req.method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }

    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = normalize(join(DIST, pathname));
    if (!file.startsWith(DIST + sep)) {
      res.writeHead(400).end();
      return;
    }

    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS }).end('Not found');
      return;
    }

    const ext = extname(file).toLowerCase();
    const accept = String(req.headers['accept-encoding'] ?? '');
    const encoding = COMPRESSIBLE.has(ext) ? (/\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : null) : null;
    const body = await readBody(file, encoding);

    const hashedAsset = pathname.includes('/assets/');
    res.writeHead(200, {
      'Content-Type': TYPES[ext] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': hashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
      Vary: 'Accept-Encoding',
      ...(encoding ? { 'Content-Encoding': encoding } : {}),
      ...SECURITY_HEADERS,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

server.listen(PORT, HOST, () => {
  const mode = process.env.MAPBOX_SECRET_TOKEN ? 'temporary tokens' : process.env.MAPBOX_PUBLIC_TOKEN ? 'public token' : 'NO TOKEN CONFIGURED';
  console.log(`MRT story on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT} (map: ${mode})`);
  // Compress everything up front so the first reader never waits on brotli level 11.
  void warmCache(DIST);
});

async function warmCache(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await warmCache(path);
    else if (COMPRESSIBLE.has(extname(path).toLowerCase())) await Promise.all([readBody(path, 'br'), readBody(path, 'gzip')]);
  }
}

function readBody(file, encoding) {
  const key = `${file}|${encoding ?? 'identity'}`;
  if (!cache.has(key)) {
    // Cached as a promise: concurrent first requests share one compression job.
    const job = readFile(file).then((raw) => {
      if (encoding === 'br') return brotli(raw, { params: { [zlib.BROTLI_PARAM_QUALITY]: 11 } });
      if (encoding === 'gzip') return gzipAsync(raw, { level: 9 });
      return raw;
    });
    job.catch(() => cache.delete(key));
    cache.set(key, job);
  }
  return cache.get(key);
}

function loadEnvFiles(names) {
  for (const name of names) {
    const path = join(ROOT, name);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!match || line.trimStart().startsWith('#')) continue;
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) continue;
      process.env[key] = rawValue.replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}
