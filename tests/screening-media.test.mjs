import assert from 'node:assert/strict';
import test from 'node:test';
import { createScreeningMedia } from '../public/screening-media.js';

class FakeTrack {
  constructor(kind, settings = {}) {
    this.kind = kind;
    this.enabled = true;
    this.readyState = 'live';
    this.stopCalls = 0;
    this.constraints = [];
    this.settings = settings;
  }
  getSettings() { return this.settings; }
  async applyConstraints(value) { this.constraints.push(value); }
  stop() { this.stopCalls++; this.readyState = 'ended'; }
}

const stream = (...tracks) => ({
  getTracks: () => tracks,
  getVideoTracks: () => tracks.filter((track) => track.kind === 'video'),
  getAudioTracks: () => tracks.filter((track) => track.kind === 'audio'),
});

class FakePeer {
  static instances = [];
  constructor(config) {
    this.config = config;
    this.senders = [];
    this.transceivers = [];
    this.candidates = [];
    this.signalingState = 'stable';
    this.iceConnectionState = 'new';
    this.stats = new Map();
    this.closed = false;
    this.restartCalls = 0;
    FakePeer.instances.push(this);
  }
  addTrack(track) {
    const sender = {
      track,
      parameters: { encodings: [{}] },
      getParameters() { return structuredClone(this.parameters); },
      async setParameters(value) { this.parameters = structuredClone(value); },
    };
    this.senders.push(sender);
    return sender;
  }
  removeTrack(sender) { this.senders = this.senders.filter((item) => item !== sender); }
  addTransceiver(kind, options) {
    const transceiver = { kind, direction: options.direction };
    this.transceivers.push(transceiver);
    return transceiver;
  }
  async createOffer(options = {}) {
    this.offerOptions = options;
    const hasAudioSender = this.senders.some((sender) => sender.track.kind === 'audio');
    const receivesAudio = this.transceivers.some((item) => item.kind === 'audio' && item.direction === 'recvonly');
    const audioSection = hasAudioSender ? 'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n'
      : receivesAudio ? 'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\n' : '';
    return { type: 'offer', sdp: `v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n${audioSection}` };
  }
  async createAnswer() { return { type: 'answer', sdp: 'answer-sdp' }; }
  async setLocalDescription(description) {
    this.localDescription = description;
    this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable';
    if (description.type === 'rollback') this.signalingState = 'stable';
  }
  async setRemoteDescription(description) {
    this.remoteDescription = description;
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  async addIceCandidate(candidate) { this.candidates.push(candidate); }
  restartIce() { this.restartCalls++; }
  async getStats() { return this.stats; }
  close() { this.closed = true; }
}

function harness({ screenTracks = [new FakeTrack('video', { width: 1920, height: 1080 })], displayError, signalError = false,
  peerClass = FakePeer, onShareChangeOverride, sendSignalOverride } = {}) {
  FakePeer.instances = [];
  const shareChanges = [];
  const micChanges = [];
  const statuses = [];
  const qualities = [];
  const signals = [];
  const remoteStreams = [];
  const micTrack = new FakeTrack('audio');
  let displayCalls = 0;
  let userCalls = 0;
  let rejectSignals = signalError;
  const mediaDevices = {
    getDisplayMedia(options) {
      displayCalls++;
      assert.deepEqual(options, { video: { frameRate: { ideal: 30 } }, audio: true });
      return displayError ? Promise.reject(displayError) : Promise.resolve(stream(...screenTracks));
    },
    getUserMedia(options) {
      userCalls++;
      assert.deepEqual(options, { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      return Promise.resolve(stream(micTrack));
    },
  };
  const session = createScreeningMedia({
    mediaDevices, PeerConnection: peerClass,
    sendSignal: (signal) => { if (rejectSignals) throw new Error('peer not joined'); signals.push(signal); return sendSignalOverride?.(signal); },
    onShareChange: (value) => { shareChanges.push(value); return onShareChangeOverride?.(value); },
    onMicChange: (value) => micChanges.push(value),
    onStatus: (value) => statuses.push(value),
    onQuality: (value) => qualities.push(value),
    onRemoteStream: (value) => remoteStreams.push(value),
  });
  return {
    session, screenTracks, micTrack, shareChanges, micChanges, statuses, qualities, signals, remoteStreams,
    get peer() { return FakePeer.instances.at(-1); },
    get displayCalls() { return displayCalls; },
    get userCalls() { return userCalls; },
    allowSignals() { rejectSignals = false; },
    blockSignals() { rejectSignals = true; },
  };
}

async function withStatsClock(run) {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  let sample;
  globalThis.setInterval = (fn, delay) => { assert.ok(delay >= 2000 && delay <= 5000); sample = fn; return 41; };
  globalThis.clearInterval = () => {};
  try {
    await run(async () => {
      assert.ok(sample, 'stats timer should be active');
      sample();
      await new Promise((resolve) => setImmediate(resolve));
    });
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
}

test('cancelled capture leaves session intact', async () => {
  const denied = new DOMException('cancelled', 'NotAllowedError');
  const ctx = harness({ displayError: denied });
  const capture = ctx.session.startSharing();
  assert.equal(ctx.displayCalls, 1, 'capture starts in the calling gesture');
  await assert.rejects(capture, { name: 'NotAllowedError' });
  assert.equal(ctx.shareChanges.length, 0);
  await ctx.session.enableMic();
  assert.equal(ctx.micChanges.at(-1), true);
  ctx.session.close();
});

test('video-only source reports no film audio', async () => {
  const ctx = harness();
  assert.equal((await ctx.session.startSharing()).hasSourceAudio, false);
  assert.deepEqual(ctx.shareChanges, [{ active: true, hasSourceAudio: false }]);
  assert.equal(ctx.peer.senders.length, 1);
  assert.equal(ctx.peer.senders[0].track.kind, 'video');
  assert.equal(JSON.stringify(ctx.peer.config.iceServers).includes('turn:'), false);
  assert.deepEqual(ctx.peer.config.iceServers, [{ urls: 'stun:stun.cloudflare.com:3478' }]);
  assert.equal(ctx.statuses.some((value) => value.state === 'no-source-audio'), true);
  ctx.session.close();
});

test('video-only sharer offer reserves audio receive without an audio sender', async () => {
  const ctx = harness();
  try {
    await ctx.session.startSharing();
    assert.deepEqual(ctx.peer.transceivers, [{ kind: 'audio', direction: 'recvonly' }]);
    const offer = ctx.signals.find((signal) => signal.kind === 'offer');
    assert.match(offer.data.sdp, /m=audio[^\r\n]*\r\na=recvonly/);
    assert.equal(ctx.peer.senders.filter((sender) => sender.track.kind === 'audio').length, 0);
  } finally { ctx.session.close(); }
});

test('sharer with source audio or mic does not add a redundant receive transceiver', async () => {
  const sourceAudio = harness({ screenTracks: [new FakeTrack('video'), new FakeTrack('audio')] });
  try {
    await sourceAudio.session.startSharing();
    assert.deepEqual(sourceAudio.peer.transceivers, []);
    assert.match(sourceAudio.signals.find((signal) => signal.kind === 'offer').data.sdp, /m=audio[^\r\n]*\r\na=sendrecv/);
  } finally { sourceAudio.session.close(); }
  const micFirst = harness();
  try {
    await micFirst.session.enableMic();
    await micFirst.session.startSharing();
    assert.deepEqual(micFirst.peer.transceivers, []);
    assert.match(micFirst.signals.find((signal) => signal.kind === 'offer').data.sdp, /m=audio[^\r\n]*\r\na=sendrecv/);
  } finally { micFirst.session.close(); }
});

test('source audio ending reports film audio absent while video continues', async () => {
  const video = new FakeTrack('video');
  const filmAudio = new FakeTrack('audio');
  const ctx = harness({ screenTracks: [video, filmAudio] });
  try {
    await ctx.session.startSharing();
    filmAudio.readyState = 'ended';
    filmAudio.onended();
    assert.deepEqual(ctx.shareChanges.at(-1), { active: true, hasSourceAudio: false });
    assert.equal(video.stopCalls, 0);
  } finally { ctx.session.close(); }
});

test('stopping during capture setup does not announce a share', async () => {
  let finishConstraints;
  const video = new FakeTrack('video');
  video.applyConstraints = () => new Promise((resolve) => { finishConstraints = resolve; });
  const ctx = harness({ screenTracks: [video] });
  try {
    const pending = ctx.session.startSharing();
    await Promise.resolve();
    ctx.session.stopSharing();
    finishConstraints();
    await assert.rejects(pending, /cancelled/);
    assert.deepEqual(ctx.shareChanges, []);
    assert.equal(video.stopCalls, 1);
  } finally { ctx.session.close(); }
});

test('unavailable peer connection releases captured tracks', async () => {
  const video = new FakeTrack('video');
  const filmAudio = new FakeTrack('audio');
  const ctx = harness({ screenTracks: [video, filmAudio], peerClass: null });
  try {
    await assert.rejects(ctx.session.startSharing(), /WebRTC is unavailable/);
    assert.equal(video.stopCalls, 1);
    assert.equal(filmAudio.stopCalls, 1);
    assert.deepEqual(ctx.shareChanges, []);
  } finally { ctx.session.close(); }
  assert.equal(video.stopCalls, 1);
});

test('rejected share callback releases tracks and peer', async () => {
  const video = new FakeTrack('video');
  const ctx = harness({ screenTracks: [video], onShareChangeOverride: ({ active }) => {
    if (active) return Promise.reject(new Error('share command rejected'));
  } });
  try {
    await assert.rejects(ctx.session.startSharing(), /share command rejected/);
    assert.equal(video.stopCalls, 1);
    assert.equal(ctx.peer.closed, true);
    assert.deepEqual(ctx.shareChanges.map(({ active }) => active), [true, false]);
  } finally { ctx.session.close(); }
  assert.equal(video.stopCalls, 1);
});

test('mic is opt-in and processed', async () => {
  const sourceAudio = new FakeTrack('audio');
  const ctx = harness({ screenTracks: [new FakeTrack('video'), sourceAudio] });
  await ctx.session.startSharing();
  assert.equal(ctx.userCalls, 0);
  assert.equal(ctx.peer.senders.length, 2);
  assert.equal(ctx.peer.senders[1].track, sourceAudio);
  await ctx.session.enableMic();
  assert.equal(ctx.userCalls, 1);
  assert.equal(ctx.peer.senders.length, 3);
  assert.equal(ctx.peer.senders[2].track, ctx.micTrack);
  assert.deepEqual(ctx.micChanges, [true]);
  ctx.session.setMicEnabled(false);
  assert.equal(ctx.micTrack.enabled, false);
  assert.deepEqual(ctx.micChanges, [true, false]);
  ctx.session.close();
});

test('viewer mic requests sharer renegotiation without an offer', async () => {
  const ctx = harness();
  await ctx.session.handleSignal({ kind: 'offer', negotiationId: 'n1', data: { type: 'offer', sdp: 'remote' } });
  const before = ctx.signals.length;
  await ctx.session.enableMic();
  assert.equal(ctx.signals.length, before);
  assert.equal(ctx.statuses.at(-1).state, 'needs-sharer-renegotiation');
  assert.equal(await ctx.session.restartIce(), false);
  assert.equal(ctx.signals.length, before);
  ctx.session.close();
});

test('late peer join can restart a pending sharer offer', async () => {
  const ctx = harness();
  await ctx.session.startSharing();
  const firstId = ctx.signals.find((signal) => signal.kind === 'offer').negotiationId;
  assert.equal(await ctx.session.restartIce(), true);
  const offers = ctx.signals.filter((signal) => signal.kind === 'offer');
  assert.equal(offers.length, 2);
  assert.notEqual(offers[1].negotiationId, firstId);
  assert.deepEqual(ctx.peer.offerOptions, { iceRestart: true });
  ctx.session.close();
});

test('absent peer keeps capture for later negotiation', async () => {
  const video = new FakeTrack('video');
  const ctx = harness({ screenTracks: [video], signalError: true });
  assert.deepEqual(await ctx.session.startSharing(), { hasVideo: true, hasSourceAudio: false });
  assert.equal(video.stopCalls, 0);
  assert.deepEqual(ctx.shareChanges, [{ active: true, hasSourceAudio: false }]);
  assert.equal(ctx.statuses.at(-1).state, 'waiting-for-peer');
  ctx.allowSignals();
  assert.equal(await ctx.session.restartIce(), true);
  assert.equal(ctx.signals.some((signal) => signal.kind === 'offer'), true);
  ctx.session.close();
});

test('remote screen and mic tracks form one video element stream', async () => {
  const oldMediaStream = globalThis.MediaStream;
  globalThis.MediaStream = class {
    constructor() { this.tracks = []; }
    addTrack(track) { this.tracks.push(track); }
    getTracks() { return this.tracks; }
  };
  try {
    const ctx = harness();
    await ctx.session.handleSignal({ kind: 'offer', negotiationId: 'n1', data: { type: 'offer', sdp: 'remote' } });
    const video = new FakeTrack('video');
    const audio = new FakeTrack('audio');
    ctx.peer.ontrack({ track: video, streams: [stream(video)] });
    ctx.peer.ontrack({ track: audio, streams: [stream(audio)] });
    assert.equal(ctx.remoteStreams.at(-1), ctx.remoteStreams.at(-2));
    assert.deepEqual(ctx.remoteStreams.at(-1).getTracks(), [video, audio]);
    ctx.session.close();
  } finally {
    globalThis.MediaStream = oldMediaStream;
  }
});

test('viewer becoming sharer attaches screen tracks to a fresh peer', async () => {
  const ctx = harness();
  try {
    await ctx.session.handleSignal({ kind: 'offer', negotiationId: 'n1', data: { type: 'offer', sdp: 'remote' } });
    const oldPeer = ctx.peer;
    await ctx.session.startSharing();
    assert.notEqual(ctx.peer, oldPeer);
    assert.equal(oldPeer.closed, true);
    assert.equal(ctx.peer.senders.some((sender) => sender.track.kind === 'video'), true);
  } finally { ctx.session.close(); }
});

test('close stops every owned track once', async () => {
  const screenTrack = new FakeTrack('video');
  const sourceAudio = new FakeTrack('audio');
  const ctx = harness({ screenTracks: [screenTrack, sourceAudio] });
  await ctx.session.startSharing();
  await ctx.session.enableMic();
  ctx.session.close();
  ctx.session.close();
  assert.equal(screenTrack.stopCalls, 1);
  assert.equal(sourceAudio.stopCalls, 1);
  assert.equal(ctx.micTrack.stopCalls, 1);
  assert.equal(ctx.peer.closed, true);
});

test('concurrent mic grants do not leak captured tracks', async () => {
  const ctx = harness();
  const first = ctx.session.enableMic();
  const second = ctx.session.enableMic();
  await Promise.all([first, second]);
  ctx.session.close();
  assert.equal(ctx.userCalls, 1);
  assert.equal(ctx.micTrack.stopCalls, 1);
});

test('stale signal is ignored', async () => {
  const ctx = harness();
  await ctx.session.handleSignal({ kind: 'offer', negotiationId: 'n1', data: { type: 'offer', sdp: 'first' } });
  await ctx.session.handleSignal({ kind: 'offer', negotiationId: 'n2', data: { type: 'offer', sdp: 'second' } });
  const peer = ctx.peer;
  await ctx.session.handleSignal({ kind: 'ice', negotiationId: 'n1', data: { candidate: 'candidate:1 typ host' } });
  await ctx.session.handleSignal({ kind: 'answer', negotiationId: 'n1', data: { type: 'answer', sdp: 'old' } });
  assert.equal(peer.candidates.length, 0);
  assert.deepEqual(peer.remoteDescription, { type: 'offer', sdp: 'second' });
  ctx.session.close();
});

test('remote SDP relay candidates are excluded from direct session', async () => {
  const ctx = harness();
  const sdp = 'v=0\r\na=candidate:1 1 udp 1 192.0.2.1 1234 typ host\r\na=candidate:2 1 udp 1 192.0.2.2 4321 typ relay\r\n';
  await ctx.session.handleSignal({ kind: 'offer', negotiationId: 'n1', data: { type: 'offer', sdp } });
  assert.match(ctx.peer.remoteDescription.sdp, /typ host/);
  assert.doesNotMatch(ctx.peer.remoteDescription.sdp, /typ relay/);
  const accepted = await ctx.session.handleSignal({ kind: 'ice', negotiationId: 'n1', data: { candidate: 'candidate:3 1 udp 1 192.0.2.3 3333 typ relay' } });
  assert.equal(accepted, false);
  ctx.session.close();
});

test('ICE emission uses Task 1 serializable candidate shape', async () => {
  const ctx = harness();
  await ctx.session.startSharing();
  ctx.peer.onicecandidate({ candidate: { candidate: 'candidate:1 typ host', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abc', foundation: 'extra' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ctx.signals.at(-1).data, { candidate: 'candidate:1 typ host', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abc' });
  ctx.session.close();
});

test('ICE send failure reports signaling error without escaping event handler', async () => {
  const ctx = harness();
  await ctx.session.startSharing();
  ctx.blockSignals();
  assert.doesNotThrow(() => ctx.peer.onicecandidate({ candidate: { candidate: 'candidate:1 typ host' } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.statuses.at(-1).state, 'signaling-error');
  ctx.session.close();
});

test('direct ICE failure is explicit', async () => {
  const ctx = harness();
  await ctx.session.startSharing();
  const peer = ctx.peer;
  peer.iceConnectionState = 'failed';
  peer.oniceconnectionstatechange();
  await new Promise((resolve) => setImmediate(resolve));
  peer.oniceconnectionstatechange();
  await new Promise((resolve) => setImmediate(resolve));
  peer.oniceconnectionstatechange();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.statuses.at(-1).state, 'direct-failed');
  assert.match(ctx.statuses.at(-1).message, /network/i);
  assert.equal(peer.restartCalls <= 2, true);
  ctx.session.close();
});

test('viewer ICE failure waits before reporting direct failure', async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const timers = [];
  globalThis.setTimeout = (fn, delay) => { const timer = { fn, delay, cancelled: false }; timers.push(timer); return timer; };
  globalThis.clearTimeout = (timer) => { timer.cancelled = true; };
  const ctx = harness();
  try {
    await ctx.session.handleSignal({ kind: 'offer', negotiationId: 'n1', data: { type: 'offer', sdp: 'remote' } });
    ctx.peer.iceConnectionState = 'failed';
    ctx.peer.oniceconnectionstatechange();
    assert.equal(ctx.statuses.at(-1).state, 'needs-sharer-renegotiation');
    assert.equal(ctx.statuses.some((value) => value.state === 'direct-failed'), false);
    const timer = timers.find((item) => !item.cancelled);
    assert.ok(timer);
    assert.ok(timer.delay > 0 && timer.delay <= 15_000);
    timer.fn();
    assert.equal(ctx.statuses.at(-1).state, 'direct-failed');
  } finally {
    ctx.session.close();
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test('new sharer offer resets viewer failure wait and connection cancels it', async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const timers = [];
  globalThis.setTimeout = (fn, delay) => { const timer = { fn, delay, cancelled: false }; timers.push(timer); return timer; };
  globalThis.clearTimeout = (timer) => { timer.cancelled = true; };
  const ctx = harness();
  try {
    await ctx.session.handleSignal({ kind: 'offer', negotiationId: 'n1', data: { type: 'offer', sdp: 'remote' } });
    const peer = ctx.peer;
    peer.iceConnectionState = 'failed';
    peer.oniceconnectionstatechange();
    const oldTimer = timers.find((item) => !item.cancelled);
    await ctx.session.handleSignal({ kind: 'offer', negotiationId: 'n2', data: { type: 'offer', sdp: 'restart' } });
    assert.equal(oldTimer.cancelled, true);
    const newTimer = timers.find((item) => !item.cancelled);
    assert.ok(newTimer, 'the new offer gets its own bounded connection wait');
    oldTimer.fn();
    assert.equal(ctx.statuses.some((value) => value.state === 'direct-failed'), false);
    peer.iceConnectionState = 'connected';
    peer.oniceconnectionstatechange();
    assert.equal(newTimer.cancelled, true);
    newTimer.fn();
    assert.equal(ctx.statuses.at(-1).state, 'connected');
  } finally {
    ctx.session.close();
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test('viewer recovery deadline survives a never-settling replacement answer send', async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const timers = [];
  globalThis.setTimeout = (fn, delay) => { const timer = { fn, delay, cancelled: false }; timers.push(timer); return timer; };
  globalThis.clearTimeout = (timer) => { timer.cancelled = true; };
  const neverSettles = new Promise(() => {});
  const ctx = harness({ sendSignalOverride: (signal) => signal.kind === 'answer' && signal.negotiationId === 'n2' ? neverSettles : undefined });
  try {
    await ctx.session.handleSignal({ kind: 'offer', negotiationId: 'n1', data: { type: 'offer', sdp: 'remote' } });
    const peer = ctx.peer;
    peer.iceConnectionState = 'failed';
    peer.oniceconnectionstatechange();
    const oldTimer = timers.find((item) => !item.cancelled);
    const handling = ctx.session.handleSignal({ kind: 'offer', negotiationId: 'n2', data: { type: 'offer', sdp: 'restart' } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(ctx.signals.some((signal) => signal.kind === 'answer' && signal.negotiationId === 'n2'));
    assert.equal(oldTimer.cancelled, true);
    const deadline = timers.find((item) => !item.cancelled);
    assert.ok(deadline, 'replacement answer is pending but viewer still has a deadline');
    assert.ok(deadline.delay > 0 && deadline.delay <= 15_000);
    deadline.fn();
    assert.equal(ctx.statuses.at(-1).state, 'direct-failed');
    void handling;
  } finally {
    ctx.session.close();
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test('connection during replacement answer send cancels the viewer deadline', async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const timers = [];
  globalThis.setTimeout = (fn, delay) => { const timer = { fn, delay, cancelled: false }; timers.push(timer); return timer; };
  globalThis.clearTimeout = (timer) => { timer.cancelled = true; };
  let releaseAnswer;
  const pendingAnswer = new Promise((resolve) => { releaseAnswer = resolve; });
  const ctx = harness({ sendSignalOverride: (signal) => signal.kind === 'answer' && signal.negotiationId === 'n2' ? pendingAnswer : undefined });
  try {
    await ctx.session.handleSignal({ kind: 'offer', negotiationId: 'n1', data: { type: 'offer', sdp: 'remote' } });
    const peer = ctx.peer;
    peer.iceConnectionState = 'failed';
    peer.oniceconnectionstatechange();
    const handling = ctx.session.handleSignal({ kind: 'offer', negotiationId: 'n2', data: { type: 'offer', sdp: 'restart' } });
    await new Promise((resolve) => setImmediate(resolve));
    const deadline = timers.find((item) => !item.cancelled);
    assert.ok(deadline, 'deadline stays active while answer send is pending');
    peer.iceConnectionState = 'connected';
    peer.oniceconnectionstatechange();
    assert.equal(deadline.cancelled, true);
    releaseAnswer();
    assert.equal(await handling, true);
    deadline.fn();
    assert.equal(ctx.statuses.at(-1).state, 'connected');
    assert.equal(ctx.statuses.some((value) => value.state === 'direct-failed'), false);
  } finally {
    ctx.session.close();
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test('rejected recovery offer retains a bounded viewer failure wait', async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const timers = [];
  globalThis.setTimeout = (fn, delay) => { const timer = { fn, delay, cancelled: false }; timers.push(timer); return timer; };
  globalThis.clearTimeout = (timer) => { timer.cancelled = true; };
  const ctx = harness();
  try {
    await ctx.session.handleSignal({ kind: 'offer', negotiationId: 'n1', data: { type: 'offer', sdp: 'remote' } });
    const peer = ctx.peer;
    peer.iceConnectionState = 'failed';
    peer.oniceconnectionstatechange();
    peer.setRemoteDescription = async () => { throw new Error('bad replacement SDP'); };
    await assert.rejects(ctx.session.handleSignal({ kind: 'offer', negotiationId: 'n2', data: { type: 'offer', sdp: 'bad' } }), /bad replacement SDP/);
    const timer = timers.find((item) => !item.cancelled);
    assert.ok(timer, 'a rejected replacement offer must not cancel the failure deadline');
    timer.fn();
    assert.equal(ctx.statuses.at(-1).state, 'direct-failed');
  } finally {
    ctx.session.close();
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test('persistent disconnection exhausts bounded ICE restarts', async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const timers = [];
  globalThis.setTimeout = (fn, delay) => { const timer = { fn, delay, cancelled: false }; timers.push(timer); return timer; };
  globalThis.clearTimeout = (timer) => { timer.cancelled = true; };
  const ctx = harness();
  try {
    await ctx.session.startSharing();
    ctx.peer.iceConnectionState = 'disconnected';
    ctx.peer.oniceconnectionstatechange();
    for (let i = 0; i < 3; i++) {
      const timer = timers.find((item) => !item.cancelled);
      assert.ok(timer, `recovery timer ${i + 1} should exist`);
      timer.cancelled = true;
      timer.fn();
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(ctx.statuses.at(-1).state, 'direct-failed');
    assert.equal(ctx.peer.restartCalls, 2);
  } finally {
    ctx.session.close();
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test('sustained loss degrades video first', async () => {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  let tick;
  globalThis.setInterval = (fn, delay) => { assert.ok(delay >= 2000 && delay <= 5000); tick = fn; return 41; };
  globalThis.clearInterval = () => {};
  try {
    const ctx = harness();
    await ctx.session.startSharing();
    ctx.peer.stats = new Map([
      ['out', { type: 'outbound-rtp', kind: 'video', framesPerSecond: 30, frameWidth: 1920, frameHeight: 1080 }],
      ['remote', { type: 'remote-inbound-rtp', kind: 'video', fractionLost: 0.2, roundTripTime: 0.4 }],
    ]);
    await tick();
    await new Promise((resolve) => setImmediate(resolve));
    await tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ctx.qualities.at(-1).tier, '720p');
    const videoSender = ctx.peer.senders.find((item) => item.track.kind === 'video');
    const audioSender = ctx.peer.senders.find((item) => item.track.kind === 'audio');
    assert.ok(videoSender.parameters.encodings[0].maxBitrate <= 1_500_000);
    assert.equal(audioSender, undefined);
    ctx.session.close();
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
});

test('failed video parameter update does not claim a lower quality tier', async () => {
  await withStatsClock(async (sample) => {
    const ctx = harness();
    try {
      await ctx.session.startSharing();
      const videoSender = ctx.peer.senders.find((sender) => sender.track.kind === 'video');
      videoSender.setParameters = async () => { throw new Error('unsupported parameters'); };
      ctx.peer.stats = new Map([
        ['out', { type: 'outbound-rtp', kind: 'video', framesPerSecond: 30 }],
        ['loss', { type: 'remote-inbound-rtp', kind: 'video', fractionLost: 0.2 }],
      ]);
      await sample();
      await sample();
      assert.equal(ctx.qualities.at(-1).tier, '1080p');
      assert.equal(ctx.statuses.some((value) => value.state === 'quality-limited'), true);
    } finally { ctx.session.close(); }
  });
});

test('missing network measurements do not restore high video quality', async () => {
  await withStatsClock(async (sample) => {
    const ctx = harness();
    try {
      await ctx.session.startSharing();
      ctx.peer.stats = new Map([
        ['out', { type: 'outbound-rtp', kind: 'video', framesPerSecond: 30 }],
        ['loss', { type: 'remote-inbound-rtp', kind: 'video', fractionLost: 0.2 }],
      ]);
      await sample();
      await sample();
      assert.equal(ctx.qualities.at(-1).tier, '720p');
      ctx.peer.stats = new Map([['out', { type: 'outbound-rtp', kind: 'video', framesPerSecond: 30 }]]);
      for (let i = 0; i < 4; i++) await sample();
      assert.equal(ctx.qualities.at(-1).tier, '720p');
    } finally { ctx.session.close(); }
  });
});
