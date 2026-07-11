#!/usr/bin/env node

import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { buildAffiliateCatalogUpdate } from '../lib/affiliate-catalog.js';

const root = process.cwd();
const host = '127.0.0.1';
const port = Number(process.env.PORT || 4173);
const testPassword = 'test-only-password-1234567890';
const testToken = 'test-session-token-abcdefghijklmnopqrstuvwxyz';
let affiliateCatalog = {
  schema_version: 1,
  catalog_version: 3,
  items: [
    {
      id: 'vegas-hero',
      brand: 'Vegas Hero',
      destination_url: 'https://tracking.example.test/vegas-hero?campaign=demo',
      version: 1,
      tags: ['vegas hero', 'demo'],
    },
    {
      id: 'northern-star',
      brand: 'Northern Star',
      destination_url: 'https://affiliate.example.test/click/northern-star?source=btm',
      version: 2,
      tags: ['northern star'],
    },
  ],
};
let affiliateProposals = [
  {
    number: 999,
    title: 'Update affiliate catalog',
    url: 'https://github.com/AleksandrDruk/btm-affiliate-library/pull/999',
    head_sha: '9999999999999999999999999999999999999999',
    checks: {
      'validate-catalog': 'success',
      'code-checks': 'success',
    },
    approved: true,
    publishable: true,
    code: 'ready',
    message: 'Checks пройдены, точный commit одобрен владельцем.',
  },
];
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
    if (url.pathname === '/api/affiliate-catalog' && request.method === 'GET') {
      if (request.headers.authorization !== `Bearer ${testToken}`) {
        json(response, 401, { ok: false, message: 'Сессия отсутствует или истекла.' });
        return;
      }
      json(response, 200, { ok: true, catalog: affiliateCatalog });
      return;
    }
    if (url.pathname === '/api/affiliate-catalog/propose' && request.method === 'POST') {
      if (request.headers.authorization !== `Bearer ${testToken}`) {
        json(response, 401, { ok: false, message: 'Сессия отсутствует или истекла.' });
        return;
      }
      const payload = JSON.parse(await bodyText(request, 128 * 1024));
      if (payload.catalog_version !== affiliateCatalog.catalog_version) {
        json(response, 409, { ok: false, message: 'Каталог изменился. Обновите список.' });
        return;
      }
      buildAffiliateCatalogUpdate(affiliateCatalog, payload.operations);
      json(response, 201, {
        ok: true,
        pull_request: {
          number: 999,
          url: 'https://github.com/AleksandrDruk/btm-affiliate-library/pull/999',
        },
      });
      return;
    }
    if (url.pathname === '/api/affiliate-catalog/proposals' && request.method === 'GET') {
      if (request.headers.authorization !== `Bearer ${testToken}`) {
        json(response, 401, { ok: false, message: 'Сессия отсутствует или истекла.' });
        return;
      }
      json(response, 200, { ok: true, proposals: affiliateProposals });
      return;
    }
    const publishMatch = url.pathname.match(/^\/api\/affiliate-catalog\/proposals\/([1-9][0-9]*)\/publish$/);
    if (publishMatch && request.method === 'POST') {
      if (request.headers.authorization !== `Bearer ${testToken}`) {
        json(response, 401, { ok: false, message: 'Сессия отсутствует или истекла.' });
        return;
      }
      const payload = JSON.parse(await bodyText(request, 16 * 1024));
      const proposalNumber = Number(publishMatch[1]);
      const proposal = affiliateProposals.find((item) => item.number === proposalNumber);
      if (!proposal || payload.head_sha !== proposal.head_sha || !proposal.publishable) {
        json(response, 409, { ok: false, message: 'PR больше не готов к публикации.' });
        return;
      }
      affiliateCatalog = {
        ...affiliateCatalog,
        catalog_version: affiliateCatalog.catalog_version + 1,
      };
      affiliateProposals = affiliateProposals.filter((item) => item.number !== proposalNumber);
      json(response, 200, {
        ok: true,
        published: true,
        pull_request: {
          number: proposal.number,
          url: proposal.url,
          merge_commit_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        catalog: affiliateCatalog,
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
