'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
// This script runs in a hidden BrowserWindow (show: false).
// All status updates go back to main via window.shareAPI.reportStatus().
// LiveKit handles all reconnection — no manual backoff or ICE restart needed.

let cfg         = null;   // { serverUrl, employeeId, employeeName }
let sharing     = false;
let screenLocked = false; // true while Windows screen lock is active
let stream      = null;   // captured screen MediaStream
let sourceId    = null;   // desktopCapturer source ID
let room        = null;   // LiveKit Room instance

// ── Boot — wait for commands from main ───────────────────────────────────────
window.shareAPI.onStart(async ({ cfg: config, sourceId: srcId }) => {
  // Set sharing = true first so stopSharing() can reliably interrupt any
  // async work that is still in-flight when a stop command arrives.
  sharing  = true;
  cfg      = config;
  sourceId = srcId;
  console.log('[share] starting for employee:', cfg.employeeId, 'source:', sourceId);
  await startCapture();
});

window.shareAPI.onStop(() => {
  console.log('[share] stop command received');
  stopSharing();
});

// ── Screen lock (Win+L) ───────────────────────────────────────────────────────
window.shareAPI.onScreenLocked(() => {
  // Only act if we are actively sharing — ignore spurious events
  if (!sharing) return;
  screenLocked = true;
  console.log('[share] screen locked — disconnecting LiveKit');

  // Disconnect the room and stop the stream, but keep sharing = true
  // so we can auto-restart when the screen unlocks.
  if (room) {
    try { room.disconnect(); } catch {}
    room = null;
  }
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }

  reportStatus('locked', 'Screen Locked 🔒');

  // Notify the manager portal so it can show the lock overlay
  if (cfg) {
    fetch(`${cfg.serverUrl}/api/screenshare/status`, {
      method:      'POST',
      credentials: 'omit',
      headers:     { 'Content-Type': 'application/json' },
      body:        JSON.stringify({ employeeId: cfg.employeeId, status: 'locked' }),
    }).catch(e => console.warn('[share] lock notify failed:', e.message));
  }
});

// ── Screen unlock / wake from sleep ──────────────────────────────────────────
// Handles all four resume scenarios:
//   1. Win+L unlock          — fired by powerMonitor unlock-screen
//   2. Lid open              — fired by powerMonitor resume
//   3. Sleep/hibernate wake  — fired by powerMonitor resume
//   4. Monitor sleep + lock  — fired by powerMonitor unlock-screen
//
// The screenLocked flag deduplicates: on Windows, lock-screen and suspend can
// both fire on the same transition, so only the first onScreenLocked call acts.
// Similarly, both unlock-screen and resume can fire on wake; only the first
// onScreenUnlocked call proceeds (screenLocked is already false for subsequent
// calls, so they return early).
window.shareAPI.onScreenUnlocked(() => {
  if (!sharing || !screenLocked) return; // not locked by us, or already handled
  screenLocked = false;
  console.log('[share] screen unlocked / resumed — restarting share in 3 s');

  // Tell the manager portal to hide the lock overlay immediately
  if (cfg) {
    fetch(`${cfg.serverUrl}/api/screenshare/status`, {
      method:      'POST',
      credentials: 'omit',
      headers:     { 'Content-Type': 'application/json' },
      body:        JSON.stringify({ employeeId: cfg.employeeId, status: 'unlocked' }),
    }).catch(e => console.warn('[share] unlock notify failed:', e.message));
  }

  // Wait 3 s — enough for the display stack to reinitialize after both a simple
  // unlock (needs ~1 s) and a full sleep wake (needs ~2-3 s on most hardware).
  setTimeout(async () => {
    if (!sharing || screenLocked) return; // re-locked while waiting

    // Refresh source ID — screen IDs can change after wake/unlock on some systems
    try {
      const sources = await window.shareAPI.getSources();
      if (sources && sources.length) {
        const primary = sources.find(s => s.id.startsWith('screen:')) || sources[0];
        sourceId = primary.id;
      }
    } catch (e) {
      console.warn('[share] getSources failed on resume:', e.message);
    }

    reportStatus('connecting', 'Reconnecting…');
    await startCapture();
  }, 3000);
});

// ── Capture screen ────────────────────────────────────────────────────────────
async function startCapture() {
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

  // Guard: stopSharing() may have been called while getUserMedia() was pending
  if (!sharing) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
    return;
  }

  // If the OS revokes screen-recording permission mid-session the track ends —
  // stop cleanly so the employee can re-grant and start again.
  stream.getVideoTracks()[0].onended = () => {
    if (sharing) stopSharing();
  };

  reportStatus('connecting', 'Connecting…');
  await connectLiveKit();
}

// ── LiveKit ───────────────────────────────────────────────────────────────────
async function connectLiveKit() {
  if (!sharing) return;

  // ── 1. Fetch employee token ───────────────────────────────────────────────
  let token, livekitUrl;
  try {
    const r = await fetch(`${cfg.serverUrl}/api/screenshare/token`, {
      method:      'POST',
      credentials: 'omit',
      headers:     { 'Content-Type': 'application/json' },
      body:        JSON.stringify({
        role:         'employee',
        employeeId:   cfg.employeeId,
        employeeName: cfg.employeeName || '',
      }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${r.status}`);
    }
    ({ token, livekitUrl } = await r.json());
  } catch (e) {
    console.error('[livekit] token fetch failed:', e.message);
    reportStatus('error', `Cannot reach server: ${e.message}`);
    return;
  }

  if (!sharing) return;

  // ── 2. Create room ────────────────────────────────────────────────────────
  room = new LivekitClient.Room({
    // Screen share is always full quality — no adaptive bitrate or simulcast
    adaptiveStream: false,
    dynacast:       false,
  });

  room.on(LivekitClient.RoomEvent.Reconnecting, () => {
    console.log('[livekit] reconnecting…');
    reportStatus('connecting', 'Reconnecting…');
  });
  room.on(LivekitClient.RoomEvent.Reconnected, () => {
    console.log('[livekit] reconnected');
    reportStatus('live', 'Live');
  });
  room.on(LivekitClient.RoomEvent.Disconnected, (reason) => {
    console.log('[livekit] disconnected, reason:', reason);
    // Only update status if we're still supposed to be sharing (not a clean stop)
    if (sharing) reportStatus('error', 'Connection lost — click End Working and try again');
  });

  // ── 3. Connect + publish ──────────────────────────────────────────────────
  try {
    await room.connect(livekitUrl, token);
    console.log('[livekit] connected to room:', room.name);

    // Guard: stop command may have arrived while connect() was in-flight
    if (!sharing) {
      try { room.disconnect(); } catch {}
      room = null;
      return;
    }

    // Publish the captured video track as a screen-share source
    const videoTrack = stream.getVideoTracks()[0];
    await room.localParticipant.publishTrack(videoTrack, {
      name:   'screen',
      source: LivekitClient.Track.Source.ScreenShare,
      videoEncoding: {
        maxBitrate:   1_500_000,
        maxFramerate: 15,
      },
    });

    reportStatus('live', 'Live');
    console.log('[livekit] screen track published to room:', room.name);
  } catch (e) {
    console.error('[livekit] connect/publish error:', e.message);
    reportStatus('error', `LiveKit error: ${e.message}`);
  }
}

// ── Stop sharing ──────────────────────────────────────────────────────────────
function stopSharing() {
  sharing      = false;
  screenLocked = false;

  // Disconnect room first — this unpublishes all local tracks cleanly
  if (room) {
    try { room.disconnect(); } catch {}
    room = null;
  }

  // Stop the underlying MediaStream tracks
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }

  reportStatus('offline', 'Not working');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function reportStatus(state, text) {
  window.shareAPI.reportStatus(state, text);
}
