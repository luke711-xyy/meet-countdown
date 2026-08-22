import { WaterBackground } from './water-background.js';
import { initHtmlCanvasBridge } from './html-canvas-bridge.js';

const $ = (selector) => document.querySelector(selector);
const elements = {
  background: $('.background-layer'), waterCanvas: $('#water-canvas'), targetSummary: $('#target-summary'),
  days: $('#days'), hours: $('#hours'), minutes: $('#minutes'), seconds: $('#seconds'), currentTime: $('#current-time'),
  timezoneLabel: $('#timezone-label'), dialog: $('#settings-dialog'), form: $('#settings-form'), targetAt: $('#target-at'),
  chooseBackground: $('#choose-background'), fileName: $('#file-name'), removeBackground: $('#remove-background'),
  blurRange: $('#blur-range'), blurOutput: $('#blur-output'), saveButton: $('#save-settings'), saveStatus: $('#save-status'),
  toast: $('#toast'), voiceRail: $('#voice-rail'), voiceOrb: $('#voice-orb'), voiceCount: $('#voice-count'),
  voiceList: $('#voice-list'), recordVoice: $('#record-voice'), stopVoice: $('#stop-voice'), recordTime: $('#record-time'),
  taskRail: $('#task-rail'), taskOrb: $('#task-orb'), taskCount: $('#task-count'), taskProgress: $('#task-progress'),
  taskForm: $('#task-form'), taskInput: $('#task-input'), taskList: $('#task-list'),
};

let state = null;
let roomId = null;
let memberId = null;
let selectedBackground = null;
let selectedBackgroundFile = null;
let backgroundSelection = 'unchanged';
let toastTimer = null;
let socket = null;
let recorder = null;
let recorderChunks = [];
let recorderStartedAt = 0;
let recorderTimer = null;
let lastPointerSentAt = 0;
let lastPointer = null;
const water = new WaterBackground(elements.waterCanvas);

function pad(value) { return String(value).padStart(2, '0'); }
function formatDate(date) { return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(date); }
function formatCurrentTime(date) { return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date); }
function formatShortTime(iso) { return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)); }
function toInputValue(iso) { const date = new Date(iso); const offset = date.getTimezoneOffset() * 60000; return new Date(date.getTime() - offset).toISOString().slice(0, 16); }
function currentBackground() { return state?.backgroundDataUrl || state?.backgroundUrl || null; }

function setBackground(source, blurPx) {
  elements.background.style.backgroundImage = source ? `url("${source}")` : '';
  elements.background.style.setProperty('--background-blur', `${blurPx || 0}px`);
  water.setBlur(blurPx || 0);
  void water.setImage(source);
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

async function ensureRoom() {
  const queryRoom = new URLSearchParams(location.search).get('room');
  try {
    const response = await fetch('/api/room', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(queryRoom ? { roomId: queryRoom } : {}) });
    if (!response.ok) return null;
    const result = await response.json(); roomId = result.roomId; memberId = result.memberId;
    if (!queryRoom) history.replaceState(null, '', `/?room=${encodeURIComponent(roomId)}`);
    document.body.dataset.cloudReady = 'true'; return result;
  } catch { return null; }
}

function apiUrl(path) { const url = new URL(path, location.origin); if (roomId) url.searchParams.set('room', roomId); return url; }
async function api(path, options = {}) {
  const response = await fetch(apiUrl(path), { cache: 'no-store', ...options });
  const type = response.headers.get('content-type') || ''; const body = type.includes('application/json') ? await response.json() : null;
  if (!response.ok) throw new Error(body?.error || '请求失败'); return body;
}

async function loadState() {
  try {
    state = await api('/api/state'); setBackground(currentBackground(), state.blurPx); elements.timezoneLabel.textContent = state.timeZone || '本地时间';
    renderTasks(); renderVoiceNotes(); render(); if (roomId) connectRealtime();
  } catch (error) { elements.targetSummary.textContent = '请确认后端服务正在运行'; console.error(error); }
}

function openSettings() {
  if (!state) return;
  elements.targetAt.value = toInputValue(state.targetAt); elements.blurRange.value = state.blurPx || 0; elements.blurOutput.textContent = `${state.blurPx || 0} px`;
  selectedBackground = currentBackground(); selectedBackgroundFile = null; backgroundSelection = 'unchanged';
  elements.fileName.textContent = selectedBackground ? '已选择照片' : '默认背景'; elements.removeBackground.classList.toggle('hidden', !selectedBackground);
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
      state = await api('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetAt, blurPx: Number(elements.blurRange.value) }) });
    } else {
      state = await api('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetAt, backgroundDataUrl: backgroundSelection === 'remove' ? null : selectedBackground, blurPx: Number(elements.blurRange.value) }) });
    }
    setBackground(currentBackground(), state.blurPx); elements.timezoneLabel.textContent = state.timeZone || '本地时间'; closeSettings(); showToast('设置已保存'); render();
  } catch (error) { elements.saveStatus.textContent = error.message; } finally { elements.saveButton.disabled = false; }
}

function makeTaskElement(task, index) {
  const item = document.createElement('article'); item.className = 'task-card'; item.style.setProperty('--card-offset', `${(index % 3) * 6 - 6}px`);
  const checkbox = document.createElement('button'); checkbox.className = 'task-check'; checkbox.type = 'button'; checkbox.setAttribute('aria-label', task.completed ? '标记未完成' : '标记完成'); checkbox.setAttribute('aria-pressed', String(task.completed));
  checkbox.addEventListener('click', async () => { if (!roomId) return; try { await api(`/api/tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ completed: !task.completed }) }); } catch (error) { showToast(error.message); } });
  const text = document.createElement('span'); text.className = 'task-text'; text.textContent = task.text; if (task.completed) text.classList.add('is-completed');
  const meta = document.createElement('small'); meta.textContent = task.authorId === memberId ? '我' : '对方'; item.append(checkbox, text, meta); return item;
}
function renderTasks() {
  const tasks = state?.tasks || []; elements.taskList.replaceChildren(...tasks.map(makeTaskElement)); const incomplete = tasks.filter((task) => !task.completed).length;
  elements.taskCount.textContent = incomplete ? String(incomplete) : ''; elements.taskProgress.textContent = tasks.length ? `${tasks.length - incomplete}/${tasks.length}` : '';
}

function makeVoiceElement(note) {
  const item = document.createElement('article'); item.className = 'voice-card'; const meta = document.createElement('div'); meta.className = 'voice-meta';
  const author = document.createElement('span'); author.textContent = note.authorId === memberId ? '我' : '对方'; const created = document.createElement('time'); created.textContent = formatShortTime(note.createdAt); meta.append(author, created);
  const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'metadata'; audio.src = note.url; item.append(meta, audio); return item;
}
function renderVoiceNotes() { const notes = state?.voiceNotes || []; elements.voiceList.replaceChildren(...notes.map(makeVoiceElement)); elements.voiceCount.textContent = notes.length ? String(notes.length) : ''; }

function updateTaskFromEvent(task) { const item = state.tasks.find((candidate) => candidate.id === task.id); if (item) Object.assign(item, task); renderTasks(); }
function applyRealtimeEvent(event) {
  const payload = event.payload || {};
  if (event.type === 'pointer') window.setTimeout(() => water.addRipple(payload.x, payload.y, Number(payload.strength || 0.04) * 0.72), 110);
  else if (event.type === 'settings.updated') { state.targetAt = payload.targetAt; state.blurPx = payload.blurPx; setBackground(currentBackground(), state.blurPx); render(); }
  else if (event.type === 'background.updated') { state.backgroundUrl = payload.backgroundUrl; state.backgroundDataUrl = null; setBackground(currentBackground(), state.blurPx); }
  else if (event.type === 'task.created') { state.tasks = [payload, ...(state.tasks || []).filter((task) => task.id !== payload.id)]; renderTasks(); }
  else if (event.type === 'task.updated') updateTaskFromEvent(payload);
  else if (event.type === 'task.deleted') { state.tasks = state.tasks.filter((task) => task.id !== payload.id); renderTasks(); }
  else if (event.type === 'voice.created') { state.voiceNotes = [payload, ...(state.voiceNotes || []).filter((note) => note.id !== payload.id)]; renderVoiceNotes(); }
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
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return showToast('当前浏览器不支持录音');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((type) => MediaRecorder.isTypeSupported(type)) || '';
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined); recorderChunks = []; recorderStartedAt = performance.now();
    recorder.addEventListener('dataavailable', (event) => { if (event.data.size) recorderChunks.push(event.data); });
    recorder.addEventListener('stop', async () => {
      stream.getTracks().forEach((track) => track.stop()); const blob = new Blob(recorderChunks, { type: recorder.mimeType || 'audio/webm' });
      try { const note = await api('/api/voice', { method: 'POST', headers: { 'Content-Type': blob.type, 'X-Duration-Ms': String(Math.round(performance.now() - recorderStartedAt)) }, body: blob }); state.voiceNotes = [note, ...(state.voiceNotes || [])]; renderVoiceNotes(); } catch (error) { showToast(error.message); }
    });
    recorder.start(); elements.recordVoice.classList.add('hidden'); elements.stopVoice.classList.remove('hidden');
    recorderTimer = window.setInterval(() => { elements.recordTime.textContent = `${Math.floor((performance.now() - recorderStartedAt) / 1000)}s`; }, 250);
  } catch (error) { showToast(error.name === 'NotAllowedError' ? '请允许浏览器使用麦克风' : '无法开始录音'); }
}
function stopRecording() { if (recorder && recorder.state !== 'inactive') recorder.stop(); clearInterval(recorderTimer); recorderTimer = null; elements.recordTime.textContent = ''; elements.recordVoice.classList.remove('hidden'); elements.stopVoice.classList.add('hidden'); }
function toggleRail(rail, open) { rail.classList.toggle('is-open', open ?? !rail.classList.contains('is-open')); rail.querySelector('.edge-orb')?.setAttribute('aria-expanded', String(rail.classList.contains('is-open'))); }

elements.blurRange.addEventListener('input', () => { elements.blurOutput.textContent = `${elements.blurRange.value} px`; elements.background.style.setProperty('--background-blur', `${elements.blurRange.value}px`); water.setBlur(Number(elements.blurRange.value)); });
elements.chooseBackground.addEventListener('click', () => { const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/jpeg,image/png,image/webp,image/gif'; input.addEventListener('change', () => handleBackgroundFile(input.files?.[0])); input.click(); });
elements.removeBackground.addEventListener('click', () => { selectedBackground = null; selectedBackgroundFile = null; backgroundSelection = 'remove'; elements.fileName.textContent = '默认背景'; elements.removeBackground.classList.add('hidden'); setBackground(null, Number(elements.blurRange.value)); });
elements.form.addEventListener('submit', saveSettings); $('#open-settings').addEventListener('click', openSettings); $('#close-settings').addEventListener('click', closeSettings);
elements.dialog.addEventListener('click', (event) => { if (event.target === elements.dialog) closeSettings(); }); elements.voiceOrb.addEventListener('click', () => toggleRail(elements.voiceRail)); elements.taskOrb.addEventListener('click', () => toggleRail(elements.taskRail));
elements.recordVoice.addEventListener('click', startRecording); elements.stopVoice.addEventListener('click', stopRecording);
elements.taskForm.addEventListener('submit', async (event) => { event.preventDefault(); const text = elements.taskInput.value.trim(); if (!text || !roomId) return; try { await api('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }); elements.taskInput.value = ''; } catch (error) { showToast(error.message); } });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !elements.dialog.classList.contains('hidden')) closeSettings(); });
window.addEventListener('pointermove', (event) => {
  const x = event.clientX / window.innerWidth; const y = event.clientY / window.innerHeight; const now = performance.now(); const distance = lastPointer ? Math.hypot(x - lastPointer.x, y - lastPointer.y) : 0;
  if (distance > 0.004) { const strength = Math.min(0.12, 0.025 + distance * 0.9); water.addRipple(x, y, strength); sendPointer(x, y, strength); }
  lastPointer = { x, y, now }; if (event.clientX < 92) toggleRail(elements.voiceRail, true); else if (event.clientX > window.innerWidth - 92) toggleRail(elements.taskRail, true); else if (event.clientX > 130) toggleRail(elements.voiceRail, false); else if (event.clientX < window.innerWidth - 130) toggleRail(elements.taskRail, false);
}, { passive: true });
window.addEventListener('pointerdown', (event) => water.addRipple(event.clientX / window.innerWidth, event.clientY / window.innerHeight, 0.12), { passive: true });

await initHtmlCanvasBridge(); await water.init();
const room = await ensureRoom(); if (!room) document.body.dataset.cloudReady = 'false'; await loadState(); render(); setInterval(render, 250);
