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

type AuthUser = {
  id: string;
  username: string;
};

const ROOM_PATTERN = /^room_[a-z0-9]{10}$/;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const MAX_DOODLE_POINTS = 800;
const DOODLE_STYLES = new Set(['neon', 'fireworks']);
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const AUTH_COOKIE = 'meet_auth';
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;
const PASSWORD_ITERATIONS = 100_000;

function nowIso() {
  return new Date().toISOString();
}

async function listVoiceObjectKeys(env: Env) {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.MEDIA.list({ prefix: 'rooms/', cursor });
    keys.push(...page.objects.map((object) => object.key).filter((key) => key.includes('/voice/')));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

async function clearEphemeralData(env: Env) {
  const voiceObjectKeys = await listVoiceObjectKeys(env);
  await Promise.all(voiceObjectKeys.map((key) => env.MEDIA.delete(key)));
  await env.DB.batch([
    env.DB.prepare('DELETE FROM voice_notes'),
    env.DB.prepare('DELETE FROM tasks'),
  ]);

  const rooms = await env.DB.prepare('SELECT id FROM rooms').all<{ id: string }>();
  const clearedAt = nowIso();
  await Promise.all((rooms.results || []).map((room) => broadcast(env, room.id, 'ephemeral.cleared', { clearedAt })));
  return { clearedAt, voiceObjects: voiceObjectKeys.length, rooms: rooms.results?.length || 0 };
}

function validDoodleColor(value: unknown) {
  return typeof value === 'string' && HEX_COLOR_PATTERN.test(value);
}

function validDoodleStyle(value: unknown): value is 'neon' | 'fireworks' {
  return typeof value === 'string' && DOODLE_STYLES.has(value);
}

function validDoodlePoints(value: unknown) {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_DOODLE_POINTS) return false;
  return value.every((point) => {
    if (!point || typeof point !== 'object') return false;
    const { x, y } = point as { x?: unknown; y?: unknown };
    return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1;
  });
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

function base64(bytes: ArrayBuffer | Uint8Array) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function fromBase64(value: string) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256(value: string) {
  return base64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

async function hashPassword(password: string, salt: Uint8Array) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PASSWORD_ITERATIONS, hash: 'SHA-256' }, key, 256);
  return base64(bits);
}

async function verifyPassword(password: string, saltBase64: string, expectedHash: string) {
  return (await hashPassword(password, fromBase64(saltBase64))) === expectedHash;
}

async function authenticatedUser(request: Request, env: Env) {
  const token = cookie(request, AUTH_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const result = await env.DB.prepare(`
    SELECT users.id, users.username
    FROM auth_sessions
    JOIN users ON users.id = auth_sessions.user_id
    WHERE auth_sessions.token_hash = ?1 AND auth_sessions.expires_at > ?2
  `).bind(tokenHash, nowIso()).first<AuthUser>();
  return result || null;
}

function withAuthCookie(response: Response, request: Request, token: string) {
  const headers = new Headers(response.headers);
  const secure = new URL(request.url).protocol === 'https:' ? ' Secure;' : '';
  headers.append('Set-Cookie', `${AUTH_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax;${secure} Max-Age=${SESSION_MAX_AGE}`);
  return new Response(response.body, { status: response.status, headers });
}

function clearAuthCookie(response: Response, request: Request) {
  const headers = new Headers(response.headers);
  const secure = new URL(request.url).protocol === 'https:' ? ' Secure;' : '';
  headers.append('Set-Cookie', `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax;${secure} Max-Age=0`);
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

async function createAuthSession(env: Env, request: Request, userId: string) {
  const token = base64(crypto.getRandomValues(new Uint8Array(32)));
  const timestamp = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE * 1000).toISOString();
  await env.DB.prepare('INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(await sha256(token), userId, timestamp, expiresAt).run();
  return token;
}

function validUsername(value: string) {
  return /^[\p{L}\p{N}_-]{2,24}$/u.test(value);
}

async function handleAuth(request: Request, env: Env, action: 'register' | 'login' | 'logout' | 'me') {
  if (action === 'me') {
    const user = await authenticatedUser(request, env);
    return user ? json({ user }) : json({ error: '请先登录。' }, 401);
  }
  if (action === 'logout') {
    const token = cookie(request, AUTH_COOKIE);
    if (token) await env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash = ?1').bind(await sha256(token)).run();
    return clearAuthCookie(json({ ok: true }), request);
  }

  const input = await bodyJson<{ username?: string; password?: string }>(request);
  const username = String(input.username || '').trim();
  const password = String(input.password || '');
  if (!validUsername(username)) return json({ error: '账号名称需为 2 到 24 个字，可使用中文、字母、数字、下划线或短横线。' }, 400);
  if (password.length < 8 || password.length > 72) return json({ error: '密码需为 8 到 72 个字符。' }, 400);

  if (action === 'register') {
    const id = `user_${crypto.randomUUID()}`;
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const timestamp = nowIso();
    try {
      await env.DB.prepare(`
        INSERT INTO users (id, username, password_salt, password_hash, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5)
      `).bind(id, username, base64(salt), await hashPassword(password, salt), timestamp).run();
    } catch (error) {
      if (String(error).toLowerCase().includes('unique')) return json({ error: '这个账号名称已经被使用。' }, 409);
      throw error;
    }
    const token = await createAuthSession(env, request, id);
    return withAuthCookie(json({ user: { id, username } }, 201), request, token);
  }

  const user = await env.DB.prepare('SELECT id, username, password_salt AS passwordSalt, password_hash AS passwordHash FROM users WHERE username = ?1')
    .bind(username).first<{ id: string; username: string; passwordSalt: string; passwordHash: string }>();
  if (!user || !(await verifyPassword(password, user.passwordSalt, user.passwordHash))) return json({ error: '账号名称或密码不正确。' }, 401);
  const token = await createAuthSession(env, request, user.id);
  return withAuthCookie(json({ user: { id: user.id, username: user.username } }), request, token);
}

async function roomMember(env: Env, roomId: string, userId: string) {
  return env.DB.prepare(`
    SELECT room_members.room_id AS roomId, room_members.slot, users.id AS userId, users.username
    FROM room_members JOIN users ON users.id = room_members.user_id
    WHERE room_members.room_id = ?1 AND room_members.user_id = ?2
  `).bind(roomId, userId).first<{ roomId: string; slot: number; userId: string; username: string }>();
}

async function ensureRoom(env: Env, roomId: string, user: AuthUser) {
  const existing = await env.DB.prepare('SELECT id FROM rooms WHERE id = ?1').bind(roomId).first();
  if (existing) return;
  const timestamp = nowIso();
  const targetAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO rooms (id, target_at, blur_px, background_key, contrast, brightness, slogan, created_at, updated_at)
      VALUES (?1, ?2, 0, NULL, 1.0, 1.0, '把想念留给时间', ?3, ?3)
    `).bind(roomId, targetAt, timestamp),
    env.DB.prepare('INSERT INTO room_members (room_id, user_id, slot, joined_at) VALUES (?1, ?2, 0, ?3)').bind(roomId, user.id, timestamp),
  ]);
}

async function roomState(env: Env, request: Request, roomId: string, user: AuthUser) {
  const room = await env.DB.prepare(`
    SELECT id, target_at AS targetAt, blur_px AS blurPx, contrast, brightness, slogan, background_key AS backgroundKey, updated_at AS updatedAt
    FROM rooms WHERE id = ?1
  `).bind(roomId).first<{ id: string; targetAt: string; blurPx: number; contrast: number; brightness: number; slogan: string; backgroundKey: string | null; updatedAt: string }>();
  if (!room) return null;

  const membership = await roomMember(env, roomId, user.id);
  if (!membership) return null;

  const brushSettings = await env.DB.prepare('SELECT brush_color AS brushColor, brush_style AS brushStyle, theme FROM users WHERE id = ?1')
    .bind(user.id).first<{ brushColor: string; brushStyle: string; theme: string }>();

  const tasksResult = await env.DB.prepare(`
    SELECT id, text, completed, author_id AS authorId, completed_by AS completedBy, created_at AS createdAt, updated_at AS updatedAt
    FROM tasks WHERE room_id = ?1 ORDER BY created_at ASC, id ASC
  `).bind(roomId).all();
  const voiceResult = await env.DB.prepare(`
    SELECT id, author_id AS authorId, mime_type AS mimeType, duration_ms AS durationMs, created_at AS createdAt
    FROM (
      SELECT id, author_id, mime_type, duration_ms, created_at
      FROM voice_notes
      WHERE room_id = ?1
      ORDER BY created_at DESC, id DESC
      LIMIT 40
    )
    ORDER BY createdAt ASC, id ASC
  `).bind(roomId).all();
  const doodleResult = await env.DB.prepare(`
    SELECT id, author_id AS authorId, style, color, points_json AS pointsJson, created_at AS createdAt
    FROM doodles
    WHERE room_id = ?1
    ORDER BY created_at ASC, id ASC
  `).bind(roomId).all();
  const membersResult = await env.DB.prepare(`
    SELECT users.id AS id, users.username AS username, room_members.slot AS slot
    FROM room_members JOIN users ON users.id = room_members.user_id
    WHERE room_members.room_id = ?1 ORDER BY room_members.slot ASC
  `).bind(roomId).all();

  return {
    roomId,
    targetAt: room.targetAt,
    blurPx: room.blurPx,
    contrast: room.contrast,
    brightness: room.brightness,
    slogan: room.slogan ?? '把想念留给时间',
    theme: brushSettings?.theme === 'dark' ? 'dark' : 'light',
    brushColor: brushSettings?.brushColor || '#8be9fd',
    brushStyle: 'neon',
    backgroundUrl: room.backgroundKey ? `/api/background?room=${encodeURIComponent(roomId)}&v=${encodeURIComponent(room.updatedAt)}` : null,
    updatedAt: room.updatedAt,
    timeZone: 'Asia/Singapore',
    memberId: user.id,
    username: user.username,
    inviteUrl: `${new URL(request.url).origin}/?room=${encodeURIComponent(roomId)}`,
    members: membersResult.results || [],
    tasks: (tasksResult.results || []).map((task) => ({
      ...task,
      completed: Boolean(task.completed),
      mine: task.authorId === user.id,
    })),
    voiceNotes: (voiceResult.results || []).map((note) => ({
      ...note,
      url: `/api/voice/${encodeURIComponent(String(note.id))}?room=${encodeURIComponent(roomId)}`,
      mine: note.authorId === user.id,
    })),
    doodles: (doodleResult.results || []).flatMap((doodle) => {
      try {
        const points = JSON.parse(String(doodle.pointsJson));
        if (!validDoodlePoints(points) || !validDoodleColor(doodle.color) || !validDoodleStyle(doodle.style)) return [];
        return [{ id: doodle.id, authorId: doodle.authorId, style: doodle.style, color: doodle.color, points, createdAt: doodle.createdAt, mine: doodle.authorId === user.id }];
      } catch {
        return [];
      }
    }),
  };
}

async function broadcast(env: Env, roomId: string, type: string, payload: unknown) {
  const stub = env.COUPLE_ROOM.getByName(roomId);
  await stub.broadcast({ type, payload, createdAt: nowIso() });
}

async function handleRoom(request: Request, env: Env, user: AuthUser) {
  const input = await bodyJson<{ roomId?: string }>(request);
  const roomId = input.roomId || `room_${randomToken(10)}`;
  if (!ROOM_PATTERN.test(roomId)) return json({ error: '房间链接无效。' }, 400);
  if (input.roomId) {
    const room = await env.DB.prepare('SELECT id FROM rooms WHERE id = ?1').bind(roomId).first();
    if (!room) return json({ error: '房间不存在。' }, 404);
    if (!(await roomMember(env, roomId, user.id))) {
      const slots = await env.DB.prepare('SELECT slot FROM room_members WHERE room_id = ?1 ORDER BY slot ASC').bind(roomId).all<{ slot: number }>();
      const usedSlots = new Set((slots.results || []).map((item) => item.slot));
      const slot = usedSlots.has(0) ? (usedSlots.has(1) ? null : 1) : 0;
      if (slot === null) return json({ error: '这个房间已经有两位成员，暂时无法加入。' }, 409);
      try {
        await env.DB.prepare('INSERT INTO room_members (room_id, user_id, slot, joined_at) VALUES (?1, ?2, ?3, ?4)')
          .bind(roomId, user.id, slot, nowIso()).run();
      } catch (error) {
        if (String(error).toLowerCase().includes('unique')) return json({ error: '房间刚刚被另一位成员加入，请重新打开邀请链接。' }, 409);
        throw error;
      }
      await broadcast(env, roomId, 'room.joined', { userId: user.id, username: user.username, slot });
    }
  } else {
    await ensureRoom(env, roomId, user);
  }
  const state = await roomState(env, request, roomId, user);
  return json({ roomId, memberId: user.id, inviteUrl: state?.inviteUrl, members: state?.members || [] });
}

async function destroyRoom(env: Env, roomId: string, user: AuthUser) {
  const membership = await roomMember(env, roomId, user.id);
  if (!membership) return json({ error: '你不是这个房间的成员。' }, 403);
  const room = await env.DB.prepare('SELECT id FROM rooms WHERE id = ?1').bind(roomId).first();
  if (!room) return json({ error: '房间不存在。' }, 404);

  await broadcast(env, roomId, 'room.destroyed', { actorId: user.id, actorName: user.username });
  const voiceObjects = await env.MEDIA.list({ prefix: `rooms/${roomId}/voice/` });
  await Promise.all([
    env.MEDIA.delete(`rooms/${roomId}/background`),
    ...voiceObjects.objects.map((object) => env.MEDIA.delete(object.key)),
  ]);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM voice_notes WHERE room_id = ?1').bind(roomId),
    env.DB.prepare('DELETE FROM tasks WHERE room_id = ?1').bind(roomId),
    env.DB.prepare('DELETE FROM doodles WHERE room_id = ?1').bind(roomId),
    env.DB.prepare('DELETE FROM room_members WHERE room_id = ?1').bind(roomId),
    env.DB.prepare('DELETE FROM rooms WHERE id = ?1').bind(roomId),
  ]);
  return json({ ok: true, roomId });
}

async function handleSettings(request: Request, env: Env, roomId: string, user: AuthUser) {
  const input = await bodyJson<{ targetAt?: string; blurPx?: number; contrast?: number; brightness?: number; slogan?: string; brushColor?: string; brushStyle?: string; theme?: string }>(request);
  const targetAt = new Date(input.targetAt || '');
  const blurPx = Number(input.blurPx);
  const contrast = input.contrast === undefined ? 1 : Number(input.contrast);
  const brightness = input.brightness === undefined ? 1 : Number(input.brightness);
  const currentSlogan = await env.DB.prepare('SELECT slogan FROM rooms WHERE id = ?1').bind(roomId).first<{ slogan: string }>();
  const slogan = input.slogan === undefined ? (currentSlogan?.slogan || '把想念留给时间') : String(input.slogan).trim();
  const currentBrush = await env.DB.prepare('SELECT brush_color AS brushColor, brush_style AS brushStyle, theme FROM users WHERE id = ?1')
    .bind(user.id).first<{ brushColor: string; brushStyle: string; theme: string }>();
  const brushColor = input.brushColor === undefined ? (currentBrush?.brushColor || '#8be9fd') : String(input.brushColor);
  const brushStyle = 'neon';
  const theme = input.theme === undefined ? (currentBrush?.theme === 'dark' ? 'dark' : 'light') : (input.theme === 'dark' ? 'dark' : 'light');
  if (Number.isNaN(targetAt.getTime())) return json({ error: '请输入有效的见面时间。' }, 400);
  if (!Number.isInteger(blurPx) || blurPx < 0 || blurPx > 24) return json({ error: '背景模糊度需要在 0 到 24 之间。' }, 400);
  if (!Number.isFinite(contrast) || contrast < 0 || contrast > 2) return json({ error: '背景对比度需要在 0% 到 200% 之间。' }, 400);
  if (!Number.isFinite(brightness) || brightness < 0 || brightness > 2) return json({ error: '背景亮度需要在 0% 到 200% 之间。' }, 400);
  if (Array.from(slogan).length > 20) return json({ error: '底部文案最多 20 个字。' }, 400);
  if (!validDoodleColor(brushColor)) return json({ error: '涂鸦颜色格式无效。' }, 400);
  if (!validDoodleStyle(brushStyle)) return json({ error: '涂鸦样式无效。' }, 400);
  const updatedAt = nowIso();
  await env.DB.batch([
    env.DB.prepare('UPDATE rooms SET target_at = ?1, blur_px = ?2, contrast = ?3, brightness = ?4, slogan = ?5, updated_at = ?6 WHERE id = ?7')
      .bind(targetAt.toISOString(), blurPx, contrast, brightness, slogan, updatedAt, roomId),
    env.DB.prepare('UPDATE users SET brush_color = ?1, brush_style = ?2, theme = ?3 WHERE id = ?4')
      .bind(brushColor, brushStyle, theme, user.id),
  ]);
  await broadcast(env, roomId, 'settings.updated', { targetAt: targetAt.toISOString(), blurPx, contrast, brightness, slogan, brushColor, brushStyle, updatedAt, actorId: user.id });
  return json(await roomState(env, request, roomId, user));
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
  if (length > MAX_IMAGE_BYTES) return json({ error: '背景图片请控制在 30 MB 以内。' }, 413);
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
  const existing = await env.DB.prepare('SELECT id, author_id AS authorId FROM tasks WHERE id = ?1 AND room_id = ?2')
    .bind(taskId, roomId).first<{ id: string; authorId: string }>();
  if (!existing) return json({ error: '任务不存在。' }, 404);
  if (existing.authorId !== memberId) return json({ error: '只能完成或删除自己创建的任务。' }, 403);
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

async function handleDoodles(request: Request, env: Env, roomId: string, doodleId: string, memberId: string) {
  if (request.method === 'POST') {
    const input = await bodyJson<{ id?: string; style?: string; color?: string; points?: unknown }>(request);
    const id = String(input.id || `doodle_${crypto.randomUUID()}`);
    const style = String(input.style || '');
    const color = String(input.color || '');
    if (!/^doodle_[a-zA-Z0-9_-]{8,100}$/.test(id)) return json({ error: '涂鸦 ID 无效。' }, 400);
    if (!validDoodleStyle(style)) return json({ error: '涂鸦样式无效。' }, 400);
    if (!validDoodleColor(color)) return json({ error: '涂鸦颜色格式无效。' }, 400);
    if (!validDoodlePoints(input.points)) return json({ error: '涂鸦轨迹点过多或格式无效，请缩短后重试。' }, 400);
    const createdAt = nowIso();
    await env.DB.prepare(`
      INSERT INTO doodles (id, room_id, author_id, style, color, points_json, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    `).bind(id, roomId, memberId, style, color, JSON.stringify(input.points), createdAt).run();
    const doodle = { id, authorId: memberId, style, color, points: input.points, createdAt, mine: true };
    await broadcast(env, roomId, 'doodle.created', doodle);
    return json(doodle, 201);
  }
  if (!doodleId) return json({ error: '缺少涂鸦 ID。' }, 400);
  const existing = await env.DB.prepare('SELECT id, author_id AS authorId FROM doodles WHERE id = ?1 AND room_id = ?2')
    .bind(doodleId, roomId).first<{ id: string; authorId: string }>();
  if (!existing) return json({ error: '涂鸦不存在。' }, 404);
  if (existing.authorId !== memberId) return json({ error: '只能擦除自己创建的涂鸦。' }, 403);
  if (request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM doodles WHERE id = ?1 AND room_id = ?2').bind(doodleId, roomId).run();
    await broadcast(env, roomId, 'doodle.deleted', { id: doodleId, actorId: memberId });
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

async function handleVoice(request: Request, env: Env, roomId: string, voiceId: string, memberId: string) {
  const note = await env.DB.prepare('SELECT object_key AS objectKey, mime_type AS mimeType, author_id AS authorId FROM voice_notes WHERE id = ?1 AND room_id = ?2')
    .bind(voiceId, roomId).first<{ objectKey: string; mimeType: string; authorId: string }>();
  if (!note) return new Response('Not Found', { status: 404 });
  if (request.method === 'DELETE') {
    if (note.authorId !== memberId) return json({ error: '只能删除自己创建的录音。' }, 403);
    await env.MEDIA.delete(note.objectKey);
    await env.DB.prepare('DELETE FROM voice_notes WHERE id = ?1 AND room_id = ?2').bind(voiceId, roomId).run();
    await broadcast(env, roomId, 'voice.deleted', { id: voiceId, actorId: memberId });
    return json({ ok: true });
  }
  const object = await env.MEDIA.get(note.objectKey);
  if (!object) return new Response('Not Found', { status: 404 });
  return new Response(object.body, { headers: { 'Content-Type': note.mimeType, 'Cache-Control': 'private, max-age=3600' } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/health') return json({ ok: true, service: 'meet-countdown', serverNow: nowIso() });
      if (url.pathname === '/api/auth/register' && request.method === 'POST') return handleAuth(request, env, 'register');
      if (url.pathname === '/api/auth/login' && request.method === 'POST') return handleAuth(request, env, 'login');
      if (url.pathname === '/api/auth/logout' && request.method === 'POST') return handleAuth(request, env, 'logout');
      if (url.pathname === '/api/auth/me' && request.method === 'GET') return handleAuth(request, env, 'me');

      const user = await authenticatedUser(request, env);
      if (url.pathname === '/api/room' && request.method === 'POST') {
        if (!user) return json({ error: '请先登录。' }, 401);
        return handleRoom(request, env, user);
      }

      const roomId = requestedRoom(request);
      if (url.pathname === '/ws') {
        if (!roomId) return new Response('Missing room', { status: 400 });
        if (!user || !(await roomMember(env, roomId, user.id))) return new Response('Unauthorized', { status: 401 });
        const stub = env.COUPLE_ROOM.getByName(roomId);
        const headers = new Headers(request.headers);
        headers.set('X-Member-Id', user.id);
        return stub.fetch(new Request(request, { headers }));
      }
      if (url.pathname === '/api/state' && request.method === 'GET') {
        if (!roomId) return json({ error: 'Missing room' }, 400);
        if (!user) return json({ error: '请先登录。' }, 401);
        const state = await roomState(env, request, roomId, user);
        if (!state) return json({ error: '房间不存在。' }, 404);
        return json(state);
      }
      if (!roomId) return env.ASSETS.fetch(request);
      if (!user) return json({ error: '请先登录。' }, 401);
      if (!(await roomMember(env, roomId, user.id))) return json({ error: '你不是这个房间的成员。' }, 403);
      if (url.pathname === '/api/room' && request.method === 'DELETE') return destroyRoom(env, roomId, user);
      if (url.pathname === '/api/settings' && request.method === 'PUT') return handleSettings(request, env, roomId, user);
      if (url.pathname === '/api/background') return handleBackground(request, env, roomId, user.id);
      if (url.pathname === '/api/doodles' && request.method === 'POST') return handleDoodles(request, env, roomId, '', user.id);
      if (url.pathname.startsWith('/api/doodles/') && request.method === 'DELETE') return handleDoodles(request, env, roomId, url.pathname.split('/').at(-1) || '', user.id);
      if (url.pathname === '/api/voice' && request.method === 'POST') return handleVoiceUpload(request, env, roomId, user.id);
      if (url.pathname.startsWith('/api/voice/') && (request.method === 'GET' || request.method === 'DELETE')) return handleVoice(request, env, roomId, url.pathname.split('/').at(-1) || '', user.id);
      if (url.pathname === '/api/tasks' || url.pathname.startsWith('/api/tasks/')) return handleTasks(request, env, roomId, user.id);
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error('request_failed', error);
      return json({ error: error instanceof Error ? error.message : '服务暂时不可用。' }, 500);
    }
  },
  async scheduled(_controller: ScheduledController, env: Env) {
    await Promise.all([
      clearEphemeralData(env),
      env.DB.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?1').bind(nowIso()).run(),
    ]);
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
    const memberId = request.headers.get('X-Member-Id') || '';
    if (!memberId) return new Response('Unauthorized', { status: 401 });
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
      if (input.type === 'doodle.preview' && input.payload) {
        const payload = input.payload;
        const id = String(payload.id || '');
        const phase = payload.phase === 'start' ? 'start' : 'point';
        const x = Number(payload.x);
        const y = Number(payload.y);
        const style = String(payload.style || '');
        const color = String(payload.color || '');
        if (!/^doodle_[a-zA-Z0-9_-]{8,100}$/.test(id) || !validDoodleStyle(style) || !validDoodleColor(color) || ![x, y].every(Number.isFinite) || x < 0 || x > 1 || y < 0 || y > 1) return;
        const attachment = socket.deserializeAttachment() as { memberId?: string } | null;
        const event = JSON.stringify({
          type: 'doodle.preview',
          payload: { id, phase, x, y, style, color, actorId: attachment?.memberId || '' },
          createdAt: nowIso(),
        });
        for (const peer of this.ctx.getWebSockets()) {
          if (peer !== socket) {
            try { peer.send(event); } catch { /* disconnected sockets are cleaned by the runtime */ }
          }
        }
        return;
      }
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
