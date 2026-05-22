'use strict';
const express    = require('express');
const router     = express.Router();
const mongoose   = require('mongoose');
const cloudinary = require('cloudinary').v2;

// ── Cloudinary config ─────────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── Models (act_ prefix — new collections, no conflict with existing ones) ────
const ActScreenshot = mongoose.models.ActScreenshot || mongoose.model(
  'ActScreenshot',
  new mongoose.Schema({
    username:  String,
    date:      String,   // YYYY-MM-DD
    time:      String,   // HH:MM
    hour:      Number,
    url:       String,
    thumbnail: String,
    timestamp: Date,
  }),
  'act_screenshots'
);

const ActSnapshot = mongoose.models.ActSnapshot || mongoose.model(
  'ActSnapshot',
  new mongoose.Schema({
    username:       String,
    date:           String,
    hour:           Number,
    minute:         Number,
    mouseCount:     Number,
    keystrokeCount: Number,
    timestamp:      Date,
  }),
  'act_snapshots'
);

const ActFocus = mongoose.models.ActFocus || mongoose.model(
  'ActFocus',
  new mongoose.Schema({
    username:        String,
    date:            String,
    focusLostAt:     Date,
    focusReturnedAt: Date,
    durationSeconds: Number,
    timestamp:       Date,
  }),
  'act_focus'
);

const ActIdle = mongoose.models.ActIdle || mongoose.model(
  'ActIdle',
  new mongoose.Schema({
    username:        String,
    date:            String,
    idleStartedAt:   Date,
    durationMinutes: Number,
    timestamp:       Date,
  }),
  'act_idle'
);

const ActAlert = mongoose.models.ActAlert || mongoose.model(
  'ActAlert',
  new mongoose.Schema({
    username:  String,
    date:      String,
    type:      String,
    message:   String,
    timestamp: Date,
  }),
  'act_alerts'
);

// ── Auth guards ────────────────────────────────────────────────────────────────
function guardMember(req, res) {
  if (!req.session || !req.session.username) {
    res.status(401).json({ error: 'Not authenticated' }); return false;
  }
  return true;
}

function guardManager(req, res) {
  if (!req.session || !req.session.username) {
    res.status(401).json({ error: 'Not authenticated' }); return false;
  }
  if (req.session.role !== 'manager' && req.session.role !== 'assistant') {
    res.status(403).json({ error: 'Insufficient permissions' }); return false;
  }
  return true;
}

// ── Pakistan time helper (UTC+5) ─────────────────────────────────────────────
function getPakistanTime() {
  const now = new Date();
  const pakistanOffset = 5 * 60;
  const utc    = now.getTime() + (now.getTimezoneOffset() * 60000);
  const pkTime = new Date(utc + (pakistanOffset * 60000));
  return {
    date:      pkTime.toISOString().split('T')[0],
    time:      pkTime.toTimeString().slice(0, 5),
    hour:      pkTime.getHours(),
    minute:    pkTime.getMinutes(),
    timestamp: pkTime,
  };
}

function todayISO() {
  return getPakistanTime().date;
}

// ── POST /api/activity/upload-screenshot ──────────────────────────────────────
router.post('/upload-screenshot', async (req, res) => {
  if (!guardMember(req, res)) return;
  const { base64 } = req.body;
  if (!base64 || base64.length < 100) return res.status(400).json({ error: 'base64 required' });

  const username = req.session.username;
  const pk       = getPakistanTime();

  try {
    const result = await cloudinary.uploader.upload(base64, {
      folder:        `screenshots/${username}/${pk.date}`,
      resource_type: 'image',
      format:        'jpg',
      quality:       'auto',
    });

    const thumbnail = cloudinary.url(result.public_id, {
      width: 300, height: 180, crop: 'fill', quality: 'auto', format: 'jpg', secure: true,
    });

    await ActScreenshot.create({
      username, date: pk.date, time: pk.time, hour: pk.hour,
      url: result.secure_url, thumbnail,
      timestamp: pk.timestamp,
    });

    return res.json({ success: true, url: result.secure_url, thumbnail });
  } catch (err) {
    console.error('[activity] screenshot upload error:', err.message);
    return res.status(500).json({ error: 'Upload failed' });
  }
});

// ── POST /api/activity/save-snapshot ─────────────────────────────────────────
router.post('/save-snapshot', async (req, res) => {
  if (!guardMember(req, res)) return;
  const { mouseCount = 0, keystrokeCount = 0 } = req.body;
  const username = req.session.username;
  const pk       = getPakistanTime();

  try {
    await ActSnapshot.create({
      username, date: pk.date,
      hour:           pk.hour,
      minute:         pk.minute,
      mouseCount:     Math.max(0, Number(mouseCount)     || 0),
      keystrokeCount: Math.max(0, Number(keystrokeCount) || 0),
      timestamp:      pk.timestamp,
    });
    return res.json({ success: true });
  } catch (err) {
    console.error('[activity] save-snapshot error:', err.message);
    return res.status(500).json({ error: 'DB error' });
  }
});

// ── POST /api/activity/save-focus ─────────────────────────────────────────────
router.post('/save-focus', async (req, res) => {
  if (!guardMember(req, res)) return;
  const { focusLostAt, focusReturnedAt, durationSeconds = 0 } = req.body;
  const username = req.session.username;
  const pk       = getPakistanTime();

  try {
    await ActFocus.create({
      username, date: pk.date,
      focusLostAt:     focusLostAt     ? new Date(focusLostAt)     : pk.timestamp,
      focusReturnedAt: focusReturnedAt ? new Date(focusReturnedAt) : pk.timestamp,
      durationSeconds: Math.max(0, Number(durationSeconds) || 0),
      timestamp:       pk.timestamp,
    });
    return res.json({ success: true });
  } catch (err) {
    console.error('[activity] save-focus error:', err.message);
    return res.status(500).json({ error: 'DB error' });
  }
});

// ── POST /api/activity/idle-alert ─────────────────────────────────────────────
router.post('/idle-alert', async (req, res) => {
  if (!guardMember(req, res)) return;
  const { idleStartedAt, durationMinutes = 0 } = req.body;
  const username = req.session.username;
  const pk       = getPakistanTime();

  try {
    await ActIdle.create({
      username, date: pk.date,
      idleStartedAt:   idleStartedAt ? new Date(idleStartedAt) : pk.timestamp,
      durationMinutes: Math.max(0, Number(durationMinutes) || 0),
      timestamp:       pk.timestamp,
    });
    return res.json({ success: true });
  } catch (err) {
    console.error('[activity] idle-alert error:', err.message);
    return res.status(500).json({ error: 'DB error' });
  }
});

// ── POST /api/activity/focus-alert ─────────────────────────────────────────────
router.post('/focus-alert', async (req, res) => {
  if (!guardMember(req, res)) return;
  const { message = 'Tab hidden for extended period' } = req.body;
  const username = req.session.username;
  const pk       = getPakistanTime();

  try {
    await ActAlert.create({
      username, date: pk.date, type: 'focus', message, timestamp: pk.timestamp,
    });
    return res.json({ success: true });
  } catch (err) {
    console.error('[activity] focus-alert error:', err.message);
    return res.status(500).json({ error: 'DB error' });
  }
});

// ── GET /api/activity/get-dashboard ───────────────────────────────────────────
router.get('/get-dashboard', async (req, res) => {
  if (!guardManager(req, res)) return;
  const { username, date = todayISO() } = req.query;
  if (!username) return res.status(400).json({ error: 'username required' });

  try {
    const [snapshots, screenshots, focuses, idles, alerts] = await Promise.all([
      ActSnapshot .find({ username, date }).lean(),
      ActScreenshot.find({ username, date }).sort({ timestamp: 1 }).lean(),
      ActFocus    .find({ username, date }).lean(),
      ActIdle     .find({ username, date }).lean(),
      ActAlert    .find({ username, date }).lean(),
    ]);

    const hourlyScores = [];
    let totalScore = 0, scoredHours = 0;

    for (let h = 0; h <= 23; h++) {
      const hs = snapshots.filter(s => s.hour === h);
      if (!hs.length) continue;

      const totalMouse = hs.reduce((a, s) => a + (s.mouseCount     || 0), 0);
      const totalKeys  = hs.reduce((a, s) => a + (s.keystrokeCount || 0), 0);
      const n          = hs.length;
      const mousePerMin = totalMouse / n;
      const keysPerMin  = totalKeys  / n;

      const mouseScore      = mousePerMin >= 60 ? 40 : Math.round((mousePerMin / 60) * 40);
      const keystrokeScore  = keysPerMin  >= 15 ? 30 : Math.round((keysPerMin  / 15) * 30);

      const hourFocusLost = focuses.filter(f => new Date(f.focusLostAt).getHours() === h);
      const lostSec       = hourFocusLost.reduce((a, f) => a + (f.durationSeconds || 0), 0);
      const focusedPct    = Math.max(0, 1 - lostSec / 3600);
      const focusScore    = focusedPct >= 0.9 ? 10 : Math.round(focusedPct * 10);

      const hourIdle  = idles.filter(i => new Date(i.idleStartedAt).getHours() === h);
      const idleScore = hourIdle.some(i => (i.durationMinutes || 0) >= 10) ? 0 : 20;

      const score = mouseScore + keystrokeScore + focusScore + idleScore;
      hourlyScores.push({ hour: h, score, mouse: Math.round(mousePerMin), keystrokes: Math.round(keysPerMin) });
      totalScore += score;
      scoredHours++;
    }

    return res.json({
      member:     username,
      date,
      hourlyScores,
      dailyAverage:     scoredHours > 0 ? Math.round(totalScore / scoredHours) : 0,
      screenshots:      screenshots.map(s => ({ time: s.time, thumbnail: s.thumbnail, url: s.url, timestamp: s.timestamp })),
      idleAlerts:       idles,
      focusAlerts:      alerts.filter(a => a.type === 'focus'),
      totalScreenshots: screenshots.length,
    });
  } catch (err) {
    console.error('[activity] get-dashboard error:', err.message);
    return res.status(500).json({ error: 'DB error' });
  }
});

// ── GET /api/activity/get-members-summary ─────────────────────────────────────
router.get('/get-members-summary', async (req, res) => {
  if (!guardManager(req, res)) return;
  const { date = todayISO() } = req.query;

  try {
    // Access already-registered User model (defined in server.js, same mongoose instance)
    const UserModel   = mongoose.models.User;
    const memberDocs  = UserModel
      ? await UserModel.find({ role: 'member' }, { username: 1, display: 1 }).lean()
      : [];

    const [allSnaps, allShots, allIdle] = await Promise.all([
      ActSnapshot .find({ date }).lean(),
      ActScreenshot.find({ date }).lean(),
      ActIdle      .find({ date }).lean(),
    ]);

    const result = memberDocs.map(u => {
      const snaps = allSnaps.filter(s => s.username === u.username);
      const shots = allShots.filter(s => s.username === u.username);
      const idles = allIdle .filter(s => s.username === u.username);

      const hourScores = [];
      for (let h = 0; h <= 23; h++) {
        const hs = snaps.filter(s => s.hour === h);
        if (!hs.length) continue;
        const n         = hs.length;
        const mPM       = hs.reduce((a, s) => a + (s.mouseCount     || 0), 0) / n;
        const kPM       = hs.reduce((a, s) => a + (s.keystrokeCount || 0), 0) / n;
        const hasIdle10 = idles.some(i => new Date(i.idleStartedAt).getHours() === h && i.durationMinutes >= 10);
        hourScores.push(
          (mPM >= 60 ? 40 : Math.round((mPM / 60) * 40)) +
          (kPM >= 15 ? 30 : Math.round((kPM / 15) * 30)) +
          10 + // focus assumed OK for summary
          (hasIdle10 ? 0 : 20)
        );
      }

      const score    = hourScores.length > 0 ? Math.round(hourScores.reduce((a, b) => a + b, 0) / hourScores.length) : 0;
      const lastSnap = snaps.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
      const lastSeen = lastSnap ? lastSnap.timestamp : null;
      // Compare against PK-offset "now" — timestamps are stored as UTC+5 so Date.now() (UTC) would always be 5h behind
      const pkNow     = getPakistanTime().timestamp;
      const minsSince = lastSeen ? (pkNow.getTime() - new Date(lastSeen).getTime()) / 60000 : Infinity;
      const status = minsSince < 5 ? 'active' : minsSince < 15 ? 'idle' : 'offline';

      return {
        username:        u.username,
        displayName:     u.display,
        score,
        status,
        lastSeen,
        screenshotCount: shots.length,
      };
    });

    return res.json(result);
  } catch (err) {
    console.error('[activity] get-members-summary error:', err.message);
    return res.status(500).json({ error: 'DB error' });
  }
});

module.exports = router;
