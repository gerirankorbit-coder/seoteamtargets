'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
// This script runs in a hidden BrowserWindow. It has no UI — all status
// updates go back to the main process via window.shareAPI.reportStatus().

let cfg          = null;   // { serverUrl, employeeId, employeeName }
let serverCfg    = null;   // { pusherKey, pusherCluster, iceServers }
let pusherClient = null;
let channel      = null;
let pc           = null;   // RTCPeerConnection
let stream       = null;   // captured screen MediaStream
let sourceId     = null;   // desktopCapturer source ID

let sharing         = false;
let backoffMs       = 1000;
const MAX_BACKOFF   = 30000;
let reconnectTimer  = null;
let iceRestartTimer = null;
let iceRestartTried = false;

// ── Boot — wait for commands from main ───────────────────────────────────────
window.shareAPI.onStart(async ({ cfg: config, sourceId: srcId }) => {
  // Set sharing = true HERE, before any async work, so that stopSharing() can
  // reliably set it back to false and every guard inside the call chain will see
  // the updated value even if do-stop arrives while initPusher/getUserMedia is running.
  sharing  = true;
  cfg      = config;
  sourceId = srcId;
  console.log('[share] starting for employee:', cfg.employeeId, 'source:', sourceId);
  await initPusher();
  await startCapture();
});

window.shareAPI.onStop(() => {
  console.log('[share] stop command received');
  stopSharing();
});

// ── Pusher init ───────────────────────────────────────────────────────────────
async function initPusher() {
  if (!serverCfg || !serverCfg.pusherKey) {
    try {
      const r = await fetch(`${cfg.serverUrl}/api/screenshare/config`, {
        method:      'GET',
        credentials: 'omit',
        headers:     { 'Accept': 'application/json' },
      });
      serverCfg = await r.json();
    } catch (e) {
      console.error('[share] Could not fetch server config:', e);
      reportStatus('error', 'Cannot reach server');
      return;
    }
  }

  if (pusherClient) {
    try { pusherClient.disconnect(); } catch {}
    pusherClient = null;
    channel      = null;
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
    if (sharing) reportStatus('connecting', 'Pusher disconnected — reconnecting…');
  });

  const channelName = `private-screenshare-${cfg.employeeId}`;
  channel = pusherClient.subscribe(channelName);

  channel.bind('pusher:subscription_error', (err) => {
    console.error('[pusher] auth error:', err);
    reportStatus('error', `Auth failed (${err?.status ?? err}). Check Employee ID.`);
  });

  channel.bind('pusher:subscription_succeeded', () => {
    console.log('[pusher] subscribed to', channelName);
    if (sharing && stream) sendOffer();
  });

  // Manager asked us to re-send offer (reconnect request)
  channel.bind('screenshare-reconnect', () => {
    console.log('[pusher] reconnect request from manager');
    if (sharing && stream && stream.getVideoTracks()[0]?.readyState === 'live') {
      sendOffer();
    } else if (sharing) {
      scheduleFullReconnect(0);
    }
  });

  // Manager sent WebRTC answer
  channel.bind('screenshare-answer', async ({ sdp }) => {
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

// ── Capture screen + begin WebRTC offer ──────────────────────────────────────
async function startCapture() {
  // Guard 1: stopSharing() may have been called while initPusher() was running
  if (!sharing) return;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource:   'desktop',
          chromeMediaSourceId: sourceId,
          maxWidth:  1920,
          maxHeight: 1080,
          maxFrameRate: 15,
        },
      },
    });
  } catch (e) {
    console.error('[share] getUserMedia failed:', e);
    reportStatus('error', `Screen capture failed: ${e.message}`);
    return;
  }

  // Guard 2: stopSharing() may have been called while getUserMedia() was pending
  if (!sharing) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
    return;
  }

  // NOTE: sharing = true is now set at the top of the onStart handler, not here.
  resetBackoff();

  // If the OS revokes screen recording (e.g. user denies mid-session) the
  // track fires "ended" — schedule a full reconnect which will re-capture.
  stream.getVideoTracks()[0].onended = () => {
    if (sharing) scheduleFullReconnect(2000);
  };

  reportStatus('connecting', 'Connecting…');
  await sendOffer();
}

// ── WebRTC offer ──────────────────────────────────────────────────────────────
async function sendOffer(iceRestart = false) {
  clearTimeout(iceRestartTimer);

  if (pc) { try { pc.close(); } catch {} pc = null; }

  const iceServers = serverCfg?.iceServers || [
    // Xirsys fallback — used only if /api/screenshare/config is unreachable
    {
      urls: [
        'stun:ss-turn1.xirsys.com',
        'turn:ss-turn1.xirsys.com:80?transport=udp',
        'turn:ss-turn1.xirsys.com:3478?transport=udp',
        'turn:ss-turn1.xirsys.com:80?transport=tcp',
        'turn:ss-turn1.xirsys.com:3478?transport=tcp',
        'turns:ss-turn1.xirsys.com:443?transport=tcp',
        'turns:ss-turn1.xirsys.com:5349?transport=tcp',
      ],
      username:   'gerirankorbit',
      credential: '1495cc4e-5f75-11f1-82c8-0242ac140002',
    },
  ];
  pc = new RTCPeerConnection({
    iceServers,
    iceCandidatePoolSize: 10,
    bundlePolicy:        'max-bundle',
    rtcpMuxPolicy:       'require',
  });

  // Attach all tracks (video only in practice) with the stream reference so the
  // manager side receives event.streams[0] correctly in its ontrack handler.
  stream.getTracks().forEach(t => pc.addTrack(t, stream));

  pc.oniceconnectionstatechange = () => {
    const s = pc?.iceConnectionState;
    console.log('[webrtc] ICE state:', s);

    if (s === 'connected' || s === 'completed') {
      reportStatus('live', 'Live');
      resetBackoff();
      iceRestartTried = false;
    } else if (s === 'disconnected') {
      reportStatus('connecting', 'Connection unstable…');
      iceRestartTimer = setTimeout(() => tryIceRestart(), 4000);
    } else if (s === 'failed') {
      if (!iceRestartTried) tryIceRestart();
      else scheduleFullReconnect();
    }
  };

  try {
    const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : {});
    await pc.setLocalDescription(offer);

    // Vanilla ICE — wait for full candidate gathering before sending.
    await waitIceComplete(pc);

    await apiSignal('screenshare-offer', { sdp: pc.localDescription });
    reportStatus('connecting', 'Offer sent — waiting for manager…');
  } catch (e) {
    console.error('[webrtc] sendOffer error:', e);
    reportStatus('error', `WebRTC error: ${e.message}`);
    scheduleFullReconnect();
  }
}

function waitIceComplete(peerConn) {
  return new Promise(resolve => {
    if (peerConn.iceGatheringState === 'complete') { resolve(); return; }
    peerConn.onicegatheringstatechange = () => {
      if (peerConn?.iceGatheringState === 'complete') resolve();
    };
    setTimeout(resolve, 3000);
  });
}

// ── ICE restart (soft reconnect) ─────────────────────────────────────────────
async function tryIceRestart() {
  if (!sharing || !pc) return;
  console.log('[webrtc] ICE restart');
  iceRestartTried = true;
  reportStatus('connecting', 'Reconnecting (ICE restart)…');

  try {
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    await waitIceComplete(pc);
    await apiSignal('screenshare-offer', { sdp: pc.localDescription });

    iceRestartTimer = setTimeout(() => {
      if (pc && pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed') {
        console.log('[webrtc] ICE restart did not recover — full reconnect');
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
  reportStatus('connecting', `Reconnecting in ${Math.round(delay / 1000)}s…`);

  reconnectTimer = setTimeout(async () => {
    if (!sharing) return;

    // If the video track died, re-capture
    if (!stream || stream.getVideoTracks()[0]?.readyState !== 'live') {
      try {
        if (stream) stream.getTracks().forEach(t => t.stop());

        // Ask main process for a fresh source list
        const sources = await window.shareAPI.getSources();
        const src = sources.find(s => s.id.startsWith('screen:')) || sources[0];
        if (!src) throw new Error('No screen source available');

        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource:   'desktop',
              chromeMediaSourceId: src.id,
              maxWidth: 1920, maxHeight: 1080, maxFrameRate: 15,
            },
          },
        });
        stream.getVideoTracks()[0].onended = () => {
          if (sharing) scheduleFullReconnect(2000);
        };
        sourceId = src.id;
      } catch (e) {
        console.error('[share] re-capture failed:', e);
        reportStatus('error', `Re-capture failed: ${e.message}`);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF);
        scheduleFullReconnect();
        return;
      }
    }

    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF);
    iceRestartTried = false;
    reportStatus('connecting', 'Reconnecting…');
    await sendOffer();
  }, delay);
}

function resetBackoff() { backoffMs = 1000; }

// ── Stop sharing ──────────────────────────────────────────────────────────────
function stopSharing() {
  sharing = false;
  clearTimeout(reconnectTimer);
  clearTimeout(iceRestartTimer);
  resetBackoff();

  if (pc)     { try { pc.close(); } catch {} pc = null; }
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }

  apiSignal('screenshare-stopped', {}).catch(() => {});
  reportStatus('offline', 'Not working');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function reportStatus(state, text) {
  window.shareAPI.reportStatus(state, text);
}

async function apiSignal(event, data = {}) {
  if (!cfg) return;
  try {
    const r = await fetch(`${cfg.serverUrl}/api/screenshare/signal`, {
      method:      'POST',
      credentials: 'omit',
      headers:     { 'Content-Type': 'application/json' },
      body:        JSON.stringify({ employeeId: cfg.employeeId, employeeName: cfg.employeeName || '', event, data }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      console.error('[signal] POST failed:', r.status, err);
    }
  } catch (e) {
    console.error('[signal] fetch error:', e);
  }
}
