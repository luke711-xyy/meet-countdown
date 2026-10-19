import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const origin = new URL(process.env.SCREENING_TEST_ORIGIN ?? 'http://127.0.0.1:8787');
if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) {
  throw new Error('Screening integration tests require a local HTTP Worker');
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const packet = (type, payload) => JSON.stringify({ type, payload });
const execFileAsync = promisify(execFile);

async function localSql(command) {
  const wrangler = fileURLToPath(new URL('../node_modules/.bin/wrangler', import.meta.url));
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const { stdout } = await execFileAsync(wrangler, ['d1', 'execute', 'meet-countdown-db', '--local', '--command', command, '--json'], { cwd });
  assert.equal(JSON.parse(stdout).every(({ success }) => success), true, 'local D1 setup succeeds');
}

async function request(path, { cookie, method = 'GET', body } = {}) {
  const response = await fetch(new URL(path, origin), {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await response.text();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], body: parsed };
}

async function register() {
  const username = `screen${randomUUID().replaceAll('-', '').slice(0, 14)}`;
  const password = randomUUID();
  const response = await request('/api/auth/register', {
    method: 'POST', body: { username, password },
  });
  assert.equal(response.status, 201, 'local test account registration succeeds');
  assert.ok(response.cookie, 'registration returns an auth cookie');
  return { cookie: response.cookie, memberId: response.body.user.id, username, password };
}

async function fixture(t, { outsider = false } = {}) {
  const accounts = [];
  const sockets = [];
  let roomId;
  let destroyed = false;
  t.after(async () => {
    await Promise.all(sockets.map(async (client) => {
      if (client.ws.readyState === WebSocket.CLOSED) return;
      client.ws.close();
      await Promise.race([client.closed, wait(500)]);
      if (client.ws.readyState !== WebSocket.CLOSED) {
        client.ws.terminate();
        await Promise.race([client.closed, wait(500)]);
      }
      assert.equal(client.ws.readyState, WebSocket.CLOSED, 'fixture WebSocket closes');
    }));
    if (roomId && !destroyed) {
      const path = `/api/room?room=${roomId}`;
      let deletion = await request(path, { method: 'DELETE', cookie: accounts[0]?.cookie });
      if (deletion.status === 401 || deletion.status === 403) deletion = await request(path, { method: 'DELETE', cookie: accounts[1]?.cookie });
      assert.equal(deletion.status, 200, 'fixture room deletion succeeds');
    }
    const logouts = await Promise.all(accounts.map(({ cookie }) => request('/api/auth/logout', { method: 'POST', cookie })));
    for (const logout of logouts) assert.equal(logout.status, 200, 'fixture session logout succeeds');
  });
  const first = await register();
  accounts.push(first);
  const second = await register();
  accounts.push(second);
  const created = await request('/api/room', { method: 'POST', cookie: first.cookie, body: {} });
  assert.equal(created.status, 200);
  roomId = created.body.roomId;
  const joined = await request('/api/room', { method: 'POST', cookie: second.cookie, body: { roomId } });
  assert.equal(joined.status, 200);
  let guest;
  if (outsider) {
    guest = await register();
    accounts.push(guest);
  }
  return { first, second, guest, roomId, sockets, accounts, destroy: async () => {
    const result = await request(`/api/room?room=${roomId}`, { method: 'DELETE', cookie: first.cookie });
    if (result.status === 200) destroyed = true;
    return result;
  } };
}

function wsUrl(roomId) {
  const url = new URL(`/ws?room=${roomId}`, origin);
  url.protocol = 'ws:';
  return url;
}

async function rejectedSocket(roomId, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(roomId), { headers: cookie ? { Cookie: cookie } : {} });
    ws.once('unexpected-response', (_request, response) => {
      const status = response.statusCode;
      response.resume();
      resolve({ status });
    });
    ws.once('open', () => { ws.close(); reject(new Error('nonmember WebSocket opened')); });
    ws.once('error', reject);
  });
}

async function connect(roomId, cookie, sockets) {
  const ws = new WebSocket(wsUrl(roomId), { headers: { Cookie: cookie } });
  const events = [];
  const closed = new Promise((resolve) => ws.once('close', resolve));
  ws.on('message', (raw) => events.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const client = { ws, events, closed };
  sockets.push(client);
  await event(client, 'room.ready');
  return client;
}

async function event(client, type, count = 1) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const matches = client.events.filter((item) => item.type === type);
    if (matches.length >= count) return matches.at(count - 1);
    await wait(10);
  }
  assert.fail(`timed out waiting for ${type}`);
}

async function join(client, deviceId, takeover = false) {
  client.ws.send(packet('screening.join', { deviceId, takeover }));
  return (await event(client, 'screening.joined')).payload.sessionId;
}

test('nonmember WebSocket cannot signal', async (t) => {
  const room = await fixture(t, { outsider: true });
  const guestWs = await rejectedSocket(room.roomId, room.guest.cookie);
  assert.equal(guestWs.status, 401);
  const anonymousWs = await rejectedSocket(room.roomId);
  assert.equal(anonymousWs.status, 401);
});

test('signaling reaches only addressed peer', async (t) => {
  const room = await fixture(t);
  const sharer = await connect(room.roomId, room.first.cookie, room.sockets);
  const otherDevice = await connect(room.roomId, room.first.cookie, room.sockets);
  const viewer = await connect(room.roomId, room.second.cookie, room.sockets);
  const sessionId = await join(sharer, 'sharer-device');
  await join(viewer, 'viewer-device');
  sharer.ws.send(packet('screening.share', { sessionId, seq: 1, active: true, hasSourceAudio: false }));
  await event(viewer, 'screening.share.changed');
  sharer.ws.send(packet('screening.signal', {
    sessionId, seq: 2, kind: 'offer', negotiationId: 'offer-1', targetDeviceId: 'viewer-device',
    data: { type: 'offer', sdp: 'v=0' }, memberId: room.second.memberId,
  }));
  const offer = await event(viewer, 'screening.signal');
  assert.equal(offer.payload.memberId, room.first.memberId);
  assert.equal(offer.payload.data.sdp, 'v=0');
  await wait(100);
  const otherDeviceOfferCount = otherDevice.events.filter(({ type }) => type === 'screening.signal').length;
  assert.equal(otherDeviceOfferCount, 0);
});

test('takeover invalidates first device', async (t) => {
  const room = await fixture(t);
  const firstDevice = await connect(room.roomId, room.first.cookie, room.sockets);
  const secondDevice = await connect(room.roomId, room.first.cookie, room.sockets);
  const peer = await connect(room.roomId, room.second.cookie, room.sockets);
  const oldSession = await join(firstDevice, 'first-device');
  await join(peer, 'peer-device');
  const newSession = await join(secondDevice, 'second-device', true);
  await event(firstDevice, 'screening.taken-over');
  firstDevice.ws.send(packet('screening.share', { sessionId: oldSession, seq: 1, active: true, hasSourceAudio: false }));
  await wait(100);
  const oldDeviceCanShare = peer.events.some(({ type, payload }) => type === 'screening.share.changed' && payload.deviceId === 'first-device' && payload.active);
  assert.equal(oldDeviceCanShare, false);
  secondDevice.ws.send(packet('screening.share', { sessionId: newSession, seq: 1, active: true, hasSourceAudio: false }));
  assert.equal((await event(peer, 'screening.share.changed')).payload.deviceId, 'second-device');
});

test('pause and room destruction reach both clients', async (t) => {
  const room = await fixture(t);
  const sharer = await connect(room.roomId, room.first.cookie, room.sockets);
  const viewer = await connect(room.roomId, room.second.cookie, room.sockets);
  const sharerSession = await join(sharer, 'sharer-device');
  const viewerSession = await join(viewer, 'viewer-device');
  sharer.ws.send(packet('screening.share', { sessionId: sharerSession, seq: 1, active: true, hasSourceAudio: true }));
  await event(viewer, 'screening.share.changed');
  viewer.ws.send(packet('screening.pause.request', { sessionId: viewerSession, seq: 1, paused: true }));
  assert.equal((await event(sharer, 'screening.pause.requested')).payload.paused, true);
  await event(viewer, 'screening.pause.requested');
  sharer.ws.send(packet('screening.pause.confirm', { sessionId: sharerSession, seq: 2, paused: true }));
  assert.equal((await event(viewer, 'screening.pause.confirmed')).payload.paused, true);
  await event(sharer, 'screening.pause.confirmed');
  const deleted = await room.destroy();
  assert.equal(deleted.status, 200);
  await event(sharer, 'room.destroyed');
  const peerEvents = viewer.events;
  await event(viewer, 'room.destroyed');
  await Promise.race([Promise.all([sharer.closed, viewer.closed]), wait(500)]);
  assert.equal(sharer.ws.readyState, WebSocket.CLOSED, 'deleted room closes the sharer socket');
  assert.equal(viewer.ws.readyState, WebSocket.CLOSED, 'deleted room closes the viewer socket');
  assert.equal(peerEvents.at(-1).type, 'room.destroyed');
});

test('room teardown rejects upgrades despite surviving membership', async (t) => {
  const room = await fixture(t);
  const member = await connect(room.roomId, room.first.cookie, room.sockets);
  const deleted = await room.destroy();
  assert.equal(deleted.status, 200);
  await event(member, 'room.destroyed');
  // Rebuild just the local D1 membership to hold the pre-delete DB view steady.
  // A late upgrade must still be rejected by the Durable Object teardown gate.
  assert.match(room.roomId, /^room_[a-z0-9]{10}$/);
  assert.match(room.first.memberId, /^user_[0-9a-f-]{36}$/);
  const now = new Date().toISOString();
  try {
    await localSql(`INSERT INTO rooms (id,target_at,created_at,updated_at) VALUES ('${room.roomId}','${now}','${now}','${now}'); INSERT INTO room_members (room_id,user_id,slot,joined_at) VALUES ('${room.roomId}','${room.first.memberId}',0,'${now}');`);
    const lateUpgrade = await rejectedSocket(room.roomId, room.first.cookie);
    assert.equal(lateUpgrade.status, 410);
  } finally {
    await localSql(`DELETE FROM room_members WHERE room_id = '${room.roomId}'; DELETE FROM rooms WHERE id = '${room.roomId}';`);
  }
});

test('failed room deletion restores the upgrade gate', async (t) => {
  const room = await fixture(t);
  const member = await connect(room.roomId, room.first.cookie, room.sockets);
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l3sAAAAASUVORK5CYII=', 'base64');
  const backgroundUrl = new URL(`/api/background?room=${room.roomId}`, origin);
  const uploaded = await fetch(backgroundUrl, { method: 'PUT', headers: { Cookie: room.first.cookie, 'Content-Type': 'image/png' }, body: image });
  assert.equal(uploaded.status, 200);
  const trigger = `test_room_delete_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  assert.match(room.roomId, /^room_[a-z0-9]{10}$/);
  await localSql(`CREATE TRIGGER ${trigger} BEFORE DELETE ON rooms WHEN OLD.id = '${room.roomId}' BEGIN SELECT RAISE(ABORT, 'test deletion failure'); END;`);
  try {
    const failed = await room.destroy();
    assert.equal(failed.status, 500);
    assert.equal(member.events.filter(({ type }) => type === 'room.destroyed').length, 0, 'failed deletion does not announce destruction');
    assert.equal(member.ws.readyState, WebSocket.OPEN, 'failed deletion leaves existing socket open');
    const background = await fetch(backgroundUrl, { headers: { Cookie: room.first.cookie } });
    assert.equal(background.status, 200, 'failed deletion retains room media');
    assert.deepEqual(Buffer.from(await background.arrayBuffer()), image);
    const returned = await connect(room.roomId, room.first.cookie, room.sockets);
    assert.equal(returned.events[0].type, 'room.ready');
    returned.ws.send(packet('pointer', { x: 0.5, y: 0.5, strength: 0.5 }));
    await event(member, 'pointer');
  } finally {
    await localSql(`DROP TRIGGER IF EXISTS ${trigger};`);
  }
});

test('logout closes only sockets of that login session', async (t) => {
  const room = await fixture(t);
  const secondLogin = await request('/api/auth/login', {
    method: 'POST', body: { username: room.first.username, password: room.first.password },
  });
  assert.equal(secondLogin.status, 200);
  room.accounts.push({ cookie: secondLogin.cookie });
  const oldA = await connect(room.roomId, room.first.cookie, room.sockets);
  const oldB = await connect(room.roomId, room.first.cookie, room.sockets);
  const current = await connect(room.roomId, secondLogin.cookie, room.sockets);
  const peer = await connect(room.roomId, room.second.cookie, room.sockets);
  await join(oldA, 'old-device');
  await join(peer, 'peer-device');
  const logout = await request('/api/auth/logout', { method: 'POST', cookie: room.first.cookie });
  assert.equal(logout.status, 200);
  const deadline = Date.now() + 2_000;
  while ((oldA.ws.readyState === WebSocket.OPEN || oldB.ws.readyState === WebSocket.OPEN) && Date.now() < deadline) await wait(10);
  assert.notEqual(oldA.ws.readyState, WebSocket.OPEN, 'logout closes first socket');
  assert.notEqual(oldB.ws.readyState, WebSocket.OPEN, 'logout closes second socket');
  assert.equal(current.ws.readyState, WebSocket.OPEN, 'independent login stays connected');
  const currentSession = await join(current, 'current-device');
  current.ws.send(packet('screening.share', { sessionId: currentSession, seq: 1, active: true, hasSourceAudio: false }));
  assert.equal((await event(peer, 'screening.share.changed')).payload.deviceId, 'current-device');
});

test('stale session and duplicate sequence cannot change share state', async (t) => {
  const room = await fixture(t);
  const sharer = await connect(room.roomId, room.first.cookie, room.sockets);
  const viewer = await connect(room.roomId, room.second.cookie, room.sockets);
  const sessionId = await join(sharer, 'sharer-device');
  await join(viewer, 'viewer-device');
  sharer.ws.send(packet('screening.share', { sessionId: 'stale-session', seq: 1, active: true, hasSourceAudio: false }));
  await wait(100);
  assert.equal(viewer.events.filter(({ type }) => type === 'screening.share.changed').length, 0);
  sharer.ws.send(packet('screening.share', { sessionId, seq: 1, active: true, hasSourceAudio: false }));
  await event(viewer, 'screening.share.changed');
  sharer.ws.send(packet('screening.share', { sessionId, seq: 1, active: false }));
  await wait(100);
  assert.equal(viewer.events.filter(({ type }) => type === 'screening.share.changed').length, 1);
});

test('danmaku is rate limited by the Worker', async (t) => {
  const room = await fixture(t);
  const sender = await connect(room.roomId, room.first.cookie, room.sockets);
  const viewer = await connect(room.roomId, room.second.cookie, room.sockets);
  const sessionId = await join(sender, 'sender-device');
  await join(viewer, 'viewer-device');
  sender.ws.send(packet('screening.danmaku', { sessionId, seq: 1, text: 'first' }));
  assert.equal((await event(viewer, 'screening.danmaku')).payload.text, 'first');
  sender.ws.send(packet('screening.danmaku', { sessionId, seq: 2, text: 'too fast' }));
  await wait(100);
  assert.equal(viewer.events.filter(({ type }) => type === 'screening.danmaku').length, 1);
});
