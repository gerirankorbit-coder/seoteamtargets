'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let cfg          = null;   // { serverUrl, employeeId, employeeName }
let serverCfg    = null;   // { pusherKey, pusherCluster, iceServers }
let pusherClient = null;
let channel      = null;
let pc           = null;   // RTCPeerConnection
let stream       = null;   // captured screen MediaStream
let selectedSource = null; // { id, name }

// Reconnect backoff
let backoffMs         = 1000;
const MAX_BACKOFF     = 30000;
let reconnectTimer    = null;
let iceRestartTimer   = null;
let iceRestartTried   = false;
let sharing           = false;   // true while actively sharing

// ── Boot ──────────────────────────────────────────────────────────────────────
(async function boot() {
  cfg = await window.electronAPI.getConfig();

  if (cfg.serverUrl && cfg.employeeId) {
    await initPusher();
    showSources();
  } else {
    showSetup();
  }
})();

// ── Setup screen ──────────────────────────────────────────────────────────────
function showSetup() {
  show('screen-setup');
  if (cfg) {
    setVal('inp-server', cfg.serverUrl  || '');
    setVal('inp-empid',  cfg.employeeId || '');
    setVal('inp-name',   cfg.employeeName || '');
  }
}

async function setupSave() {
  const serverUrl    = getVal('inp-server').replace(/\/$/, '');
  const employeeId   = getVal('inp-empid').trim();
  const employeeName = getVal('inp-name').trim();
  const errEl = document.getElementById('setup-err');

  if (!serverUrl || !employeeId) {
    errEl.textContent = 'Server URL and Employee ID are required.';
    return;
  }

  setBtnLoading('btn-setup-save', true, 'Connecting…');
  errEl.textContent = '';

  // Verify we can reach the server
  try {
    const r = await fetch(`${serverUrl}/api/screenshare/config`, {
      method:      'GET',
      credentials: 'omit',
      headers:     { 'Accept': 'application/json' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    serverCfg = await r.json();
  } catch (e) {
    errEl.textContent = `Cannot reach server: ${e.message}`;
    setBtnLoading('btn-setup-save', false, 'Connect');
    return;
  }

  cfg = { serverUrl, employeeId, employeeName };
  await window.electronAPI.setConfig(cfg);
  setBtnLoading('btn-setup-save', false, 'Connect');

  await initPusher();
  showSources();
}

// ── Source picker ─────────────────────────────────────────────────────────────
async function showSources() {
  show('screen-sources');
  await checkPermission();
  await loadSources();
}

async function checkPermission() {
  const status = await window.electronAPI.checkScreenPermission();
  const banner = document.getElementById('perm-warning');
  if (status !== 'granted') {
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}

async function openPerms() {
  await window.electronAPI.openPermissions();
  setTimeout(checkPermission, 2000);
}

async function loadSources() {
  const grid    = document.getElementById('sources-grid');
  const spinner = document.getElementById('sources-loading');
  grid.innerHTML = '';
  if (spinner) grid.appendChild(spinner);
  spinner.style.display = 'block';

  const sources = await window.electronAPI.getSources();
  spinner.style.display = 'none';

  if (!sources.length) {
    grid.innerHTML = '<div class="sources-empty">No screens found. Check permissions.</div>';
    return;
  }

  sources.forEach(src => {
    const el = document.createElement('div');
    el.className = 'source-thumb';
    el.dataset.id   = src.id;
    el.dataset.name = src.name;
    el.innerHTML = `
      <img src="${src.thumbnail}" alt="${esc(src.name)}" />
      <div class="source-name">${esc(src.name)}</div>`;
    el.onclick = () => selectSource(src, el);
    grid.appendChild(el);
  });

  // Re-select previously selected source if still present
  if (selectedSource) {
    const el = grid.querySelector(`[data-id="${selectedSource.id}"]`);
    if (el) el.classList.add('selected');
  }
  updateStartBtn();
}

function selectSource(src, el) {
  document.querySelectorAll('.source-thumb').forEach(t => t.classList.remove('selected'));
  el.classList.add('selected');
  selectedSource = src;
  updateStartBtn();
}

function updateStartBtn() {
  document.getElementById('btn-start-share').disabled = !selectedSource;
}

// ── Pusher init ───────────────────────────────────────────────────────────────
async function initPusher() {
  if (!serverCfg) {
    try {
      const r = await fetch(`${cfg.serverUrl}/api/screenshare/config`, {
        method:      'GET',
        credentials: 'omit',
        headers:     { 'Accept': 'application/json' },
      });
      serverCfg = await r.json();
    } catch (e) {
      console.error('[renderer] Could not fetch server config:', e);
      return;
    }
  }

  // Teardown old client if reconfiguring
  if (pusherClient) {
    try { pusherClient.disconnect(); } catch {}
    pusherClient = null; channel = null;
  }

  pusherClient = new Pusher(serverCfg.pusherKey, {
    cluster:         serverCfg.pusherCluster,
    activityTimeout: 20000,
    pongTimeout:     10000,
    channelAuthorization: {
      endpoint:  `${cfg.serverUrl}/api/screenshare/pusher-auth`,
      transport: 'ajax',
      params:    { employeeId: cfg.employeeId },
    },
  });

  pusherClient.connection.bind('error', (err) => {
    console.warn('[pusher] connection error:', err);
  });

  pusherClient.connection.bind('disconnected', () => {
    if (sharing) setStatus('connecting', 'Pusher disconnected — reconnecting…');
  });

  const channelName = `private-screenshare-${cfg.employeeId}`;
  channel = pusherClient.subscribe(channelName);

  channel.bind('pusher:subscription_error', (err) => {
    console.error('[pusher] auth error:', err);
    setStatus('error', `Auth failed (${err?.status || err}). Check Employee ID.`);
  });

  channel.bind('pusher:subscription_succeeded', () => {
    console.log('[pusher] subscribed to', channelName);
    // If already sharing (e.g. Pusher reconnected), resend offer
    if (sharing && stream) sendOffer();
  });

  // Manager requests we reconnect / re-send offer
  channel.bind('client-reconnect-request', () => {
    console.log('[pusher] reconnect-request received');
    if (sharing && stream && stream.getVideoTracks()[0]?.readyState === 'live') {
      sendOffer();
    } else if (sharing) {
      // Stream dead — do full reconnect
      scheduleFullReconnect(0);
    }
  });

  // Manager sent answer
  channel.bind('client-answer', async ({ sdp }) => {
    if (!pc) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      console.log('[webrtc] remote description set — handshake complete');
    } catch (e) {
      console.error('[webrtc] setRemoteDescription error:', e);
      scheduleFullReconnect();
    }
  });
}

// ── Start sharing ─────────────────────────────────────────────────────────────
async function startSharing() {
  if (!selectedSource) return;
  if (!pusherClient || !channel) {
    await initPusher();
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource:   'desktop',
          chromeMediaSourceId: selectedSource.id,
          maxWidth:  1920,
          maxHeight: 1080,
          maxFrameRate: 15,
        }
      }
    });
  } catch (e) {
    setError(`Could not capture screen: ${e.message}`);
    return;
  }

  sharing = true;
  resetBackoff();

  // Show preview
  const prev = document.getElementById('preview-video');
  if (prev) { prev.srcObject = stream; prev.play().catch(() => {}); }

  // Update UI
  document.getElementById('preview-source-name').textContent = selectedSource.name;
  document.getElementById('meta-empid').textContent = `ID: ${cfg.employeeId}`;
  document.getElementById('meta-name').textContent  = cfg.employeeName ? `· ${cfg.employeeName}` : '';
  show('screen-sharing');
  setStatus('connecting', 'Connecting…');
  window.electronAPI.updateStatus('connecting');

  // Track ended — screen sharing revoked by OS or user
  stream.getVideoTracks()[0].onended = () => {
    if (sharing) scheduleFullReconnect(2000);
  };

  await sendOffer();
}

// ── WebRTC offer ──────────────────────────────────────────────────────────────
async function sendOffer(iceRestart = false) {
  clearTimeout(iceRestartTimer);

  if (pc) { try { pc.close(); } catch {} pc = null; }

  const iceServers = serverCfg?.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }];
  pc = new RTCPeerConnection({ iceServers });

  stream.getTracks().forEach(t => pc.addTrack(t, stream));

  pc.oniceconnectionstatechange = () => {
    const s = pc?.iceConnectionState;
    console.log('[webrtc] ICE state:', s);

    if (s === 'connected' || s === 'completed') {
      setStatus('live', 'Live');
      window.electronAPI.updateStatus('live');
      resetBackoff();
      iceRestartTried = false;
    } else if (s === 'disconnected') {
      setStatus('connecting', 'Connection unstable…');
      // Try ICE restart after 4s
      iceRestartTimer = setTimeout(() => tryIceRestart(), 4000);
    } else if (s === 'failed') {
      if (!iceRestartTried) {
        tryIceRestart();
      } else {
        scheduleFullReconnect();
      }
    }
  };

  try {
    const offerOptions = iceRestart ? { iceRestart: true } : {};
    const offer = await pc.createOffer(offerOptions);
    await pc.setLocalDescription(offer);

    // Vanilla ICE — wait for all candidates before sending
    await waitIceComplete(pc);

    channel.trigger('client-offer', { sdp: pc.localDescription });
    setStatus('connecting', 'Offer sent — waiting for manager…');
  } catch (e) {
    console.error('[webrtc] sendOffer error:', e);
    setError(`WebRTC error: ${e.message}`);
    scheduleFullReconnect();
  }
}

function waitIceComplete(peerConn) {
  return new Promise(resolve => {
    if (peerConn.iceGatheringState === 'complete') { resolve(); return; }
    peerConn.onicegatheringstatechange = () => {
      if (peerConn && peerConn.iceGatheringState === 'complete') resolve();
    };
    setTimeout(resolve, 3000);
  });
}

// ── ICE restart (soft reconnect) ─────────────────────────────────────────────
async function tryIceRestart() {
  if (!sharing || !pc) return;
  console.log('[webrtc] trying ICE restart');
  iceRestartTried = true;
  setStatus('connecting', 'Reconnecting (ICE restart)…');

  try {
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    await waitIceComplete(pc);
    channel.trigger('client-offer', { sdp: pc.localDescription });

    // If not recovered in 8s, escalate to full reconnect
    iceRestartTimer = setTimeout(() => {
      if (pc && pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed') {
        console.log('[webrtc] ICE restart did not recover — doing full reconnect');
        scheduleFullReconnect();
      }
    }, 8000);
  } catch (e) {
    console.error('[webrtc] ICE restart failed:', e);
    scheduleFullReconnect();
  }
}

// ── Full reconnect with exponential backoff ───────────────────────────────────
function scheduleFullReconnect(overrideMs = null) {
  if (!sharing) return;
  clearTimeout(reconnectTimer);
  clearTimeout(iceRestartTimer);

  const delay = overrideMs !== null ? overrideMs : backoffMs;
  const secs  = Math.round(delay / 1000);
  setStatus('connecting', `Reconnecting in ${secs}s…`);
  window.electronAPI.updateStatus('connecting');

  reconnectTimer = setTimeout(async () => {
    if (!sharing) return;

    // If stream track is dead, re-capture
    if (!stream || stream.getVideoTracks()[0]?.readyState !== 'live') {
      try {
        if (stream) stream.getTracks().forEach(t => t.stop());
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource:   'desktop',
              chromeMediaSourceId: selectedSource.id,
              maxWidth: 1920, maxHeight: 1080, maxFrameRate: 15,
            }
          }
        });
        // Re-attach track ended handler
        stream.getVideoTracks()[0].onended = () => { if (sharing) scheduleFullReconnect(2000); };
        const prev = document.getElementById('preview-video');
        if (prev) { prev.srcObject = stream; prev.play().catch(() => {}); }
      } catch (e) {
        setError(`Re-capture failed: ${e.message}`);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF);
        scheduleFullReconnect();
        return;
      }
    }

    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF);
    iceRestartTried = false;
    setStatus('connecting', 'Reconnecting…');
    await sendOffer();
  }, delay);
}

function resetBackoff() {
  backoffMs = 1000;
}

// ── Stop sharing ──────────────────────────────────────────────────────────────
function stopSharing(goBackToSources = false) {
  sharing = false;
  clearTimeout(reconnectTimer);
  clearTimeout(iceRestartTimer);
  resetBackoff();

  if (pc) { try { pc.close(); } catch {} pc = null; }
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }

  try { channel?.trigger('client-stopped', {}); } catch {}

  window.electronAPI.updateStatus('offline');

  if (goBackToSources) {
    selectedSource = null;
    showSources();
  }
}

// ── Manual reconnect button ───────────────────────────────────────────────────
async function reconnect() {
  if (!sharing) return;
  clearTimeout(reconnectTimer);
  clearTimeout(iceRestartTimer);
  iceRestartTried = false;
  setStatus('connecting', 'Reconnecting…');
  await sendOffer();
}

// ── Status helpers ────────────────────────────────────────────────────────────
function setStatus(state, text) {
  const dot  = document.getElementById('status-dot');
  const label = document.getElementById('status-text');
  const errEl = document.getElementById('share-err');
  if (dot) {
    dot.className = `status-dot ${state}`;
  }
  if (label) label.textContent = text;
  if (errEl && state !== 'error') errEl.textContent = '';
}

function setError(msg) {
  setStatus('error', 'Error');
  const errEl = document.getElementById('share-err');
  if (errEl) errEl.textContent = msg;
}

// ── Screen helpers ────────────────────────────────────────────────────────────
function show(screenId) {
  ['screen-setup','screen-sources','screen-sharing'].forEach(id => {
    document.getElementById(id).style.display = (id === screenId) ? 'flex' : 'none';
  });
}

function getVal(id)       { return document.getElementById(id)?.value || ''; }
function setVal(id, val)  { const el = document.getElementById(id); if (el) el.value = val; }
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function setBtnLoading(id, loading, label) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.disabled     = loading;
  btn.textContent  = label;
}
