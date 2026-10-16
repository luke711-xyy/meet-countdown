import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createScreeningRoom } from '../public/screening-room.js';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function setup({ capture = true } = {}) {
  const dom = new JSDOM(html, { url: 'https://example.test/?room=r1' });
  const { document } = dom.window;
  Object.defineProperty(dom.window.navigator, 'mediaDevices', { value: capture ? { getDisplayMedia() {} } : {} });
  const root = document.querySelector('#screening-room');
  const trigger = document.querySelector('#open-screening');
  const sent = [];
  const media = [];
  const controller = createScreeningRoom({
    root, trigger, send: (command) => { sent.push(command); return true; },
    getContext: () => ({ roomId: 'r1', memberId: 'm1', members: [{ id: 'm1', username: '我' }, { id: 'm2', username: '对方' }] }),
    createMedia: (callbacks) => {
      const instance = {
        callbacks, closed: false, restarts: 0, signals: [],
        startSharing: async () => ({ hasVideo: true, hasSourceAudio: false }),
        stopSharing() { callbacks.onShareChange({ active: false, hasSourceAudio: false }); },
        enableMic: async () => { await callbacks.onMicChange(true); return true; },
        setMicEnabled(value) { callbacks.onMicChange(value); return value; },
        handleSignal(signal) { this.signals.push(signal); return Promise.resolve(true); },
        restartIce() { this.restarts++; return Promise.resolve(true); },
        close() { this.closed = true; callbacks.onRemoteStream(null); },
      };
      media.push(instance);
      return instance;
    },
  });
  const event = (type, payload) => controller.handleEvent({ type, payload });
  const joined = (peers = []) => event('screening.joined', { sessionId: 's1', memberId: 'm1', deviceId: sent[0]?.payload.deviceId, peers });
  return { dom, document, root, trigger, sent, media, controller, event, joined };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('entry and glass controls remain accessible', async () => {
  const { document, root, trigger, sent, controller, joined } = setup();
  assert.equal(trigger.getAttribute('aria-label'), '进入放映室');
  assert.equal(root.hidden, true);
  await controller.open();
  assert.equal(root.hidden, false);
  assert.equal(sent[0].type, 'screening.join');
  joined();
  assert.equal(document.activeElement, document.querySelector('#screening-close'));
  for (const id of ['screening-mic', 'screening-danmaku-input', 'screening-pause', 'screening-share', 'screening-close']) {
    assert.ok(document.querySelector(`#${id}`).getAttribute('aria-label') || document.querySelector(`label[for="${id}"]`));
  }
  document.dispatchEvent(new document.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(root.hidden, true);
  assert.equal(document.activeElement, trigger);
  assert.equal(sent.at(-1).type, 'screening.leave');
});

test('unsupported capture leaves viewer controls usable', async () => {
  const { document, controller, joined } = setup({ capture: false });
  await controller.open(); joined();
  const shareButton = document.querySelector('#screening-share');
  const micButton = document.querySelector('#screening-mic');
  assert.equal(shareButton.disabled, true);
  assert.equal(micButton.disabled, false);
  assert.equal(document.querySelector('#screening-danmaku-input').disabled, false);
});

test('missing source audio is explicit', async () => {
  const { document, controller, joined, media } = setup();
  await controller.open(); joined();
  media[0].callbacks.onStatus({ state: 'no-source-audio' });
  const status = document.querySelector('#screening-status');
  assert.match(status.textContent, /未共享影片声音/);
});

test('direct connection failure is explicit', async () => {
  const { document, controller, joined, media } = setup();
  await controller.open(); joined();
  media[0].callbacks.onStatus({ state: 'direct-failed' });
  assert.match(document.querySelector('#screening-status').textContent, /直连失败.*换网络/);
});

test('pause and autoplay states are honest', async () => {
  const { document, controller, joined, event, sent, media } = setup();
  await controller.open(); joined([{ memberId: 'm2', deviceId: 'd2', sharer: true, paused: false }]);
  document.querySelector('#screening-pause').click();
  assert.equal(sent.at(-1).type, 'screening.pause.request');
  assert.match(document.querySelector('#screening-status').textContent, /等待分享者确认/);
  event('screening.pause.confirmed', { memberId: 'm2', deviceId: 'd2', paused: true });
  assert.match(document.querySelector('#screening-pause').getAttribute('aria-label'), /继续/);
  const video = document.querySelector('#screening-video');
  video.play = () => Promise.reject(new Error('autoplay'));
  media[0].callbacks.onRemoteStream({ id: 'stream' });
  await tick();
  assert.equal(document.querySelector('#screening-enable-audio').hidden, false);
  assert.match(document.querySelector('#screening-status').textContent, /开启声音/);
});

test('share announcement precedes first offer and no peer rejects signaling', async () => {
  const { controller, joined, sent, media } = setup();
  await controller.open(); joined();
  const callbacks = media[0].callbacks;
  await callbacks.onShareChange({ active: true, hasSourceAudio: true });
  assert.equal(sent.at(-1).type, 'screening.share');
  await assert.rejects(callbacks.sendSignal({ kind: 'offer', negotiationId: 'n1', data: { type: 'offer', sdp: 'v=0' } }));
});

test('peer return restarts sharer without stopping capture and viewer recovery is bounded', async () => {
  const { controller, joined, event, sent, media } = setup();
  await controller.open(); joined([{ memberId: 'm2', deviceId: 'd2', sharer: false }]);
  await media[0].callbacks.onShareChange({ active: true, hasSourceAudio: false });
  event('screening.peer.left', { memberId: 'm2', deviceId: 'd2' });
  assert.equal(media[0].closed, false);
  event('screening.peer.joined', { memberId: 'm2', deviceId: 'd3' });
  await tick();
  assert.equal(media[0].restarts, 1);
  controller.close();

  const viewer = setup();
  await viewer.controller.open(); viewer.joined([{ memberId: 'm2', deviceId: 'd2', sharer: true }]);
  viewer.media[0].callbacks.onStatus({ state: 'needs-sharer-renegotiation' });
  await tick();
  assert.deepEqual(viewer.sent.slice(-2).map((command) => command.type), ['screening.leave', 'screening.join']);
  viewer.event('screening.joined', { sessionId: 's2', memberId: 'm1', deviceId: viewer.sent[0].payload.deviceId, peers: [{ memberId: 'm2', deviceId: 'd2', sharer: true }] });
  viewer.media[0].callbacks.onStatus({ state: 'needs-sharer-renegotiation' });
  await tick();
  assert.equal(viewer.sent.filter((command) => command.type === 'screening.leave').length, 1);
});

test('signal forwards only media shape and takeover closes media', async () => {
  const { controller, joined, event, media } = setup();
  await controller.open(); joined([{ memberId: 'm2', deviceId: 'd2', sharer: true }]);
  event('screening.signal', { memberId: 'm2', deviceId: 'd2', sessionId: 'other', kind: 'offer', negotiationId: 'n2', data: { type: 'offer', sdp: 'v=0' } });
  assert.deepEqual(media[0].signals[0], { kind: 'offer', negotiationId: 'n2', data: { type: 'offer', sdp: 'v=0' } });
  event('screening.taken-over', { memberId: 'm1', deviceId: 'elsewhere' });
  assert.equal(media[0].closed, true);
});

test('viewer mic uses mic.changed to ask sharer for an offer without a fake command', async () => {
  const viewer = setup();
  await viewer.controller.open(); viewer.joined([{ memberId: 'm2', deviceId: 'd2', sharer: true }]);
  viewer.document.querySelector('#screening-mic').click();
  await tick();
  assert.equal(viewer.sent.at(-1).type, 'screening.mic');
  viewer.media[0].callbacks.onStatus({ state: 'needs-sharer-renegotiation' });
  await tick();
  assert.equal(viewer.sent.some((command) => command.type === 'screening.leave'), false);

  const sharer = setup();
  await sharer.controller.open(); sharer.joined([{ memberId: 'm2', deviceId: 'd2', sharer: false }]);
  await sharer.media[0].callbacks.onShareChange({ active: true, hasSourceAudio: true });
  sharer.event('screening.mic.changed', { memberId: 'm2', deviceId: 'd2', enabled: true });
  await tick();
  assert.equal(sharer.media[0].restarts, 1);
  await sharer.media[0].callbacks.sendSignal({ kind: 'offer', negotiationId: 'n3', data: { type: 'offer', sdp: 'v=0' } });
  assert.deepEqual(sharer.sent.at(-1), { type: 'screening.signal', payload: { sessionId: 's1', seq: 2, kind: 'offer', negotiationId: 'n3', data: { type: 'offer', sdp: 'v=0' }, targetDeviceId: 'd2' } });
});
