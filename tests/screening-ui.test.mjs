import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createScreeningRoom } from '../public/screening-room.js';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

test('screening shell uses available width while video keeps its full uncropped frame', () => {
  for (const width of [390, 1440, 2560]) {
    const dom = new JSDOM(html, { url: 'https://example.test/' });
    dom.window.innerWidth = width;
    const style = dom.window.document.createElement('style');
    style.textContent = css;
    dom.window.document.head.append(style);
    const shell = dom.window.getComputedStyle(dom.window.document.querySelector('.screening-shell'));
    const video = dom.window.getComputedStyle(dom.window.document.querySelector('#screening-video'));
    assert.equal(shell.width, '100%', `${width}px viewport must not cap the screening shell`);
    assert.equal(video.objectFit, 'contain', `${width}px viewport must not crop the picture`);
    dom.window.close();
  }
});

test('screening stage fills the shell beneath overlaid heading and controls', () => {
  const dom = new JSDOM(html, { url: 'https://example.test/' });
  const style = dom.window.document.createElement('style');
  style.textContent = css;
  dom.window.document.head.append(style);
  const computed = (selector) => dom.window.getComputedStyle(dom.window.document.querySelector(selector));
  assert.equal(computed('.screening-shell').position, 'relative');
  assert.equal(computed('.screening-stage').width, '100%');
  assert.equal(computed('.screening-stage').height, '100%');
  assert.equal(computed('.screening-heading').position, 'absolute');
  assert.equal(computed('.screening-bottom').position, 'absolute');
  assert.equal(computed('#screening-video').objectFit, 'contain');
  assert.equal(computed('.screening-audio-action').top, '50%', 'autoplay unlock must stay clear of the bottom overlay');
  dom.window.document.querySelector('#screening-room').classList.add('is-idle');
  assert.equal(computed('.screening-controls').opacity, '0');
  dom.window.close();
});

test('screening notices can scroll above controls in a short viewport', () => {
  const dom = new JSDOM(html, { url: 'https://example.test/' });
  const { document } = dom.window;
  const notices = document.querySelector('.screening-notices');
  const actions = document.querySelector('.screening-actions');
  const heading = document.querySelector('.screening-heading');
  assert.ok(notices);
  assert.ok(actions);
  assert.equal(notices.contains(document.getElementById('screening-status')), true);
  assert.equal(heading.contains(document.getElementById('screening-audio-indicator')), true);
  for (const id of ['screening-takeover', 'screening-confirm-row']) {
    assert.equal(actions.contains(document.getElementById(id)), true);
    assert.equal(notices.contains(document.getElementById(id)), false);
  }
  assert.equal(notices.contains(document.querySelector('.screening-controls')), false);
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
  assert.equal(dom.window.getComputedStyle(notices).overflowY, 'auto');
  assert.equal(dom.window.getComputedStyle(actions).flex, '0 0 auto');
  assert.match(css, /@media \(max-height: 420px\)[\s\S]*?\.screening-bottom\s*\{[^}]*max-height:\s*calc\(100% - 56px\);/);
  dom.window.close();
});

test('narrow screening controls retain DOM tab order in two rows with touch-sized targets', () => {
  const controls = new JSDOM(html).window.document.querySelector('.screening-controls');
  assert.deepEqual([...controls.querySelectorAll('button, input')].map((node) => node.id || node.getAttribute('aria-label')),
    ['screening-mic', 'screening-danmaku-input', '发送弹幕', 'screening-pause', 'screening-share', 'screening-close']);
  assert.match(css, /@media \(max-width: 430px\)[\s\S]*?\.screening-message\s*\{[^}]*grid-column:\s*2\s*\/\s*4;/);
  assert.match(css, /@media \(max-width: 430px\)[\s\S]*?#screening-pause\s*\{[^}]*grid-column:\s*1;/);
  assert.match(css, /@media \(max-width: 430px\)[\s\S]*?\.screening-orb\s*\{[^}]*min-width:\s*44px;/);
  assert.match(css, /@media \(max-width: 820px\), \(pointer: coarse\)[\s\S]*?\.screening-message input\s*\{[^}]*height:\s*44px;/);
  assert.match(css, /@media \(hover: none\), \(pointer: coarse\)[\s\S]*?\.screening-room\.is-idle[^}]*\.screening-controls\s*\{[^}]*opacity:\s*1;/);
});

function setup({ capture = true, sendResponse = () => true } = {}) {
  const dom = new JSDOM(html, { url: 'https://example.test/?room=r1' });
  const { document } = dom.window;
  Object.defineProperty(dom.window.navigator, 'mediaDevices', { value: capture ? { getDisplayMedia() {} } : {} });
  const root = document.querySelector('#screening-room');
  const trigger = document.querySelector('#open-screening');
  const sent = [];
  const media = [];
  const controller = createScreeningRoom({
    root, trigger, send: (command) => { sent.push(command); return sendResponse(command); },
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
  const shareAck = (hasSourceAudio, requestSeq = sent.findLast((command) => command.type === 'screening.share' && command.payload.active)?.payload.seq) =>
    event('screening.share.changed', { memberId: 'm1', deviceId: sent[0]?.payload.deviceId, active: true, hasSourceAudio, requestSeq });
  return { dom, document, root, trigger, sent, media, controller, event, joined, shareAck };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('entry and glass controls remain accessible', async () => {
  const { document, root, trigger, sent, controller, joined } = setup();
  assert.equal(trigger.getAttribute('aria-label'), '进入放映室');
  assert.equal(root.hidden, true);
  await controller.open();
  assert.equal(root.hidden, false);
  assert.equal(document.querySelector('#screening-video').hidden, true);
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

test('desktop controls wake after idle on keyboard focus or pointer movement', async () => {
  const room = setup();
  const win = room.document.defaultView;
  const style = room.document.createElement('style');
  style.textContent = css;
  room.document.head.append(style);
  const controls = room.document.querySelector('.screening-controls');
  const originalSetTimeout = win.setTimeout.bind(win);
  let idleCallback;
  win.setTimeout = (callback, delay, ...args) => {
    if (delay === 5000) { idleCallback = callback; return 321; }
    return originalSetTimeout(callback, delay, ...args);
  };
  await room.controller.open(); room.joined();
  assert.equal(typeof idleCallback, 'function');
  idleCallback();
  assert.equal(room.root.classList.contains('is-idle'), true);
  assert.equal(win.getComputedStyle(controls).opacity, '0', 'initial dialog focus should not keep controls visible forever');
  room.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  assert.equal(room.root.classList.contains('is-keyboard-active'), true);
  assert.equal(win.getComputedStyle(controls).opacity, '1');
  room.root.dispatchEvent(new win.Event('pointermove', { bubbles: true }));
  assert.equal(room.root.classList.contains('is-keyboard-active'), false);
  idleCallback();
  assert.equal(win.getComputedStyle(controls).opacity, '0');
  room.document.activeElement.blur();
  room.document.querySelector('#screening-mic').focus();
  assert.equal(room.root.classList.contains('is-idle'), false);
  room.root.dispatchEvent(new win.Event('pointerdown', { bubbles: true }));
  assert.equal(room.root.classList.contains('is-keyboard-active'), false);
  room.document.activeElement.blur();
  await Promise.resolve();
  room.document.querySelector('#screening-mic').focus();
  assert.equal(room.root.classList.contains('is-keyboard-active'), false, 'pointer-origin focus should still fade');
  idleCallback();
  assert.equal(room.root.classList.contains('is-idle'), true);
  room.root.dispatchEvent(new win.Event('pointermove', { bubbles: true }));
  assert.equal(room.root.classList.contains('is-idle'), false);
  room.controller.close();
  room.dom.window.close();
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

test('mic control returns to off when media reports sharing cleanup', async () => {
  const room = setup();
  await room.controller.open(); room.joined();
  const button = room.document.querySelector('#screening-mic');
  await room.media[0].callbacks.onMicChange(true);
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  await room.media[0].callbacks.onMicChange(false);
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.equal(button.getAttribute('aria-label'), '开启麦克风');
});

test('missing source audio is explicit', async () => {
  const { document, controller, joined, media, event } = setup();
  await controller.open(); joined([{ memberId: 'm2', deviceId: 'd2', sharer: true, hasSourceAudio: false }]);
  const indicator = document.querySelector('#screening-audio-indicator');
  assert.equal(indicator.hidden, false);
  assert.match(indicator.textContent, /未共享影片声音/);
  media[0].callbacks.onStatus({ state: 'connected' });
  assert.equal(indicator.hidden, false);
  event('screening.share.changed', { memberId: 'm2', deviceId: 'd2', active: true, hasSourceAudio: true });
  assert.equal(indicator.hidden, true);
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
  assert.equal(video.hidden, false);
  await tick();
  assert.equal(document.querySelector('#screening-enable-audio').hidden, false);
  assert.match(document.querySelector('#screening-status').textContent, /开启声音/);
});

test('share announcement precedes first offer and no peer rejects signaling', async () => {
  const { controller, joined, sent, media, shareAck, document } = setup();
  await controller.open(); joined();
  const callbacks = media[0].callbacks;
  let settled = false;
  const pending = callbacks.onShareChange({ active: true, hasSourceAudio: true }).then(() => { settled = true; });
  assert.equal(sent.at(-1).type, 'screening.share');
  assert.deepEqual(sent.at(-1).payload, { sessionId: 's1', seq: 1, active: true, hasSourceAudio: true });
  await tick();
  assert.equal(settled, false);
  assert.equal(document.querySelector('#screening-share').getAttribute('aria-pressed'), 'false');
  shareAck(true);
  await pending;
  assert.equal(document.querySelector('#screening-share').getAttribute('aria-pressed'), 'true');
  await assert.rejects(callbacks.sendSignal({ kind: 'offer', negotiationId: 'n1', data: { type: 'offer', sdp: 'v=0' } }));
});

test('peer return restarts sharer without stopping capture and viewer recovery is bounded', async () => {
  const { controller, joined, event, sent, media, shareAck } = setup();
  await controller.open(); joined([{ memberId: 'm2', deviceId: 'd2', sharer: false }]);
  const pending = media[0].callbacks.onShareChange({ active: true, hasSourceAudio: false });
  shareAck(false);
  await pending;
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
  const pending = sharer.media[0].callbacks.onShareChange({ active: true, hasSourceAudio: true });
  sharer.shareAck(true);
  await pending;
  sharer.event('screening.mic.changed', { memberId: 'm2', deviceId: 'd2', enabled: true });
  await tick();
  assert.equal(sharer.media[0].restarts, 1);
  await sharer.media[0].callbacks.sendSignal({ kind: 'offer', negotiationId: 'n3', data: { type: 'offer', sdp: 'v=0' } });
  assert.deepEqual(sharer.sent.at(-1), { type: 'screening.signal', payload: { sessionId: 's1', seq: 2, kind: 'offer', negotiationId: 'n3', data: { type: 'offer', sdp: 'v=0' }, targetDeviceId: 'd2' } });
});

test('losing a simultaneous share stops capture without an offer or pressed claim', async () => {
  const room = setup();
  const { controller, joined, event, sent, media, document } = room;
  await controller.open(); joined([{ memberId: 'm2', deviceId: 'd2', sharer: false }]);
  let capturing = false;
  media[0].startSharing = async () => {
    capturing = true;
    try {
      await media[0].callbacks.onShareChange({ active: true, hasSourceAudio: false });
      await media[0].callbacks.sendSignal({ kind: 'offer', negotiationId: 'n_race', data: { type: 'offer', sdp: 'v=0' } });
    } catch {
      capturing = false;
      await media[0].callbacks.onShareChange({ active: false, hasSourceAudio: false });
      throw new Error('share rejected');
    }
  };
  document.querySelector('#screening-share').click();
  await tick();
  assert.equal(sent.at(-1).type, 'screening.share');
  assert.equal(document.querySelector('#screening-share').getAttribute('aria-pressed'), 'false');
  event('screening.share.changed', { memberId: 'm2', deviceId: 'd2', active: true, hasSourceAudio: true });
  await tick();
  assert.equal(capturing, false);
  assert.equal(document.querySelector('#screening-share').getAttribute('aria-pressed'), 'false');
  assert.equal(sent.some((command) => command.type === 'screening.signal'), false);
  assert.match(document.querySelector('#screening-person').textContent, /对方正在共享/);
});

test('share ack timeout, stalled send, and socket loss release pending capture', async () => {
  for (const failure of ['timeout', 'stalled-send', 'socket']) {
    const room = setup({ sendResponse: (command) => failure === 'stalled-send' && command.type === 'screening.share' && command.payload.active ? new Promise(() => {}) : true });
    const { dom, controller, joined, media, document } = room;
    await controller.open(); joined([{ memberId: 'm2', deviceId: 'd2', sharer: false }]);
    let timeout = null;
    const originalSet = dom.window.setTimeout.bind(dom.window);
    const originalClear = dom.window.clearTimeout.bind(dom.window);
    dom.window.setTimeout = (callback, delay) => delay >= 5000 ? (timeout = callback, 99999) : originalSet(callback, delay);
    dom.window.clearTimeout = (id) => { if (id !== 99999) originalClear(id); };
    let capturing = false;
    media[0].startSharing = async () => {
      capturing = true;
      try { await media[0].callbacks.onShareChange({ active: true, hasSourceAudio: true }); }
      catch { capturing = false; throw new Error('share abandoned'); }
    };
    document.querySelector('#screening-share').click();
    await tick();
    assert.equal(capturing, true);
    if (failure !== 'socket') { assert.equal(typeof timeout, 'function'); timeout(); }
    else controller.onSocketClose();
    await tick();
    assert.equal(capturing, false);
    assert.equal(document.querySelector('#screening-share').getAttribute('aria-pressed'), 'false');
    if (failure !== 'socket') {
      const releasesBefore = room.sent.filter((command) => command.type === 'screening.share' && !command.payload.active).length;
      room.shareAck(true);
      assert.equal(document.querySelector('#screening-share').getAttribute('aria-pressed'), 'false');
      assert.equal(room.sent.filter((command) => command.type === 'screening.share' && !command.payload.active).length, releasesBefore);
    }
    controller.close();
  }
});

test('stale share echoes cannot confirm or cancel an immediate retry', async () => {
  const room = setup();
  const { dom, controller, joined, event, sent, media, document } = room;
  await controller.open(); joined([{ memberId: 'm2', deviceId: 'd2', sharer: false }]);
  let shareTimeout;
  const originalSet = dom.window.setTimeout.bind(dom.window);
  const originalClear = dom.window.clearTimeout.bind(dom.window);
  dom.window.setTimeout = (callback, delay) => delay === 8000 ? (shareTimeout = callback, 99999) : originalSet(callback, delay);
  dom.window.clearTimeout = (id) => { if (id !== 99999) originalClear(id); };
  let captures = 0;
  let released = 0;
  media[0].startSharing = async () => {
    captures++;
    try {
      await media[0].callbacks.onShareChange({ active: true, hasSourceAudio: true });
      await media[0].callbacks.sendSignal({ kind: 'offer', negotiationId: `n${captures}`, data: { type: 'offer', sdp: 'v=0' } });
    } catch {
      released++;
      await media[0].callbacks.onShareChange({ active: false, hasSourceAudio: false });
      throw new Error('share abandoned');
    }
  };

  document.querySelector('#screening-share').click();
  await tick();
  assert.deepEqual(sent.filter((command) => command.type === 'screening.share').map(({ payload }) => [payload.seq, payload.active]), [[1, true]]);
  shareTimeout();
  await tick();
  assert.equal(released, 1);
  assert.deepEqual(sent.filter((command) => command.type === 'screening.share').map(({ payload }) => [payload.seq, payload.active]), [[1, true], [2, false]]);

  document.querySelector('#screening-share').click();
  await tick();
  assert.equal(captures, 2);
  assert.deepEqual(sent.filter((command) => command.type === 'screening.share').map(({ payload }) => [payload.seq, payload.active]), [[1, true], [2, false], [3, true]]);
  const localEvent = (active, requestSeq) => event('screening.share.changed', {
    memberId: 'm1', deviceId: sent[0].payload.deviceId, active, hasSourceAudio: active, requestSeq,
  });
  localEvent(true, 1);
  await tick();
  assert.equal(document.querySelector('#screening-share').getAttribute('aria-pressed'), 'false');
  assert.equal(sent.some((command) => command.type === 'screening.signal'), false);
  assert.equal(sent.filter((command) => command.type === 'screening.share').length, 3);
  localEvent(false, 2);
  await tick();
  assert.equal(document.querySelector('#screening-share').getAttribute('aria-pressed'), 'false');
  assert.equal(sent.some((command) => command.type === 'screening.signal'), false);

  localEvent(true, 3);
  await tick();
  assert.equal(document.querySelector('#screening-share').getAttribute('aria-pressed'), 'true');
  assert.equal(sent.filter((command) => command.type === 'screening.signal').length, 1);
  localEvent(true, 1);
  localEvent(false, 2);
  assert.equal(document.querySelector('#screening-share').getAttribute('aria-pressed'), 'true');
  assert.equal(sent.filter((command) => command.type === 'screening.share').length, 3);
  controller.close();
});

test('late join snapshot and source audio loss keep viewer notice visible', async () => {
  const room = setup();
  await room.controller.open();
  room.joined([{ memberId: 'm2', deviceId: 'd2', sharer: true, hasSourceAudio: false }]);
  const indicator = room.document.querySelector('#screening-audio-indicator');
  assert.equal(indicator.hidden, false);
  room.media[0].callbacks.onStatus({ state: 'connected' });
  assert.equal(indicator.hidden, false);
  room.event('screening.share.changed', { memberId: 'm2', deviceId: 'd2', active: true, hasSourceAudio: true });
  assert.equal(indicator.hidden, true);
  room.event('screening.share.changed', { memberId: 'm2', deviceId: 'd2', active: true, hasSourceAudio: false });
  room.media[0].callbacks.onStatus({ state: 'connecting' });
  assert.equal(indicator.hidden, false);
  room.media[0].callbacks.onRemoteStream(null);
  assert.equal(room.document.querySelector('#screening-video').hidden, true);
});

test('share state uses the server echo and bottom controls include leave', async () => {
  const room = setup();
  await room.controller.open(); room.joined();
  assert.equal(room.document.querySelector('.screening-controls').contains(room.document.querySelector('#screening-close')), true);
  const pending = room.media[0].callbacks.onShareChange({ active: true, hasSourceAudio: true });
  assert.match(room.document.querySelector('#screening-empty').textContent, /确认/);
  room.shareAck(true);
  await pending;
  assert.match(room.document.querySelector('#screening-empty').textContent, /你正在共享/);
});
