const root = document.documentElement;
const mainScreen = document.querySelector('#mainScreen');
const settingsScreen = document.querySelector('#settingsScreen');
const settingsButton = document.querySelector('#settingsButton');
const backButton = document.querySelector('#backButton');
const documentUrl = document.querySelector('#documentUrl');
const commandRow = document.querySelector('#commandRow');
const primaryButton = document.querySelector('#primaryButton');
const statusRow = document.querySelector('#statusRow');
const statusText = document.querySelector('#statusText');
const exportProgress = document.querySelector('#exportProgress');
const exportProgressFill = exportProgress.querySelector('span');
const logToggle = document.querySelector('#logToggle');
const closeLogButton = document.querySelector('#closeLogButton');
const logDrawer = document.querySelector('#logDrawer');
const logContent = document.querySelector('#logContent');
const changePathButton = document.querySelector('#changePathButton');
const outputPath = document.querySelector('#outputPath');
const toast = document.querySelector('#toast');

let exportState = 'idle';
let toastTimer;

function setScreen(screen) {
  const showSettings = screen === 'settings';
  mainScreen.classList.toggle('is-active', !showSettings);
  settingsScreen.classList.toggle('is-active', showSettings);
  settingsButton.hidden = showSettings;
  closeLog();
}

function setStatus(kind, text) {
  statusRow.className = `status-row${kind ? ` is-${kind}` : ''}`;
  statusText.textContent = text;
}

function appendLog(line) {
  if (logContent.textContent === 'Waiting for an export…') logContent.textContent = '';
  logContent.textContent += `${line}\n`;
  logContent.scrollTop = logContent.scrollHeight;
}

function setProgress(value, visible = true) {
  exportProgress.classList.toggle('is-visible', visible);
  exportProgressFill.style.transform = `scaleX(${Math.max(0, Math.min(1, value))})`;
}

function openLog() {
  logDrawer.classList.add('is-open');
  logDrawer.setAttribute('aria-hidden', 'false');
  logToggle.setAttribute('aria-expanded', 'true');
}

function closeLog() {
  logDrawer.classList.remove('is-open');
  logDrawer.setAttribute('aria-hidden', 'true');
  logToggle.setAttribute('aria-expanded', 'false');
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('is-visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 1800);
}

function looksLikeDocumentUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com)$/.test(url.hostname);
  } catch {
    return false;
  }
}

function startMockExport() {
  const value = documentUrl.value.trim();
  if (!looksLikeDocumentUrl(value)) {
    commandRow.classList.remove('is-invalid');
    void commandRow.offsetWidth;
    commandRow.classList.add('is-invalid');
    setStatus('error', 'Enter a valid document link');
    documentUrl.focus();
    return;
  }

  exportState = 'working';
  primaryButton.classList.add('is-busy');
  primaryButton.textContent = 'Exporting';
  documentUrl.disabled = true;
  setStatus('working', 'Reading document');
  setProgress(0.14);
  logContent.textContent = '';
  appendLog('Connecting to Feishu…');

  window.setTimeout(() => {
    setStatus('working', 'Generating file');
    setProgress(0.68);
    appendLog('Document body loaded');
    appendLog('Generating Markdown…');
  }, 650);

  window.setTimeout(() => {
    exportState = 'complete';
    primaryButton.classList.remove('is-busy');
    primaryButton.textContent = 'Open Folder';
    documentUrl.disabled = false;
    setStatus('complete', 'Exported');
    setProgress(1);
    appendLog(`Saved to ${outputPath.textContent}`);
    window.setTimeout(() => setProgress(0, false), 420);
  }, 1650);
}

function handlePrimaryAction() {
  if (exportState === 'complete') {
    showToast('Web prototype: the native app will open Finder');
    return;
  }
  if (exportState !== 'working') startMockExport();
}

settingsButton.addEventListener('click', () => setScreen('settings'));
backButton.addEventListener('click', () => setScreen('main'));
primaryButton.addEventListener('click', handlePrimaryAction);
documentUrl.addEventListener('input', () => {
  commandRow.classList.remove('is-invalid');
  if (exportState === 'complete') {
    exportState = 'idle';
    primaryButton.textContent = 'Export';
    setStatus('idle', '');
    setProgress(0, false);
  }
});
documentUrl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') handlePrimaryAction();
});

logToggle.addEventListener('click', () => {
  if (logDrawer.classList.contains('is-open')) closeLog();
  else openLog();
});
closeLogButton.addEventListener('click', closeLog);

document.querySelectorAll('[data-theme-choice]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-theme-choice]').forEach((item) => item.classList.remove('is-selected'));
    button.classList.add('is-selected');
    const choice = button.dataset.themeChoice;
    if (choice === 'system') root.removeAttribute('data-theme');
    else root.dataset.theme = choice;
  });
});

changePathButton.addEventListener('click', () => {
  outputPath.textContent = outputPath.textContent.startsWith('~/Downloads')
    ? '~/Documents/Feishu Exports'
    : '~/Downloads/Feishu Exports';
  showToast('Web prototype: folder selection simulated');
});
