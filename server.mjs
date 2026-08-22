import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(root, 'public');
const dataDir = join(root, 'data');
const dbPath = join(dataDir, 'meet-countdown.sqlite');
const port = Number(process.env.PORT || 4321);

await mkdir(dataDir, { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    target_at TEXT NOT NULL,
    background_data_url TEXT,
    blur_px INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )
`);

const initialTarget = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
if (!db.prepare('SELECT id FROM settings WHERE id = 1').get()) {
  db.prepare(`
    INSERT INTO settings (id, target_at, background_data_url, blur_px, updated_at)
    VALUES (1, ?, NULL, 0, ?)
  `).run(initialTarget.toISOString(), new Date().toISOString());
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function getSettings() {
  const row = db.prepare(`
    SELECT target_at AS targetAt, background_data_url AS backgroundDataUrl, blur_px AS blurPx, updated_at AS updatedAt
    FROM settings WHERE id = 1
  `).get();
  return {
    ...row,
    serverNow: new Date().toISOString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 12 * 1024 * 1024) {
        reject(new Error('请求体过大，图片请控制在 10 MB 以内。'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(new Error('无法读取设置数据。'));
      }
    });
    req.on('error', reject);
  });
}

function validateSettings(input) {
  const targetAt = new Date(input.targetAt);
  if (Number.isNaN(targetAt.getTime())) throw new Error('请输入有效的见面时间。');

  const blurPx = Number(input.blurPx);
  if (!Number.isInteger(blurPx) || blurPx < 0 || blurPx > 24) {
    throw new Error('背景模糊度需要在 0 到 24 之间。');
  }

  const backgroundDataUrl = input.backgroundDataUrl ?? null;
  if (backgroundDataUrl !== null) {
    if (typeof backgroundDataUrl !== 'string' || !/^data:image\/(jpeg|png|webp|gif);base64,[a-z0-9+/=]+$/i.test(backgroundDataUrl)) {
      throw new Error('背景图片格式不受支持，请选择 JPG、PNG、WEBP 或 GIF。');
    }
    if (backgroundDataUrl.length > 11 * 1024 * 1024) throw new Error('背景图片请控制在 8 MB 以内。');
  }

  return { targetAt: targetAt.toISOString(), blurPx, backgroundDataUrl };
}

async function serveStatic(pathname, res) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = normalize(join(publicDir, requested));
  if (!filePath.startsWith(publicDir + sep) && filePath !== publicDir) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const content = await readFile(filePath);
    const extension = extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': mimeTypes[extension] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(content);
  } catch {
    const fallback = await readFile(join(publicDir, 'index.html'));
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fallback);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, service: 'meet-countdown', serverNow: new Date().toISOString() });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    sendJson(res, 200, getSettings());
    return;
  }

  if (req.method === 'PUT' && url.pathname === '/api/settings') {
    try {
      const settings = validateSettings(await parseBody(req));
      db.prepare(`
        UPDATE settings
        SET target_at = ?, background_data_url = ?, blur_px = ?, updated_at = ?
        WHERE id = 1
      `).run(settings.targetAt, settings.backgroundDataUrl, settings.blurPx, new Date().toISOString());
      sendJson(res, 200, getSettings());
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === 'GET') {
    await serveStatic(url.pathname, res);
    return;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Meet Countdown is running at http://127.0.0.1:${port}`);
});

function close() {
  db.close();
  server.close();
}

process.on('SIGINT', close);
process.on('SIGTERM', close);
