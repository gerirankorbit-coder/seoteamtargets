'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
// This script runs in a hidden BrowserWindow (show: false).
// All status updates go back to main via window.shareAPI.reportStatus().
// LiveKit handles all reconnection — no manual backoff or ICE restart needed.

let cfg      = null;   // { serverUrl, employeeId, employeeName }
let sharing  = false;
let stream   = null;   // captured screen MediaStream
let sourceId = null;   // desktopCapturer source ID
let room     = null;   // LiveKit Room instance

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
  sharing = false;

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
