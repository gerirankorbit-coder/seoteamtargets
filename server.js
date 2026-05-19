require('dotenv').config();
const mongoose = require('mongoose');
const express  = require('express');
const session  = require('express-session');
const path     = require('path');
const cors     = require('cors');
const os       = require('os');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── MongoDB connection ─────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✓ MongoDB connected'))
  .catch(err => console.error('✗ MongoDB error:', err));

// ── Schemas ────────────────────────────────────────────────────────────────
// One document per (username + date) — tasks stored as Mixed to preserve
// all field shapes (rows/value/text/links/sectionNote) without migration.
const EntrySchema = new mongoose.Schema({
  username: { type: String, required: true },
  date:     { type: String, required: true },
  tasks:    { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });
EntrySchema.index({ username: 1, date: 1 }, { unique: true });
const Entry = mongoose.model('Entry', EntrySchema);

// Config collection stores task overrides and any future app-wide settings.
const ConfigSchema = new mongoose.Schema({
  key:   { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed },
});
const Config = mongoose.model('Config', ConfigSchema);

// ── Task-override cache (loaded from DB on startup) ────────────────────────
let taskOverrides = {};
mongoose.connection.once('open', async () => {
  try {
    const doc = await Config.findOne({ key: 'taskOverrides' });
    if (doc) taskOverrides = doc.value || {};
  } catch (_) {}
});

// ── Credentials ────────────────────────────────────────────────────────────
const USERS = {
  "manager":        { password: "mgr2024",   role: "manager",   display: "Manager" },
  "assistant":      { password: "asst2024",  role: "assistant", display: "Assistant" },
  "ali.lodhi":      { password: "ali123",    role: "member",    display: "Ali Lodhi" },
  "abida.khalid":   { password: "abida123",  role: "member",    display: "Abida Khalid" },
  "syed.salman":    { password: "salman123", role: "member",    display: "Syed Salman Ali" },
  "usman.tariq":    { password: "usman123",  role: "member",    display: "Usman Tariq" },
  "abdullah.asif":  { password: "asif123",   role: "member",    display: "Abdullah Asif" },
  "abdullah.gull":  { password: "gull123",   role: "member",    display: "Abdullah Gull" },
  "rizwan.haider":  { password: "rizwan123", role: "member",    display: "Rizwan Haider" },
  "haseeb.ahmed":   { password: "haseeb123", role: "member",    display: "Haseeb Ahmed" },
  "sana.effat":     { password: "sana123",   role: "member",    display: "Sana Effat" },
  "m.kashif":       { password: "kashif123", role: "member",    display: "Muhammad Kashif" },
  "sajid.saleem":   { password: "sajid123",  role: "member",    display: "Sajid Saleem" },
  "toseef.ahmed":   { password: "toseef123", role: "member",    display: "Toseef Ahmed" },
  "ahmad.rehman":   { password: "ahmad123",  role: "member",    display: "Ahmad Rehman" },
  "naveed.liaqat":  { password: "naveed123", role: "member",    display: "Naveed Liaqat" },
  "abler.khan":     { password: "abler123",  role: "member",    display: "Abler Khan" },
  "ali.raza":       { password: "raza123",   role: "member",    display: "Ali Raza" },
};

// ── Team task definitions ──────────────────────────────────────────────────
const TEAM = {
  "Ali Lodhi": [
    { name: "Geo Fencing",       type: "layers",     label: "Layers" },
    { name: "GEO Tagging",       type: "count",      label: "Tagged" },
    { name: "Guest Posting",     type: "links",      label: "Links" },
    { name: "Reddit Accounts",   type: "count",      label: "Accounts" },
    { name: "Cloud Stacking",    type: "layers",     label: "Layers" },
    { name: "Pinterest Working", type: "links_note", label: "Links" },
    { name: "Web Working",       type: "note",       label: "Notes" },
  ],
  "Abida Khalid": [
    { name: "Web 2.0 Sites Building", type: "count",      label: "Sites" },
    { name: "Web 2.0 Blogs",          type: "links",      label: "Links" },
    { name: "Reddit",                 type: "links_note", label: "Links" },
  ],
  "Syed Salman Ali": [
    { name: "Citations",          type: "count",      label: "Citations" },
    { name: "PDF",                type: "links",      label: "Links" },
    { name: "Social Bookmarking", type: "links",      label: "Links" },
    { name: "Linktree",           type: "count_note", label: "Count" },
    { name: "Reddit Accounts",    type: "count",      label: "Accounts" },
  ],
  "Usman Tariq": [
    { name: "Web 2.0 Blogs",               type: "links", label: "Links" },
    { name: "Guest Posting",               type: "links", label: "Links" },
    { name: "Guest Posting Sites Finding", type: "count", label: "Sites" },
    { name: "Reddit Accounts",             type: "count", label: "Accounts" },
  ],
  "Abdullah Asif": [
    { name: "Guest Posting", type: "links", label: "Links" },
  ],
  "Abdullah Gull": [
    { name: "Video Submission",  type: "count",      label: "Videos" },
    { name: "Audio Submission",  type: "count",      label: "Files" },
    { name: "Google Properties", type: "count_note", label: "Count" },
    { name: "Google Stacking",   type: "layers",     label: "Layers" },
    { name: "Quora",             type: "links_note", label: "Links" },
    { name: "Image Submission",  type: "count",      label: "Images" },
    { name: "Reddit Accounts",   type: "count",      label: "Accounts" },
    { name: "Google Site Blogs", type: "links",      label: "Links" },
    { name: "Profiles",          type: "count",      label: "Profiles" },
  ],
  "Rizwan Haider": [
    { name: "Audio Submission",   type: "count", label: "Files" },
    { name: "Image Submission",   type: "count", label: "Images" },
    { name: "Profile Submission", type: "count", label: "Profiles" },
  ],
  "Haseeb Ahmed": [
    { name: "GMBS",           type: "count",      label: "GMBs" },
    { name: "Blogs",          type: "links",      label: "Links" },
    { name: "Website Copies", type: "count_note", label: "Count" },
  ],
  "Sana Effat": [
    { name: "Blogs",           type: "links", label: "Links" },
    { name: "Website Content", type: "note",  label: "Notes" },
  ],
  "Muhammad Kashif": [
    { name: "Citations",       type: "count", label: "Citations" },
    { name: "Profile",         type: "count", label: "Profiles" },
    { name: "Reddit Accounts", type: "count", label: "Accounts" },
    { name: "PDF",             type: "links", label: "Links" },
  ],
  "Sajid Saleem": [
    { name: "Client Working Cross Check and Update", type: "note", label: "Notes" },
  ],
  "Toseef Ahmed": [
    { name: "GMB Posting",  type: "count",      label: "Posts" },
    { name: "GMB Designs",  type: "count",      label: "Designs" },
    { name: "GMB Audits",   type: "count_note", label: "Audits" },
    { name: "Pinterest",    type: "count",      label: "Pins" },
    { name: "BD/PD",        type: "note",       label: "Notes" },
  ],
  "Ahmad Rehman": [
    { name: "Console/Site Check",        type: "note",       label: "Notes" },
    { name: "Blogs Published",           type: "links",      label: "Links" },
    { name: "Keywords Tracking",         type: "count",      label: "Keywords" },
    { name: "Keywords Finding",          type: "count",      label: "Keywords" },
    { name: "Reddit Accounts",           type: "count",      label: "Accounts" },
    { name: "Technical Working Console", type: "note",       label: "Notes" },
    { name: "Links Inspections",         type: "count",      label: "Links" },
    { name: "Image Creation",            type: "count",      label: "Images" },
    { name: "Schema",                    type: "count_note", label: "Count" },
    { name: "Console Report",            type: "note",       label: "Notes" },
    { name: "GA4",                       type: "note",       label: "Notes" },
    { name: "GTM",                       type: "note",       label: "Notes" },
  ],
  "Naveed Liaqat": [
    { name: "Blogs Research",        type: "note",       label: "Notes" },
    { name: "Keywords for Websites", type: "count",      label: "Keywords" },
    { name: "Guest Posting",         type: "links",      label: "Links" },
    { name: "Reddit",                type: "links_note", label: "Links" },
    { name: "Blog Upload",           type: "count",      label: "Blogs" },
    { name: "Schema Working",        type: "count_note", label: "Count" },
  ],
  "Abler Khan": [
    { name: "Contextual Links",                 type: "links",      label: "Links" },
    { name: "Profiles",                         type: "count",      label: "Profiles" },
    { name: "Citations",                        type: "count",      label: "Citations" },
    { name: "Directories",                      type: "count",      label: "Dirs" },
    { name: "Multiple Sites CK for GP and PRs", type: "note",       label: "Notes" },
    { name: "Pinterest",                        type: "count",      label: "Pins" },
    { name: "Reddit Accounts",                  type: "count",      label: "Accounts" },
    { name: "Press Release",                    type: "links",      label: "Links" },
    { name: "Web 2.0",                          type: "links",      label: "Links" },
    { name: "Guest Post",                       type: "links",      label: "Links" },
    { name: "SBM",                              type: "count",      label: "Count" },
    { name: "Websites Reports",                 type: "note",       label: "Notes" },
  ],
  "Ali Raza": [
    { name: "Profiles",           type: "count",      label: "Profiles" },
    { name: "Guest Posting",      type: "links",      label: "Links" },
    { name: "Image Submission",   type: "count",      label: "Images" },
    { name: "PDF Submission",     type: "links",      label: "Links" },
    { name: "Social Bookmarking", type: "links",      label: "Links" },
    { name: "Reddit",             type: "links_note", label: "Links" },
    { name: "Sites Finding",      type: "count",      label: "Sites" },
    { name: "Pinterest",          type: "count",      label: "Pins" },
  ],
};

function getMemberTasks(displayName) {
  return taskOverrides[displayName] || TEAM[displayName] || [];
}

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces))
    for (const iface of ifaces[name])
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
  return 'localhost';
}

// ── Middleware ─────────────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'gmb-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure:  process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge:   8 * 60 * 60 * 1000,
  },
}));

// ── Static assets ─────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Public routes ──────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (req.session.role === 'manager' || req.session.role === 'assistant') return res.redirect('/dashboard');
  if (req.session.role === 'member') return res.redirect('/member');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login', (req, res) => {
  if (req.session.role === 'manager' || req.session.role === 'assistant') return res.redirect('/dashboard');
  if (req.session.role === 'member') return res.redirect('/member');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials.' });
  const user = USERS[username.toLowerCase().trim()];
  if (!user || user.password !== password)
    return res.status(401).json({ error: 'Invalid username or password.' });
  req.session.username = username.toLowerCase().trim();
  req.session.role     = user.role;
  req.session.display  = user.display;
  const redirect = (user.role === 'manager' || user.role === 'assistant') ? '/dashboard' : '/member';
  res.json({ success: true, redirect });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {});
  res.json({ success: true });
});

// ── Auth middleware ────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.role) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
    return res.redirect('/login');
  }
  next();
}

function requireManager(req, res, next) {
  if (req.session.role !== 'manager' && req.session.role !== 'assistant') {
    if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Insufficient permissions' });
    return res.redirect('/member');
  }
  next();
}

app.use(requireAuth);

// ── Protected page routes ──────────────────────────────────────────────────
app.get('/member', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'member.html')));

app.get('/dashboard', requireManager, (req, res) => {
  if (req.session.role !== 'manager' && req.session.role !== 'assistant') {
    return res.redirect('/member');
  }
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ── Protected API routes ───────────────────────────────────────────────────

app.get('/api/me', (req, res) => {
  const tasks = getMemberTasks(req.session.display);
  res.json({ username: req.session.username, display: req.session.display, role: req.session.role, tasks });
});

// Save all tasks for a given date (one document per username+date)
app.post('/api/save', async (req, res) => {
  const { date, tasks } = req.body;
  if (!date || !tasks) return res.status(400).json({ error: 'Missing required fields' });
  try {
    await Entry.findOneAndUpdate(
      { username: req.session.username, date },
      { username: req.session.username, date, tasks },
      { upsert: true, new: true }
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Save error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Fetch the current user's tasks for a specific date
app.get('/api/mydata/:date', async (req, res) => {
  try {
    const entry = await Entry.findOne(
      { username: req.session.username, date: req.params.date },
      { tasks: 1, _id: 0 }
    );
    res.json(entry ? (entry.tasks || {}) : {});
  } catch (_) {
    res.json({});
  }
});

// Fetch all dates for a specific username (members: own only; managers: any)
app.get('/api/data/:username', async (req, res) => {
  const target = req.params.username;
  if (req.session.role === 'member' && req.session.username !== target) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const entries = await Entry.find({ username: target }, { date: 1, tasks: 1, _id: 0 });
    const result  = {};
    entries.forEach(e => { result[e.date] = e.tasks; });
    res.json(result);
  } catch (_) {
    res.json({});
  }
});

// Fetch everything — returns same shape as before: { username: { date: tasks } }
app.get('/api/all', requireManager, async (req, res) => {
  try {
    const entries = await Entry.find({}, { username: 1, date: 1, tasks: 1, _id: 0 });
    const result  = {};
    entries.forEach(e => {
      if (!result[e.username]) result[e.username] = {};
      result[e.username][e.date] = e.tasks;
    });
    res.json(result);
  } catch (_) {
    res.json({});
  }
});

app.get('/api/members', requireManager, (req, res) => {
  const members = Object.entries(USERS)
    .filter(([, u]) => u.role === 'member')
    .map(([username, u]) => ({ username, display: u.display, tasks: getMemberTasks(u.display) }));
  res.json(members);
});

// Save task overrides for a member (persists to Config collection)
app.post('/api/tasks/:displayName', requireManager, async (req, res) => {
  const { tasks } = req.body;
  if (!Array.isArray(tasks)) return res.status(400).json({ error: 'tasks must be an array' });
  const displayName = decodeURIComponent(req.params.displayName);
  if (!TEAM[displayName]) return res.status(404).json({ error: 'Member not found' });
  try {
    taskOverrides[displayName] = tasks;
    await Config.findOneAndUpdate(
      { key: 'taskOverrides' },
      { key: 'taskOverrides', value: taskOverrides },
      { upsert: true, new: true }
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Task override save error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Reset task overrides to default for a member
app.delete('/api/tasks/:displayName', requireManager, async (req, res) => {
  const displayName = decodeURIComponent(req.params.displayName);
  try {
    delete taskOverrides[displayName];
    await Config.findOneAndUpdate(
      { key: 'taskOverrides' },
      { key: 'taskOverrides', value: taskOverrides },
      { upsert: true, new: true }
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Task override delete error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    const ip  = getLocalIP();
    const pad = s => s.padEnd(43);
    console.log('');
    console.log('  ┌─────────────────────────────────────────────┐');
    console.log('  │       Rank Orbit — SEO Team Progress        │');
    console.log('  ├─────────────────────────────────────────────┤');
    console.log(`  │  ${pad('Landing   : http://' + ip + ':' + PORT)}│`);
    console.log(`  │  ${pad('Dashboard : http://' + ip + ':' + PORT + '/dashboard')}│`);
    console.log(`  │  ${pad('Member    : http://' + ip + ':' + PORT + '/member')}│`);
    console.log('  ├─────────────────────────────────────────────┤');
    console.log(`  │  ${pad('manager  / mgr2024   → Dashboard')}│`);
    console.log(`  │  ${pad('assistant/ asst2024  → Dashboard')}│`);
    console.log(`  │  ${pad('ali.lodhi/ ali123    → Member Portal')}│`);
    console.log('  └─────────────────────────────────────────────┘');
    console.log('');
  });
}

module.exports = app;
