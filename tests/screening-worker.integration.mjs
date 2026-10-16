import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const origin = new URL(process.env.SCREENING_TEST_ORIGIN ?? 'http://127.0.0.1:8787');
if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) {
  throw new Error('Screening integration tests require a local HTTP Worker');
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const packet = (type, payload) => JSON.stringify({ type, payload });

async function request(path, { cookie, method = 'GET', body } = {}) {
  const response = await fetch(new URL(path, origin), {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], body: await response.json() };
}

async function register() {
  const username = `screen${randomUUID().replaceAll('-', '').slice(0, 14)}`;
  const response = await request('/api/auth/register', {
    method: 'POST', body: { username, password: randomUUID() },
  });
  assert.equal(response.status, 201, 'local test account registration succeeds');
  assert.ok(response.cookie, 'registration returns an auth cookie');
  return { cookie: response.cookie, memberId: response.body.user.id };
}

async function fixture(t, { outsider = false } = {}) {
  const accounts = [];
  const sockets = [];
  let roomId;
  t.after(async () => {
    await Promise.all(sockets.map(async (client) => {
      if (client.ws.readyState === WebSocket.CLOSED) return;
      client.ws.close();
      await Promise.race([client.closed, wait(500)]);
      if (client.ws.readyState !== WebSocket.CLOSED) client.ws.terminate();
    }));
    if (roomId) await request(`/api/room?room=${roomId}`, { method: 'DELETE', cookie: accounts[0]?.cookie });
    await Promise.all(accounts.map(({ cookie }) => request('/api/auth/logout', { method: 'POST', cookie })));
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
  return { first, second, guest, roomId, sockets, destroy: () => request(`/api/room?room=${roomId}`, { method: 'DELETE', cookie: first.cookie }) };
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
  assert.equal(peerEvents.at(-1).type, 'room.destroyed');
  await Promise.race([Promise.all([sharer.closed, viewer.closed]), wait(500)]);
  assert.equal(sharer.ws.readyState, WebSocket.CLOSED, 'deleted room closes the sharer socket');
  assert.equal(viewer.ws.readyState, WebSocket.CLOSED, 'deleted room closes the viewer socket');
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
