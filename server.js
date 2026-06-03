require('dotenv').config();
const mongoose = require('mongoose');
const express  = require('express');
const session  = require('express-session');
const MongoStore = require('connect-mongo')(session);
const path     = require('path');
const cors     = require('cors');
const os       = require('os');

const Pusher = require('pusher');
const pusher = new Pusher({
  appId:   process.env.PUSHER_APP_ID,
  key:     process.env.PUSHER_KEY,
  secret:  process.env.PUSHER_SECRET,
  cluster: process.env.PUSHER_CLUSTER,
  useTLS:  true,
});

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
const Entry = mongoose.models.Entry || mongoose.model('Entry', EntrySchema);

// Config collection stores task overrides and any future app-wide settings.
const ConfigSchema = new mongoose.Schema({
  key:   { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed },
});
const Config = mongoose.models.Config || mongoose.model('Config', ConfigSchema);

// User schema — persistent accounts, seeded from USERS on first run
const UserSchema = new mongoose.Schema({
  username:        { type: String, required: true, unique: true },
  password:        { type: String, required: true },
  role:            { type: String, required: true },
  display:         { type: String, required: true },
  passwordVersion: { type: Number, default: 1 },
});
const User = mongoose.models.User || mongoose.model('User', UserSchema);

// Attendance — one record per (username + date)
const AttendanceSchema = new mongoose.Schema({
  username:             { type: String, required: true },
  date:                 { type: String, required: true }, // YYYY-MM-DD
  workMode:             { type: String, enum: ['WFH', 'WFO'] },
  startTime:            { type: String }, // "HH:MM"
  endTime:              { type: String }, // "HH:MM"
  sessions:             [{ startTime: String, endTime: String, workMode: String }],
  note:                 { type: String, default: '' },
  checkOuts:            [{ outTime: String, inTime: String }],
  totalCheckOutMinutes: { type: Number, default: 0 },
  totalWorkingMinutes:  { type: Number, default: 0 },
  editHistory: [{
    field:    String,
    oldValue: String,
    newValue: String,
    editedBy: String,
    editedAt: { type: Date, default: Date.now },
  }],
}, { timestamps: true });
AttendanceSchema.index({ username: 1, date: 1 }, { unique: true });
const Attendance = mongoose.models.Attendance || mongoose.model('Attendance', AttendanceSchema);

// ── In-memory caches (loaded from DB on startup) ──────────────────────────
let taskOverrides     = {};
let passwordOverrides = {}; // loaded for initial seed merge only
let usersCache        = {}; // { username: { password, role, display, passwordVersion } }

mongoose.connection.once('open', async () => {
  try {
    // Load Config documents
    const [taskDoc, pwDoc] = await Promise.all([
      Config.findOne({ key: 'taskOverrides' }),
      Config.findOne({ key: 'passwordOverrides' }),
    ]);
    if (taskDoc) taskOverrides     = taskDoc.value || {};
    if (pwDoc)   passwordOverrides = pwDoc.value   || {};

    // Upsert every USERS entry into MongoDB on every startup.
    // $setOnInsert: only writes when the document is brand-new (upsert insert path),
    // so manually-changed passwords (passwordVersion > 1) are never overwritten.
    // For existing docs with passwordVersion === 1 (still at default), we also
    // force-sync the password so a stale/empty DB is always corrected.
    const upsertOps = Object.entries(USERS).map(([username, data]) => {
      const ov = passwordOverrides[username] || {};
      const pw = ov.password || data.password;
      const pv = ov.passwordVersion || data.passwordVersion || 1;
      return {
        updateOne: {
          filter: { username, passwordVersion: { $lte: 1 } }, // only touch default-password docs
          update: {
            $set: {
              password:        pw,
              role:            data.role,
              display:         data.display,
              passwordVersion: pv,
            },
            $setOnInsert: { username },
          },
          upsert: true,
        },
      };
    });
    const bulkResult = await User.bulkWrite(upsertOps, { ordered: false });
    console.log(`✓ Users synced — upserted: ${bulkResult.upsertedCount}, modified: ${bulkResult.modifiedCount}`);

    // Load all users into in-memory cache
    const allUsers = await User.find(
      {},
      { _id: 0, username: 1, password: 1, role: 1, display: 1, passwordVersion: 1 }
    );
    usersCache = {};
    allUsers.forEach(u => {
      usersCache[u.username] = {
        password:        u.password,
        role:            u.role,
        display:         u.display,
        passwordVersion: u.passwordVersion,
      };
    });
    console.log('✓ Loaded', Object.keys(usersCache).length, 'users into cache');

    // Feature 6: Ensure manager display name is "Abdullah Saleem" (migration for existing DBs)
    const managerDoc = await User.findOne({ username: 'manager' });
    if (managerDoc && managerDoc.display !== 'Abdullah Saleem') {
      await User.updateOne({ username: 'manager' }, { $set: { display: 'Abdullah Saleem' } });
      if (usersCache['manager']) usersCache['manager'].display = 'Abdullah Saleem';
      console.log('✓ Migrated manager display name to Abdullah Saleem');
    }
  } catch (err) {
    console.error('Startup error:', err);
  }
});

// ── Credentials ────────────────────────────────────────────────────────────
// passwordVersion: 1 is the baseline. Incrementing it (via change-password API)
// invalidates all existing sessions for that user immediately.
const USERS = {
  "manager":        { password: "mgr2024",       role: "manager",   display: "Abdullah Saleem",   passwordVersion: 1 },
  "assistant":      { password: "asst2024",       role: "assistant", display: "Assistant",         passwordVersion: 1 },
  "ali.lodhi":      { password: "ali@123#RO",     role: "member",    display: "Ali Lodhi",         passwordVersion: 1 },
  "abida.khalid":   { password: "abida@123#RO",   role: "member",    display: "Abida Khalid",      passwordVersion: 1 },
  "syed.salman":    { password: "salman@123#RO",  role: "member",    display: "Syed Salman Ali",   passwordVersion: 1 },
  "usman.tariq":    { password: "usman@123#RO",   role: "member",    display: "Usman Tariq",       passwordVersion: 1 },
  "abdullah.asif":  { password: "asif@123#RO",    role: "member",    display: "Abdullah Asif",     passwordVersion: 1 },
  "abdullah.gull":  { password: "gull@123#RO",    role: "member",    display: "Abdullah Gull",     passwordVersion: 1 },
  "rizwan.haider":  { password: "rizwan@123#RO",  role: "member",    display: "Rizwan Haider",     passwordVersion: 1 },
  "haseeb.ahmed":   { password: "haseeb@123#RO",  role: "member",    display: "Haseeb Ahmed",      passwordVersion: 1 },
  "sana.effat":     { password: "sana@123#RO",    role: "member",    display: "Sana Effat",        passwordVersion: 1 },
  "m.kashif":       { password: "kashif@123#RO",  role: "member",    display: "Muhammad Kashif",   passwordVersion: 1 },
  "sajid.saleem":   { password: "sajid@123#RO",   role: "member",    display: "Sajid Saleem",      passwordVersion: 1 },
  "toseef.ahmed":   { password: "toseef@123#RO",  role: "member",    display: "Toseef Ahmed",      passwordVersion: 1 },
  "ahmad.rehman":   { password: "ahmad@123#RO",   role: "member",    display: "Ahmad Rehman",      passwordVersion: 1 },
  "naveed.liaqat":  { password: "naveed@123#RO",  role: "member",    display: "Naveed Liaqat",     passwordVersion: 1 },
  "abler.khan":     { password: "abler@123#RO",   role: "member",    display: "Abler Khan",        passwordVersion: 1 },
  "ali.raza":       { password: "raza@123#RO",    role: "member",    display: "Ali Raza",          passwordVersion: 1 },
};

// User lookup — reads from in-memory cache (populated from MongoDB on startup)
function getUser(username) {
  const u = usersCache[username];
  return u ? { ...u } : null;
}

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
// /api/screenshare/* has its own per-route CORS (wildcard, no credentials).
// The global cors() must NOT run on those routes: reflecting Origin: null from
// Electron's file:// with credentials:true causes Chromium to block the response.
app.use((req, res, next) => {
  if (req.path.startsWith('/api/screenshare')) return next();
  cors({ origin: true, credentials: true })(req, res, next);
});
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // needed for Pusher auth (sends form-encoded body)
app.use(session({
  secret: process.env.SESSION_SECRET || 'gmb-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  store: new MongoStore({
    mongooseConnection: mongoose.connection,
  }),
  cookie: {
    secure:   process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge:   30 * 24 * 60 * 60 * 1000, // 30 days — persists across browser restarts
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

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials.' });
  const uname = username.toLowerCase().trim();

  // Primary: read from in-memory cache (populated from MongoDB on startup)
  let user = getUser(uname);

  // Fallback 1: cache not yet ready (cold-start race) — query MongoDB directly
  if (!user) {
    try {
      const dbUser = await User.findOne(
        { username: uname },
        { _id: 0, username: 1, password: 1, role: 1, display: 1, passwordVersion: 1 }
      );
      if (dbUser) {
        user = {
          password:        dbUser.password,
          role:            dbUser.role,
          display:         dbUser.display,
          passwordVersion: dbUser.passwordVersion || 1,
        };
      }
    } catch (err) {
      console.error('Login DB fallback error:', err);
      return res.status(500).json({ error: 'Server error. Please try again.' });
    }
  }

  // Fallback 2: hardcoded USERS object — canonical source of truth for default creds.
  // Covers edge case where DB credentials drifted from the defaults.
  if (!user || user.password !== password) {
    const hardcoded = USERS[uname];
    if (hardcoded && hardcoded.password === password) {
      user = {
        password:        hardcoded.password,
        role:            hardcoded.role,
        display:         hardcoded.display,
        passwordVersion: hardcoded.passwordVersion || 1,
      };
    }
  }

  if (!user || user.password !== password)
    return res.status(401).json({ error: 'Invalid username or password.' });

  req.session.username        = uname;
  req.session.role            = user.role;
  req.session.display         = user.display;
  req.session.passwordVersion = user.passwordVersion || 1;
  const redirect = (user.role === 'manager' || user.role === 'assistant') ? '/dashboard' : '/member';

  // Explicitly save session before responding — ensures it is persisted to
  // MongoDB *before* the client follows the redirect, preventing a race where
  // the next request arrives before the session store has written the record.
  req.session.save(saveErr => {
    if (saveErr) {
      console.error('Session save error:', saveErr);
      return res.status(500).json({ error: 'Login failed — session could not be saved. Please try again.' });
    }
    res.json({ success: true, redirect });
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {});
  res.json({ success: true });
});

// ── Public API routes (no auth required) ──────────────────────────────────
// Must be mounted BEFORE app.use(requireAuth) so Electron clients (no session)
// can reach /api/screenshare/config and /api/screenshare/pusher-auth freely.
app.use('/api/screenshare', require('./api/screenshare'));

// ── Auth middleware ────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.role) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
    return res.redirect('/login');
  }
  // Only enforce version check when cache is loaded AND user is found in it.
  // If cache is empty (cold-start) or user isn't in cache (edge case), skip
  // the version check entirely — don't destroy a valid session over a cache miss.
  if (Object.keys(usersCache).length > 0) {
    const currentUser = getUser(req.session.username);
    if (currentUser) {
      const currentVer = currentUser.passwordVersion || 1;
      const sessionVer = req.session.passwordVersion  || 1;
      if (sessionVer !== currentVer) {
        req.session.destroy(() => {});
        if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'password_changed' });
        return res.redirect('/login?reason=password_changed');
      }
    }
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

// Restrict to manager role only (assistants cannot add/remove members)
function requireManagerOnly(req, res, next) {
  if (req.session.role !== 'manager') {
    return res.status(403).json({ error: 'Only manager can perform this action' });
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

// Change a member's password — invalidates all their active sessions immediately
app.post('/api/admin/change-password', requireManager, async (req, res) => {
  const { username, newPassword } = req.body;
  if (!username || !newPassword) return res.status(400).json({ error: 'Missing fields' });
  if (newPassword.length < 6)    return res.status(400).json({ error: 'Password too short (min 6 chars)' });
  const target = username.toLowerCase().trim();
  if (!usersCache[target]) return res.status(404).json({ error: 'User not found' });
  const newVersion = Date.now();
  try {
    await User.findOneAndUpdate({ username: target }, { password: newPassword, passwordVersion: newVersion });
    usersCache[target] = { ...usersCache[target], password: newPassword, passwordVersion: newVersion };
    res.json({ success: true });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Manager: save / override any member's submitted data for a date
app.post('/api/manager-save/:username', requireManager, async (req, res) => {
  const { date, tasks } = req.body;
  const target = req.params.username;
  if (!date || !tasks) return res.status(400).json({ error: 'Missing fields' });
  try {
    await Entry.findOneAndUpdate(
      { username: target, date },
      { username: target, date, tasks },
      { upsert: true, new: true }
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Manager save error:', err);
    res.status(500).json({ error: 'Database error' });
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
  // Build member list from the hardcoded USERS object (always available, never
  // dependent on MongoDB being loaded) then layer in any dynamically-added
  // members that exist in usersCache but not in USERS (added via /api/admin/members).
  const seen    = new Set();
  const members = [];

  // 1. Hardcoded members (source of truth for the permanent team)
  Object.entries(USERS)
    .filter(([, u]) => u.role === 'member')
    .forEach(([username, u]) => {
      seen.add(username);
      // Prefer cache version if available (may have updated display/password)
      const cached = usersCache[username];
      const display = (cached && cached.display) || u.display;
      members.push({ username, display, tasks: getMemberTasks(display) });
    });

  // 2. Dynamically-added members (only in MongoDB / usersCache, not in USERS)
  Object.entries(usersCache)
    .filter(([username, u]) => u.role === 'member' && !seen.has(username))
    .forEach(([username, u]) => {
      members.push({ username, display: u.display, tasks: getMemberTasks(u.display) });
    });

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

// Save data for any member — used by manager to edit submitted entries
app.post('/api/admin/save', requireManager, async (req, res) => {
  const { username, date, tasks } = req.body;
  if (!username || !date || !tasks) return res.status(400).json({ error: 'Missing fields' });
  const target = username.toLowerCase().trim();
  if (!usersCache[target]) return res.status(404).json({ error: 'User not found' });
  try {
    await Entry.findOneAndUpdate(
      { username: target, date },
      { username: target, date, tasks },
      { upsert: true, new: true }
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Admin save error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Add a new member (manager only)
app.post('/api/admin/members', requireManagerOnly, async (req, res) => {
  let { username, password, role, display } = req.body;
  if (!username || !password || !display) return res.status(400).json({ error: 'Missing required fields' });
  if (password.length < 6) return res.status(400).json({ error: 'Password too short (min 6 chars)' });
  const uname = username.toLowerCase().trim();
  const dname = display.trim();
  if (!uname) return res.status(400).json({ error: 'Invalid username' });
  if (usersCache[uname]) return res.status(409).json({ error: 'Username already exists' });
  const validRoles = ['member', 'assistant'];
  const userRole = validRoles.includes(role) ? role : 'member';
  try {
    await User.create({ username: uname, password, role: userRole, display: dname, passwordVersion: 1 });
    usersCache[uname] = { password, role: userRole, display: dname, passwordVersion: 1 };
    res.json({ success: true, username: uname, display: dname, role: userRole });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Username already exists' });
    console.error('Add member error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Remove a member (manager only)
app.delete('/api/admin/members/:username', requireManagerOnly, async (req, res) => {
  const target = req.params.username.toLowerCase().trim();
  const user   = usersCache[target];
  if (!user)               return res.status(404).json({ error: 'User not found' });
  if (user.role === 'manager') return res.status(403).json({ error: 'Cannot remove manager accounts' });
  try {
    await User.deleteOne({ username: target });
    delete usersCache[target];
    res.json({ success: true });
  } catch (err) {
    console.error('Remove member error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Attendance helpers ─────────────────────────────────────────────────────
function currentTimeStr() {
  const now = new Date();
  return String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
}

function timeToMinutes(timeStr) {
  if (!timeStr) return 0;
  const [h, m] = timeStr.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

// Duration between two HH:MM strings — handles midnight crossing automatically
function timeDiffMins(startStr, endStr) {
  if (!startStr || !endStr) return 0;
  let s = timeToMinutes(startStr);
  let e = timeToMinutes(endStr);
  if (e < s) e += 24 * 60; // end is next day (e.g. 23:00 → 01:00)
  return Math.max(0, e - s);
}

// Recalculate totalWorkingMinutes accounting for sessions and breaks
function recalcWorkMins(record) {
  const sessions = record.sessions || [];
  if (sessions.length > 0) {
    let total = 0;
    sessions.forEach(s => {
      if (s.startTime && s.endTime)
        total += timeDiffMins(s.startTime, s.endTime);
    });
    record.totalWorkingMinutes = Math.max(0, total - (record.totalCheckOutMinutes || 0));
  } else if (record.startTime && record.endTime) {
    const rawMins = timeDiffMins(record.startTime, record.endTime);
    record.totalWorkingMinutes = Math.max(0, rawMins - (record.totalCheckOutMinutes || 0));
  }
}

// ── Attendance routes ──────────────────────────────────────────────────────

// POST /api/attendance/start — start a working session (supports multiple sessions per day)
app.post('/api/attendance/start', async (req, res) => {
  const { workMode, time, date: reqDate } = req.body;
  if (!workMode || !['WFH', 'WFO'].includes(workMode))
    return res.status(400).json({ error: 'workMode must be WFH or WFO' });
  // Feature 3: accept date from client for night-shift support; default to today
  const date      = (reqDate && /^\d{4}-\d{2}-\d{2}$/.test(reqDate)) ? reqDate : new Date().toISOString().split('T')[0];
  const startTime = time || currentTimeStr();
  try {
    const existing = await Attendance.findOne({ username: req.session.username, date });
    // Allow multiple sessions — never block a new start (each session is independent)
    const isFirst = !existing || !existing.startTime;
    const update  = {
      $push:        { sessions: { startTime, endTime: '', workMode } },
      $setOnInsert: { username: req.session.username, date },
    };
    // First session of the day — also set root fields for backward compat
    if (isFirst) update.$set = { workMode, startTime };
    const record = await Attendance.findOneAndUpdate(
      { username: req.session.username, date },
      update,
      { upsert: true, new: true }
    );
    res.json({ success: true, record });
  } catch (err) {
    console.error('Attendance start error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/attendance/end — end the current active session
app.post('/api/attendance/end', async (req, res) => {
  const { time, date: reqDate } = req.body;
  const date    = (reqDate && /^\d{4}-\d{2}-\d{2}$/.test(reqDate)) ? reqDate : new Date().toISOString().split('T')[0];
  const endTime = time || currentTimeStr();
  try {
    const record = await Attendance.findOne({ username: req.session.username, date });
    if (!record) return res.status(400).json({ error: 'No attendance record found for that date' });
    const sessions = record.sessions || [];
    if (sessions.length > 0) {
      // Multi-session mode: end the last open session
      let openIdx = -1;
      for (let i = sessions.length - 1; i >= 0; i--) {
        if (sessions[i].startTime && !sessions[i].endTime) { openIdx = i; break; }
      }
      if (openIdx === -1) return res.json({ success: true, record, message: 'no active session' });
      sessions[openIdx].endTime = endTime;
      record.sessions = sessions;
      record.markModified('sessions');
      record.endTime  = endTime; // backward compat
      recalcWorkMins(record);
    } else {
      // Legacy single-session mode (records created before multi-session)
      if (!record.startTime) return res.status(400).json({ error: 'No start time found' });
      if (record.endTime)    return res.json({ success: true, record, message: 'session already ended' });
      record.endTime = endTime;
      recalcWorkMins(record);
    }
    await record.save();
    res.json({ success: true, record });
  } catch (err) {
    console.error('Attendance end error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/attendance/checkout — take a break
app.post('/api/attendance/checkout', async (req, res) => {
  const { time, date: reqDate } = req.body;
  const date    = (reqDate && /^\d{4}-\d{2}-\d{2}$/.test(reqDate)) ? reqDate : new Date().toISOString().split('T')[0];
  const outTime = time || currentTimeStr();
  try {
    const record = await Attendance.findOne({ username: req.session.username, date });
    if (!record || !record.startTime)
      return res.status(400).json({ error: 'Not working yet' });
    if (record.endTime)
      return res.status(400).json({ error: 'Work session already ended' });
    const openCheckout = (record.checkOuts || []).find(co => co.outTime && !co.inTime);
    if (openCheckout)
      return res.status(400).json({ error: 'Already checked out — check in first' });
    record.checkOuts.push({ outTime, inTime: '' });
    record.markModified('checkOuts');
    await record.save();
    res.json({ success: true, record });
  } catch (err) {
    console.error('Attendance checkout error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/attendance/checkin — return from break
app.post('/api/attendance/checkin', async (req, res) => {
  const { time, date: reqDate } = req.body;
  const date   = (reqDate && /^\d{4}-\d{2}-\d{2}$/.test(reqDate)) ? reqDate : new Date().toISOString().split('T')[0];
  const inTime = time || currentTimeStr();
  try {
    const record = await Attendance.findOne({ username: req.session.username, date });
    if (!record) return res.status(400).json({ error: 'No attendance record found' });
    const openIdx = (record.checkOuts || []).findIndex(co => co.outTime && !co.inTime);
    if (openIdx === -1) return res.status(400).json({ error: 'Not checked out' });
    record.checkOuts[openIdx].inTime = inTime;
    let totalCoMins = 0;
    record.checkOuts.forEach(co => {
      if (co.outTime && co.inTime)
        totalCoMins += timeDiffMins(co.outTime, co.inTime);
    });
    record.totalCheckOutMinutes = totalCoMins;
    recalcWorkMins(record);
    record.markModified('checkOuts');
    await record.save();
    res.json({ success: true, record });
  } catch (err) {
    console.error('Attendance checkin error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/attendance/checkout-count — number of team members currently checked out (for live banner)
app.get('/api/attendance/checkout-count', requireAuth, async (req, res) => {
  const date = new Date().toISOString().split('T')[0];
  try {
    const records = await Attendance.find({ date })
      .select('checkOuts').lean().maxTimeMS(3000);
    const count = records.filter(r =>
      (r.checkOuts || []).some(co => co.outTime && !co.inTime)
    ).length;
    return res.json({ count });
  } catch (err) {
    return res.json({ count: 0 });
  }
});

// PUT /api/attendance/note/:id — save overtime / half-day note (member: own record; manager: any)
app.put('/api/attendance/note/:id', requireAuth, async (req, res) => {
  const { note } = req.body;
  if (note === undefined) return res.status(400).json({ error: 'note is required' });
  try {
    const record = await Attendance.findById(req.params.id);
    if (!record) return res.status(404).json({ error: 'Record not found' });
    if (req.session.role === 'member' && record.username !== req.session.username)
      return res.status(403).json({ error: 'Access denied' });
    record.note = String(note).trim();
    await record.save();
    res.json({ success: true, record });
  } catch (err) {
    console.error('Attendance note error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/attendance/today — current user's today record
app.get('/api/attendance/today', async (req, res) => {
  const date = new Date().toISOString().split('T')[0];
  try {
    const record = await Attendance.findOne({ username: req.session.username, date });
    res.json(record || null);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/attendance/history/:username — all records (member: own; manager: any)
app.get('/api/attendance/history/:username', async (req, res) => {
  const target = req.params.username;
  if (req.session.role === 'member' && req.session.username !== target)
    return res.status(403).json({ error: 'Access denied' });
  try {
    const records = await Attendance.find({ username: target }).sort({ date: -1 });
    res.json(records);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/attendance/all/:date — all members for a date (manager only)
app.get('/api/attendance/all/:date', requireManager, async (req, res) => {
  try {
    const records = await Attendance.find({ date: req.params.date });
    res.json(records);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/attendance/monthly/:username/:month — monthly report (YYYY-MM)
app.get('/api/attendance/monthly/:username/:month', async (req, res) => {
  const { username, month } = req.params;
  if (req.session.role === 'member' && req.session.username !== username)
    return res.status(403).json({ error: 'Access denied' });
  if (!/^\d{4}-\d{2}$/.test(month))
    return res.status(400).json({ error: 'month must be YYYY-MM' });
  try {
    const records = await Attendance.find({ username, date: { $regex: '^' + month } }).sort({ date: 1 });
    res.json(records);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/attendance/all-monthly/:month — all members for a month (manager only)
app.get('/api/attendance/all-monthly/:month', requireManager, async (req, res) => {
  const { month } = req.params;
  if (!/^\d{4}-\d{2}$/.test(month))
    return res.status(400).json({ error: 'month must be YYYY-MM' });
  try {
    const records = await Attendance.find({ date: { $regex: '^' + month } }).sort({ date: 1 });
    res.json(records);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// PUT /api/attendance/edit/:id — edit any field, saves to editHistory
app.put('/api/attendance/edit/:id', async (req, res) => {
  const { field, newValue } = req.body;
  if (!field || newValue === undefined)
    return res.status(400).json({ error: 'field and newValue are required' });
  const memberEditableFields = ['startTime', 'endTime', 'checkOuts'];
  try {
    const record = await Attendance.findById(req.params.id);
    if (!record) return res.status(404).json({ error: 'Record not found' });
    if (req.session.role === 'member') {
      if (record.username !== req.session.username)
        return res.status(403).json({ error: 'Access denied' });
      if (!memberEditableFields.includes(field))
        return res.status(403).json({ error: 'You can only edit time fields' });
    }
    const oldValue = JSON.stringify(record[field] !== undefined ? record[field] : '');
    record.editHistory.push({
      field,
      oldValue,
      newValue: JSON.stringify(newValue),
      editedBy: req.session.display || req.session.username,
      editedAt: new Date(),
    });
    record[field] = newValue;
    // Recalculate totals when times change
    if (['startTime', 'endTime', 'sessions'].includes(field)) {
      recalcWorkMins(record);
    }
    if (field === 'checkOuts') {
      let totalCoMins = 0;
      (record.checkOuts || []).forEach(co => {
        if (co.outTime && co.inTime)
          totalCoMins += timeDiffMins(co.outTime, co.inTime);
      });
      record.totalCheckOutMinutes = totalCoMins;
      recalcWorkMins(record);
    }
    record.markModified('editHistory');
    record.markModified('checkOuts');
    await record.save();
    res.json({ success: true, record });
  } catch (err) {
    console.error('Attendance edit error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Screen Monitoring ─────────────────────────────────────────────────────

// In-memory monitoring state (resets on server restart — acceptable for live monitoring)
const screenPermissions = {}; // { username: true/false }
const activeScreens     = {}; // { username: { sharedAt: Date } }

// GET /monitor — redirect to new screen-share monitor (old page removed)
app.get('/monitor', requireAuth, requireManager, (req, res) => {
  res.redirect('/dashboard/monitor');
});

// POST /api/monitor/signal — WebRTC signaling relay via Pusher
app.post('/api/monitor/signal', requireAuth, async (req, res) => {
  const { type, data, targetUsername, fromUsername } = req.body;
  if (!type || !data) return res.status(400).json({ error: 'type and data are required' });
  try {
    // Track active screens when member sends an offer
    if (type === 'offer' && req.session.role === 'member') {
      activeScreens[req.session.username] = { sharedAt: new Date().toISOString() };
    }
    // Remove from active screens on disconnect
    if (type === 'disconnect') {
      delete activeScreens[req.session.username];
    }
    await pusher.trigger('monitor-channel', 'signal', {
      type,
      data,
      targetUsername: targetUsername || null,
      fromUsername:   fromUsername   || req.session.username,
      fromRole:       req.session.role,
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Pusher signal error:', err);
    res.status(500).json({ error: 'Signal failed' });
  }
});

// GET /api/monitor/active-screens — which members are currently sharing (manager only)
app.get('/api/monitor/active-screens', requireManager, (req, res) => {
  const list = Object.entries(activeScreens).map(([username, info]) => ({
    username,
    display: (usersCache[username] || USERS[username] || {}).display || username,
    sharedAt: info.sharedAt,
  }));
  res.json(list);
});

// POST /api/monitor/allow — manager grants/revokes screen permission for a member
app.post('/api/monitor/allow', requireManager, async (req, res) => {
  const { username, allowed } = req.body;
  if (!username || allowed === undefined)
    return res.status(400).json({ error: 'username and allowed are required' });
  const target = username.toLowerCase().trim();
  screenPermissions[target] = !!allowed;
  // Notify member of permission change via Pusher
  try {
    await pusher.trigger('monitor-channel', 'permission', {
      targetUsername: target,
      allowed:        !!allowed,
    });
  } catch (err) {
    console.error('Pusher permission notify error:', err);
  }
  res.json({ success: true, username: target, allowed: !!allowed });
});

// GET /api/monitor/permission — member checks if they are currently permitted to share
// Default is true (auto-allowed); only false if manager has explicitly revoked
app.get('/api/monitor/permission', requireAuth, (req, res) => {
  const allowed = screenPermissions[req.session.username] !== false;
  res.json({ allowed });
});

// ── Activity Monitoring ───────────────────────────────────────────────────────
// /activity-dashboard redirects to the new screen-share monitor
app.get('/activity-dashboard', requireManager, (req, res) =>
  res.redirect('/dashboard/monitor'));
app.use('/api/activity', require('./api/activity'));

// ── Screen Share Monitor (WebRTC + Pusher private channels) ──────────────────
app.get('/dashboard/monitor', requireManager, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'dashboard-monitor.html')));

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