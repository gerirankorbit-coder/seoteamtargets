'use strict';
const express      = require('express');
const router       = express.Router();
const Pusher       = require('pusher');
const { AccessToken } = require('livekit-server-sdk');

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

// ── ICE servers (Xirsys STUN + TURN) ─────────────────────────────────────────
// Credentials fall back to the hardcoded Xirsys values; override via
// TURN_USERNAME / TURN_CREDENTIAL env vars to rotate without a code deploy.
function getIceServers() {
  const username   = process.env.TURN_USERNAME   || 'gerirankorbit';
  const credential = process.env.TURN_CREDENTIAL || '1495cc4e-5f75-11f1-82c8-0242ac140002';
  return [
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
      username,
      credential,
    },
  ];
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

  // ── Employee subscribing to the global notifications channel ───────────────
  // Required so the Electron app can receive server-pushed commands such as
  // 'force-reconnect' without a manager session cookie.
  if (employeeId && channel === 'private-screenshare-notifications') {
    try {
      const auth = pusher.authorizeChannel(socketId, channel);
      return res.json(auth);
    } catch (e) {
      console.error('[pusher-auth] authorizeChannel error (employee-notif):', e.message);
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

  // employeeName is optional metadata used for manager-side auto-discovery
  const { employeeId, employeeName, event, data = {} } = req.body;

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

    // Broadcast presence changes to the manager notification channel so the
    // manager portal can auto-discover employees without manual configuration.
    // Fire-and-forget — don't let a secondary trigger failure block the response.
    if (event === 'screenshare-offer') {
      pusher.trigger('private-screenshare-notifications', 'employee-online', {
        employeeId,
        employeeName: employeeName || employeeId,
      }).catch(e => console.warn('[screenshare/signal] notifications trigger failed:', e.message));
    } else if (event === 'screenshare-stopped') {
      pusher.trigger('private-screenshare-notifications', 'employee-offline', {
        employeeId,
      }).catch(e => console.warn('[screenshare/signal] notifications trigger failed:', e.message));
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('[screenshare/signal] Pusher error:', err.message);
    return res.status(500).json({ error: 'Pusher trigger failed', detail: err.message });
  }
});

// ── POST /api/screenshare/status ─────────────────────────────────────────────
// Lightweight notification from the Electron app: employee screen locked or
// unlocked. No auth required (same as the employee token route).
// Broadcasts employee-locked / employee-unlocked on the notifications channel
// so the manager portal can show / hide the lock overlay in real time.
router.post('/status', async (req, res) => {
  const pusher = getPusher();
  if (!pusher) return res.status(500).json({ error: 'Pusher not configured' });

  const { employeeId, status } = req.body || {};
  if (!employeeId || !['locked', 'unlocked'].includes(status))
    return res.status(400).json({ error: 'employeeId and status (locked|unlocked) required' });

  const event = status === 'locked' ? 'employee-locked' : 'employee-unlocked';
  try {
    await pusher.trigger('private-screenshare-notifications', event, { employeeId });
    return res.json({ success: true });
  } catch (err) {
    console.error('[screenshare/status] Pusher error:', err.message);
    return res.status(500).json({ error: 'Pusher trigger failed' });
  }
});

// ── POST /api/screenshare/force-reconnect ────────────────────────────────────
// Manager-only: silently triggers a reconnect on the target employee's
// Electron app via a Pusher event. The employee sees zero UI change.
router.post('/force-reconnect', async (req, res) => {
  const pusher = getPusher();
  if (!pusher) return res.status(500).json({ error: 'Pusher not configured' });

  if (!req.session?.username ||
      (req.session.role !== 'manager' && req.session.role !== 'assistant')) {
    return res.status(403).json({ error: 'Manager session required' });
  }

  const { employeeId } = req.body || {};
  if (!employeeId || typeof employeeId !== 'string' || !employeeId.trim()) {
    return res.status(400).json({ error: 'employeeId required' });
  }

  try {
    await pusher.trigger('private-screenshare-notifications', 'force-reconnect', {
      employeeId: employeeId.trim(),
    });
    console.log(`[screenshare/force-reconnect] triggered for ${employeeId} by ${req.session.username}`);
    return res.json({ success: true });
  } catch (err) {
    console.error('[screenshare/force-reconnect] Pusher error:', err.message);
    return res.status(500).json({ error: 'Pusher trigger failed' });
  }
});

// ── POST /api/screenshare/token ───────────────────────────────────────────────
// Issues a short-lived LiveKit JWT for the given role.
//
//   Employee (Electron, no session)
//     body: { role: 'employee', employeeId: '<id>', employeeName?: '<name>' }
//     → canPublish: true,  canSubscribe: false, identity: employeeId
//
//   Manager (browser, session required)
//     body: { role: 'manager', employeeId: '<id>' }
//     → canPublish: false, canSubscribe: true,  identity: session username
//
//   Room name for both: "screenshare-{employeeId}"
//   TTL: 4 h (covers a full work shift; refresh by calling again)
//
router.post('/token', async (req, res) => {
  const apiKey    = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    console.error('[livekit/token] Missing LIVEKIT_API_KEY or LIVEKIT_API_SECRET');
    return res.status(500).json({ error: 'LiveKit not configured on server' });
  }

  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'JSON body required' });
  }

  const { role, employeeId, employeeName } = req.body;

  if (!employeeId || typeof employeeId !== 'string' || !employeeId.trim()) {
    return res.status(400).json({ error: 'employeeId is required' });
  }

  const room = `screenshare-${employeeId.trim()}`;

  // ── Employee path (Electron — no session) ────────────────────────────────
  if (role === 'employee') {
    const token = new AccessToken(apiKey, apiSecret, {
      identity: employeeId.trim(),
      name:     employeeName || employeeId.trim(),
      ttl:      '4h',
    });
    token.addGrant({
      roomJoin:     true,
      room,
      canPublish:   true,
      canSubscribe: false,
    });
    try {
      return res.json({
        token:      await token.toJwt(),
        room,
        livekitUrl: process.env.LIVEKIT_URL || '',
      });
    } catch (e) {
      console.error('[livekit/token] employee sign error:', e.message);
      return res.status(500).json({ error: 'Token signing failed' });
    }
  }

  // ── Manager path (browser — session required) ─────────────────────────────
  if (role === 'manager') {
    if (!req.session?.username ||
        (req.session.role !== 'manager' && req.session.role !== 'assistant')) {
      return res.status(403).json({ error: 'Manager session required' });
    }
    const token = new AccessToken(apiKey, apiSecret, {
      identity: req.session.username,
      name:     req.session.username,
      ttl:      '4h',
    });
    token.addGrant({
      roomJoin:     true,
      room,
      canPublish:   false,
      canSubscribe: true,
    });
    try {
      return res.json({
        token:      await token.toJwt(),
        room,
        livekitUrl: process.env.LIVEKIT_URL || '',
      });
    } catch (e) {
      console.error('[livekit/token] manager sign error:', e.message);
      return res.status(500).json({ error: 'Token signing failed' });
    }
  }

  return res.status(400).json({ error: 'role must be "employee" or "manager"' });
});

module.exports = router;
