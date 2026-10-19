const ICE_SERVERS = [{ urls: 'stun:stun.cloudflare.com:3478' }];
const STATS_INTERVAL_MS = 3000;
const DISCONNECT_GRACE_MS = 3000;
const RECOVERY_WAIT_MS = 5000;
const VIEWER_RECOVERY_WAIT_MS = 10_000;
const MAX_ICE_RESTARTS = 2;
const MIC_CONSTRAINTS = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } };

const isRelay = (candidate) => /(?:^|\s)typ\s+relay(?:\s|$)/i.test(candidate || '');
const withoutRelayCandidates = (sdp) => sdp.split(/\r?\n/)
  .filter((line) => !(line.startsWith('a=candidate:') && isRelay(line))).join('\r\n');
const statusMessage = 'Direct connection failed on this network. Try a different network and rejoin.';
let nextFallbackId = 0;

function newNegotiationId() {
  if (globalThis.crypto?.randomUUID) return `n_${globalThis.crypto.randomUUID().replaceAll('-', '')}`;
  return `n_${Date.now().toString(36)}_${(++nextFallbackId).toString(36)}`;
}

function serializableCandidate(candidate) {
  const value = typeof candidate.toJSON === 'function' ? candidate.toJSON() : candidate;
  if (!value || typeof value.candidate !== 'string' || isRelay(value.candidate)) return null;
  const data = { candidate: value.candidate };
  if (value.sdpMid !== undefined && (value.sdpMid === null || typeof value.sdpMid === 'string')) data.sdpMid = value.sdpMid;
  if (value.sdpMLineIndex !== undefined && (value.sdpMLineIndex === null || Number.isInteger(value.sdpMLineIndex) && value.sdpMLineIndex >= 0)) data.sdpMLineIndex = value.sdpMLineIndex;
  if (value.usernameFragment !== undefined && (value.usernameFragment === null || typeof value.usernameFragment === 'string')) data.usernameFragment = value.usernameFragment;
  return data;
}

/** Owns browser media only. The caller adds session, sequence and target to each signal. */
export function createScreeningMedia({
  sendSignal,
  onShareChange = () => {},
  onMicChange = () => {},
  onRemoteStream = () => {},
  onStatus = () => {},
  onQuality = () => {},
  mediaDevices = globalThis.navigator?.mediaDevices,
  PeerConnection = globalThis.RTCPeerConnection,
}) {
  if (typeof sendSignal !== 'function') throw new TypeError('sendSignal is required');

  let peer = null;
  let screenStream = null;
  let screenVideo = null;
  let shareAnnounced = false;
  let micStream = null;
  let micTrack = null;
  let micRequest = null;
  let micSender = null;
  let micGeneration = 0;
  let remoteStream = null;
  let screenSenders = [];
  let negotiationId = null;
  let remoteDescriptionReady = false;
  let pendingRemoteIce = [];
  let pendingLocalIce = [];
  let sendingDescription = false;
  let statsTimer = null;
  let disconnectTimer = null;
  let closed = false;
  let captureGeneration = 0;
  let restartAttempts = 0;
  let recoveryBusy = false;
  let viewerRecoveryPending = false;
  let failureReported = false;
  let qualityTier = '1080p';
  let maxQualityTier = '1080p';
  let badSamples = 0;
  let goodSamples = 0;
  const ownedTracks = new Set();
  const stoppedTracks = new Set();

  function report(state, message, details = {}) {
    if (!closed) onStatus({ state, ...(message ? { message } : {}), ...details });
  }

  function stopTrack(track) {
    if (!track || stoppedTracks.has(track)) return;
    stoppedTracks.add(track);
    track.stop();
  }

  function stopStream(stream) {
    for (const track of stream?.getTracks() || []) stopTrack(track);
  }

  function stopMic() {
    micGeneration++;
    micRequest = null;
    const hadMic = Boolean(micStream || micTrack);
    if (micStream) {
      for (const track of micStream.getTracks()) {
        track.onended = null;
        track.enabled = false;
        stopTrack(track);
      }
    }
    if (peer && micSender) {
      try { peer.removeTrack(micSender); }
      catch { /* Closing or replacing the peer still releases the owned track. */ }
    }
    micStream = null;
    micTrack = null;
    micSender = null;
    if (hadMic) {
      try { Promise.resolve(onMicChange(false)).catch(() => report('signaling-error')); }
      catch { report('signaling-error'); }
    }
  }

  function clearDisconnectTimer() {
    if (disconnectTimer !== null) clearTimeout(disconnectTimer);
    disconnectTimer = null;
  }

  function scheduleDisconnect(callback, delay) {
    clearDisconnectTimer();
    const timer = setTimeout(() => {
      if (disconnectTimer !== timer) return;
      disconnectTimer = null;
      callback();
    }, delay);
    disconnectTimer = timer;
  }

  function releasePeer() {
    clearDisconnectTimer();
    if (statsTimer !== null) clearInterval(statsTimer);
    statsTimer = null;
    if (peer) {
      peer.onicecandidate = null;
      peer.oniceconnectionstatechange = null;
      peer.ontrack = null;
      peer.close();
      peer = null;
    }
    micSender = null;
    screenSenders = [];
    negotiationId = null;
    remoteDescriptionReady = false;
    pendingRemoteIce = [];
    pendingLocalIce = [];
    sendingDescription = false;
    remoteStream = null;
    restartAttempts = 0;
    recoveryBusy = false;
    viewerRecoveryPending = false;
    failureReported = false;
    badSamples = 0;
    goodSamples = 0;
    qualityTier = '1080p';
    maxQualityTier = '1080p';
    if (!closed) onRemoteStream(null);
  }

  function failDirect() {
    if (failureReported || closed) return;
    failureReported = true;
    viewerRecoveryPending = false;
    clearDisconnectTimer();
    report('direct-failed', statusMessage);
  }

  function waitForViewerRecovery(current, id, requestOffer) {
    if (peer !== current || closed) return;
    viewerRecoveryPending = true;
    if (requestOffer) report('needs-sharer-renegotiation', 'Ask the sharer to reconnect.');
    scheduleDisconnect(() => {
      if (peer === current && negotiationId === id && !closed &&
          current.iceConnectionState !== 'connected' && current.iceConnectionState !== 'completed') failDirect();
    }, VIEWER_RECOVERY_WAIT_MS);
  }

  function ensurePeer() {
    if (peer) return peer;
    if (!PeerConnection) throw new Error('WebRTC is unavailable');
    const current = new PeerConnection({ iceServers: ICE_SERVERS });
    peer = current;
    current.ontrack = (event) => {
      if (closed || peer !== current) return;
      if (!remoteStream) remoteStream = globalThis.MediaStream ? new MediaStream() : event.streams?.[0];
      if (!remoteStream) return;
      if (!remoteStream.getTracks().includes(event.track)) remoteStream.addTrack(event.track);
      onRemoteStream(remoteStream);
    };
    current.onicecandidate = (event) => {
      if (closed || peer !== current || !negotiationId || !event.candidate) return;
      const data = serializableCandidate(event.candidate);
      if (!data) return;
      if (sendingDescription) pendingLocalIce.push(data);
      else Promise.resolve().then(() => sendSignal({ kind: 'ice', negotiationId, data })).catch(() => report('signaling-error'));
    };
    current.oniceconnectionstatechange = () => {
      if (closed || peer !== current) return;
      const state = current.iceConnectionState;
      if (state === 'connected' || state === 'completed') {
        clearDisconnectTimer();
        viewerRecoveryPending = false;
        restartAttempts = 0;
        failureReported = false;
        report('connected');
      } else if (state === 'disconnected') {
        report('disconnected');
        if (viewerRecoveryPending) return;
        scheduleDisconnect(() => {
          if (peer === current && current.iceConnectionState === 'disconnected') void recoverIce();
        }, DISCONNECT_GRACE_MS);
      } else if (state === 'failed') {
        if (viewerRecoveryPending) return;
        clearDisconnectTimer();
        void recoverIce();
      } else if (state === 'checking') {
        report('connecting');
      }
    };
    if (micTrack && micTrack.readyState !== 'ended') micSender = current.addTrack(micTrack, micStream);
    if (screenStream) attachScreenTracks(current);
    // A video-only offer still needs an audio m-line so the viewer can answer with a mic track.
    if (screenStream && !micSender && !screenSenders.some((sender) => sender.track.kind === 'audio')) {
      current.addTransceiver('audio', { direction: 'recvonly' });
    }
    statsTimer = setInterval(() => { void sampleQuality().catch(() => report('stats-unavailable')); }, STATS_INTERVAL_MS);
    return current;
  }

  function attachScreenTracks(current) {
    screenSenders = screenStream.getTracks()
      .filter((track) => track.readyState !== 'ended')
      .map((track) => current.addTrack(track, screenStream));
  }

  async function flushLocalIce(id) {
    const candidates = pendingLocalIce;
    pendingLocalIce = [];
    for (const data of candidates) {
      if (negotiationId !== id || closed) break;
      await sendSignal({ kind: 'ice', negotiationId: id, data });
    }
  }

  async function flushRemoteIce(current, id) {
    const candidates = pendingRemoteIce;
    pendingRemoteIce = [];
    for (const data of candidates) {
      if (peer !== current || negotiationId !== id || closed) break;
      await current.addIceCandidate(data);
    }
  }

  async function sendOffer(iceRestart = false) {
    if (closed || !screenStream) return false;
    const current = ensurePeer();
    if (current.signalingState === 'have-local-offer') await current.setLocalDescription({ type: 'rollback' });
    if (peer !== current || closed) return false;
    const id = newNegotiationId();
    negotiationId = id;
    remoteDescriptionReady = false;
    pendingRemoteIce = [];
    pendingLocalIce = [];
    sendingDescription = true;
    try {
      if (iceRestart) current.restartIce?.();
      const offer = await current.createOffer(iceRestart ? { iceRestart: true } : {});
      await current.setLocalDescription(offer);
      if (peer !== current || negotiationId !== id || closed) return false;
      try {
        await sendSignal({ kind: 'offer', negotiationId: id, data: { type: 'offer', sdp: current.localDescription.sdp } });
      } catch {
        pendingLocalIce = [];
        report('waiting-for-peer', 'Waiting for the other device to join.');
        return false;
      }
      sendingDescription = false;
      await flushLocalIce(id);
      report('connecting');
      return true;
    } finally {
      sendingDescription = false;
    }
  }

  async function recoverIce() {
    if (closed || !peer || recoveryBusy || failureReported) return;
    if (!screenStream) {
      if (!viewerRecoveryPending) waitForViewerRecovery(peer, negotiationId, true);
      return;
    }
    if (restartAttempts >= MAX_ICE_RESTARTS) { failDirect(); return; }
    recoveryBusy = true;
    restartAttempts++;
    const current = peer;
    try { await sendOffer(true); }
    catch { if (restartAttempts >= MAX_ICE_RESTARTS) failDirect(); }
    finally {
      recoveryBusy = false;
      if (peer === current && !closed && !failureReported &&
          current.iceConnectionState !== 'connected' && current.iceConnectionState !== 'completed') {
        scheduleDisconnect(() => { void recoverIce(); }, RECOVERY_WAIT_MS);
      }
    }
  }

  async function setVideoTier(tier) {
    if (!screenVideo || !peer) return false;
    const sender = screenSenders.find((item) => item.track === screenVideo);
    if (!sender) return false;
    const settings = screenVideo.getSettings?.() || {};
    const selectedTier = tier === '1080p' && maxQualityTier === '720p' ? '720p' : tier;
    const scale = selectedTier === '720p'
      ? Math.max(1, (settings.width || 1280) / 1280, (settings.height || 720) / 720)
      : Math.max(1, (settings.width || 1920) / 1920, (settings.height || 1080) / 1080);
    try {
      const parameters = sender.getParameters();
      if (!parameters.encodings?.length) parameters.encodings = [{}];
      parameters.encodings[0].maxBitrate = selectedTier === '720p' ? 2_500_000 : 6_000_000;
      parameters.encodings[0].scaleResolutionDownBy = scale;
      await sender.setParameters(parameters);
      qualityTier = selectedTier;
      return true;
    } catch {
      report('quality-limited');
      return false;
    }
  }

  function readStats(stats) {
    const reports = [...stats.values()];
    const video = reports.find((item) => item.type === (screenStream ? 'outbound-rtp' : 'inbound-rtp') && (item.kind === 'video' || item.mediaType === 'video'));
    const loss = reports.find((item) => item.type === 'remote-inbound-rtp' && (item.kind === 'video' || item.mediaType === 'video'));
    const inbound = reports.find((item) => item.type === 'inbound-rtp' && (item.kind === 'video' || item.mediaType === 'video'));
    const selectedPair = reports.find((item) => item.type === 'candidate-pair' && (item.selected || item.nominated && item.state === 'succeeded'));
    const remoteCandidate = selectedPair && stats.get(selectedPair.remoteCandidateId);
    const localCandidate = selectedPair && stats.get(selectedPair.localCandidateId);
    const candidateType = remoteCandidate?.candidateType || localCandidate?.candidateType || null;
    return {
      frameRate: video?.framesPerSecond ?? null,
      width: video?.frameWidth ?? null,
      height: video?.frameHeight ?? null,
      framesDropped: inbound?.framesDropped ?? null,
      packetsLost: inbound?.packetsLost ?? null,
      lossFraction: loss?.fractionLost ?? null,
      jitterMs: (loss?.jitter ?? inbound?.jitter ?? null) === null ? null : (loss?.jitter ?? inbound?.jitter) * 1000,
      rttMs: (loss?.roundTripTime ?? selectedPair?.currentRoundTripTime ?? null) === null ? null : (loss?.roundTripTime ?? selectedPair?.currentRoundTripTime) * 1000,
      candidateType,
      localCandidateType: localCandidate?.candidateType || null,
      remoteCandidateType: remoteCandidate?.candidateType || null,
    };
  }

  async function sampleQuality() {
    const current = peer;
    if (!current || closed || current.closed) return;
    const sample = readStats(await current.getStats());
    if (peer !== current || closed) return;
    if (sample.localCandidateType === 'relay' || sample.remoteCandidateType === 'relay') {
      failDirect();
      current.close();
      return;
    }
    if (screenStream && screenVideo) {
      const bad = (sample.lossFraction !== null && sample.lossFraction >= 0.08) ||
        (sample.rttMs !== null && sample.rttMs >= 350) ||
        (sample.jitterMs !== null && sample.jitterMs >= 60);
      const measured = sample.lossFraction !== null || sample.rttMs !== null || sample.jitterMs !== null;
      const good = measured && (sample.lossFraction === null || sample.lossFraction <= 0.02) &&
        (sample.rttMs === null || sample.rttMs <= 180) &&
        (sample.jitterMs === null || sample.jitterMs <= 25);
      badSamples = bad ? badSamples + 1 : 0;
      goodSamples = good ? goodSamples + 1 : 0;
      if (qualityTier === '1080p' && badSamples >= 2) {
        await setVideoTier('720p');
        badSamples = 0;
      } else if (qualityTier === '720p' && maxQualityTier === '1080p' && goodSamples >= 4) {
        await setVideoTier('1080p');
        goodSamples = 0;
      }
    }
    onQuality({ ...sample, tier: qualityTier });
  }

  async function startSharing() {
    if (closed) throw new Error('Media session is closed');
    if (screenStream) return { hasVideo: true, hasSourceAudio: screenStream.getAudioTracks().some((track) => track.readyState !== 'ended') };
    if (!mediaDevices?.getDisplayMedia) throw new Error('Screen capture is unavailable');
    const generation = ++captureGeneration;
    // Must run inside the click gesture, before the first await.
    const request = mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: true });
    const captured = await request;
    for (const track of captured.getTracks()) ownedTracks.add(track);
    if (closed || generation !== captureGeneration) {
      stopStream(captured);
      throw new Error('Screen capture was cancelled');
    }
    const video = captured.getVideoTracks()[0];
    if (!video) {
      stopStream(captured);
      throw new Error('The selected source has no video');
    }
    screenStream = captured;
    screenVideo = video;
    video.contentHint = 'motion';
    video.onended = () => { if (!closed) stopSharing(); };
    for (const track of captured.getAudioTracks()) {
      track.onended = () => {
        if (closed || !shareAnnounced || screenStream !== captured || captured.getAudioTracks().some((audio) => audio.readyState !== 'ended')) return;
        onShareChange({ active: true, hasSourceAudio: false });
        report('no-source-audio', 'No film audio is being shared.');
      };
    }
    try {
      await video.applyConstraints?.({ width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } });
    } catch { /* Browser/source may fix capture dimensions. */ }
    if (closed || generation !== captureGeneration || screenStream !== captured) throw new Error('Screen capture was cancelled');
    const hasSourceAudio = captured.getAudioTracks().some((track) => track.readyState !== 'ended');
    try {
      if (!hasSourceAudio) report('no-source-audio', 'No film audio is being shared.');
      if (peer && !screenSenders.length) releasePeer();
      const settings = video.getSettings?.() || {};
      maxQualityTier = settings.width > 0 && settings.height > 0 && settings.width <= 1280 && settings.height <= 720 ? '720p' : '1080p';
      ensurePeer();
      shareAnnounced = true;
      await Promise.resolve(onShareChange({ active: true, hasSourceAudio }));
      if (closed || generation !== captureGeneration) return { hasVideo: true, hasSourceAudio };
      await setVideoTier('1080p');
      await sendOffer();
      return { hasVideo: true, hasSourceAudio };
    } catch (error) {
      if (screenStream === captured) {
        const notifyStopped = shareAnnounced && !closed;
        shareAnnounced = false;
        stopSharing();
        if (notifyStopped) {
          try { await onShareChange({ active: false, hasSourceAudio: false }); }
          catch { report('signaling-error'); }
        }
      } else {
        stopStream(captured);
      }
      throw error;
    }
  }

  function stopSharing() {
    captureGeneration++;
    if (!screenStream) return;
    const captured = screenStream;
    screenStream = null;
    screenVideo = null;
    for (const track of captured.getTracks()) {
      track.onended = null;
      stopTrack(track);
    }
    stopMic();
    releasePeer();
    if (shareAnnounced && !closed) onShareChange({ active: false, hasSourceAudio: false });
    shareAnnounced = false;
  }

  function enableMic() {
    if (closed) return Promise.reject(new Error('Media session is closed'));
    if (micTrack && micTrack.readyState !== 'ended') return Promise.resolve(setMicEnabled(true));
    if (micRequest) return micRequest;
    if (!mediaDevices?.getUserMedia) return Promise.reject(new Error('Microphone capture is unavailable'));
    const generation = ++micGeneration;
    const request = (async () => {
      const captured = await mediaDevices.getUserMedia(MIC_CONSTRAINTS);
      for (const track of captured.getTracks()) ownedTracks.add(track);
      if (closed || generation !== micGeneration) {
        stopStream(captured);
        throw new Error('Microphone capture was cancelled');
      }
      const audio = captured.getAudioTracks()[0];
      if (!audio) {
        stopStream(captured);
        throw new Error('Microphone capture returned no audio');
      }
      try {
        micStream = captured;
        micTrack = audio;
        micTrack.enabled = true;
        micTrack.onended = () => {
          if (!closed && micTrack === audio) stopMic();
        };
        if (peer) micSender = peer.addTrack(micTrack, micStream);
        await Promise.resolve(onMicChange(true));
        if (closed || generation !== micGeneration) throw new Error('Microphone capture was cancelled');
        if (screenStream && peer) await sendOffer();
        else if (peer) report('needs-sharer-renegotiation', 'Ask the sharer to reconnect.');
        return true;
      } catch (error) {
        if (micStream === captured) stopMic();
        else stopStream(captured);
        throw error;
      }
    })();
    micRequest = request;
    request.then(() => { if (micRequest === request) micRequest = null; }, () => { if (micRequest === request) micRequest = null; });
    return request;
  }

  function setMicEnabled(enabled) {
    if (closed) return false;
    if (enabled && !micTrack) return enableMic();
    if (!micTrack || micTrack.readyState === 'ended' || micTrack.enabled === Boolean(enabled)) return Boolean(micTrack?.enabled);
    micTrack.enabled = Boolean(enabled);
    onMicChange(micTrack.enabled);
    return micTrack.enabled;
  }

  async function handleSignal({ kind, negotiationId: incomingId, data } = {}) {
    if (closed || !/^[A-Za-z0-9_-]{1,64}$/.test(incomingId || '') || !data || typeof data !== 'object') return false;
    if (kind === 'offer') {
      if (screenStream || data.type !== 'offer' || typeof data.sdp !== 'string' || !data.sdp) return false;
      if (incomingId === negotiationId) return false;
      const current = ensurePeer();
      const recovering = viewerRecoveryPending || current.iceConnectionState === 'failed' || current.iceConnectionState === 'disconnected';
      failureReported = false;
      negotiationId = incomingId;
      if (recovering) waitForViewerRecovery(current, incomingId, false);
      else {
        clearDisconnectTimer();
        viewerRecoveryPending = false;
      }
      remoteDescriptionReady = false;
      pendingRemoteIce = [];
      pendingLocalIce = [];
      sendingDescription = true;
      try {
        await current.setRemoteDescription({ type: 'offer', sdp: withoutRelayCandidates(data.sdp) });
        if (peer !== current || negotiationId !== incomingId || closed || failureReported) return false;
        remoteDescriptionReady = true;
        await flushRemoteIce(current, incomingId);
        const answer = await current.createAnswer();
        if (peer !== current || negotiationId !== incomingId || closed || failureReported) return false;
        await current.setLocalDescription(answer);
        if (peer !== current || negotiationId !== incomingId || closed || failureReported) return false;
        await sendSignal({ kind: 'answer', negotiationId: incomingId, data: { type: 'answer', sdp: current.localDescription.sdp } });
        if (peer !== current || negotiationId !== incomingId || closed || failureReported) return false;
        sendingDescription = false;
        await flushLocalIce(incomingId);
        return peer === current && negotiationId === incomingId && !closed && !failureReported;
      } finally {
        sendingDescription = false;
      }
    }
    if (incomingId !== negotiationId || !peer) return false;
    if (kind === 'answer') {
      if (!screenStream || data.type !== 'answer' || typeof data.sdp !== 'string' || !data.sdp) return false;
      await peer.setRemoteDescription({ type: 'answer', sdp: withoutRelayCandidates(data.sdp) });
      remoteDescriptionReady = true;
      await flushRemoteIce(peer, incomingId);
      return true;
    }
    if (kind === 'ice') {
      const candidate = serializableCandidate(data);
      if (!candidate) return false;
      if (!remoteDescriptionReady) pendingRemoteIce.push(candidate);
      else await peer.addIceCandidate(candidate);
      return true;
    }
    return false;
  }

  async function restartIce() {
    if (closed || !screenStream) {
      if (!closed && peer) report('needs-sharer-renegotiation', 'Ask the sharer to reconnect.');
      return false;
    }
    return sendOffer(true);
  }

  function close() {
    if (closed) return;
    closed = true;
    captureGeneration++;
    if (screenStream) {
      for (const track of screenStream.getTracks()) {
        track.onended = null;
        stopTrack(track);
      }
      screenStream = null;
      screenVideo = null;
      if (shareAnnounced) onShareChange({ active: false, hasSourceAudio: false });
      shareAnnounced = false;
    }
    stopMic();
    for (const track of ownedTracks) stopTrack(track);
    releasePeer();
    ownedTracks.clear();
    onRemoteStream(null);
  }

  return { startSharing, stopSharing, enableMic, setMicEnabled, handleSignal, restartIce, close };
}
