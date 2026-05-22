/**
 * activity-member.js — Rank Orbit Activity Monitoring (passive, member side)
 * Loaded at the bottom of member.html. Runs silently, zero UI changes.
 */
(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────────────────────────
  const API            = '/api/activity';
  const SNAP_MS        = 60_000;          // send mouse/keystroke snapshot every 60s
  const SS_MIN_MS      = 2 * 60_000;      // screenshot: min interval 2 min
  const SS_MAX_MS      = 5 * 60_000;      // screenshot: max interval 5 min
  const IDLE_WARN_MS   = 3 * 60_000;      // warn at 3 min idle
  const IDLE_ALERT_MS  = 5 * 60_000;      // alert at 5 min idle
  const FOCUS_ALERT_MS = 5 * 60_000;      // focus alert if hidden > 5 min
  const POLL_MS        = 5_000;           // poll working state every 5s

  // ── State ────────────────────────────────────────────────────────────────────
  let isTracking      = false;
  let mouseCount      = 0;
  let keystrokeCount  = 0;
  let lastActivityMs  = Date.now();
  let lastMouseMs     = 0;           // debounce: max 1 mouse event per second
  let snapTimer       = null;
  let ssTimer         = null;
  let idleAlertFired  = false;
  let focusLostAt     = null;
  let focusAlertFired = false;

  // ── Stream interception ──────────────────────────────────────────────────────
  // Patch getDisplayMedia BEFORE the user clicks Start Working so that when
  // monStartSharing() calls it, we silently capture the same stream reference
  // without prompting the user a second time.
  if (navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function') {
    const _orig = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getDisplayMedia = async function (constraints) {
      const stream = await _orig(constraints);
      window._actMonStream = stream;
      stream.getVideoTracks().forEach(t => {
        t.addEventListener('ended', () => {
          if (window._actMonStream === stream) window._actMonStream = null;
        });
      });
      return stream; // return unchanged — monStartSharing works normally
    };
  }

  // ── Passive event listeners (always attached, only count when tracking) ──────
  document.addEventListener('mousemove', () => {
    const now = Date.now();
    if (now - lastMouseMs >= 1000) { // max 1 count per second
      lastMouseMs = now;
      if (isTracking) mouseCount++;
    }
    lastActivityMs = now;
    idleAlertFired = false;
  }, { passive: true });

  document.addEventListener('keydown', () => {
    if (isTracking) keystrokeCount++;
    lastActivityMs = Date.now();
    idleAlertFired = false;
  }, { passive: true });

  document.addEventListener('click', () => {
    lastActivityMs = Date.now();
    idleAlertFired = false;
  }, { passive: true });

  document.addEventListener('scroll', () => {
    lastActivityMs = Date.now();
  }, { passive: true });

  // ── Tab focus / visibility ────────────────────────────────────────────────────
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      focusLostAt     = new Date();
      focusAlertFired = false;
    } else {
      if (focusLostAt) {
        const returned  = new Date();
        const durSec    = Math.round((returned - focusLostAt) / 1000);
        apiPost(`${API}/save-focus`, {
          focusLostAt:     focusLostAt.toISOString(),
          focusReturnedAt: returned.toISOString(),
          durationSeconds: durSec,
        });
      }
      focusLostAt     = null;
      focusAlertFired = false;
    }
  });

  // ── API helper ────────────────────────────────────────────────────────────────
  function apiPost(url, data) {
    return fetch(url, {
      method:      'POST',
      headers:     { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body:        JSON.stringify(data),
    }).catch(() => {});
  }

  // ── Screenshot capture ────────────────────────────────────────────────────────
  async function captureAndUpload() {
    const stream = window._actMonStream;
    if (!stream) return;
    const tracks = stream.getVideoTracks();
    if (!tracks.length || tracks[0].readyState !== 'live') return;

    try {
      let base64;

      if (typeof ImageCapture !== 'undefined') {
        // Modern path — no visible UI flicker
        const ic     = new ImageCapture(tracks[0]);
        const bitmap = await ic.grabFrame();
        const canvas = document.createElement('canvas');
        canvas.width  = Math.min(bitmap.width,  1920);
        canvas.height = Math.min(bitmap.height, 1080);
        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        base64 = canvas.toDataURL('image/jpeg', 0.75);
      } else {
        // Fallback: off-screen video element (never appended to DOM)
        base64 = await new Promise((resolve, reject) => {
          const vid = document.createElement('video');
          vid.srcObject = stream;
          vid.muted     = true;
          vid.onloadedmetadata = () => {
            vid.play().then(() => {
              requestAnimationFrame(() => {
                const canvas = document.createElement('canvas');
                canvas.width  = vid.videoWidth  || 1280;
                canvas.height = vid.videoHeight || 720;
                canvas.getContext('2d').drawImage(vid, 0, 0, canvas.width, canvas.height);
                vid.srcObject = null;
                resolve(canvas.toDataURL('image/jpeg', 0.75));
              });
            }).catch(reject);
          };
          vid.onerror = reject;
          setTimeout(() => reject(new Error('timeout')), 8000);
        });
      }

      if (!base64 || base64.length < 5000) return; // skip blank/tiny frames

      try {
        await apiPost(`${API}/upload-screenshot`, { base64 });
      } catch {
        // Retry once after 30s
        setTimeout(() => apiPost(`${API}/upload-screenshot`, { base64 }), 30_000);
      }
    } catch { /* silently skip on any error */ }
  }

  // ── Snapshot sender ───────────────────────────────────────────────────────────
  function sendSnapshot() {
    if (!isTracking) return;
    const payload = {
      mouseCount,
      keystrokeCount,
      timestamp: new Date().toISOString(),
    };
    mouseCount     = 0;
    keystrokeCount = 0;
    apiPost(`${API}/save-snapshot`, payload);
  }

  // ── Idle + focus alert checks ─────────────────────────────────────────────────
  function checkAlerts() {
    if (!isTracking) return;
    const now     = Date.now();
    const elapsed = now - lastActivityMs;

    // Idle alert
    if (elapsed > IDLE_ALERT_MS && !idleAlertFired) {
      idleAlertFired = true;
      apiPost(`${API}/idle-alert`, {
        idleStartedAt:   new Date(lastActivityMs).toISOString(),
        durationMinutes: Math.round(elapsed / 60_000),
      });
    }

    // Focus alert (tab has been hidden too long)
    if (focusLostAt && !focusAlertFired) {
      const hiddenMs = now - focusLostAt.getTime();
      if (hiddenMs > FOCUS_ALERT_MS) {
        focusAlertFired = true;
        apiPost(`${API}/focus-alert`, {
          message: `Tab hidden for ${Math.round(hiddenMs / 60_000)} minute(s)`,
        });
      }
    }
  }

  // ── Screenshot scheduler ──────────────────────────────────────────────────────
  function scheduleNextScreenshot() {
    if (!isTracking) return;
    const delay = SS_MIN_MS + Math.random() * (SS_MAX_MS - SS_MIN_MS);
    ssTimer = setTimeout(async () => {
      await captureAndUpload();
      scheduleNextScreenshot();
    }, delay);
  }

  // ── Start / stop ──────────────────────────────────────────────────────────────
  function startTracking() {
    if (isTracking) return;
    isTracking     = true;
    lastActivityMs = Date.now();
    idleAlertFired = false;
    mouseCount     = 0;
    keystrokeCount = 0;

    snapTimer = setInterval(() => {
      sendSnapshot();
      checkAlerts();
    }, SNAP_MS);

    scheduleNextScreenshot();
  }

  function stopTracking() {
    if (!isTracking) return;
    isTracking = false;
    clearInterval(snapTimer);
    clearTimeout(ssTimer);
    snapTimer = null;
    ssTimer   = null;
    sendSnapshot(); // flush remaining counts
  }

  // ── Working state poller ──────────────────────────────────────────────────────
  function pollWorkingState() {
    try {
      const state = localStorage.getItem('ro_att_state');
      if (state === 'working') {
        if (!isTracking) startTracking();
      } else {
        if (isTracking) stopTracking();
      }
    } catch { /* localStorage unavailable — do nothing */ }
  }

  // Poll immediately, then every 5s
  pollWorkingState();
  setInterval(pollWorkingState, POLL_MS);

})();
