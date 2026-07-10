#!/usr/bin/env node

import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const host = '127.0.0.1';
const port = Number(process.env.PORT || 4173);
const testPassword = 'test-only-password-1234567890';
const testToken = 'test-session-token-abcdefghijklmnopqrstuvwxyz';
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function json(response, status, body) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}

async function bodyText(request, maxBytes = 64 * 1024) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBytes) throw new Error('Body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${host}:${port}`);
    if (url.pathname === '/config.json') {
      json(response, 200, {
        api_base: `http://${host}:${port}/api`,
        catalog_url: `http://${host}:${port}/catalog.json`,
        turnstile_site_key: '1x00000000000000000000AA',
      });
      return;
    }
    if (url.pathname === '/api/login' && request.method === 'POST') {
      const payload = JSON.parse(await bodyText(request));
      if (payload.password !== testPassword || !payload.turnstile_token) {
        json(response, 401, { ok: false, message: 'Неверный пароль или проверка безопасности.' });
        return;
      }
      json(response, 200, { ok: true, token: testToken, expires_in: 1800 });
      return;
    }
    if (url.pathname === '/api/upload' && request.method === 'POST') {
      if (request.headers.authorization !== `Bearer ${testToken}`) {
        json(response, 401, { ok: false, message: 'Сессия отсутствует или истекла.' });
        return;
      }
      await bodyText(request, 40 * 1024 * 1024);
      json(response, 201, {
        ok: true,
        pull_request: { number: 999, url: 'https://github.com/AleksandrDruk/btm-library/pull/999' },
      });
      return;
    }

    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(`${root}${path.sep}`) && absolute !== path.join(root, 'index.html')) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const stats = await lstat(absolute);
    if (!stats.isFile()) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': contentTypes[path.extname(absolute)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    });
    createReadStream(absolute).pipe(response);
  } catch {
    response.writeHead(404).end('Not found');
  }
});

server.listen(port, host, () => {
  process.stdout.write(`BTM uploader dev server: http://${host}:${port}\n`);
});
