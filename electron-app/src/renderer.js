'use strict';

// ── Boot ──────────────────────────────────────────────────────────────────────
let cfg = null;

(async function boot() {
  cfg = await window.electronAPI.getConfig();

  if (cfg.serverUrl && cfg.employeeId) {
    showPortalMode();
  } else {
    showSetupMode();
  }

  // Listen for status updates forwarded from the share window via main process
  window.electronAPI.onSharingStatus(({ state, text }) => {
    updateToolbar(state, text);
  });
})();

// ── Mode switching ────────────────────────────────────────────────────────────
function showSetupMode() {
  document.getElementById('setup-screen').style.display   = 'flex';
  document.getElementById('portal-toolbar').style.display = 'none';

  // Pre-fill any saved values
  setVal('inp-server', cfg?.serverUrl    || '');
  setVal('inp-empid',  cfg?.employeeId   || '');
  setVal('inp-name',   cfg?.employeeName || '');
}

function showPortalMode() {
  document.getElementById('setup-screen').style.display   = 'none';
  document.getElementById('portal-toolbar').style.display = 'flex';

  const nameEl = document.getElementById('tb-emp-name');
  if (nameEl) nameEl.textContent = cfg?.employeeName || cfg?.employeeId || '';

  updateToolbar('offline', '');
}

// ── Setup form ────────────────────────────────────────────────────────────────
async function setupSave() {
  const serverUrl    = getVal('inp-server').replace(/\/$/, '');
  const employeeId   = getVal('inp-empid').trim();
  const employeeName = getVal('inp-name').trim();
  const errEl        = document.getElementById('setup-err');

  errEl.textContent = '';

  if (!serverUrl || !employeeId) {
    errEl.textContent = 'Server URL and Employee ID are required.';
    return;
  }

  setBtnLoading('btn-setup-save', true, 'Connecting…');

  // Verify server is reachable
  try {
    const r = await fetch(`${serverUrl}/api/screenshare/config`, {
      method:      'GET',
      credentials: 'omit',
      headers:     { 'Accept': 'application/json' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    errEl.textContent = `Cannot reach server: ${e.message}`;
    setBtnLoading('btn-setup-save', false, 'Connect');
    return;
  }

  cfg = { serverUrl, employeeId, employeeName };
  await window.electronAPI.setConfig(cfg);

  // Tell main process to resize window and create the portal BrowserView
  await window.electronAPI.setupComplete({ serverUrl });

  setBtnLoading('btn-setup-save', false, 'Connect');
  showPortalMode();
}

// ── Toolbar actions ───────────────────────────────────────────────────────────
async function startWorking() {
  const btnStart = document.getElementById('btn-start-working');
  const errEl    = document.getElementById('tb-err');

  if (btnStart) { btnStart.disabled = true; btnStart.textContent = 'Starting…'; }
  if (errEl)    errEl.textContent = '';

  const result = await window.electronAPI.startSharing();

  if (result && result.error) {
    if (errEl)    errEl.textContent = result.error;
    if (btnStart) { btnStart.disabled = false; btnStart.textContent = '▶ Start Working'; }
  }
  // On success the share window reports status via onSharingStatus -> updateToolbar
}

async function endWorking() {
  await window.electronAPI.stopSharing();
}

function openSettings() {
  showSetupMode();
}

// ── Toolbar state ─────────────────────────────────────────────────────────────
function updateToolbar(state, text) {
  const dot       = document.getElementById('tb-status-dot');
  const label     = document.getElementById('tb-status-text');
  const statusRow = document.getElementById('tb-status-row');
  const btnStart  = document.getElementById('btn-start-working');
  const btnEnd    = document.getElementById('btn-end-working');
  const errEl     = document.getElementById('tb-err');

  const isWorking = state === 'live' || state === 'connecting';

  if (dot)   dot.className = 'tb-dot ' + state;
  if (label) label.textContent =
    state === 'live'       ? '● Working' :
    state === 'connecting' ? '◌ Connecting…' : '';

  if (statusRow) statusRow.style.display = isWorking ? 'flex' : 'none';

  if (btnStart) {
    btnStart.style.display = isWorking ? 'none' : 'flex';
    btnStart.disabled      = false;
    btnStart.textContent   = '▶ Start Working';
  }
  if (btnEnd)  btnEnd.style.display = isWorking ? 'flex' : 'none';
  if (errEl && state !== 'error') errEl.textContent = '';
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getVal(id)      { return document.getElementById(id)?.value || ''; }
function setVal(id, val) { const el = document.getElementById(id); if (el) el.value = val; }
function setBtnLoading(id, loading, label) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.disabled    = loading;
  btn.textContent = label;
}
