import assert from 'node:assert/strict';
import test from 'node:test';
import { parseScreeningMessage, transitionScreening } from '../src/screening-protocol.ts';

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
  peers = command(peers, 'a2', 'screening.share', 1, { active: true }).peers;
  const secondSharer = command(peers, 'b1', 'screening.share', 1, { active: true });
  assert.equal(secondSharer.events.some((event) => event.type === 'screening.share.changed'), false);
  assert.equal(peer(secondSharer.peers, 'b1').sharer, false);
  peers = command(secondSharer.peers, 'a2', 'screening.share', 2, { active: false }).peers;
  const handoff = command(peers, 'b1', 'screening.share', 2, { active: true });
  assert.equal(peer(handoff.peers, 'b1').sharer, true);
  assert.equal(handoff.events.filter((event) => event.type === 'screening.share.changed').length, 2);
});

test('rejects stale sequence and negotiation', () => {
  let peers = joined(sockets(), 'a1', 'alice-phone');
  peers = joined(peers, 'b1', 'bob-tablet');
  peers = command(peers, 'a1', 'screening.share', 1, { active: true }).peers;
  const offer = command(peers, 'a1', 'screening.signal', 2, { kind: 'offer', negotiationId: 'n1', targetDeviceId: 'bob-tablet', data: { type: 'offer', sdp: 'v=0' }, actorId: 'mallory' });
  assert.deepEqual(offer.events.filter((event) => event.type === 'screening.signal').map((event) => event.socketId), ['b1']);
  assert.equal(offer.events[0].payload.memberId, 'alice');
  peers = offer.peers;
  const repeated = command(peers, 'a1', 'screening.signal', 2, { kind: 'ice', negotiationId: 'n1', targetDeviceId: 'bob-tablet', data: { candidate: 'old' } });
  assert.deepEqual(repeated.events, []);
  const reusedNegotiation = command(peers, 'a1', 'screening.signal', 3, { kind: 'offer', negotiationId: 'n1', targetDeviceId: 'bob-tablet', data: { type: 'offer', sdp: 'v=0' } });
  assert.deepEqual(reusedNegotiation.events, []);
  peers = command(reusedNegotiation.peers, 'a1', 'screening.signal', 4, { kind: 'offer', negotiationId: 'n2', targetDeviceId: 'bob-tablet', data: { type: 'offer', sdp: 'v=0' } }).peers;
  const staleIce = command(peers, 'b1', 'screening.signal', 1, { kind: 'ice', negotiationId: 'n1', targetDeviceId: 'alice-phone', data: { candidate: 'old' } });
  assert.deepEqual(staleIce.events, []);
  const wrongTarget = command(staleIce.peers, 'b1', 'screening.signal', 2, { kind: 'answer', negotiationId: 'n2', targetDeviceId: 'alice-other', data: { type: 'answer', sdp: 'v=0' } });
  assert.deepEqual(wrongTarget.events, []);
  const oldSession = send(wrongTarget.peers, 'a1', 'screening.leave', { sessionId: 'session-stale', seq: 100 });
  assert.deepEqual(oldSession.events, []);
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

test('requires sharer pause confirmation', () => {
  let peers = joined(sockets(), 'a1', 'alice-phone');
  peers = joined(peers, 'b1', 'bob-tablet');
  peers = command(peers, 'a1', 'screening.share', 1, { active: true }).peers;
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
  peers = command(peers, 'a1', 'screening.share', 1, { active: true }).peers;
  peers = command(peers, 'b1', 'screening.pause.request', 1, { paused: true }).peers;
  peers = command(peers, 'a1', 'screening.pause.confirm', 2, { paused: true }).peers;
  const left = command(peers, 'a1', 'screening.leave', 3);
  assert.equal(peer(left.peers, 'b1').paused, false);
  assert.equal(left.events.some((event) => event.socketId === 'b1' && event.type === 'screening.peer.left'), true);
  assert.equal(left.events.some((event) => event.socketId === 'b1' && event.type === 'screening.share.changed' && event.payload.active === false), true);
});
