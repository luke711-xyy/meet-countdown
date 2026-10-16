import { createScreeningMedia } from './screening-media.js';

const MAX_DANMAKU = 6;
const DANMAKU_INTERVAL_MS = 1000;
const MAX_VIEWER_REJOINS = 1;
const SHARE_ACK_TIMEOUT_MS = 8000;
const CONTROLS_IDLE_MS = 5000;
let fallbackDevice = 0;

function deviceId() {
  if (globalThis.crypto?.randomUUID) return `d_${globalThis.crypto.randomUUID().replaceAll('-', '')}`;
  return `d_${Date.now().toString(36)}_${(++fallbackDevice).toString(36)}`;
}

/** The DOM owns presentation; the media factory owns tracks and PeerConnection. */
export function createScreeningRoom({ root, trigger, send, getContext, onOpenChange = () => {}, createMedia = createScreeningMedia }) {
  if (!root || !trigger || typeof send !== 'function' || typeof getContext !== 'function') throw new TypeError('Screening room elements and callbacks are required');
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  const el = (id) => root.querySelector(`#${id}`);
  const ui = {
    close: el('screening-close'), person: el('screening-person'), video: el('screening-video'),
    empty: el('screening-empty'), status: el('screening-status'), audio: el('screening-enable-audio'),
    audioIndicator: el('screening-audio-indicator'),
    mic: el('screening-mic'), share: el('screening-share'), pause: el('screening-pause'),
    messageForm: el('screening-danmaku-form'), message: el('screening-danmaku-input'),
    danmaku: el('screening-danmaku'), confirmRow: el('screening-confirm-row'),
    confirmText: el('screening-confirm-text'), confirm: el('screening-confirm'), takeover: el('screening-takeover'),
  };
  const captureSupported = typeof win?.navigator?.mediaDevices?.getDisplayMedia === 'function';
  const myDeviceId = deviceId();
  let opened = false;
  let disposed = false;
  let socketReady = true;
  let sessionId = null;
  let seq = 0;
  let peer = null;
  let sharerId = null;
  let isSharer = false;
  let sharingBusy = false;
  let micEnabled = false;
  let micEverEnabled = false;
  let paused = false;
  let pendingPause = null;
  let sourceAudioMissing = false;
  let pendingShare = null;
  let latestShareRequestSeq = 0;
  let latestReleaseSeq = 0;
  let confirmedShareSeq = 0;
  let idleTimer = null;
  let micStatusExpected = false;
  let viewerRejoins = 0;
  let rejoining = false;
  let lastDanmakuAt = 0;
  let danmakuLane = 0;
  let media = null;
  let inertState = [];

  function status(message) {
    ui.status.textContent = message;
  }

  function rejectPendingShare(message) {
    if (!pendingShare) return;
    const pending = pendingShare;
    pendingShare = null;
    win.clearTimeout(pending.timer);
    pending.reject(new Error(message));
    render();
  }

  function wakeControls() {
    if (!opened) return;
    root.classList.remove('is-idle');
    if (idleTimer !== null) win.clearTimeout(idleTimer);
    idleTimer = win.setTimeout(() => { idleTimer = null; root.classList.add('is-idle'); }, CONTROLS_IDLE_MS);
  }

  function context() { return getContext() || {}; }
  function peerName(id) {
    return context().members?.find((member) => (member.id ?? member.memberId) === id)?.username || '对方';
  }
  function sendRaw(type, payload) {
    if (!socketReady) throw new Error('放映室连接已断开');
    const result = send({ type, payload });
    if (result === false) throw new Error('放映室连接已断开');
    return Promise.resolve(result);
  }
  function command(type, fields = {}, onSequence = () => {}) {
    if (!sessionId) throw new Error('尚未加入放映室');
    const requestSeq = ++seq;
    onSequence(requestSeq);
    return sendRaw(type, { sessionId, seq: requestSeq, ...fields });
  }
  function releaseShare() {
    return command('screening.share', { active: false, hasSourceAudio: false }, (requestSeq) => { latestReleaseSeq = requestSeq; });
  }
  function join(takeover = false) {
    if (!opened || !context().roomId) return Promise.resolve(false);
    status('正在加入放映室…');
    return sendRaw('screening.join', { deviceId: myDeviceId, takeover });
  }

  function render() {
    ui.share.disabled = !sessionId || !captureSupported || Boolean(sharerId && !isSharer) || sharingBusy;
    ui.share.setAttribute('aria-label', isSharer ? '停止共享' : '共享画面');
    ui.share.title = ui.share.getAttribute('aria-label');
    ui.share.setAttribute('aria-pressed', String(isSharer));
    ui.mic.disabled = !sessionId;
    ui.mic.setAttribute('aria-label', micEnabled ? '关闭麦克风' : '开启麦克风');
    ui.mic.setAttribute('aria-pressed', String(micEnabled));
    ui.pause.disabled = !sessionId || !sharerId || pendingPause !== null;
    ui.pause.setAttribute('aria-label', paused ? '请求继续' : '请求暂停');
    ui.pause.title = ui.pause.getAttribute('aria-label');
    ui.message.disabled = !sessionId;
    ui.messageForm.querySelector('button').disabled = !sessionId;
    ui.person.textContent = sharerId ? `${peerName(sharerId)}正在共享` : peer ? `${peerName(peer.memberId)}已加入` : '';
    ui.audioIndicator.hidden = !sharerId || !sourceAudioMissing;
    ui.empty.querySelector('span').textContent = pendingShare ? '正在等待服务器确认共享…'
      : sharingBusy && !isSharer ? '正在准备共享…'
        : isSharer ? '你正在共享画面'
          : sharerId ? '正在连接对方画面…' : '等待共享画面';
    ui.confirmRow.hidden = pendingPause === null || !isSharer;
    if (pendingPause !== null) {
      ui.confirmText.textContent = pendingPause ? '请在播放器中暂停' : '请在播放器中继续';
      ui.confirm.textContent = pendingPause ? '已暂停' : '已继续';
    }
  }

  function mediaSession() {
    if (media) return media;
    media = createMedia({
      sendSignal: (signal) => {
        if (!peer?.deviceId) return Promise.reject(new Error('等待另一设备加入'));
        try { return command('screening.signal', { ...signal, targetDeviceId: peer.deviceId }); }
        catch (error) { return Promise.reject(error); }
      },
      onShareChange: async ({ active, hasSourceAudio }) => {
        if (!opened || !sessionId) return;
        if (active && isSharer) {
          sourceAudioMissing = !hasSourceAudio;
          render();
          try {
            await command('screening.share', { active: true, hasSourceAudio: Boolean(hasSourceAudio) },
              (requestSeq) => { latestShareRequestSeq = requestSeq; });
          }
          catch { status('影片声音状态发送失败'); }
          return;
        }
        if (active) {
          if (pendingShare) return pendingShare.promise;
          const pending = {};
          pending.promise = new Promise((resolve, reject) => { pending.resolve = resolve; pending.reject = reject; });
          pending.timer = win.setTimeout(() => {
            if (pendingShare !== pending) return;
            rejectPendingShare('共享确认超时');
            try { void releaseShare().catch(() => {}); } catch { /* Session may have closed. */ }
            status('共享确认超时，请重试');
          }, SHARE_ACK_TIMEOUT_MS);
          pendingShare = pending;
          sourceAudioMissing = !hasSourceAudio;
          status('等待服务器确认共享…');
          render();
          try {
            void command('screening.share', { active: true, hasSourceAudio: Boolean(hasSourceAudio) },
              (requestSeq) => { pending.requestSeq = requestSeq; latestShareRequestSeq = requestSeq; })
              .catch((error) => { if (pendingShare === pending) rejectPendingShare(error.message); });
          } catch (error) { rejectPendingShare(error.message); }
          return pending.promise;
        }
        rejectPendingShare('共享已停止');
        if (!isSharer && latestReleaseSeq > latestShareRequestSeq) return;
        if (isSharer) {
          isSharer = false;
          sharerId = null;
          sourceAudioMissing = false;
          paused = false;
          pendingPause = null;
          status('等待共享画面');
          render();
        }
        try { await releaseShare(); }
        catch { status('停止共享通知失败'); }
      },
      onMicChange: async (enabled) => {
        if (!opened || !sessionId) return;
        if (enabled && !micEverEnabled && !isSharer && peer) micStatusExpected = true;
        if (enabled) micEverEnabled = true;
        micEnabled = enabled;
        render();
        try { await command('screening.mic', { enabled }); }
        catch { status('麦克风状态发送失败'); }
      },
      onRemoteStream: (stream) => {
        if (!opened) return;
        ui.video.srcObject = stream;
        ui.video.hidden = !stream;
        ui.empty.hidden = Boolean(stream);
        if (!stream) { ui.audio.hidden = true; return; }
        try {
          Promise.resolve(ui.video.play()).then(() => { ui.audio.hidden = true; }, () => {
            ui.audio.hidden = false;
            status('播放受限，请开启声音');
          });
        } catch {
          ui.audio.hidden = false;
          status('播放受限，请开启声音');
        }
      },
      onStatus: ({ state }) => {
        if (!opened) return;
        if (state === 'no-source-audio') { sourceAudioMissing = true; status('未共享影片声音'); render(); }
        else if (state === 'direct-failed') status('当前网络直连失败，请换网络后重新加入');
        else if (state === 'needs-sharer-renegotiation') {
          status('等待分享者重新连接');
          if (micStatusExpected) micStatusExpected = false;
          else if (!isSharer) void rejoinViewer();
        } else if (state === 'waiting-for-peer') status('等待对方加入');
        else if (state === 'connected') { micStatusExpected = false; status('已连接'); }
        else if (state === 'connecting') status('正在连接…');
        else if (state === 'disconnected') status('连接中断，正在重试');
        else if (state === 'signaling-error') status('连接信令发送失败');
      },
    });
    return media;
  }

  async function rejoinViewer() {
    if (!opened || !sessionId || !peer || !sharerId || rejoining || viewerRejoins >= MAX_VIEWER_REJOINS) return;
    rejoining = true;
    viewerRejoins++;
    try {
      await command('screening.leave');
      sessionId = null;
      seq = 0;
      render();
      await join();
    } catch {
      status('重新加入失败，请离开后重试');
    } finally { rejoining = false; }
  }

  function addDanmaku(text) {
    if (!text || !opened) return;
    while (ui.danmaku.children.length >= MAX_DANMAKU) ui.danmaku.firstElementChild.remove();
    const item = doc.createElement('span');
    item.className = 'screening-danmaku-item';
    item.textContent = [...text].slice(0, 80).join('');
    item.style.top = `${8 + (danmakuLane++ % 4) * 20}%`;
    ui.danmaku.append(item);
    win.setTimeout(() => item.remove(), 7200);
  }

  async function open() {
    if (disposed || opened || !context().roomId) return false;
    opened = true;
    root.hidden = false;
    const behind = doc.querySelectorAll('.app-shell, .edge-rail, .settings-dialog, .context-menu');
    inertState = [...behind].map((node) => [node, node.inert]);
    for (const [node] of inertState) node.inert = true;
    doc.documentElement.classList.add('screening-is-open');
    ui.close.focus();
    wakeControls();
    onOpenChange(true);
    mediaSession();
    try { await join(); }
    catch { status('连接失败，请稍后重试'); }
    render();
    return true;
  }

  function close({ notify = true } = {}) {
    if (!opened) return;
    rejectPendingShare('已离开放映室');
    if (idleTimer !== null) win.clearTimeout(idleTimer);
    idleTimer = null;
    root.classList.remove('is-idle');
    if (notify && sessionId && socketReady) {
      try { void command('screening.leave').catch(() => {}); } catch { /* Socket may have closed. */ }
    }
    opened = false;
    sessionId = null;
    seq = 0;
    peer = null;
    sharerId = null;
    isSharer = false;
    micEnabled = false;
    micEverEnabled = false;
    paused = false;
    pendingPause = null;
    sourceAudioMissing = false;
    latestShareRequestSeq = 0;
    latestReleaseSeq = 0;
    confirmedShareSeq = 0;
    micStatusExpected = false;
    viewerRejoins = 0;
    rejoining = false;
    media?.close();
    media = null;
    ui.video.srcObject = null;
    ui.video.hidden = true;
    ui.audio.hidden = true;
    ui.empty.hidden = false;
    ui.danmaku.replaceChildren();
    ui.takeover.hidden = true;
    root.hidden = true;
    for (const [node, value] of inertState) node.inert = value;
    inertState = [];
    doc.documentElement.classList.remove('screening-is-open');
    onOpenChange(false);
    trigger.focus();
    render();
  }

  function handleEvent({ type, payload = {} } = {}) {
    if (type === 'room.destroyed') { close({ notify: false }); return; }
    if (!opened || !type?.startsWith('screening.')) return;
    if (type === 'screening.taken-over') { status('已在另一设备接管'); close({ notify: false }); return; }
    if (type === 'screening.device-in-use') {
      ui.takeover.hidden = false;
      status('正在另一设备放映');
      return;
    }
    if (type === 'screening.joined') {
      if (payload.deviceId !== myDeviceId || !payload.sessionId) return;
      sessionId = payload.sessionId;
      seq = 0;
      latestShareRequestSeq = 0;
      latestReleaseSeq = 0;
      confirmedShareSeq = 0;
      ui.takeover.hidden = true;
      const other = payload.peers?.find((item) => item.memberId !== context().memberId);
      peer = other ? { memberId: other.memberId, deviceId: other.deviceId } : null;
      sharerId = other?.sharer ? other.memberId : null;
      sourceAudioMissing = Boolean(sharerId && other.hasSourceAudio !== true);
      paused = other?.paused === true;
      pendingPause = null;
      status(sharerId ? '正在连接画面…' : '等待共享画面');
      render();
      return;
    }
    if (!sessionId) return;
    if (type === 'screening.peer.joined' && payload.memberId !== context().memberId) {
      peer = { memberId: payload.memberId, deviceId: payload.deviceId };
      status(isSharer ? '正在连接画面…' : '对方已加入');
      render();
      if (isSharer) void Promise.resolve(mediaSession().restartIce()).catch(() => status('重新连接失败'));
    } else if (type === 'screening.peer.left' && peer?.deviceId === payload.deviceId) {
      peer = null;
      if (!isSharer) {
        if (sharerId === payload.memberId) sharerId = null;
        media?.close();
        media = null;
        micEnabled = false;
        micEverEnabled = false;
      }
      status('等待对方加入');
      render();
    } else if (type === 'screening.share.changed') {
      if (payload.memberId === context().memberId) {
        const requestSeq = payload.requestSeq;
        if (!Number.isSafeInteger(requestSeq) || requestSeq < 1) return;
        if (payload.active && pendingShare) {
          if (requestSeq !== pendingShare.requestSeq) return;
          const pending = pendingShare;
          pendingShare = null;
          win.clearTimeout(pending.timer);
          isSharer = true;
          sharerId = payload.memberId;
          sourceAudioMissing = payload.hasSourceAudio !== true;
          confirmedShareSeq = requestSeq;
          pending.resolve();
        } else if (payload.active && isSharer) {
          if (requestSeq < confirmedShareSeq || requestSeq <= latestReleaseSeq) return;
          confirmedShareSeq = requestSeq;
          sourceAudioMissing = payload.hasSourceAudio !== true;
        } else if (payload.active) {
          if (requestSeq <= latestReleaseSeq) return;
          try { void releaseShare().catch(() => {}); } catch { /* Session may have closed. */ }
          return;
        } else {
          if (pendingShare || requestSeq !== latestReleaseSeq || requestSeq < confirmedShareSeq) return;
          isSharer = false;
          if (sharerId === payload.memberId) sharerId = null;
          sourceAudioMissing = false;
        }
      } else {
        if (payload.active) {
          rejectPendingShare('对方已开始共享');
          sharerId = payload.memberId;
          sourceAudioMissing = payload.hasSourceAudio !== true;
        } else if (sharerId === payload.memberId) {
          sharerId = null;
          sourceAudioMissing = false;
        }
      }
      if (!payload.active) { paused = false; pendingPause = null; }
      if (!payload.active && payload.memberId !== context().memberId) {
        ui.video.srcObject = null;
        ui.video.hidden = true;
        ui.empty.hidden = false;
        ui.audio.hidden = true;
      }
      status(sharerId ? isSharer ? '正在共享画面' : '正在连接画面…' : '等待共享画面');
      render();
    } else if (type === 'screening.signal' && peer?.deviceId === payload.deviceId) {
      const { kind, negotiationId, data } = payload;
      void Promise.resolve(mediaSession().handleSignal({ kind, negotiationId, data })).catch(() => status('画面连接失败'));
    } else if (type === 'screening.mic.changed' && payload.memberId !== context().memberId && isSharer && payload.enabled) {
      void Promise.resolve(mediaSession().restartIce()).catch(() => status('重新连接失败'));
    } else if (type === 'screening.danmaku') {
      addDanmaku(payload.text);
    } else if (type === 'screening.pause.requested') {
      pendingPause = payload.paused === true;
      status(isSharer ? '请操作外部播放器后确认' : '等待分享者确认');
      render();
    } else if (type === 'screening.pause.confirmed') {
      paused = payload.paused === true;
      pendingPause = null;
      status(paused ? '分享者已确认暂停' : '分享者已确认继续');
      render();
    }
  }

  function onSocketOpen() {
    socketReady = true;
    if (!opened) return;
    rejectPendingShare('连接已重置');
    sessionId = null;
    seq = 0;
    peer = null;
    sharerId = null;
    isSharer = false;
    sourceAudioMissing = false;
    latestShareRequestSeq = 0;
    latestReleaseSeq = 0;
    confirmedShareSeq = 0;
    media?.close();
    media = null;
    micEverEnabled = false;
    mediaSession();
    void join().catch(() => status('重新加入失败'));
    render();
  }
  function onSocketClose() {
    socketReady = false;
    rejectPendingShare('连接已断开');
    sessionId = null;
    seq = 0;
    peer = null;
    sharerId = null;
    isSharer = false;
    sourceAudioMissing = false;
    latestShareRequestSeq = 0;
    latestReleaseSeq = 0;
    confirmedShareSeq = 0;
    media?.close();
    media = null;
    micEverEnabled = false;
    if (opened) { status('连接中断，等待重连'); render(); }
  }

  async function toggleShare() {
    if (!sessionId || ui.share.disabled || sharingBusy) return;
    if (isSharer) { mediaSession().stopSharing(); return; }
    sharingBusy = true;
    render();
    try { await mediaSession().startSharing(); }
    catch (error) {
      status(error?.name === 'NotAllowedError' ? '已取消共享' : '无法共享画面');
    } finally { sharingBusy = false; render(); }
  }
  async function toggleMic() {
    if (!sessionId || ui.mic.disabled) return;
    try {
      if (micEnabled) await mediaSession().setMicEnabled(false);
      else await mediaSession().enableMic();
    } catch { status('无法开启麦克风'); }
  }
  function requestPause() {
    if (!sessionId || !sharerId || pendingPause !== null) return;
    const next = !paused;
    try {
      void command('screening.pause.request', { paused: next }).catch(() => status('请求发送失败'));
      status(isSharer ? '请操作外部播放器后确认' : '等待分享者确认');
    } catch { status('请求发送失败'); }
  }
  function confirmPause() {
    if (!isSharer || pendingPause === null) return;
    try { void command('screening.pause.confirm', { paused: pendingPause }).catch(() => status('确认发送失败')); }
    catch { status('确认发送失败'); }
  }
  function sendDanmaku(event) {
    event.preventDefault();
    const text = [...ui.message.value.trim()].slice(0, 80).join('');
    if (!sessionId || !text) return;
    const now = Date.now();
    if (now - lastDanmakuAt < DANMAKU_INTERVAL_MS) { status('弹幕发送稍快，请稍候'); return; }
    try {
      void command('screening.danmaku', { text }).catch(() => status('弹幕发送失败'));
      lastDanmakuAt = now;
      ui.message.value = '';
    } catch { status('弹幕发送失败'); }
  }
  function onKeydown(event) {
    if (!opened) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab') return;
    const focusables = [...root.querySelectorAll('button:not(:disabled), input:not(:disabled)')]
      .filter((node) => !node.closest('[hidden]'));
    const first = focusables[0];
    const last = focusables.at(-1);
    if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  function enableAudio() {
    try {
      Promise.resolve(ui.video.play()).then(() => { ui.audio.hidden = true; status('已连接'); }, () => status('请再次点按开启声音'));
    } catch { status('请再次点按开启声音'); }
  }
  function takeover() { void join(true).catch(() => status('接管失败，请重试')); }

  trigger.addEventListener('click', open);
  root.addEventListener('pointermove', wakeControls);
  root.addEventListener('pointerdown', wakeControls);
  root.addEventListener('focusin', wakeControls);
  ui.close.addEventListener('click', close);
  ui.share.addEventListener('click', toggleShare);
  ui.mic.addEventListener('click', toggleMic);
  ui.pause.addEventListener('click', requestPause);
  ui.confirm.addEventListener('click', confirmPause);
  ui.messageForm.addEventListener('submit', sendDanmaku);
  ui.audio.addEventListener('click', enableAudio);
  ui.takeover.addEventListener('click', takeover);
  doc.addEventListener('keydown', onKeydown);
  render();

  function dispose() {
    close();
    disposed = true;
    trigger.removeEventListener('click', open);
    root.removeEventListener('pointermove', wakeControls);
    root.removeEventListener('pointerdown', wakeControls);
    root.removeEventListener('focusin', wakeControls);
    ui.close.removeEventListener('click', close);
    ui.share.removeEventListener('click', toggleShare);
    ui.mic.removeEventListener('click', toggleMic);
    ui.pause.removeEventListener('click', requestPause);
    ui.confirm.removeEventListener('click', confirmPause);
    ui.messageForm.removeEventListener('submit', sendDanmaku);
    ui.audio.removeEventListener('click', enableAudio);
    ui.takeover.removeEventListener('click', takeover);
    doc.removeEventListener('keydown', onKeydown);
  }
  return { open, close, handleEvent, onSocketOpen, onSocketClose, dispose };
}
