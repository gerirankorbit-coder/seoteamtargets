'use strict';
const express = require('express');
const router  = express.Router();
const Pusher  = require('pusher');

// ── Pusher server client ──────────────────────────────────────────────────────
// Constructed lazily so missing env vars don't crash the module at load time.
// Each route that needs Pusher calls getPusher() and handles the null case.
let _pusher = null;
function getPusher() {
  if (_pusher) return _pusher;
  const { PUSHER_APP_ID, PUSHER_KEY, PUSHER_SECRET, PUSHER_CLUSTER } = process.env;
  if (!PUSHER_APP_ID || !PUSHER_KEY || !PUSHER_SECRET || !PUSHER_CLUSTER) {
    console.error('[screenshare] Missing Pusher env vars — PUSHER_APP_ID, PUSHER_KEY, PUSHER_SECRET, PUSHER_CLUSTER must all be set');
    return null;
  }
  try {
    _pusher = new Pusher({
      appId:   PUSHER_APP_ID,
      key:     PUSHER_KEY,
      secret:  PUSHER_SECRET,
      cluster: PUSHER_CLUSTER,
      useTLS:  true,
    });
  } catch (e) {
    console.error('[screenshare] Failed to create Pusher instance:', e.message);
    return null;
  }
  return _pusher;
}

// ── ICE servers (STUN always; TURN optional via env) ─────────────────────────
function getIceServers() {
  const servers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
  if (process.env.TURN_URL) {
    servers.push({
      urls:       process.env.TURN_URL,
      username:   process.env.TURN_USERNAME   || '',
      credential: process.env.TURN_CREDENTIAL || '',
    });
  }
  return servers;
}

// ── CORS ──────────────────────────────────────────────────────────────────────
// /config  → fully public: wildcard origin, NO credentials header
//            (wildcard + credentials is invalid per CORS spec)
// all other routes → reflect origin + credentials so manager session cookie works
router.use((req, res, next) => {
  if (req.path === '/config' || req.path === '/config/') {
    res.header('Access-Control-Allow-Origin',  '*');
    res.header('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  } else {
    const origin = req.headers.origin || '';
    if (origin) {
      res.header('Access-Control-Allow-Origin',      origin);
      res.header('Access-Control-Allow-Credentials', 'true');
    } else {
      // Electron / no-origin requests (credentials: omit) — safe to use wildcard
      res.header('Access-Control-Allow-Origin', '*');
    }
    res.header('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── GET /api/screenshare/config ───────────────────────────────────────────────
router.get('/config', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.json({
    pusherKey:     process.env.PUSHER_KEY     || '',
    pusherCluster: process.env.PUSHER_CLUSTER || '',
    iceServers:    getIceServers(),
  });
});

// ── POST /api/screenshare/pusher-auth ─────────────────────────────────────────
// Pusher JS sends this as application/x-www-form-urlencoded (requires
// express.urlencoded() in the global middleware stack — see server.js).
//
//   Manager path  — session present + role manager/assistant
//                   → authorised to subscribe to any private-screenshare-* channel
//
//   Employee path — no session; must send employeeId in body / query
//                   → authorised only for private-screenshare-{employeeId}
//
router.post('/pusher-auth', (req, res) => {
  const pusher = getPusher();
  if (!pusher) {
    return res.status(500).json({ error: 'Pusher not configured on server' });
  }

  const socketId = req.body?.socket_id;
  const channel  = req.body?.channel_name;

  if (!socketId || !channel) {
    console.warn('[pusher-auth] Missing socket_id or channel_name. body:', req.body);
    return res.status(400).json({ error: 'socket_id and channel_name required' });
  }

  if (!channel.startsWith('private-screenshare-')) {
    return res.status(403).json({ error: 'Forbidden channel' });
  }

  // ── Manager/assistant via session ─────────────────────────────────────────
  if (req.session?.username &&
      (req.session.role === 'manager' || req.session.role === 'assistant')) {
    try {
      const auth = pusher.authorizeChannel(socketId, channel);
      return res.json(auth);
    } catch (e) {
      console.error('[pusher-auth] authorizeChannel error (manager):', e.message);
      return res.status(500).json({ error: 'Auth signing failed' });
    }
  }

  // ── Employee via employeeId param (Electron — no session) ─────────────────
  const employeeId = ((req.body?.employeeId) || (req.query?.employeeId) || '').trim();
  if (employeeId && channel === `private-screenshare-${employeeId}`) {
    try {
      const auth = pusher.authorizeChannel(socketId, channel);
      return res.json(auth);
    } catch (e) {
      console.error('[pusher-auth] authorizeChannel error (employee):', e.message);
      return res.status(500).json({ error: 'Auth signing failed' });
    }
  }

  console.warn('[pusher-auth] Not authorised. session role:', req.session?.role, 'employeeId:', employeeId, 'channel:', channel);
  return res.status(403).json({ error: 'Not authorised' });
});

// ── POST /api/screenshare/signal ──────────────────────────────────────────────
// Server-side relay so both Electron (no Pusher client-events) and browser can
// send signaling messages without needing "Client Events" enabled in Pusher.
router.post('/signal', async (req, res) => {
  const pusher = getPusher();
  if (!pusher) {
    return res.status(500).json({ error: 'Pusher not configured on server' });
  }

  // Guard against missing/unparsed body
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'JSON body required' });
  }

  const { employeeId, event, data = {} } = req.body;

  const allowed = [
    'screenshare-offer',
    'screenshare-answer',
    'screenshare-reconnect',
    'screenshare-stopped',
  ];

  if (!employeeId || !event) {
    return res.status(400).json({ error: 'employeeId and event required' });
  }
  if (!allowed.includes(event)) {
    return res.status(400).json({ error: `Event not allowed: ${event}` });
  }

  try {
    await pusher.trigger(`private-screenshare-${employeeId}`, event, data);
    return res.json({ success: true });
  } catch (err) {
    console.error('[screenshare/signal] Pusher error:', err.message);
    return res.status(500).json({ error: 'Pusher trigger failed', detail: err.message });
  }
});

module.exports = router;
