import assert from 'node:assert/strict';
import test from 'node:test';
import * as screeningProtocol from '../src/screening-protocol.ts';

const { parseScreeningMessage, transitionScreening } = screeningProtocol;

const sockets = () => [
  { socketId: 'a1', memberId: 'alice' },
  { socketId: 'a2', memberId: 'alice' },
  { socketId: 'b1', memberId: 'bob' },
  { socketId: 'c1', memberId: 'charlie' },
];
const peer = (peers, socketId) => peers.find((item) => item.socketId === socketId);
let nextSession = 0;
const session = () => `session-${++nextSession}`;
const send = (peers, socketId, type, payload, nowMs = 1000) => {
  const command = parseScreeningMessage(JSON.stringify({ type, payload }));
  assert.ok(command, `valid ${type} fixture`);
  return transitionScreening(peers, socketId, command, nowMs, session);
};
const joined = (peers, socketId, deviceId, takeover = false) =>
  send(peers, socketId, 'screening.join', { deviceId, takeover }).peers;
const command = (peers, socketId, type, seq, extra = {}, nowMs = 1000) =>
  send(peers, socketId, type, { sessionId: peer(peers, socketId)?.sessionId, seq, ...extra }, nowMs);

test('rejects malformed and oversized messages', () => {
  assert.equal(parseScreeningMessage('not json'), null);
  assert.equal(parseScreeningMessage('x'.repeat(65_537)), null);
  assert.equal(parseScreeningMessage(JSON.stringify({ type: 'screening.unknown', payload: {} })), null);
  assert.equal(parseScreeningMessage(JSON.stringify({ type: 'screening.join', payload: { deviceId: '' } })), null);
  assert.equal(parseScreeningMessage(JSON.stringify({ type: 'screening.leave', payload: { sessionId: 's', seq: 0 } })), null);
  assert.equal(parseScreeningMessage(JSON.stringify({ type: 'screening.danmaku', payload: { sessionId: 's', seq: 1, text: 'x'.repeat(81) } })), null);
  assert.equal(parseScreeningMessage(JSON.stringify({ type: 'screening.signal', payload: { sessionId: 's', seq: 1, kind: 'ice', negotiationId: 'n', targetDeviceId: 'd', data: 5 } })), null);
});

test('gates oversized screening before room JSON parse while preserving pointer and doodle', () => {
  const gate = screeningProtocol.shouldRejectOversizedRealtimeMessage;
  const padding = 'x'.repeat(65_537);
  assert.equal(gate(JSON.stringify({ type: 'screening.join', payload: { deviceId: 'd' }, padding })), true);
  assert.equal(gate(JSON.stringify({ padding, payload: { type: 'pointer' }, type: 'screening.join' })), true);
  assert.equal(gate(`{"type":"pointer","padding":"${padding}","type":"screening.join"}`), true);
  assert.equal(gate(JSON.stringify({ type: 'pointer', payload: { x: 0.5, y: 0.5, strength: 1, padding } })), false);
  assert.equal(gate(JSON.stringify({ padding, type: 'doodle.preview', payload: { id: 'doodle_12345678' } })), false);
  assert.equal(gate(JSON.stringify({ type: 'screening.danmaku', payload: { text: 'é'.repeat(33_000) } })), true);
  assert.equal(gate(JSON.stringify({ type: 'screening.join', payload: { deviceId: 'd' } })), false);
});

test('does not JSON.parse an oversized screening packet in the pre-parse gate', () => {
  const raw = JSON.stringify({ payload: { padding: 'x'.repeat(65_537) }, type: 'screening.join' });
  const originalParse = JSON.parse;
  let parseCalls = 0;
  try {
    JSON.parse = (...args) => { parseCalls++; return originalParse(...args); };
    assert.equal(screeningProtocol.shouldRejectOversizedRealtimeMessage(raw), true);
  } finally {
    JSON.parse = originalParse;
  }
  assert.equal(parseCalls, 0);
});

test('enforces two-member device and sharer ownership', () => {
  let peers = joined(sockets(), 'a1', 'alice-phone');
  const deniedDevice = send(peers, 'a2', 'screening.join', { deviceId: 'alice-laptop', takeover: false });
  assert.equal(peer(deniedDevice.peers, 'a2').sessionId, undefined);
  const takeover = send(peers, 'a2', 'screening.join', { deviceId: 'alice-laptop', takeover: true });
  assert.equal(takeover.events.some((event) => event.type === 'screening.taken-over' && event.socketId === 'a1'), true);
  assert.equal(peer(takeover.peers, 'a1').sessionId, undefined);
  peers = joined(takeover.peers, 'b1', 'bob-tablet');
  const thirdMember = send(peers, 'c1', 'screening.join', { deviceId: 'charlie-phone', takeover: false });
  assert.equal(peer(thirdMember.peers, 'c1').sessionId, undefined);
  peers = command(peers, 'a2', 'screening.share', 1, { active: true, hasSourceAudio: false }).peers;
  const secondSharer = command(peers, 'b1', 'screening.share', 1, { active: true, hasSourceAudio: false });
  assert.equal(secondSharer.events.some((event) => event.type === 'screening.share.changed'), false);
  assert.equal(peer(secondSharer.peers, 'b1').sharer, false);
  peers = command(secondSharer.peers, 'a2', 'screening.share', 2, { active: false }).peers;
  const handoff = command(peers, 'b1', 'screening.share', 2, { active: true, hasSourceAudio: false });
  assert.equal(peer(handoff.peers, 'b1').sharer, true);
  assert.equal(handoff.events.filter((event) => event.type === 'screening.share.changed').length, 2);
});

test('requires boolean source audio for active share and rejects true on inactive share', () => {
  const parse = (active, hasSourceAudio, includeAudio = true) => parseScreeningMessage(JSON.stringify({
    type: 'screening.share', payload: { sessionId: 's', seq: 1, active, ...(includeAudio ? { hasSourceAudio } : {}) },
  }));
  assert.equal(parse(true, undefined, false), null);
  assert.equal(parse(true, 'yes'), null);
  assert.deepEqual(parse(true, true), { type: 'screening.share', sessionId: 's', seq: 1, active: true, hasSourceAudio: true });
  assert.deepEqual(parse(true, false), { type: 'screening.share', sessionId: 's', seq: 1, active: true, hasSourceAudio: false });
  assert.equal(parse(false, true), null);
  assert.deepEqual(parse(false, undefined, false), { type: 'screening.share', sessionId: 's', seq: 1, active: false, hasSourceAudio: false });
  assert.deepEqual(parse(false, false), { type: 'screening.share', sessionId: 's', seq: 1, active: false, hasSourceAudio: false });
});

test('initial share persists source audio and announces it to both members', () => {
  let peers = joined(sockets(), 'a1', 'alice-phone');
  peers = joined(peers, 'b1', 'bob-tablet');
  const started = command(peers, 'a1', 'screening.share', 1, { active: true, hasSourceAudio: true });
  assert.equal(peer(started.peers, 'a1').hasSourceAudio, true);
  assert.deepEqual(started.events.map(({ socketId, type, payload }) => ({ socketId, type, payload })), [
    { socketId: 'a1', type: 'screening.share.changed', payload: { memberId: 'alice', deviceId: 'alice-phone', active: true, hasSourceAudio: true, requestSeq: 1 } },
    { socketId: 'b1', type: 'screening.share.changed', payload: { memberId: 'alice', deviceId: 'alice-phone', active: true, hasSourceAudio: true, requestSeq: 1 } },
  ]);
});

test('share confirmation echoes parsed command seq, not client requestSeq', () => {
  let peers = joined(sockets(), 'a1', 'alice-phone');
  peers = joined(peers, 'b1', 'bob-tablet');
  const parsed = parseScreeningMessage(JSON.stringify({ type: 'screening.share', payload: {
    sessionId: peer(peers, 'a1').sessionId, seq: 7, active: true, hasSourceAudio: true, requestSeq: 999,
  } }));
  assert.deepEqual(parsed, {
    type: 'screening.share', sessionId: peer(peers, 'a1').sessionId, seq: 7, active: true, hasSourceAudio: true,
  });
  const started = transitionScreening(peers, 'a1', parsed, 1000, session);
  assert.deepEqual(started.events.map(({ socketId, payload }) => ({ socketId, requestSeq: payload.requestSeq })), [
    { socketId: 'a1', requestSeq: 7 }, { socketId: 'b1', requestSeq: 7 },
  ]);
});

test('active sharer audio update broadcasts without resetting negotiation', () => {
  let peers = joined(sockets(), 'a1', 'alice-phone');
  peers = joined(peers, 'b1', 'bob-tablet');
  peers = command(peers, 'a1', 'screening.share', 1, { active: true, hasSourceAudio: true }).peers;
  peers = command(peers, 'a1', 'screening.signal', 2, {
    kind: 'offer', negotiationId: 'n1', targetDeviceId: 'bob-tablet', data: { type: 'offer', sdp: 'v=0' },
  }).peers;
  const updated = command(peers, 'a1', 'screening.share', 3, { active: true, hasSourceAudio: false });
  assert.equal(peer(updated.peers, 'a1').sharer, true);
  assert.equal(peer(updated.peers, 'a1').hasSourceAudio, false);
  assert.equal(peer(updated.peers, 'a1').negotiationId, 'n1');
  assert.deepEqual(updated.events.map(({ socketId, payload }) => ({ socketId, payload })), [
    { socketId: 'a1', payload: { memberId: 'alice', deviceId: 'alice-phone', active: true, hasSourceAudio: false, requestSeq: 3 } },
    { socketId: 'b1', payload: { memberId: 'alice', deviceId: 'alice-phone', active: true, hasSourceAudio: false, requestSeq: 3 } },
  ]);
  const unchanged = command(updated.peers, 'a1', 'screening.share', 4, { active: true, hasSourceAudio: false });
  assert.deepEqual(unchanged.events, []);
});

test('late join snapshot retains source audio across attachment JSON round-trip', () => {
  let peers = joined(sockets(), 'a1', 'alice-phone');
  peers = command(peers, 'a1', 'screening.share', 1, { active: true, hasSourceAudio: true }).peers;
  peers = JSON.parse(JSON.stringify(peers)); // mimic DO hibernation and attachment reload
  const newcomer = send(peers, 'b1', 'screening.join', { deviceId: 'bob-tablet', takeover: false });
  const joinedEvent = newcomer.events.find((event) => event.socketId === 'b1' && event.type === 'screening.joined');
  assert.deepEqual(joinedEvent.payload.peers, [
    { memberId: 'alice', deviceId: 'alice-phone', sharer: true, paused: false, micEnabled: false, hasSourceAudio: true },
  ]);
});

test('second simultaneous sharer gets no share confirmation, requestSeq, or audio state', () => {
  let peers = joined(sockets(), 'a1', 'alice-phone');
  peers = joined(peers, 'b1', 'bob-tablet');
  peers = command(peers, 'a1', 'screening.share', 1, { active: true, hasSourceAudio: true }).peers;
  const denied = command(peers, 'b1', 'screening.share', 1, { active: true, hasSourceAudio: true, requestSeq: 999 });
  assert.deepEqual(denied.events, []);
  assert.equal(peer(denied.peers, 'b1').sharer, false);
  assert.equal(peer(denied.peers, 'b1').hasSourceAudio, false);
  assert.equal(peer(denied.peers, 'a1').hasSourceAudio, true);
});

test('inactive share clears source audio and announces false', () => {
  let peers = joined(sockets(), 'a1', 'alice-phone');
  peers = joined(peers, 'b1', 'bob-tablet');
  peers = command(peers, 'a1', 'screening.share', 1, { active: true, hasSourceAudio: true }).peers;
  const stopped = command(peers, 'a1', 'screening.share', 2, { active: false });
  assert.equal(peer(stopped.peers, 'a1').hasSourceAudio, false);
  assert.deepEqual(stopped.events.map(({ socketId, payload }) => ({ socketId, payload })), [
    { socketId: 'a1', payload: { memberId: 'alice', deviceId: 'alice-phone', active: false, hasSourceAudio: false, requestSeq: 2 } },
    { socketId: 'b1', payload: { memberId: 'alice', deviceId: 'alice-phone', active: false, hasSourceAudio: false, requestSeq: 2 } },
  ]);
});

test('rapid active-inactive-active share events keep distinct request sequences in order after hibernation', () => {
  let peers = joined(sockets(), 'a1', 'alice-phone');
  peers = joined(peers, 'b1', 'bob-tablet');
  const first = command(peers, 'a1', 'screening.share', 1, { active: true, hasSourceAudio: true });
  const stopped = command(first.peers, 'a1', 'screening.share', 2, { active: false });
  peers = JSON.parse(JSON.stringify(stopped.peers)); // mimic serialized attachments after DO hibernation
  const retry = command(peers, 'a1', 'screening.share', 3, { active: true, hasSourceAudio: false });
  assert.deepEqual([...first.events, ...stopped.events, ...retry.events]
    .map(({ socketId, payload }) => [socketId, payload.active, payload.requestSeq]), [
      ['a1', true, 1], ['b1', true, 1],
      ['a1', false, 2], ['b1', false, 2],
      ['a1', true, 3], ['b1', true, 3],
    ]);
});

test('leave and takeover clear source audio and announce share stopped', () => {
  let peers = joined(sockets(), 'a1', 'alice-phone');
  peers = joined(peers, 'b1', 'bob-tablet');
  peers = command(peers, 'a1', 'screening.share', 1, { active: true, hasSourceAudio: true }).peers;
  const left = command(peers, 'a1', 'screening.leave', 2);
  assert.equal(peer(left.peers, 'a1').hasSourceAudio, undefined);
  assert.deepEqual(left.events.find((event) => event.socketId === 'b1' && event.type === 'screening.share.changed').payload,
    { memberId: 'alice', deviceId: 'alice-phone', active: false, hasSourceAudio: false });

  peers = joined(sockets(), 'a1', 'alice-phone');
  peers = joined(peers, 'b1', 'bob-tablet');
  peers = command(peers, 'a1', 'screening.share', 1, { active: true, hasSourceAudio: true }).peers;
  const takeover = send(peers, 'a2', 'screening.join', { deviceId: 'alice-laptop', takeover: true });
  assert.equal(peer(takeover.peers, 'a1').hasSourceAudio, undefined);
  assert.equal(peer(takeover.peers, 'a2').hasSourceAudio, false);
  assert.deepEqual(takeover.events.find((event) => event.socketId === 'b1' && event.type === 'screening.share.changed').payload,
    { memberId: 'alice', deviceId: 'alice-phone', active: false, hasSourceAudio: false });
});

test('rejects stale sequence and negotiation', () => {
  let peers = joined(sockets(), 'a1', 'alice-phone');
  peers = joined(peers, 'b1', 'bob-tablet');
  peers = command(peers, 'a1', 'screening.share', 1, { active: true, hasSourceAudio: false }).peers;
  const offer = command(peers, 'a1', 'screening.signal', 2, { kind: 'offer', negotiationId: 'n1', targetDeviceId: 'bob-tablet', data: { type: 'offer', sdp: 'v=0' }, actorId: 'mallory' });
  assert.deepEqual(offer.events.filter((event) => event.type === 'screening.signal').map((event) => event.socketId), ['b1']);
  assert.equal(offer.events[0].payload.memberId, 'alice');
  peers = offer.peers;
  const repeated = command(peers, 'a1', 'screening.signal', 2, { kind: 'ice', negotiationId: 'n1', targetDeviceId: 'bob-tablet', data: { candidate: 'old' } });
  assert.deepEqual(repeated.events, []);
  const reusedNegotiation = command(peers, 'a1', 'screening.signal', 3, { kind: 'offer', negotiationId: 'n1', targetDeviceId: 'bob-tablet', data: { type: 'offer', sdp: 'v=0' } });
  assert.deepEqual(reusedNegotiation.events, []);
  peers = command(reusedNegotiation.peers, 'a1', 'screening.signal', 4, { kind: 'offer', negotiationId: 'n2', targetDeviceId: 'bob-tablet', data: { type: 'offer', sdp: 'v=0' } }).peers;
  peers = JSON.parse(JSON.stringify(peers)); // mimic serialized attachments after DO hibernation
  const olderNegotiation = command(peers, 'a1', 'screening.signal', 5, { kind: 'offer', negotiationId: 'n1', targetDeviceId: 'bob-tablet', data: { type: 'offer', sdp: 'v=0' } });
  assert.deepEqual(olderNegotiation.events, []);
  assert.equal(peer(olderNegotiation.peers, 'a1').negotiationId, 'n2');
  peers = olderNegotiation.peers;
  const staleIce = command(peers, 'b1', 'screening.signal', 1, { kind: 'ice', negotiationId: 'n1', targetDeviceId: 'alice-phone', data: { candidate: 'old' } });
  assert.deepEqual(staleIce.events, []);
  const wrongTarget = command(staleIce.peers, 'b1', 'screening.signal', 2, { kind: 'answer', negotiationId: 'n2', targetDeviceId: 'alice-other', data: { type: 'answer', sdp: 'v=0' } });
  assert.deepEqual(wrongTarget.events, []);
  const oldSession = send(wrongTarget.peers, 'a1', 'screening.leave', { sessionId: 'session-stale', seq: 100 });
  assert.deepEqual(oldSession.events, []);
});

test('64 negotiation IDs stay within the attachment budget and emoji IDs cannot enter history', () => {
  let peers = joined(sockets(), 'a1', 'alice-phone');
  peers = joined(peers, 'b1', 'bob-tablet');
  peers = command(peers, 'a1', 'screening.share', 1, { active: true, hasSourceAudio: false }).peers;
  const emojiIds = Array.from({ length: 64 }, (_, index) => '😀'.repeat(63) + String.fromCharCode(65 + index));
  assert.ok(Buffer.byteLength(JSON.stringify({ ...peer(peers, 'a1'), roomId: 'room_0123456789',
    negotiationId: emojiIds.at(-1), usedNegotiationIds: emojiIds })) > 16_384);
  let acceptedEmojiIds = 0;
  for (let index = 0; index < 64; index++) {
    const negotiationId = emojiIds[index];
    const parsed = parseScreeningMessage(JSON.stringify({ type: 'screening.signal', payload: {
      sessionId: peer(peers, 'a1').sessionId, seq: index + 2, kind: 'offer', negotiationId,
      targetDeviceId: 'bob-tablet', data: { type: 'offer', sdp: 'v=0' },
    } }));
    if (!parsed) continue;
    acceptedEmojiIds++;
    peers = transitionScreening(peers, 'a1', parsed, 1000, session).peers;
  }
  assert.equal(acceptedEmojiIds, 0);
  assert.ok(Buffer.byteLength(JSON.stringify({ ...peer(peers, 'a1'), roomId: 'room_0123456789' })) < 16_384);

  for (let index = 0; index < 64; index++) {
    const negotiationId = `${String(index).padStart(2, '0')}${'a'.repeat(62)}`;
    peers = command(peers, 'a1', 'screening.signal', index + 2, {
      kind: 'offer', negotiationId, targetDeviceId: 'bob-tablet', data: { type: 'offer', sdp: 'v=0' },
    }).peers;
  }
  assert.equal(peer(peers, 'a1').usedNegotiationIds.length, 64);
  assert.ok(Buffer.byteLength(JSON.stringify({ ...peer(peers, 'a1'), roomId: 'room_0123456789' })) < 16_384);
});

test('does not relay an offer when a peer attachment write fails', () => {
  let peers = joined(sockets(), 'a1', 'alice-phone');
  peers = joined(peers, 'b1', 'bob-tablet');
  peers = command(peers, 'a1', 'screening.share', 1, { active: true, hasSourceAudio: false }).peers;
  const result = command(peers, 'a1', 'screening.signal', 2, {
    kind: 'offer', negotiationId: 'n1', targetDeviceId: 'bob-tablet', data: { type: 'offer', sdp: 'v=0' },
  });
  const sent = [];
  const byId = new Map([
    ['a1', { attachment: peer(peers, 'a1'), socket: { serializeAttachment() {}, send(message) { sent.push(message); } } }],
    ['b1', { attachment: peer(peers, 'b1'), socket: { serializeAttachment() { throw new Error('attachment too large'); }, send(message) { sent.push(message); } } }],
  ]);
  assert.equal(screeningProtocol.applyScreeningTransition(result, byId, (event) => event.type), false);
  assert.deepEqual(sent, []);
});

test('relays an offer after both peer attachment writes succeed', () => {
  let peers = joined(sockets(), 'a1', 'alice-phone');
  peers = joined(peers, 'b1', 'bob-tablet');
  peers = command(peers, 'a1', 'screening.share', 1, { active: true, hasSourceAudio: false }).peers;
  const result = command(peers, 'a1', 'screening.signal', 2, {
    kind: 'offer', negotiationId: 'n1', targetDeviceId: 'bob-tablet', data: { type: 'offer', sdp: 'v=0' },
  });
  const sent = [];
  const writes = [];
  const byId = new Map(['a1', 'b1'].map((socketId) => [socketId, {
    attachment: peer(peers, socketId),
    socket: { serializeAttachment(next) { writes.push({ socketId, next }); }, send(message) { sent.push({ socketId, message }); } },
  }]));
  assert.equal(screeningProtocol.applyScreeningTransition(result, byId, (event) => event.type), true);
  assert.deepEqual(writes.map(({ socketId }) => socketId), ['a1', 'b1']);
  assert.deepEqual(sent, [{ socketId: 'b1', message: 'screening.signal' }]);
});

test('rate-limits short danmaku', () => {
  let peers = joined(sockets(), 'a1', 'alice-phone');
  const first = command(peers, 'a1', 'screening.danmaku', 1, { text: '  hello  ' }, 1000);
  assert.equal(first.events[0].payload.text, 'hello');
  peers = first.peers;
  const tooSoon = command(peers, 'a1', 'screening.danmaku', 2, { text: 'again' }, 1999);
  assert.deepEqual(tooSoon.events, []);
  const allowed = command(tooSoon.peers, 'a1', 'screening.danmaku', 3, { text: 'again' }, 2000);
  assert.equal(allowed.events.some((event) => event.type === 'screening.danmaku'), true);
});

test('danmaku rate window survives leave and rejoin by the same member', () => {
  let peers = joined(sockets(), 'a1', 'alice-phone');
  peers = joined(peers, 'b1', 'bob-tablet');
  peers = command(peers, 'a1', 'screening.danmaku', 1, { text: 'first' }, 1000).peers;
  peers = command(peers, 'a1', 'screening.leave', 2, {}, 1001).peers;
  peers = joined(peers, 'a2', 'alice-laptop');
  const tooSoon = command(peers, 'a2', 'screening.danmaku', 1, { text: 'too soon' }, 1002);
  assert.equal(tooSoon.events.some((event) => event.type === 'screening.danmaku'), false);
  const allowed = command(tooSoon.peers, 'a2', 'screening.danmaku', 2, { text: 'allowed' }, 2000);
  assert.equal(allowed.events.some((event) => event.type === 'screening.danmaku'), true);
});

test('requires sharer pause confirmation', () => {
  let peers = joined(sockets(), 'a1', 'alice-phone');
  peers = joined(peers, 'b1', 'bob-tablet');
  peers = command(peers, 'a1', 'screening.share', 1, { active: true, hasSourceAudio: false }).peers;
  const requested = command(peers, 'b1', 'screening.pause.request', 1, { paused: true });
  assert.equal(requested.events.some((event) => event.type === 'screening.pause.requested'), true);
  const falseConfirm = command(requested.peers, 'b1', 'screening.pause.confirm', 2, { paused: true });
  assert.deepEqual(falseConfirm.events, []);
  const confirmed = command(falseConfirm.peers, 'a1', 'screening.pause.confirm', 2, { paused: true });
  assert.equal(confirmed.events.filter((event) => event.type === 'screening.pause.confirmed').length, 2);
  assert.equal(peer(confirmed.peers, 'a1').paused, true);
  const duplicate = command(confirmed.peers, 'a1', 'screening.pause.confirm', 3, { paused: true });
  assert.deepEqual(duplicate.events, []);
});

test('leaving the sharer clears confirmed pause and notifies the remaining device', () => {
  let peers = joined(sockets(), 'a1', 'alice-phone');
  peers = joined(peers, 'b1', 'bob-tablet');
  peers = command(peers, 'a1', 'screening.share', 1, { active: true, hasSourceAudio: false }).peers;
  peers = command(peers, 'b1', 'screening.pause.request', 1, { paused: true }).peers;
  peers = command(peers, 'a1', 'screening.pause.confirm', 2, { paused: true }).peers;
  const left = command(peers, 'a1', 'screening.leave', 3);
  assert.equal(peer(left.peers, 'b1').paused, false);
  assert.equal(left.events.some((event) => event.socketId === 'b1' && event.type === 'screening.peer.left'), true);
  assert.equal(left.events.some((event) => event.socketId === 'b1' && event.type === 'screening.share.changed' && event.payload.active === false), true);
});
