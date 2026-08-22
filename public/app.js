import { WaterBackground } from './water-background.js';
import { initHtmlCanvasBridge } from './html-canvas-bridge.js';

const $ = (selector) => document.querySelector(selector);
const elements = {
  authGate: $('#auth-gate'), authIntro: $('#auth-intro'), authForm: $('#auth-form'), authUsername: $('#auth-username'), authPassword: $('#auth-password'), authStatus: $('#auth-status'), authSubmit: $('#auth-submit'), loginTab: $('#login-tab'), registerTab: $('#register-tab'), roomGate: $('#room-gate'), roomGateMessage: $('#room-gate-message'), createRoomButton: $('#create-room-button'), accountName: $('#account-name'),
  background: $('.background-layer'), waterCanvas: $('#water-canvas'), targetSummary: $('#target-summary'),
  days: $('#days'), hours: $('#hours'), minutes: $('#minutes'), seconds: $('#seconds'), currentTime: $('#current-time'),
  timezoneLabel: $('#timezone-label'), dialog: $('#settings-dialog'), form: $('#settings-form'), targetAt: $('#target-at'),
  chooseBackground: $('#choose-background'), fileName: $('#file-name'), removeBackground: $('#remove-background'),
  blurRange: $('#blur-range'), blurOutput: $('#blur-output'), contrastRange: $('#contrast-range'), contrastOutput: $('#contrast-output'), brightnessRange: $('#brightness-range'), brightnessOutput: $('#brightness-output'), saveButton: $('#save-settings'), saveStatus: $('#save-status'),
  toast: $('#toast'), voiceRail: $('#voice-rail'), voiceOrb: $('#voice-orb'), voiceCount: $('#voice-count'),
  voiceCapsules: $('#voice-capsules'), voiceRecordingCapsule: $('#voice-recording-capsule'), cancelVoice: $('#cancel-voice'), stopVoice: $('#stop-voice'), recordTime: $('#record-time'),
  taskRail: $('#task-rail'), taskOrb: $('#task-orb'), taskCount: $('#task-count'), taskComposer: $('#task-form'), cancelTask: $('#cancel-task'), taskInput: $('#task-input'), taskListTheirs: $('#task-list-theirs'), taskListMine: $('#task-list-mine'),
  inviteUrl: $('#invite-url'), copyInvite: $('#copy-invite'), roomMembers: $('#room-members'), destroyRoom: $('#destroy-room'), logoutButton: $('#logout-button'),
  contextMenu: $('#context-menu'), contextDelete: $('#context-delete'),
};

let state = null;
let roomId = null;
let memberId = null;
let currentUser = null;
let authMode = 'login';
let selectedBackground = null;
let selectedBackgroundFile = null;
let backgroundSelection = 'unchanged';
let toastTimer = null;
let socket = null;
let recorder = null;
let recorderStartedAt = 0;
let recorderTimer = null;
let recordingSession = null;
let activeAudio = null;
let activeVoiceItem = null;
let activeVoicePlay = null;
let contextTarget = null;
let lastPointerSentAt = 0;
let lastPointer = null;
const water = new WaterBackground(elements.waterCanvas);

function pad(value) { return String(value).padStart(2, '0'); }
function formatDate(date) { return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(date); }
function formatCurrentTime(date) { return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date); }
function formatShortTime(iso) { return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)); }
function toInputValue(iso) { const date = new Date(iso); const offset = date.getTimezoneOffset() * 60000; return new Date(date.getTime() - offset).toISOString().slice(0, 16); }
function currentBackground() { return state?.backgroundDataUrl || state?.backgroundUrl || null; }

function setBackground(source, blurPx, contrast = Number(elements.contrastRange?.value) || 1, brightness = Number(elements.brightnessRange?.value) || 0) {
  elements.background.style.backgroundImage = source ? `url("${source}")` : '';
  elements.background.style.setProperty('--background-blur', `${blurPx || 0}px`);
  water.setBlur(blurPx || 0);
  water.setTone(contrast, brightness);
  void water.setImage(source);
}

function updateToneLabels() {
  elements.contrastOutput.textContent = `${Math.round(Number(elements.contrastRange.value) * 100)}%`;
  const brightness = Math.round(Number(elements.brightnessRange.value) * 100);
  elements.brightnessOutput.textContent = `${brightness > 0 ? '+' : ''}${brightness}%`;
}

function render() {
  if (!state) return;
  const target = new Date(state.targetAt); const now = new Date(); const remainingMs = target.getTime() - now.getTime();
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const days = Math.floor(totalSeconds / 86400); const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60); const seconds = totalSeconds % 60;
  elements.days.textContent = String(days).padStart(2, '0'); elements.hours.textContent = pad(hours);
  elements.minutes.textContent = pad(minutes); elements.seconds.textContent = pad(seconds);
  elements.targetSummary.textContent = remainingMs > 0 ? `${formatDate(target)} · ${state.timeZone || '本地时间'}` : '现在就去见面吧';
  elements.currentTime.textContent = `现在是 ${formatCurrentTime(now)}`;
}

function showToast(message) {
  elements.toast.textContent = message; elements.toast.classList.add('is-visible'); clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove('is-visible'), 2600);
}
function closeContextMenu() {
  contextTarget = null;
  elements.contextMenu.classList.add('hidden');
}
function openContextMenu(event, type, id) {
  event.preventDefault(); event.stopPropagation();
  contextTarget = { type, id };
  elements.contextDelete.textContent = type === 'voice' ? '删除录音' : '删除任务';
  elements.contextMenu.classList.remove('hidden');
  const margin = 10;
  const left = Math.min(event.clientX, window.innerWidth - elements.contextMenu.offsetWidth - margin);
  const top = Math.min(event.clientY, window.innerHeight - elements.contextMenu.offsetHeight - margin);
  elements.contextMenu.style.left = `${Math.max(margin, left)}px`;
  elements.contextMenu.style.top = `${Math.max(margin, top)}px`;
  requestAnimationFrame(() => elements.contextDelete.focus());
}
async function deleteContextTarget() {
  const target = contextTarget;
  closeContextMenu();
  if (!target || !roomId) return;
  try {
    const path = target.type === 'voice' ? `/api/voice/${encodeURIComponent(target.id)}` : `/api/tasks/${encodeURIComponent(target.id)}`;
    await api(path, { method: 'DELETE' });
    if (target.type === 'voice') { state.voiceNotes = (state.voiceNotes || []).filter((note) => note.id !== target.id); renderVoiceNotes(); }
    else { state.tasks = (state.tasks || []).filter((task) => task.id !== target.id); renderTasks(); }
  } catch (error) { showToast(error.message); }
}

function setAuthMode(mode) {
  authMode = mode;
  const register = mode === 'register';
  elements.loginTab.classList.toggle('is-active', !register); elements.registerTab.classList.toggle('is-active', register);
  elements.loginTab.setAttribute('aria-selected', String(!register)); elements.registerTab.setAttribute('aria-selected', String(register));
  elements.authSubmit.textContent = register ? '创建账号' : '登录'; elements.authPassword.autocomplete = register ? 'new-password' : 'current-password';
  elements.authStatus.textContent = '';
}

async function refreshAuth() {
  try {
    const response = await fetch('/api/auth/me', { cache: 'no-store' });
    if (!response.ok) return null;
    const result = await response.json(); currentUser = result.user; memberId = currentUser.id; elements.accountName.textContent = currentUser.username; elements.authGate.classList.add('hidden');
    return currentUser;
  } catch { return null; }
}

function showRoomGate(message) {
  elements.roomGateMessage.textContent = message; elements.roomGate.classList.remove('hidden');
}
function hideRoomGate() { elements.roomGate.classList.add('hidden'); }

async function ensureRoom() {
  const queryRoom = new URLSearchParams(location.search).get('room');
  try {
    const response = await fetch('/api/room', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(queryRoom ? { roomId: queryRoom } : {}) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) { showRoomGate(result.error || '暂时无法进入这个房间。'); return null; }
    roomId = result.roomId; memberId = result.memberId;
    if (!queryRoom) history.replaceState(null, '', `/?room=${encodeURIComponent(roomId)}`);
    document.body.dataset.cloudReady = 'true'; hideRoomGate(); return result;
  } catch { showRoomGate('网络连接暂时不可用，请稍后再试。'); return null; }
}

function apiUrl(path) { const url = new URL(path, location.origin); if (roomId) url.searchParams.set('room', roomId); return url; }
async function api(path, options = {}) {
  const response = await fetch(apiUrl(path), { cache: 'no-store', ...options });
  const type = response.headers.get('content-type') || ''; const body = type.includes('application/json') ? await response.json() : null;
  if (!response.ok) throw new Error(body?.error || '请求失败'); return body;
}

async function loadState() {
  try {
    state = await api('/api/state'); elements.contrastRange.value = state.contrast ?? 1; elements.brightnessRange.value = state.brightness ?? 0; updateToneLabels(); setBackground(currentBackground(), state.blurPx, state.contrast ?? 1, state.brightness ?? 0); elements.timezoneLabel.textContent = state.timeZone || '本地时间'; elements.inviteUrl.value = state.inviteUrl || ''; elements.roomMembers.textContent = `${(state.members || []).length} / 2`;
    renderTasks(); renderVoiceNotes(); render(); if (roomId) connectRealtime();
  } catch (error) { elements.targetSummary.textContent = '请确认后端服务正在运行'; console.error(error); }
}

function openSettings() {
  if (!state) return;
  elements.targetAt.value = toInputValue(state.targetAt); elements.blurRange.value = state.blurPx || 0; elements.blurOutput.textContent = `${state.blurPx || 0} px`; elements.contrastRange.value = state.contrast ?? 1; elements.brightnessRange.value = state.brightness ?? 0; updateToneLabels();
  selectedBackground = currentBackground(); selectedBackgroundFile = null; backgroundSelection = 'unchanged';
  elements.fileName.textContent = selectedBackground ? '已选择照片' : '默认背景'; elements.removeBackground.classList.toggle('hidden', !selectedBackground); elements.inviteUrl.value = state.inviteUrl || `${location.origin}/?room=${encodeURIComponent(roomId || '')}`; elements.roomMembers.textContent = `${(state.members || []).length} / 2`;
  elements.dialog.classList.remove('hidden'); elements.dialog.setAttribute('aria-hidden', 'false');
}
function closeSettings() { elements.dialog.classList.add('hidden'); elements.dialog.setAttribute('aria-hidden', 'true'); }

function handleBackgroundFile(file) {
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) return showToast('图片太大了，请选择 8 MB 以内的照片');
  selectedBackgroundFile = file; backgroundSelection = 'upload';
  const reader = new FileReader();
  reader.addEventListener('load', () => { selectedBackground = reader.result; elements.fileName.textContent = file.name; elements.removeBackground.classList.remove('hidden'); setBackground(selectedBackground, Number(elements.blurRange.value)); });
  reader.readAsDataURL(file);
}

async function saveSettings(event) {
  event.preventDefault(); elements.saveButton.disabled = true; elements.saveStatus.textContent = '正在保存…';
  try {
    const targetAt = new Date(elements.targetAt.value).toISOString();
    if (roomId) {
      if (backgroundSelection === 'upload' && selectedBackgroundFile) await api('/api/background', { method: 'PUT', headers: { 'Content-Type': selectedBackgroundFile.type }, body: selectedBackgroundFile });
      else if (backgroundSelection === 'remove') await api('/api/background', { method: 'DELETE' });
      state = await api('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetAt, blurPx: Number(elements.blurRange.value), contrast: Number(elements.contrastRange.value), brightness: Number(elements.brightnessRange.value) }) });
    } else {
      state = await api('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetAt, backgroundDataUrl: backgroundSelection === 'remove' ? null : selectedBackground, blurPx: Number(elements.blurRange.value), contrast: Number(elements.contrastRange.value), brightness: Number(elements.brightnessRange.value) }) });
    }
    setBackground(currentBackground(), state.blurPx, state.contrast ?? 1, state.brightness ?? 0); elements.timezoneLabel.textContent = state.timeZone || '本地时间'; closeSettings(); showToast('设置已保存'); render();
  } catch (error) { elements.saveStatus.textContent = error.message; } finally { elements.saveButton.disabled = false; }
}

function makeTaskElement(task, index) {
  const item = document.createElement('article'); item.className = 'task-capsule';
  item.addEventListener('contextmenu', (event) => openContextMenu(event, 'task', task.id));
  const checkbox = document.createElement('button'); checkbox.className = 'task-check'; checkbox.type = 'button'; checkbox.setAttribute('aria-label', task.completed ? '标记未完成' : '标记完成'); checkbox.setAttribute('aria-pressed', String(task.completed));
  checkbox.addEventListener('click', async () => { if (!roomId) return; try { await api(`/api/tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ completed: !task.completed }) }); } catch (error) { showToast(error.message); } });
  const text = document.createElement('span'); text.className = 'task-text'; text.textContent = task.text; if (task.completed) text.classList.add('is-completed');
  item.append(checkbox, text); return item;
}
function renderTasks() {
  const tasks = state?.tasks || []; const theirs = tasks.filter((task) => task.authorId !== memberId); const mine = tasks.filter((task) => task.authorId === memberId);
  elements.taskListTheirs.replaceChildren(...theirs.map(makeTaskElement)); elements.taskListMine.replaceChildren(...mine.map((task, index) => makeTaskElement(task, index)));
  const incomplete = tasks.filter((task) => !task.completed).length;
  elements.taskCount.textContent = incomplete ? String(incomplete) : '';
}

function makeVoiceElement(note) {
  const item = document.createElement('article'); item.className = `voice-capsule ${note.authorId === memberId ? 'is-mine' : 'is-theirs'}`; item.title = `${note.authorId === memberId ? '我' : '对方'} · ${formatShortTime(note.createdAt)}`;
  item.addEventListener('contextmenu', (event) => openContextMenu(event, 'voice', note.id));
  const play = document.createElement('button'); play.className = 'voice-play'; play.type = 'button'; play.textContent = '▶'; play.setAttribute('aria-label', '播放留言');
  const wave = document.createElement('span'); wave.className = 'voice-wave'; wave.setAttribute('aria-hidden', 'true');
  for (let index = 0; index < 17; index += 1) {
    const bar = document.createElement('i'); bar.className = 'voice-bar'; bar.style.setProperty('--bar-height', `${5 + ((index * 7) % 10)}px`); bar.style.setProperty('--bar-delay', `${(index % 6) * 55}ms`); bar.style.setProperty('--bar-speed', `${580 + (index % 4) * 90}ms`); wave.append(bar);
  }
  const time = document.createElement('time'); time.className = 'voice-time'; time.textContent = formatShortTime(note.createdAt);
  const audio = document.createElement('audio'); audio.preload = 'metadata'; audio.src = note.url;
  const reset = () => { item.classList.remove('is-playing'); play.textContent = '▶'; if (activeAudio === audio) { activeAudio = null; activeVoiceItem = null; activeVoicePlay = null; } };
  play.addEventListener('click', async () => {
    try {
      if (!audio.paused) { audio.pause(); audio.currentTime = 0; reset(); return; }
      if (activeAudio && activeAudio !== audio) { activeAudio.pause(); activeAudio.currentTime = 0; activeVoiceItem?.classList.remove('is-playing'); if (activeVoicePlay) activeVoicePlay.textContent = '▶'; }
      await audio.play(); activeAudio = audio; activeVoiceItem = item; activeVoicePlay = play; item.classList.add('is-playing'); play.textContent = 'Ⅱ';
    } catch { showToast('无法播放这条留言'); }
  });
  audio.addEventListener('ended', reset); audio.addEventListener('pause', () => { if (activeAudio === audio && audio.currentTime >= audio.duration) reset(); });
  item.append(play, wave, time, audio); return item;
}
function stopActiveVoice() { if (!activeAudio) return; activeAudio.pause(); activeAudio.currentTime = 0; activeVoiceItem?.classList.remove('is-playing'); if (activeVoicePlay) activeVoicePlay.textContent = '▶'; activeAudio = null; activeVoiceItem = null; activeVoicePlay = null; }
function renderVoiceNotes() { stopActiveVoice(); const notes = state?.voiceNotes || []; elements.voiceCapsules.replaceChildren(...notes.map(makeVoiceElement)); elements.voiceCount.textContent = notes.length ? String(notes.length) : ''; }

async function syncEphemeralState() {
  if (!roomId || !state) return;
  try {
    const latest = await api('/api/state');
    const tasksChanged = JSON.stringify(latest.tasks || []) !== JSON.stringify(state?.tasks || []);
    const voicesChanged = JSON.stringify(latest.voiceNotes || []) !== JSON.stringify(state?.voiceNotes || []);
    if (tasksChanged) { state.tasks = latest.tasks || []; renderTasks(); }
    if (voicesChanged) { state.voiceNotes = latest.voiceNotes || []; renderVoiceNotes(); }
  } catch {
    // Realtime remains the primary path; the periodic readback only heals stale tabs.
  }
}

function updateTaskFromEvent(task) { const item = state.tasks.find((candidate) => candidate.id === task.id); if (item) Object.assign(item, task); renderTasks(); }
function applyRealtimeEvent(event) {
  const payload = event.payload || {};
  if (event.type === 'pointer') window.setTimeout(() => water.addRipple(payload.x, payload.y, Number(payload.strength || 0.04) * 0.72), 110);
  else if (event.type === 'settings.updated') { state.targetAt = payload.targetAt; state.blurPx = payload.blurPx; state.contrast = payload.contrast ?? 1; state.brightness = payload.brightness ?? 0; elements.contrastRange.value = state.contrast; elements.brightnessRange.value = state.brightness; updateToneLabels(); setBackground(currentBackground(), state.blurPx, state.contrast, state.brightness); render(); }
  else if (event.type === 'background.updated') { state.backgroundUrl = payload.backgroundUrl; state.backgroundDataUrl = null; setBackground(currentBackground(), state.blurPx); }
  else if (event.type === 'task.created') { state.tasks = [payload, ...(state.tasks || []).filter((task) => task.id !== payload.id)]; renderTasks(); }
  else if (event.type === 'task.updated') updateTaskFromEvent(payload);
  else if (event.type === 'task.deleted') { state.tasks = state.tasks.filter((task) => task.id !== payload.id); renderTasks(); }
  else if (event.type === 'voice.created') { state.voiceNotes = [payload, ...(state.voiceNotes || []).filter((note) => note.id !== payload.id)]; renderVoiceNotes(); }
  else if (event.type === 'voice.deleted') { state.voiceNotes = (state.voiceNotes || []).filter((note) => note.id !== payload.id); renderVoiceNotes(); }
  else if (event.type === 'room.joined') { state.members = [...(state.members || []).filter((member) => member.id !== payload.userId), { id: payload.userId, username: payload.username, slot: payload.slot }].sort((a, b) => a.slot - b.slot); elements.roomMembers.textContent = `${state.members.length} / 2`; showToast(`${payload.username || '对方'} 已加入房间`); }
  else if (event.type === 'room.destroyed') { state = null; socket?.close(); socket = null; showRoomGate('房间已被退出的一方销毁，请创建一个新的房间。'); showToast('房间已销毁'); }
  else if (event.type === 'ephemeral.cleared') { state.tasks = []; state.voiceNotes = []; renderTasks(); renderVoiceNotes(); }
}

function connectRealtime() {
  if (!roomId || socket) return;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/ws?room=${encodeURIComponent(roomId)}`);
  socket.addEventListener('message', (message) => { try { applyRealtimeEvent(JSON.parse(message.data)); } catch { /* ignore malformed packets */ } });
  socket.addEventListener('close', () => { socket = null; window.setTimeout(connectRealtime, 1800); }); socket.addEventListener('error', () => socket?.close());
}
function sendPointer(x, y, strength) { if (!socket || socket.readyState !== WebSocket.OPEN) return; const now = performance.now(); if (now - lastPointerSentAt < 60) return; lastPointerSentAt = now; socket.send(JSON.stringify({ type: 'pointer', payload: { x, y, strength } })); }

async function startRecording() {
  if (!roomId) return showToast('部署到 Cloudflare 后可使用留言');
  if (recorder?.state === 'recording') return stopRecording();
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return showToast('当前浏览器不支持录音');
  elements.voiceRail.classList.add('is-hovered');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((type) => MediaRecorder.isTypeSupported(type)) || '';
    const activeRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined); const chunks = []; const session = { recorder: activeRecorder, startedAt: performance.now(), discarded: false }; recordingSession = session; recorder = activeRecorder; recorderStartedAt = session.startedAt;
    activeRecorder.addEventListener('dataavailable', (event) => { if (event.data.size) chunks.push(event.data); });
    activeRecorder.addEventListener('stop', async () => {
      const shouldUpload = !session.discarded;
      stream.getTracks().forEach((track) => track.stop());
      const blob = new Blob(chunks, { type: activeRecorder.mimeType || 'audio/webm' });
      if (recordingSession === session) recordingSession = null;
      if (recorder === activeRecorder) recorder = null;
      if (!shouldUpload) return;
      try { const note = await api('/api/voice', { method: 'POST', headers: { 'Content-Type': blob.type, 'X-Duration-Ms': String(Math.round(performance.now() - session.startedAt)) }, body: blob }); state.voiceNotes = [note, ...(state.voiceNotes || []).filter((existing) => existing.id !== note.id)]; renderVoiceNotes(); } catch (error) { showToast(error.message); }
    });
    activeRecorder.start(); elements.voiceRail.classList.add('is-recording'); elements.voiceRecordingCapsule.classList.remove('hidden'); elements.voiceOrb.setAttribute('aria-expanded', 'true');
    recorderTimer = window.setInterval(() => { elements.recordTime.textContent = `${Math.floor((performance.now() - recorderStartedAt) / 1000)}s`; }, 250);
    if (!elements.voiceRail.classList.contains('is-hovered')) cancelRecording();
  } catch (error) { elements.voiceRail.classList.remove('is-hovered'); showToast(error.name === 'NotAllowedError' ? '请允许浏览器使用麦克风' : '无法开始录音'); }
}
function resetRecordingUi() {
  clearInterval(recorderTimer); recorderTimer = null; elements.recordTime.textContent = '';
  elements.voiceRail.classList.remove('is-recording'); elements.voiceRecordingCapsule.classList.add('hidden'); elements.voiceOrb.setAttribute('aria-expanded', 'false');
}
function stopRecording() {
  if (recordingSession) recordingSession.discarded = false;
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  resetRecordingUi();
}
function cancelRecording() {
  if (recordingSession) recordingSession.discarded = true;
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  resetRecordingUi();
}
function openTaskComposer() {
  if (!roomId) return showToast('部署到 Cloudflare 后可使用清单');
  elements.taskRail.classList.add('is-hovered');
  elements.taskRail.classList.add('is-composer-active'); elements.taskComposer.classList.remove('hidden'); elements.taskOrb.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => elements.taskInput.focus());
}
function closeTaskComposer() {
  elements.taskRail.classList.remove('is-composer-active'); elements.taskComposer.classList.add('hidden'); elements.taskOrb.setAttribute('aria-expanded', 'false');
}
function cancelTaskComposer() { elements.taskInput.value = ''; closeTaskComposer(); }
function setRailHover(rail, hovered) {
  rail.classList.toggle('is-hovered', hovered);
  if (hovered) return;
  if (rail === elements.voiceRail && recorder?.state === 'recording') cancelRecording();
  if (rail === elements.taskRail && elements.taskRail.classList.contains('is-composer-active')) cancelTaskComposer();
}

async function bootApp() {
  const user = await refreshAuth();
  if (!user) {
    elements.authGate.classList.remove('hidden');
    if (new URLSearchParams(location.search).has('room')) elements.authIntro.textContent = '登录后即可加入对方发来的邀请房间。';
    return;
  }
  const room = await ensureRoom();
  if (!room) return;
  await loadState(); render();
}

async function submitAuth(event) {
  event.preventDefault(); elements.authSubmit.disabled = true; elements.authStatus.textContent = '正在处理…';
  try {
    const response = await fetch(`/api/auth/${authMode}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: elements.authUsername.value.trim(), password: elements.authPassword.value }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || '暂时无法完成操作。');
    elements.authPassword.value = ''; elements.authStatus.textContent = ''; await bootApp();
  } catch (error) { elements.authStatus.textContent = error.message; } finally { elements.authSubmit.disabled = false; }
}

async function destroyCurrentRoom() {
  if (!roomId || !window.confirm('退出后，这个房间和其中的任务、录音会立即销毁，另一方也会被通知。继续吗？')) return;
  elements.destroyRoom.disabled = true;
  try {
    await api('/api/room', { method: 'DELETE' }); socket?.close(); socket = null; roomId = null; state = null; history.replaceState(null, '', '/'); showRoomGate('房间已销毁，可以创建一个新的房间。'); closeSettings();
  } catch (error) { showToast(error.message); } finally { elements.destroyRoom.disabled = false; }
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' }); socket?.close(); socket = null; currentUser = null; memberId = null; location.href = '/';
}

elements.blurRange.addEventListener('input', () => { elements.blurOutput.textContent = `${elements.blurRange.value} px`; elements.background.style.setProperty('--background-blur', `${elements.blurRange.value}px`); water.setBlur(Number(elements.blurRange.value)); });
elements.contrastRange.addEventListener('input', () => { updateToneLabels(); water.setTone(Number(elements.contrastRange.value), Number(elements.brightnessRange.value)); });
elements.brightnessRange.addEventListener('input', () => { updateToneLabels(); water.setTone(Number(elements.contrastRange.value), Number(elements.brightnessRange.value)); });
elements.chooseBackground.addEventListener('click', () => { const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/jpeg,image/png,image/webp,image/gif'; input.addEventListener('change', () => handleBackgroundFile(input.files?.[0])); input.click(); });
elements.removeBackground.addEventListener('click', () => { selectedBackground = null; selectedBackgroundFile = null; backgroundSelection = 'remove'; elements.fileName.textContent = '默认背景'; elements.removeBackground.classList.add('hidden'); setBackground(null, Number(elements.blurRange.value)); });
elements.form.addEventListener('submit', saveSettings); $('#open-settings').addEventListener('click', openSettings); $('#close-settings').addEventListener('click', closeSettings);
elements.dialog.addEventListener('click', (event) => { if (event.target === elements.dialog) closeSettings(); }); elements.voiceOrb.addEventListener('click', startRecording); elements.taskOrb.addEventListener('click', openTaskComposer);
elements.cancelVoice.addEventListener('click', cancelRecording); elements.stopVoice.addEventListener('click', stopRecording); elements.cancelTask.addEventListener('click', cancelTaskComposer);
elements.loginTab.addEventListener('click', () => setAuthMode('login')); elements.registerTab.addEventListener('click', () => setAuthMode('register')); elements.authForm.addEventListener('submit', submitAuth);
elements.copyInvite.addEventListener('click', async () => { try { await navigator.clipboard.writeText(elements.inviteUrl.value); showToast('邀请链接已复制'); } catch { elements.inviteUrl.select(); showToast('请手动复制邀请链接'); } });
elements.destroyRoom.addEventListener('click', destroyCurrentRoom); elements.logoutButton.addEventListener('click', logout);
elements.createRoomButton.addEventListener('click', async () => { history.replaceState(null, '', '/'); const room = await ensureRoom(); if (room) await loadState(); });
elements.contextDelete.addEventListener('click', deleteContextTarget);
elements.taskComposer.addEventListener('submit', async (event) => { event.preventDefault(); const text = elements.taskInput.value.trim(); if (!text || !roomId) return; try { await api('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }); elements.taskInput.value = ''; closeTaskComposer(); } catch (error) { showToast(error.message); } });
elements.voiceRail.addEventListener('pointerleave', cancelRecording); elements.taskRail.addEventListener('pointerleave', cancelTaskComposer);
document.addEventListener('pointerdown', (event) => { if (!event.target.closest?.('#context-menu')) closeContextMenu(); });
document.addEventListener('keydown', (event) => { if (event.key !== 'Escape') return; if (!elements.dialog.classList.contains('hidden')) closeSettings(); else if (!elements.contextMenu.classList.contains('hidden')) closeContextMenu(); else if (elements.taskRail.classList.contains('is-composer-active')) cancelTaskComposer(); else if (recorder?.state === 'recording') cancelRecording(); });
window.addEventListener('pointermove', (event) => {
  const x = event.clientX / window.innerWidth; const y = event.clientY / window.innerHeight; const now = performance.now(); const distance = lastPointer ? Math.hypot(x - lastPointer.x, y - lastPointer.y) : 0;
  if (distance > 0.004) { const strength = Math.min(0.12, 0.025 + distance * 0.9); water.addRipple(x, y, strength); sendPointer(x, y, strength); }
  lastPointer = { x, y, now }; const rail = event.target?.closest?.('.edge-rail');
  setRailHover(elements.voiceRail, Boolean(rail === elements.voiceRail || event.clientX < 92));
  setRailHover(elements.taskRail, Boolean(rail === elements.taskRail || event.clientX > window.innerWidth - 92));
}, { passive: true });
window.addEventListener('pointerdown', (event) => water.addRipple(event.clientX / window.innerWidth, event.clientY / window.innerHeight, 0.12), { passive: true });

await initHtmlCanvasBridge(); await water.init();
await bootApp(); setInterval(render, 250); setInterval(syncEphemeralState, 30000);
