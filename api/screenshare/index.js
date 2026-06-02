'use strict';
const express = require('express');
const router  = express.Router();
const Pusher  = require('pusher');

const pusher = new Pusher({
  appId:   process.env.PUSHER_APP_ID,
  key:     process.env.PUSHER_KEY,
  secret:  process.env.PUSHER_SECRET,
  cluster: process.env.PUSHER_CLUSTER,
  useTLS:  true,
});

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
//            (wildcard + credentials is invalid per CORS spec and rejected by
//            Electron's renderer security even with webSecurity:false)
// /pusher-auth → reflects origin + credentials so manager session cookie works
router.use((req, res, next) => {
  if (req.path === '/config' || req.path === '/config/') {
    res.header('Access-Control-Allow-Origin',  '*');
    res.header('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  } else {
    // pusher-auth and any future credentialed routes
    const origin = req.headers.origin || '*';
    res.header('Access-Control-Allow-Origin',      origin);
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Methods',     'POST,OPTIONS');
    res.header('Access-Control-Allow-Headers',     'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── GET /api/screenshare/config ───────────────────────────────────────────────
// Fully public — returns Pusher key/cluster + ICE servers.
// No secrets. Safe for Electron (file:// origin) and unauthenticated browsers.
router.get('/config', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*'); // belt-and-suspenders on the route itself
  res.json({
    pusherKey:     process.env.PUSHER_KEY,
    pusherCluster: process.env.PUSHER_CLUSTER,
    iceServers:    getIceServers(),
  });
});

// ── POST /api/screenshare/pusher-auth ─────────────────────────────────────────
// Authenticates Pusher private-screenshare-{id} channels.
//
//   Manager path  — session present + role manager/assistant
//                   → authorised to subscribe to any private-screenshare-* channel
//
//   Employee path — no session; must send employeeId in body / query
//                   → authorised only for private-screenshare-{employeeId}
//
router.post('/pusher-auth', (req, res) => {
  const socketId   = req.body.socket_id;
  const channel    = req.body.channel_name;

  if (!socketId || !channel) {
    return res.status(400).json({ error: 'socket_id and channel_name required' });
  }

  // Channel must be one of our screenshare channels
  if (!channel.startsWith('private-screenshare-')) {
    return res.status(403).json({ error: 'Forbidden channel' });
  }

  // ── Manager/assistant via session ─────────────────────────────────────────
  if (req.session && req.session.username &&
      (req.session.role === 'manager' || req.session.role === 'assistant')) {
    const auth = pusher.authorizeChannel(socketId, channel);
    return res.json(auth);
  }

  // ── Employee via employeeId param (Electron — no session) ─────────────────
  const employeeId = (req.body.employeeId || req.query.employeeId || '').trim();
  if (employeeId && channel === `private-screenshare-${employeeId}`) {
    const auth = pusher.authorizeChannel(socketId, channel);
    return res.json(auth);
  }

  return res.status(403).json({ error: 'Not authorised' });
});

module.exports = router;
