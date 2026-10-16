import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createScreeningRoom } from '../public/screening-room.js';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '');
const waterSource = readFileSync(new URL('../public/water-background.js', import.meta.url), 'utf8')
  .replace("'/vendor/three.module.js'", JSON.stringify(new URL('../public/vendor/three.module.js', import.meta.url).href));
const { WaterBackground: RealWaterBackground } = await import(`data:text/javascript,${encodeURIComponent(waterSource)}`);

async function setup() {
  const dom = new JSDOM(html, { url: 'https://example.test/?room=r1' });
  const { document } = dom.window;
  Object.defineProperty(dom.window.navigator, 'mediaDevices', { value: { getDisplayMedia() {} } });
  const water = { running: true, suspended: false, ripples: 0, suspensions: [],
    init: async () => true, setImage: async () => {}, setBlur() {}, setTone() {}, resize() {},
    addRipple() { this.ripples++; }, setSuspended(value) { this.suspended = value; this.running = !value; this.suspensions.push(value); } };
  const doodle = { draws: 0, syncViewport() {}, configure() {}, hydrate() {}, beginDraw() { this.draws++; return { id: 'd1', points: [], style: 'neon', color: '#8be9fd' }; },
    appendDraw() {}, finishDraw() {}, cancelDraw() {}, beginErase() {}, eraseAt() {}, add() {}, remove() {}, applyPreview() {} };
  const media = [];
  const commands = [];
  class Socket extends dom.window.EventTarget {
    static OPEN = 1;
    constructor(url) { super(); this.url = url; this.readyState = 0; Socket.instances.push(this); }
    send(value) { if (this.readyState !== Socket.OPEN) throw new Error('socket closed'); commands.push(JSON.parse(value)); }
    open() { this.readyState = Socket.OPEN; this.dispatchEvent(new dom.window.Event('open')); }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new dom.window.Event('close')); }
    receive(type, payload = {}) { this.dispatchEvent(new dom.window.MessageEvent('message', { data: JSON.stringify({ type, payload }) })); }
  }
  Socket.instances = [];
  class WaterBackground { constructor() { return water; } }
  class DoodleCanvas { constructor() { return doodle; } }
  const mediaFactory = () => {
    const instance = { closeCalls: 0, close() { this.closeCalls++; }, handleSignal: async () => {}, restartIce: async () => {},
      startSharing: async () => {}, stopSharing() {}, enableMic: async () => {}, setMicEnabled: async () => {} };
    media.push(instance);
    return instance;
  };
  const response = (body) => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => body });
  const roomState = { targetAt: '2030-01-01T00:00:00.000Z', timeZone: 'UTC', members: [{ id: 'm1', username: 'Me', slot: 1 }], tasks: [], voiceNotes: [], doodles: [] };
  const fetch = async (url) => {
    const path = new URL(url, 'https://example.test').pathname;
    if (path === '/api/auth/me') return response({ user: { id: 'm1', username: 'Me' } });
    if (path === '/api/room') return response({ roomId: 'r1', memberId: 'm1' });
    if (path === '/api/state') return response({ ...roomState });
    if (path === '/api/auth/logout') return response({});
    throw new Error(`unexpected fetch: ${path}`);
  };
  const scheduled = [];
  dom.window.setTimeout = (fn, delay) => { scheduled.push({ fn, delay }); return scheduled.length; };
  dom.window.clearTimeout = () => {};
  const location = { protocol: 'https:', host: 'example.test', origin: 'https://example.test', search: '?room=r1', href: 'https://example.test/?room=r1' };
  const history = { replaceState(_state, _title, href) { location.href = href; location.search = new URL(href, location.origin).search; } };
  const run = new AsyncFunction('WaterBackground', 'DoodleCanvas', 'createScreeningRoom', 'initHtmlCanvasBridge', 'document', 'window', 'navigator', 'location', 'history', 'fetch', 'WebSocket', 'setInterval', 'setTimeout', 'requestAnimationFrame', 'performance', appSource);
  await run(WaterBackground, DoodleCanvas, (args) => createScreeningRoom({ ...args, createMedia: mediaFactory }), async () => {}, document, dom.window, dom.window.navigator,
    location, history, fetch, Socket, () => 0, () => 0, () => 0, { now: () => 1000 });
  const socket = Socket.instances[0];
  socket.open();
  return { dom, document, water, doodle, media, commands, Socket, socket, scheduled };
}

test('opening suspends background and drawing', async () => {
  const app = await setup();
  await app.document.querySelector('#open-screening').click();
  assert.equal(app.document.body.classList.contains('is-screening'), true);
  assert.equal(app.water.running, false);
  const surface = app.document.querySelector('#water-canvas');
  surface.dispatchEvent(new app.dom.window.MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 100, button: 0 }));
  app.dom.window.dispatchEvent(new app.dom.window.MouseEvent('pointermove', { clientX: 120, clientY: 120 }));
  assert.equal(app.doodle.draws, 0);
  assert.equal(app.water.ripples, 0);
  app.socket.receive('pointer', { x: 0.5, y: 0.5, strength: 0.1 });
  assert.equal(app.scheduled.some(({ delay }) => delay === 110), false);
  assert.equal(app.commands.at(-1).type, 'screening.join');
});

test('exit restores countdown', async () => {
  const app = await setup();
  app.document.querySelector('#open-screening').click();
  assert.equal(app.document.body.classList.contains('is-screening'), true);
  app.document.querySelector('#screening-close').click();
  assert.equal(app.document.body.classList.contains('is-screening'), false);
  assert.equal(app.water.running, true);
  assert.deepEqual(app.water.suspensions, [true, false]);
  assert.equal(app.document.querySelector('#screening-room').hidden, true);
  assert.match(app.document.querySelector('#days').textContent, /^\d+$/);
  app.dom.window.dispatchEvent(new app.dom.window.MouseEvent('pointerdown', { clientX: 100, clientY: 100, button: 0 }));
  assert.equal(app.doodle.draws, 1);
});

test('room teardown is idempotent', async () => {
  for (const remote of [false, true]) {
    const app = await setup();
    app.document.querySelector('#open-screening').click();
    assert.equal(app.media.length, 1);
    if (remote) app.socket.receive('room.destroyed');
    else {
      app.dom.window.confirm = () => true;
      app.document.querySelector('#destroy-room').click();
      await new Promise((resolve) => setImmediate(resolve));
    }
    app.socket.close();
    for (const { fn, delay } of [...app.scheduled]) if (delay === 1800) fn();
    assert.equal(app.media[0].closeCalls, 1);
    assert.equal(app.Socket.instances.length, 1);
    assert.equal(app.document.body.classList.contains('is-screening'), false);
  }
});

test('reconnect discards old media session', async () => {
  const app = await setup();
  app.document.querySelector('#open-screening').click();
  assert.equal(app.commands[0]?.type, 'screening.join');
  app.socket.receive('screening.joined', { sessionId: 's1', memberId: 'm1', deviceId: app.commands[0].payload.deviceId, peers: [] });
  app.socket.close();
  assert.equal(app.media[0].closeCalls, 1);
  assert.equal(app.water.running, false);
  const reconnect = app.scheduled.find(({ delay }) => delay === 1800);
  assert.ok(reconnect);
  reconnect.fn();
  const next = app.Socket.instances[1];
  next.open();
  assert.equal(app.media.length, 2);
  assert.equal(app.media[1].closeCalls, 0);
  assert.equal(app.commands.at(-1).type, 'screening.join');
});

test('water suspension cancels frames and resumes one redraw on the same renderer', (t) => {
  const oldResizeObserver = globalThis.ResizeObserver;
  const oldRequest = globalThis.requestAnimationFrame;
  const oldCancel = globalThis.cancelAnimationFrame;
  const callbacks = new Map();
  let nextFrame = 0;
  globalThis.ResizeObserver = class { observe() {} };
  globalThis.requestAnimationFrame = (callback) => { const id = ++nextFrame; callbacks.set(id, callback); return id; };
  globalThis.cancelAnimationFrame = (id) => callbacks.delete(id);
  t.after(() => { globalThis.ResizeObserver = oldResizeObserver; globalThis.requestAnimationFrame = oldRequest; globalThis.cancelAnimationFrame = oldCancel; });
  const dom = new JSDOM('<canvas id="water"></canvas><canvas id="doodle"></canvas>');
  const water = new RealWaterBackground(dom.window.document.querySelector('#water'), dom.window.document.querySelector('#doodle'));
  const renderer = { draws: 0, setRenderTarget() {}, render() { this.draws++; }, clear() {} };
  water.renderer = renderer;
  water.ready = true;
  water.simulation = { current: 0, targets: [{ texture: {} }, { texture: {} }], material: { uniforms: { uState: {}, uImpulseCount: {}, uImpulses: { value: Array.from({ length: 32 }, () => ({ copy() {} })) } } }, scene: {}, camera: {} };
  water.background = { material: { uniforms: { uRipple: {} } }, scene: {}, camera: {} };
  water.wake(500);
  assert.equal(callbacks.size, 1);
  water.setSuspended(true);
  assert.equal(water.running, false);
  assert.equal(callbacks.size, 0);
  water.addRipple(0.5, 0.5);
  water.doodleCanvas.dispatchEvent(new dom.window.Event('doodle-render'));
  water.wake(500);
  assert.equal(callbacks.size, 0);
  assert.equal(water.impulses.length, 0);
  water.render(1000); // A callback already queued by the browser must also be inert.
  assert.equal(renderer.draws, 0);
  water.setSuspended(false);
  assert.equal(water.renderer, renderer);
  assert.equal(callbacks.size, 1);
  const [id, frame] = callbacks.entries().next().value;
  callbacks.delete(id);
  frame(1016);
  assert.ok(renderer.draws > 0);
});
