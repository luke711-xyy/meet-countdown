const $ = (selector) => document.querySelector(selector);

const elements = {
  background: $('.background-layer'),
  targetSummary: $('#target-summary'),
  days: $('#days'),
  hours: $('#hours'),
  minutes: $('#minutes'),
  seconds: $('#seconds'),
  currentTime: $('#current-time'),
  timezoneLabel: $('#timezone-label'),
  dialog: $('#settings-dialog'),
  form: $('#settings-form'),
  targetAt: $('#target-at'),
  chooseBackground: $('#choose-background'),
  fileName: $('#file-name'),
  removeBackground: $('#remove-background'),
  blurRange: $('#blur-range'),
  blurOutput: $('#blur-output'),
  saveButton: $('#save-settings'),
  saveStatus: $('#save-status'),
  toast: $('#toast'),
};

let state = null;
let selectedBackground = null;
let toastTimer = null;

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatDate(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function formatCurrentTime(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date);
}

function toInputValue(iso) {
  const date = new Date(iso);
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function setBackground(dataUrl, blurPx) {
  if (dataUrl) {
    elements.background.style.backgroundImage = `url("${dataUrl}")`;
  } else {
    elements.background.style.backgroundImage = '';
  }
  elements.background.style.setProperty('--background-blur', `${blurPx}px`);
}

function render() {
  if (!state) return;
  const target = new Date(state.targetAt);
  const now = new Date();
  const remainingMs = target.getTime() - now.getTime();
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  elements.days.textContent = String(days).padStart(2, '0');
  elements.hours.textContent = pad(hours);
  elements.minutes.textContent = pad(minutes);
  elements.seconds.textContent = pad(seconds);
  elements.targetSummary.textContent = remainingMs > 0 ? `${formatDate(target)} · ${state.timeZone}` : '现在就去见面吧';
  elements.currentTime.textContent = `现在是 ${formatCurrentTime(now)}`;
}

function openSettings() {
  if (!state) return;
  elements.targetAt.value = toInputValue(state.targetAt);
  elements.blurRange.value = state.blurPx;
  elements.blurOutput.textContent = `${state.blurPx} px`;
  selectedBackground = state.backgroundDataUrl;
  elements.fileName.textContent = selectedBackground ? '已选择照片' : '默认背景';
  elements.removeBackground.classList.toggle('hidden', !selectedBackground);
  elements.dialog.classList.remove('hidden');
  elements.dialog.setAttribute('aria-hidden', 'false');
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove('is-visible'), 2600);
}

async function loadState() {
  try {
    const response = await fetch('/api/state', { cache: 'no-store' });
    if (!response.ok) throw new Error('读取失败');
    state = await response.json();
    setBackground(state.backgroundDataUrl, state.blurPx);
    elements.timezoneLabel.textContent = state.timeZone || '本地时间';
    render();
  } catch (error) {
    elements.targetSummary.textContent = '请确认后端服务正在运行';
    console.error(error);
  }
}

elements.blurRange.addEventListener('input', () => {
  elements.blurOutput.textContent = `${elements.blurRange.value} px`;
  elements.background.style.setProperty('--background-blur', `${elements.blurRange.value}px`);
});

function handleBackgroundFile(file) {
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) {
    showToast('图片太大了，请选择 8 MB 以内的照片');
    return;
  }
  const reader = new FileReader();
  reader.addEventListener('load', () => {
    selectedBackground = reader.result;
    elements.fileName.textContent = file.name;
    elements.removeBackground.classList.remove('hidden');
    setBackground(selectedBackground, Number(elements.blurRange.value));
  });
  reader.readAsDataURL(file);
}

elements.chooseBackground.addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/jpeg,image/png,image/webp,image/gif';
  input.addEventListener('change', () => handleBackgroundFile(input.files?.[0]));
  input.click();
});

elements.removeBackground.addEventListener('click', () => {
  selectedBackground = null;
  elements.fileName.textContent = '默认背景';
  elements.removeBackground.classList.add('hidden');
  setBackground(null, Number(elements.blurRange.value));
});

elements.form.addEventListener('submit', async (event) => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  elements.saveButton.disabled = true;
  elements.saveStatus.textContent = '正在保存…';
  try {
    const response = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetAt: new Date(elements.targetAt.value).toISOString(),
        backgroundDataUrl: selectedBackground,
        blurPx: Number(elements.blurRange.value),
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '保存失败');
    state = result;
    setBackground(state.backgroundDataUrl, state.blurPx);
    elements.timezoneLabel.textContent = state.timeZone || '本地时间';
    closeSettings();
    showToast('设置已保存');
    render();
  } catch (error) {
    elements.saveStatus.textContent = error.message;
  } finally {
    elements.saveButton.disabled = false;
  }
});

$('#open-settings').addEventListener('click', openSettings);
function closeSettings() {
  elements.dialog.classList.add('hidden');
  elements.dialog.setAttribute('aria-hidden', 'true');
}

$('#close-settings').addEventListener('click', closeSettings);
elements.dialog.addEventListener('click', (event) => {
  if (event.target === elements.dialog) closeSettings();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !elements.dialog.classList.contains('hidden')) closeSettings();
});

loadState();
render();
setInterval(render, 250);
