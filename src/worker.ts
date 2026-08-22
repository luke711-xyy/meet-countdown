import { DurableObject } from 'cloudflare:workers';

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  MEDIA: R2Bucket;
  COUPLE_ROOM: DurableObjectNamespace<CoupleRoom>;
}

type RoomEvent = {
  type: string;
  payload: unknown;
  createdAt: string;
};

const ROOM_PATTERN = /^room_[a-z0-9]{10}$/;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;

function nowIso() {
  return new Date().toISOString();
}

function randomToken(length = 10) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => (byte % 36).toString(36)).join('').slice(0, length);
}

function json(data: unknown, status = 200, headers: HeadersInit = {}) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
  responseHeaders.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), { status, headers: responseHeaders });
}

function cookie(request: Request, name: string) {
  const header = request.headers.get('Cookie') || '';
  const value = header.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return value ? decodeURIComponent(value.slice(name.length + 1)) : null;
}

function sessionId(request: Request) {
  return cookie(request, 'meet_session') || `member_${randomToken(16)}`;
}

function withSession(response: Response, request: Request, memberId: string) {
  if (cookie(request, 'meet_session')) return response;
  const headers = new Headers(response.headers);
  const secure = new URL(request.url).protocol === 'https:' ? ' Secure;' : '';
  headers.append('Set-Cookie', `meet_session=${encodeURIComponent(memberId)}; Path=/; HttpOnly; SameSite=Lax;${secure} Max-Age=31536000`);
  return new Response(response.body, { status: response.status, headers });
}

function requestedRoom(request: Request) {
  const roomId = new URL(request.url).searchParams.get('room');
  if (!roomId || !ROOM_PATTERN.test(roomId)) return null;
  return roomId;
}

async function bodyJson<T>(request: Request): Promise<T> {
  try {
    return await request.json() as T;
  } catch {
    throw new Error('请求数据无法读取。');
  }
}

async function ensureRoom(env: Env, roomId: string) {
  const existing = await env.DB.prepare('SELECT id FROM rooms WHERE id = ?1').bind(roomId).first();
  if (existing) return;
  const timestamp = nowIso();
  const targetAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(`
    INSERT INTO rooms (id, target_at, blur_px, background_key, created_at, updated_at)
    VALUES (?1, ?2, 0, NULL, ?3, ?3)
  `).bind(roomId, targetAt, timestamp).run();
}

async function roomState(env: Env, request: Request, roomId: string, memberId: string) {
  const room = await env.DB.prepare(`
    SELECT id, target_at AS targetAt, blur_px AS blurPx, background_key AS backgroundKey, updated_at AS updatedAt
    FROM rooms WHERE id = ?1
  `).bind(roomId).first<{ id: string; targetAt: string; blurPx: number; backgroundKey: string | null; updatedAt: string }>();
  if (!room) return null;

  const tasksResult = await env.DB.prepare(`
    SELECT id, text, completed, author_id AS authorId, completed_by AS completedBy, created_at AS createdAt, updated_at AS updatedAt
    FROM tasks WHERE room_id = ?1 ORDER BY completed ASC, updated_at DESC
  `).bind(roomId).all();
  const voiceResult = await env.DB.prepare(`
    SELECT id, author_id AS authorId, mime_type AS mimeType, duration_ms AS durationMs, created_at AS createdAt
    FROM voice_notes WHERE room_id = ?1 ORDER BY created_at DESC LIMIT 40
  `).bind(roomId).all();

  return {
    roomId,
    targetAt: room.targetAt,
    blurPx: room.blurPx,
    backgroundUrl: room.backgroundKey ? `/api/background?room=${encodeURIComponent(roomId)}` : null,
    updatedAt: room.updatedAt,
    timeZone: 'Asia/Singapore',
    memberId,
    tasks: (tasksResult.results || []).map((task) => ({
      ...task,
      completed: Boolean(task.completed),
      mine: task.authorId === memberId,
    })),
    voiceNotes: (voiceResult.results || []).map((note) => ({
      ...note,
      url: `/api/voice/${encodeURIComponent(String(note.id))}?room=${encodeURIComponent(roomId)}`,
      mine: note.authorId === memberId,
    })),
  };
}

async function broadcast(env: Env, roomId: string, type: string, payload: unknown) {
  const stub = env.COUPLE_ROOM.getByName(roomId);
  await stub.broadcast({ type, payload, createdAt: nowIso() });
}

async function handleRoom(request: Request, env: Env) {
  const input = await bodyJson<{ roomId?: string }>(request);
  const roomId = input.roomId || `room_${randomToken(10)}`;
  if (!ROOM_PATTERN.test(roomId)) return json({ error: '房间链接无效。' }, 400);
  if (input.roomId) {
    const room = await env.DB.prepare('SELECT id FROM rooms WHERE id = ?1').bind(roomId).first();
    if (!room) return json({ error: '房间不存在。' }, 404);
  } else {
    await ensureRoom(env, roomId);
  }
  const memberId = sessionId(request);
  return withSession(json({ roomId, memberId, inviteUrl: `${new URL(request.url).origin}/?room=${roomId}` }), request, memberId);
}

async function handleSettings(request: Request, env: Env, roomId: string, memberId: string) {
  const input = await bodyJson<{ targetAt?: string; blurPx?: number }>(request);
  const targetAt = new Date(input.targetAt || '');
  const blurPx = Number(input.blurPx);
  if (Number.isNaN(targetAt.getTime())) return json({ error: '请输入有效的见面时间。' }, 400);
  if (!Number.isInteger(blurPx) || blurPx < 0 || blurPx > 24) return json({ error: '背景模糊度需要在 0 到 24 之间。' }, 400);
  const updatedAt = nowIso();
  await env.DB.prepare('UPDATE rooms SET target_at = ?1, blur_px = ?2, updated_at = ?3 WHERE id = ?4')
    .bind(targetAt.toISOString(), blurPx, updatedAt, roomId).run();
  await broadcast(env, roomId, 'settings.updated', { targetAt: targetAt.toISOString(), blurPx, updatedAt, actorId: memberId });
  return json(await roomState(env, request, roomId, memberId));
}

function safeImageType(contentType: string | null) {
  return contentType && ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(contentType.split(';')[0].toLowerCase())
    ? contentType.split(';')[0].toLowerCase()
    : null;
}

async function handleBackground(request: Request, env: Env, roomId: string, memberId: string) {
  if (request.method === 'GET') {
    const room = await env.DB.prepare('SELECT background_key AS backgroundKey FROM rooms WHERE id = ?1').bind(roomId).first<{ backgroundKey: string | null }>();
    if (!room?.backgroundKey) return new Response('Not Found', { status: 404 });
    const object = await env.MEDIA.get(room.backgroundKey);
    if (!object) return new Response('Not Found', { status: 404 });
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('Cache-Control', 'private, max-age=3600');
    return new Response(object.body, { headers });
  }

  if (request.method === 'DELETE') {
    await env.MEDIA.delete(`rooms/${roomId}/background`);
    await env.DB.prepare('UPDATE rooms SET background_key = NULL, updated_at = ?1 WHERE id = ?2').bind(nowIso(), roomId).run();
    await broadcast(env, roomId, 'background.updated', { backgroundUrl: null, actorId: memberId });
    return json({ ok: true });
  }

  const type = safeImageType(request.headers.get('Content-Type'));
  const length = Number(request.headers.get('Content-Length') || 0);
  if (!type) return json({ error: '背景只支持 JPG、PNG、WEBP 或 GIF。' }, 400);
  if (length > MAX_IMAGE_BYTES) return json({ error: '背景图片请控制在 8 MB 以内。' }, 413);
  const key = `rooms/${roomId}/background`;
  await env.MEDIA.put(key, request.body, { httpMetadata: { contentType: type } });
  await env.DB.prepare('UPDATE rooms SET background_key = ?1, updated_at = ?2 WHERE id = ?3').bind(key, nowIso(), roomId).run();
  await broadcast(env, roomId, 'background.updated', { backgroundUrl: `/api/background?room=${encodeURIComponent(roomId)}&v=${Date.now()}`, actorId: memberId });
  return json({ backgroundUrl: `/api/background?room=${encodeURIComponent(roomId)}&v=${Date.now()}` });
}

async function handleTasks(request: Request, env: Env, roomId: string, memberId: string) {
  const url = new URL(request.url);
  const taskId = url.pathname.split('/').at(-1);
  if (request.method === 'POST') {
    const input = await bodyJson<{ text?: string }>(request);
    const text = String(input.text || '').trim();
    if (!text || text.length > 120) return json({ error: '任务文字需要在 1 到 120 个字之间。' }, 400);
    const id = `task_${crypto.randomUUID()}`;
    const timestamp = nowIso();
    await env.DB.prepare(`
      INSERT INTO tasks (id, room_id, text, completed, author_id, completed_by, created_at, updated_at)
      VALUES (?1, ?2, ?3, 0, ?4, NULL, ?5, ?5)
    `).bind(id, roomId, text, memberId, timestamp).run();
    const task = { id, text, completed: false, authorId: memberId, completedBy: null, createdAt: timestamp, updatedAt: timestamp };
    await broadcast(env, roomId, 'task.created', task);
    return json(task, 201);
  }
  if (!taskId) return json({ error: '缺少任务 ID。' }, 400);
  const existing = await env.DB.prepare('SELECT id FROM tasks WHERE id = ?1 AND room_id = ?2').bind(taskId, roomId).first();
  if (!existing) return json({ error: '任务不存在。' }, 404);
  if (request.method === 'PATCH') {
    const input = await bodyJson<{ completed?: boolean }>(request);
    const completed = Boolean(input.completed);
    const timestamp = nowIso();
    await env.DB.prepare('UPDATE tasks SET completed = ?1, completed_by = ?2, updated_at = ?3 WHERE id = ?4 AND room_id = ?5')
      .bind(completed ? 1 : 0, completed ? memberId : null, timestamp, taskId, roomId).run();
    const task = { id: taskId, completed, completedBy: completed ? memberId : null, updatedAt: timestamp };
    await broadcast(env, roomId, 'task.updated', task);
    return json(task);
  }
  if (request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM tasks WHERE id = ?1 AND room_id = ?2').bind(taskId, roomId).run();
    await broadcast(env, roomId, 'task.deleted', { id: taskId });
    return json({ ok: true });
  }
  return json({ error: 'Method not allowed' }, 405);
}

async function handleVoiceUpload(request: Request, env: Env, roomId: string, memberId: string) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_AUDIO_BYTES) return json({ error: '录音请控制在 12 MB 以内。' }, 413);
  const mimeType = request.headers.get('Content-Type') || 'audio/webm';
  if (!mimeType.startsWith('audio/')) return json({ error: '录音格式无效。' }, 400);
  const id = `voice_${crypto.randomUUID()}`;
  const key = `rooms/${roomId}/voice/${id}`;
  const durationMs = Math.max(0, Number(request.headers.get('X-Duration-Ms') || 0));
  const createdAt = nowIso();
  await env.MEDIA.put(key, request.body, { httpMetadata: { contentType: mimeType } });
  await env.DB.prepare(`
    INSERT INTO voice_notes (id, room_id, author_id, object_key, mime_type, duration_ms, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
  `).bind(id, roomId, memberId, key, mimeType, durationMs, createdAt).run();
  const note = { id, authorId: memberId, mimeType, durationMs, createdAt, url: `/api/voice/${id}?room=${encodeURIComponent(roomId)}` };
  await broadcast(env, roomId, 'voice.created', note);
  return json(note, 201);
}

async function handleVoice(request: Request, env: Env, roomId: string, voiceId: string) {
  const note = await env.DB.prepare('SELECT object_key AS objectKey, mime_type AS mimeType FROM voice_notes WHERE id = ?1 AND room_id = ?2')
    .bind(voiceId, roomId).first<{ objectKey: string; mimeType: string }>();
  if (!note) return new Response('Not Found', { status: 404 });
  const object = await env.MEDIA.get(note.objectKey);
  if (!object) return new Response('Not Found', { status: 404 });
  return new Response(object.body, { headers: { 'Content-Type': note.mimeType, 'Cache-Control': 'private, max-age=3600' } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/health') return json({ ok: true, service: 'meet-countdown', serverNow: nowIso() });
      if (url.pathname === '/api/room' && request.method === 'POST') return handleRoom(request, env);

      const roomId = requestedRoom(request);
      if (url.pathname === '/ws') {
        if (!roomId) return new Response('Missing room', { status: 400 });
        const stub = env.COUPLE_ROOM.getByName(roomId);
        return stub.fetch(request);
      }
      if (url.pathname === '/api/state' && request.method === 'GET') {
        if (!roomId) return json({ error: 'Missing room' }, 400);
        const memberId = sessionId(request);
        const state = await roomState(env, request, roomId, memberId);
        if (!state) return json({ error: '房间不存在。' }, 404);
        return withSession(json(state), request, memberId);
      }
      if (!roomId) return env.ASSETS.fetch(request);
      const memberId = sessionId(request);
      const room = await env.DB.prepare('SELECT id FROM rooms WHERE id = ?1').bind(roomId).first();
      if (!room) return json({ error: '房间不存在。' }, 404);
      if (url.pathname === '/api/settings' && request.method === 'PUT') return handleSettings(request, env, roomId, memberId);
      if (url.pathname === '/api/background') return handleBackground(request, env, roomId, memberId);
      if (url.pathname === '/api/voice' && request.method === 'POST') return handleVoiceUpload(request, env, roomId, memberId);
      if (url.pathname.startsWith('/api/voice/') && request.method === 'GET') return handleVoice(request, env, roomId, url.pathname.split('/').at(-1) || '');
      if (url.pathname === '/api/tasks' || url.pathname.startsWith('/api/tasks/')) return handleTasks(request, env, roomId, memberId);
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error('request_failed', error);
      return json({ error: error instanceof Error ? error.message : '服务暂时不可用。' }, 500);
    }
  },
};

export class CoupleRoom extends DurableObject<Env> {
  async fetch(request: Request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const url = new URL(request.url);
    const roomId = url.searchParams.get('room') || '';
    const memberId = cookie(request, 'meet_session') || `member_${randomToken(16)}`;
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ roomId, memberId });
    server.send(JSON.stringify({ type: 'room.ready', payload: { roomId, memberId }, createdAt: nowIso() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async broadcast(event: RoomEvent) {
    const message = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.send(message); } catch { /* disconnected sockets are cleaned by the runtime */ }
    }
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string') return;
    try {
      const input = JSON.parse(message) as { type?: string; payload?: Record<string, unknown> };
      if (input.type !== 'pointer' || !input.payload) return;
      const payload = input.payload;
      const x = Number(payload.x);
      const y = Number(payload.y);
      const strength = Number(payload.strength);
      if (![x, y, strength].every(Number.isFinite) || x < 0 || x > 1 || y < 0 || y > 1) return;
      const event = JSON.stringify({ type: 'pointer', payload: { x, y, strength: Math.min(1, Math.max(0, strength)) }, createdAt: nowIso() });
      for (const peer of this.ctx.getWebSockets()) {
        if (peer !== socket) {
          try { peer.send(event); } catch { /* disconnected sockets are cleaned by the runtime */ }
        }
      }
    } catch {
      // Ignore malformed realtime packets.
    }
  }

  webSocketClose() {}
  webSocketError() {}
}
