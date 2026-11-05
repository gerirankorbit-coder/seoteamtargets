require('dotenv').config();

// ── Environment guard (staging isolation) ──────────────────────────────────
// Production = the live deployment of `main` (or a plain `npm start` with no
// staging settings). Anything else — APP_ENV=staging, a Vercel preview, or a
// Vercel deployment of any branch other than `main` — is treated as staging:
//   1. Vercel previews always use the database "rankorbit_staging" (forced here,
//      on the same cluster); other staging runs use MONGODB_DB_NAME. Either way
//      the server refuses to start unless the name contains "staging", so test
//      writes can never reach live data.
//   2. The real employee list is not loaded; only test.* accounts exist, seeded
//      automatically on first start, and every page shows a STAGING banner.
// In production none of this changes behaviour.
const PROD_BRANCH   = 'main';
const gitRef        = process.env.VERCEL_GIT_COMMIT_REF;
const IS_PRODUCTION = !(
  (process.env.APP_ENV && process.env.APP_ENV !== 'production') ||
  process.env.VERCEL_ENV === 'preview' ||
  (gitRef && gitRef !== PROD_BRANCH)
);
const STAGING_DB_NAME = 'rankorbit_staging';
// Staging on Vercel starts clean (no test accounts or TEST data); local staging keeps the
// seeded test data the automated tests use. STAGING_CLEAN=1 forces the clean mode locally.
const CLEAN_STAGING = !IS_PRODUCTION && (!!process.env.VERCEL || process.env.STAGING_CLEAN === '1');
const MONGODB_URI     = process.env.MONGODB_URI;
const MONGODB_DB_NAME = IS_PRODUCTION
  ? (process.env.MONGODB_DB_NAME || '')
  : (process.env.VERCEL_ENV === 'preview' ? STAGING_DB_NAME : (process.env.MONGODB_DB_NAME || STAGING_DB_NAME));
const uriDbName       = ((MONGODB_URI || '').match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/) || [])[1] || '';
const EFFECTIVE_DB    = MONGODB_DB_NAME || uriDbName || 'test';

if (!IS_PRODUCTION) {
  if (!/staging/i.test(EFFECTIVE_DB)) {
    throw new Error(
      `[staging guard] Refusing to start: non-production environment is pointed at database "${EFFECTIVE_DB}". ` +
      `Set MONGODB_DB_NAME to a staging database (e.g. ${STAGING_DB_NAME}).`
    );
  }
  console.log(`⚠ STAGING mode — database "${EFFECTIVE_DB}"`);
}

const mongoose = require('mongoose');
const express  = require('express');
const session  = require('express-session');
const MongoStore = require('connect-mongo')(session);
const path     = require('path');
const fs       = require('fs');
const cors     = require('cors');
const os       = require('os');
const { isHash, hashPassword, verifyPassword, migratePlainPasswords } = require('./lib/passwords');
const {
  TASK_TYPES, ENTRY_VERSION, publicTask, cleanTaskInput, newTaskId, tasksForUser, tasksByUser,
  entryTasksV2, saveMemberTaskList, resetMemberTasks, setAssignees, migrateToTaskIds, titleCase,
} = require('./lib/tasks');
const { buildOverview, localNow } = require('./lib/overview');
const worklog = require('./lib/worklog');
const rules   = require('./lib/rules');
const { buildTeam, buildProfile, buildMySummary, loadMembers } = require('./lib/team');
const { buildReport } = require('./lib/reports');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── MongoDB connection ─────────────────────────────────────────────────────
let dbError = null, startupError = null; // last failures, shown by /api/staging/health
let startupDone; const startupReady = new Promise(r => { startupDone = r; }); // the 'open' handler finished
// Staging gives up after 8 s so a connection problem is reported within one
// serverless request; production keeps the driver defaults.
mongoose.connect(MONGODB_URI, {
  ...(MONGODB_DB_NAME ? { dbName: MONGODB_DB_NAME } : {}),
  ...(IS_PRODUCTION ? {} : { serverSelectionTimeoutMS: 8000 }),
})
  .then(() => console.log('✓ MongoDB connected'))
  .catch(err => { dbError = err; console.error('✗ MongoDB error:', err); });
mongoose.connection.on('error', err => { dbError = err; });

// ── Schemas ────────────────────────────────────────────────────────────────
// One document per (username + date) — tasks stored as Mixed to preserve
// all field shapes (rows/value/text/links/sectionNote).
// entryVersion 2 (V2): tasks are keyed by taskId; older entries are keyed by task name
// and are converted by the startup migration (lib/tasks.js).
const EntrySchema = new mongoose.Schema({
  username: { type: String, required: true },
  date:     { type: String, required: true },
  entryVersion: { type: Number }, // 2 = tasks keyed by taskId (not named `schema`: reserved in Mongoose)
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
  shift:           { type: String }, // optional: 'day' | 'night' (used by Overview rules)
  active:          { type: Boolean, default: true },
  lastActiveAt:    { type: Date },   // last time the member used the portal
  rev:             { type: Number, default: 0 }, // bumped when the manager changes this member's tasks / entries / attendance
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

// Manager's private notes about a member (Employee profile → Notes)
const MemberNoteSchema = new mongoose.Schema({
  username: { type: String, required: true, index: true },
  text:     { type: String, required: true },
  author:   { type: String, required: true },
}, { timestamps: true });
const MemberNote = mongoose.models.MemberNote || mongoose.model('MemberNote', MemberNoteSchema);

// A member asking the manager to correct a locked record (attendance time, a task entry…)
const CorrectionSchema = new mongoose.Schema({
  username:   { type: String, required: true, index: true },
  date:       { type: String, required: true },              // the day to correct (YYYY-MM-DD)
  kind:       { type: String, enum: ['attendance', 'task', 'other'], required: true },
  taskId:     { type: String },
  taskName:   { type: String },
  message:    { type: String, required: true },
  status:     { type: String, enum: ['open', 'done', 'declined'], default: 'open', index: true },
  reply:      { type: String, default: '' },
  resolvedBy: { type: String },
  resolvedAt: { type: Date },
}, { timestamps: true });
const Correction = mongoose.models.Correction || mongoose.model('Correction', CorrectionSchema);

// Client — the shared client list the team picks from when logging work
const ClientSchema = new mongoose.Schema({
  clientId: { type: String, required: true, unique: true },
  name:     { type: String, required: true },
  key:      { type: String, required: true, unique: true },   // lower-case name, so "abc dental" = "ABC Dental"
  active:   { type: Boolean, default: true },
  fromTeam: { type: Boolean, default: false },                // added by a team member, not yet checked by the manager
  addedBy:  { type: String },
}, { timestamps: true });
const Client = mongoose.models.Client || mongoose.model('Client', ClientSchema);

// Assignment — one member, one task, a daily target and the days it applies (to = null: ongoing).
// Targets are read per day from these, so changing a target never rewrites past months.
const AssignmentSchema = new mongoose.Schema({
  username: { type: String, required: true, index: true },
  taskId:   { type: String, required: true, index: true },
  target:   { type: Number, default: null },
  from:     { type: String, required: true },
  to:       { type: String, default: null },
  by:       { type: String },
}, { timestamps: true });
const Assignment = mongoose.models.Assignment || mongoose.model('Assignment', AssignmentSchema);

// The Assignments page's change list ("From 1 Dec: Guest Posting moves from … to …")
const AssignLogSchema = new mongoose.Schema({ text: String, by: String, from: String }, { timestamps: true });
const AssignLog = mongoose.models.AssignLog || mongoose.model('AssignLog', AssignLogSchema);

// Task — one document per task; assignees are the usernames it is assigned to (one
// task can be shared by many members). legacyKey is unique: "<username>|<original name>"
// for tasks from the pre-V2 lists (so old name-keyed entries can be matched to them),
// "task:<taskId>" for tasks created later.
const TaskSchema = new mongoose.Schema({
  taskId:          { type: String, required: true, unique: true },
  name:            { type: String, required: true },
  type:            { type: String, required: true, enum: TASK_TYPES },
  label:           { type: String },
  dailyTarget:     { type: Number, default: null },
  active:          { type: Boolean, default: true },
  assignees:       { type: [String], default: [] },
  formerAssignees: { type: [String], default: [] },
  order:           { type: Number, default: 0 },
  unit:            { type: String },               // what is counted: links, posts, audits… (work log)
  group:           { type: String },               // library group on the Assignments page
  archivedAt:      { type: String },               // the day it was archived (Settings → Tasks)
  legacyKey:       { type: String, required: true, unique: true },
}, { timestamps: true });
TaskSchema.index({ assignees: 1 });
const Task = mongoose.models.Task || mongoose.model('Task', TaskSchema);

// ── In-memory caches (loaded from DB on startup) ──────────────────────────
// taskOverrides/taskBaselines are the pre-V2 per-member task lists; they are read
// only to build the Task documents during the migration.
let taskOverrides     = {};
let taskBaselines     = {}; // { displayName: [TEAM task names at the time the override was saved] }
let passwordOverrides = {}; // loaded for initial seed merge only
let usersCache        = {}; // { username: { password, role, display, passwordVersion } }

mongoose.connection.once('open', async () => {
  try {
    // Staging only: make sure the test.* accounts and TEST data exist (idempotent).
    // Unique indexes must exist before anything writes tasks (parallel cold starts).
    await Promise.all([Task.init(), Config.init(), Client.init(), Assignment.init()]);

    if (CLEAN_STAGING) {
      const r = await require('./lib/clean-start').cleanStart({ db: mongoose.connection.db, Config, dbName: mongoose.connection.db.databaseName });
      if (r.cleaned) console.log('✓ Staging emptied for a clean start:', JSON.stringify(r.emptied));
    } else if (!IS_PRODUCTION) await require('./lib/staging-seed').seedStagingData({ User, Entry, Attendance, Config, Task });
    await syncRules(true);

    // Load Config documents
    const [taskDoc, pwDoc, baseDoc] = await Promise.all([
      Config.findOne({ key: 'taskOverrides' }),
      Config.findOne({ key: 'passwordOverrides' }),
      Config.findOne({ key: 'taskBaselines' }),
    ]);
    if (taskDoc) taskOverrides     = taskDoc.value || {};
    if (baseDoc) taskBaselines     = baseDoc.value || {};
    if (pwDoc)   passwordOverrides = pwDoc.value   || {};

    // Make sure every USERS entry exists in MongoDB. Existing accounts keep their
    // password; only role/display are refreshed (for accounts still on their first
    // password). A missing account is created only if an initial password is
    // provided via SEED_USER_PASSWORDS (JSON: {"username":"password"}) or a legacy
    // passwordOverrides entry; it is stored hashed.
    let seedPasswords = {};
    try { seedPasswords = JSON.parse(process.env.SEED_USER_PASSWORDS || '{}'); }
    catch { console.error('✗ SEED_USER_PASSWORDS is not valid JSON — ignored'); }
    const existing = new Set((await User.find({}, { username: 1 }).lean()).map(u => u.username));
    // Accounts removed in Settings are never re-created from the code list
    const removedDoc = await Config.findOne({ key: 'removedUsers' }).lean();
    for (const u of (removedDoc && removedDoc.value) || []) existing.add(u);
    let created = 0, refreshed = 0;
    for (const [username, data] of Object.entries(USERS)) {
      if (existing.has(username)) {
        const r = await User.updateOne(
          { username, passwordVersion: { $lte: 1 } },
          { $set: { role: data.role, display: data.display } }
        );
        refreshed += r.modifiedCount || 0;
        continue;
      }
      const initial = seedPasswords[username] || (passwordOverrides[username] || {}).password;
      if (!initial) { console.warn(`⚠ User "${username}" is not in the database and has no initial password — not created`); continue; }
      try {
        await User.create({ username, role: data.role, display: data.display,
                            password: await hashPassword(initial), passwordVersion: 1 });
        created++;
      } catch (e) { if (e.code !== 11000) throw e; }
    }
    console.log(`✓ Users synced — created: ${created}, refreshed: ${refreshed}`);

    // One-time, idempotent: hash any password still stored as plain text.
    const migrated = await migratePlainPasswords(User);
    if (migrated) console.log(`✓ Hashed ${migrated} plain-text password(s)`);

    // Load all users into in-memory cache
    const allUsers = await User.find(
      {},
      { _id: 0, username: 1, password: 1, role: 1, display: 1, passwordVersion: 1, shift: 1, active: 1 }
    ).lean();
    usersCache = {};
    allUsers.forEach(u => { usersCache[u.username] = cacheEntry(u); });
    console.log('✓ Loaded', Object.keys(usersCache).length, 'users into cache');

    // Feature 6: Ensure manager display name is "Abdullah Saleem" (migration for existing DBs)
    const managerDoc = await User.findOne({ username: 'manager' });
    if (managerDoc && managerDoc.display !== 'Abdullah Saleem') {
      await User.updateOne({ username: 'manager' }, { $set: { display: 'Abdullah Saleem' } });
      if (usersCache['manager']) usersCache['manager'].display = 'Abdullah Saleem';
      console.log('✓ Migrated manager display name to Abdullah Saleem');
    }

    // V2: permanent taskIds (one-time, idempotent; see lib/tasks.js)
    const report = await migrateToTaskIds({
      Task, Entry, Config, members: memberAccounts(), legacyListFor: legacyMemberTasks,
    });
    if (report && !report.dryRun) console.log('✓ Task model:', JSON.stringify({
      entriesBefore: report.entriesBefore, entriesAfter: report.entriesAfter,
      converted: report.entriesConverted, unmapped: report.unmappedValues, tasks: report.totalTasks }));
  } catch (err) {
    startupError = err;
    console.error('Startup error:', err);
  } finally { startupDone(); }
});

// ── Team accounts ──────────────────────────────────────────────────────────
// Usernames, roles and display names only — passwords live (bcrypt-hashed) in
// MongoDB, never in code. A brand-new account needs an initial password from
// SEED_USER_PASSWORDS, or can be added from the dashboard.
const USERS = {
  "manager":        { role: "manager",  display: "Abdullah Saleem" },
  "assistant":      { role: "assistant", display: "Assistant" },
  "ali.lodhi":      { role: "member",   display: "Ali Lodhi" },
  "abida.khalid":   { role: "member",   display: "Abida Khalid" },
  "syed.salman":    { role: "member",   display: "Syed Salman Ali" },
  "usman.tariq":    { role: "member",   display: "Usman Tariq" },
  "abdullah.asif":  { role: "member",   display: "Abdullah Asif" },
  "abdullah.gull":  { role: "member",   display: "Abdullah Gull" },
  "rizwan.haider":  { role: "member",   display: "Rizwan Haider" },
  "haseeb.ahmed":   { role: "member",   display: "Haseeb Ahmed" },
  "sana.effat":     { role: "member",   display: "Sana Effat" },
  "m.kashif":       { role: "member",   display: "Muhammad Kashif" },
  "sajid.saleem":   { role: "member",   display: "Sajid Saleem" },
  "toseef.ahmed":   { role: "member",   display: "Toseef Ahmed" },
  "ahmad.rehman":   { role: "member",   display: "Ahmad Rehman" },
  "naveed.liaqat":  { role: "member",   display: "Naveed Liaqat" },
  "abler.khan":     { role: "member",   display: "Abler Khan" },
  "ali.raza":       { role: "member",   display: "Ali Raza" },
  "ali.miraj":      { role: "member",   display: "Ali Miraj Din" },
  "muhammad.asim":  { role: "member",   display: "Muhammad Asim" },
  "anas.irfan":     { role: "member",   display: "Anas Irfan" },
  "mazhar":         { role: "member",   display: "Mazhar" },
  "anas.raza":      { role: "member",   display: "Anas Raza" },
  "atif.ahmad":     { role: "member",   display: "Atif Ahmad" },
};
// Staging never loads the real team: only the seeded test.* accounts exist there.
if (!IS_PRODUCTION) for (const k of Object.keys(USERS)) delete USERS[k];

// User lookup — reads from in-memory cache (populated from MongoDB on startup)
function getUser(username) {
  const u = usersCache[username];
  return u ? { ...u } : null;
}

// Re-read one user from MongoDB into the cache. Each server instance has its own
// cache, so this is how a password change made on another instance is picked up.
function cacheEntry(u) {
  return {
    password:        u.password,
    role:            u.role,
    display:         u.display,
    passwordVersion: u.passwordVersion || 1,
    shift:           u.shift || null,
    active:          u.active !== false,
    checkedAt:       Date.now(),
  };
}
async function refreshUser(username) {
  const u = await User.findOne(
    { username },
    { _id: 0, password: 1, role: 1, display: 1, passwordVersion: 1, shift: 1, active: 1 }
  ).lean();
  if (!u) { delete usersCache[username]; return null; }
  usersCache[username] = cacheEntry(u);
  return getUser(username);
}

// ── Team task definitions (lib/team-defaults.js) ───────────────────────────
const { TEAM, legacyListFor } = require('./lib/team-defaults');
// Pre-V2 task list of a member, from the Config overrides loaded at startup
const legacyMemberTasks = displayName => legacyListFor(taskOverrides, taskBaselines)(displayName);

// Every member account: the team list in code plus members added from the dashboard.
// Only accounts that exist in the database count (a member removed in Settings is gone
// even if the code still lists them). active: false = deactivated (kept for history).
function memberAccounts({ activeOnly = false } = {}) {
  const out = new Map();
  const add = (username, u) => {
    const c = usersCache[username];
    if (!c || c.role !== 'member' || out.has(username)) return;
    if (activeOnly && c.active === false) return;
    out.set(username, { username, display: c.display || u.display, active: c.active !== false });
  };
  for (const [username, u] of Object.entries(USERS)) add(username, u);
  for (const [username, u] of Object.entries(usersCache)) add(username, u);
  return [...out.values()];
}

// Default task list for "Reset to Default": the list in code (TEAM); in staging the
// seeded test lists. null = this member has no default list.
function defaultTasksFor(username, display) {
  const codeName = (USERS[username] || {}).display; // TEAM is keyed by the original name
  if (TEAM[display] || TEAM[codeName]) return TEAM[display] || TEAM[codeName];
  if (!IS_PRODUCTION && !CLEAN_STAGING) return require('./lib/staging-seed').TEST_TASKS[username] || null;
  return null;
}

// Dashboard routes address members by display name.
function usernameForDisplay(displayName) {
  const m = memberAccounts().find(a => a.display === displayName);
  return m ? m.username : null;
}

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces))
    for (const iface of ifaces[name])
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
  return 'localhost';
}

// ── Session secret ─────────────────────────────────────────────────────────
// From SESSION_SECRET. If it is not set, derive a stable secret from MONGODB_URI
// (itself a secret that only lives in the environment) so every server instance
// agrees on it — no secret is ever written in code.
const SESSION_SECRET = process.env.SESSION_SECRET ||
  require('crypto').createHash('sha256').update('rank-orbit-session:' + (MONGODB_URI || '')).digest('hex');
if (!process.env.SESSION_SECRET) console.warn('⚠ SESSION_SECRET is not set — using a secret derived from MONGODB_URI');

// ── Middleware ─────────────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: new MongoStore({
    mongooseConnection: mongoose.connection,
    // Staging's local FerretDB has no TTL indexes, so expire sessions by sweep there.
    ...(IS_PRODUCTION ? {} : { autoRemove: 'interval', autoRemoveInterval: 10 }),
  }),
  cookie: {
    secure:   process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge:   30 * 24 * 60 * 60 * 1000, // 30 days — persists across browser restarts
  },
}));

// ── Staging banner (never in production) ──────────────────────────────────
// Every HTML page — whether sent by a route or by express.static — gets a fixed
// "STAGING — test data only" bar injected right after <body>.
if (!IS_PRODUCTION) {
  const PUBLIC_DIR = path.join(__dirname, 'public');
  const BANNER =
    '<div id="staging-banner" style="position:fixed;top:0;left:0;right:0;z-index:2147483647;' +
    'background:#f59e0b;color:#111;font:700 12px/22px Inter,\'Segoe UI\',Roboto,sans-serif;text-align:center;' +
    'letter-spacing:.05em;pointer-events:none;opacity:.95">' + (CLEAN_STAGING ? 'TEST VERSION — not the live site yet' : 'STAGING — test data only') + '</div>' +
    // keep the page (and its sticky/fixed bars) below the 22px banner
    '<style>body{padding-top:22px}.topbar,.app-topbar{top:22px!important}.sidebar{top:22px!important}.em-overlay{top:22px!important}</style>';
  const withBanner = html => /<body[^>]*>/i.test(html)
    ? html.replace(/<body[^>]*>/i, m => m + BANNER)
    : BANNER + html;
  app.use((req, res, next) => {
    const sendFile = res.sendFile.bind(res);
    res.sendFile = (file, ...rest) => {
      if (typeof file !== 'string' || !file.endsWith('.html')) return sendFile(file, ...rest);
      fs.readFile(file, 'utf8', (err, html) => err ? next(err) : res.type('html').send(withBanner(html)));
    };
    // express.static below answers "/" with index.html before any route runs, so mirror that.
    const rel = req.path === '/' ? '/index.html' : req.path;
    if (req.method === 'GET' && rel.endsWith('.html')) {
      const file = path.join(PUBLIC_DIR, path.normalize(rel));
      if (file.startsWith(PUBLIC_DIR + path.sep) && fs.existsSync(file)) {
        return res.sendFile(file);
      }
    }
    next();
  });
}

// ── Static assets ─────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Public routes ──────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (req.session.role === 'manager' || req.session.role === 'assistant') return res.redirect('/dashboard');
  if (req.session.role === 'member') return res.redirect('/member');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Homepage numbers (public, counts only): active team members, active tasks, entries logged
app.get('/api/public/stats', async (req, res) => {
  try {
    const [members, tasks, entries] = await Promise.all([
      User.countDocuments({ role: 'member', active: { $ne: false } }),
      Task.countDocuments({ active: { $ne: false }, 'assignees.0': { $exists: true } }),
      Entry.estimatedDocumentCount(),
    ]);
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ members, tasks, entries });
  } catch (err) {
    res.status(503).json({ error: 'unavailable' });
  }
});

app.get('/login', (req, res) => {
  if (req.session.role === 'manager' || req.session.role === 'assistant') return res.redirect('/dashboard');
  if (req.session.role === 'member') return res.redirect('/member');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// ── First manager account (clean staging only) ───────────────────────────
// A clean staging database has no accounts. The sign-in page then offers "Create the
// manager account" once; as soon as one manager exists this is closed for good.
async function setupNeeded() {
  if (!CLEAN_STAGING) return false;
  await Promise.race([startupReady, new Promise(r => setTimeout(r, 15000))]);
  return !(await User.exists({ role: 'manager' }));
}
app.get('/api/setup', async (req, res) => {
  try { res.json({ needed: await setupNeeded() }); } catch { res.json({ needed: false }); }
});
app.post('/api/setup', async (req, res) => {
  try {
    if (!(await setupNeeded())) return res.status(403).json({ error: 'A manager account already exists. Sign in instead.' });
    const uname = String(req.body.username || '').toLowerCase().trim(), dname = String(req.body.display || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    const password = String(req.body.password || '');
    if (dname.length < 2) return res.status(400).json({ error: 'Write your full name' });
    if (!/^[a-z0-9._-]{3,30}$/.test(uname)) return res.status(400).json({ error: 'Username: 3–30 small letters, numbers, dots, underscores or hyphens' });
    if (password.length < 8) return res.status(400).json({ error: 'Use a password of at least 8 characters' });
    // Unique username index: two people pressing at once cannot both create one
    await User.create({ username: uname, role: 'manager', display: dname, password: await hashPassword(password), passwordVersion: 1, active: true });
    if (await User.countDocuments({ role: 'manager' }) > 1) { await User.deleteOne({ username: uname }); return res.status(403).json({ error: 'A manager account was just created. Sign in instead.' }); }
    await refreshUser(uname);
    console.log('✓ First manager account created:', uname);
    res.json({ success: true, username: uname });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'That username is taken' });
    console.error('Setup error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials.' });
  const uname = username.toLowerCase().trim();

  // Always check the password against MongoDB, not this instance's cache: the password
  // may have been changed on another server instance (an old password must not work,
  // and the session must get the current passwordVersion).
  let user, valid = false;
  try {
    user  = await refreshUser(uname);
    valid = !!user && await verifyPassword(password, user.password);
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
  if (!valid) return res.status(401).json({ error: 'Invalid username or password.' });
  if (user.active === false) return res.status(403).json({ error: 'This account is deactivated. Please contact your manager.' });

  // Legacy plain-text password (not yet migrated): store it hashed now.
  if (!isHash(user.password)) {
    try {
      const hashed = await hashPassword(password);
      await User.updateOne({ username: uname, password: user.password }, { $set: { password: hashed } });
      if (usersCache[uname]) usersCache[uname].password = hashed;
    } catch (err) { console.error('Password upgrade error:', err); }
  }

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

// ── Auth middleware ────────────────────────────────────────────────────────
// A member's sessions end as soon as their passwordVersion changes. Each server
// instance re-reads the user from MongoDB at most every 30 s, so a password change
// made on any instance logs the member out everywhere within that window.
const VERSION_RECHECK_MS = 30 * 1000;

// "Last active" for the Team page: a plain timestamp, written at most every 2 min
// per member and instance (no tracking — just when they last used the portal).
const lastActiveWrite = new Map();
function touchLastActive(session) {
  if (session.role !== 'member') return;
  const now = Date.now(), prev = lastActiveWrite.get(session.username) || 0;
  if (now - prev < 2 * 60 * 1000) return;
  lastActiveWrite.set(session.username, now);
  User.updateOne({ username: session.username }, { $set: { lastActiveAt: new Date(now) } }).catch(() => {});
}
async function requireAuth(req, res, next) {
  if (!req.session.role) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
    // Tell the sign-in page which portal was asked for (wording only — the role decides access)
    const portal = req.path.startsWith('/dashboard') ? 'manager' : req.path.startsWith('/member') ? 'member' : '';
    return res.redirect('/login' + (portal ? '?portal=' + portal : ''));
  }
  let currentUser = getUser(req.session.username), removed = false;
  if (!currentUser || !currentUser.checkedAt || Date.now() - currentUser.checkedAt > VERSION_RECHECK_MS) {
    try { currentUser = await refreshUser(req.session.username); removed = !currentUser; }
    catch (err) { console.error('Session check error:', err); } // keep the session on a DB hiccup
  }
  touchLastActive(req.session);
  // Removed or deactivated from Settings: the session ends (on every instance within 30 s)
  // Answer only once the session is gone: the browser goes to /login straight away, and a
  // session still in the store there would bounce it back to the portal
  if (removed || (currentUser && currentUser.active === false)) {
    return req.session.destroy(() => req.path.startsWith('/api/')
      ? res.status(401).json({ error: 'account_deactivated' }) : res.redirect('/login?reason=deactivated'));
  }
  if (currentUser && currentUser.role && req.session.role && currentUser.role !== req.session.role) {
    return req.session.destroy(() => req.path.startsWith('/api/')
      ? res.status(401).json({ error: 'role_changed' }) : res.redirect('/login?reason=role_changed'));
  }
  if (currentUser) {
    const currentVer = currentUser.passwordVersion || 1;
    const sessionVer = req.session.passwordVersion  || 1;
    if (sessionVer !== currentVer) {
      return req.session.destroy(() => req.path.startsWith('/api/')
        ? res.status(401).json({ error: 'password_changed' }) : res.redirect('/login?reason=password_changed'));
    }
  }
  next();
}

// Several server instances run at once (Vercel), each with its own user cache. Before
// manager pages and APIs the cache is re-read from MongoDB (at most every 5 s per
// instance), so a member added, changed or removed on one instance shows on all of them.
// Work rules (Settings → Work rules): every instance re-reads them every few seconds
const RULES_SYNC_MS = 10 * 1000;
let rulesSyncedAt = 0, rulesSyncing = null;
function syncRules(force = false) {
  if (!force && Date.now() - rulesSyncedAt < RULES_SYNC_MS) return Promise.resolve();
  if (!rulesSyncing) rulesSyncing = Config.findOne({ key: 'workRules' }).lean()
    .then(doc => { rules.set(doc && doc.value); rulesSyncedAt = Date.now(); })
    .catch(err => console.error('Rules sync error:', err))
    .finally(() => { rulesSyncing = null; });
  return rulesSyncing;
}

const USERS_SYNC_MS = 5 * 1000;
let usersSyncedAt = 0, usersSyncing = null;
function syncUsersCache() {
  if (Date.now() - usersSyncedAt < USERS_SYNC_MS) return Promise.resolve();
  if (!usersSyncing) {
    usersSyncing = User.find({}, { _id: 0, username: 1, password: 1, role: 1, display: 1, passwordVersion: 1, shift: 1, active: 1 }).lean()
      .then(docs => {
        const seen = new Set();
        for (const u of docs) { usersCache[u.username] = cacheEntry(u); seen.add(u.username); }
        for (const name of Object.keys(usersCache)) if (!seen.has(name)) delete usersCache[name];
        usersSyncedAt = Date.now();
      })
      .catch(err => console.error('User sync error:', err)) // keep the cache on a DB hiccup
      .finally(() => { usersSyncing = null; });
  }
  return usersSyncing;
}

async function requireManager(req, res, next) {
  if (req.session.role !== 'manager' && req.session.role !== 'assistant') {
    if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Insufficient permissions' });
    return res.redirect('/member');
  }
  await syncUsersCache();
  next();
}

// Restrict to manager role only (assistants cannot add/remove members)
async function requireManagerOnly(req, res, next) {
  if (req.session.role !== 'manager') {
    return res.status(403).json({ error: 'Only manager can perform this action' });
  }
  await syncUsersCache();
  next();
}

// Staging only: why can't the app reach its database? (no secrets in the output)
// networkCheck: DNS lookup of the cluster, then a plain TCP connect to one host on
// port 27017 — "timeout" there almost always means the Atlas IP access list.
async function networkCheck(uri) {
  const dns = require('dns').promises, net = require('net');
  const host = (uri.match(/^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?,]+)/) || [])[1];
  const mask = h => h ? h.replace(/^([^.]+)\.([^.]+)\./, '$1.***.') : h;
  const out = { cluster: mask(host) };
  let target = host && host.split(':')[0], port = 27017;
  if (uri.startsWith('mongodb+srv://')) {
    try {
      const srv = await dns.resolveSrv('_mongodb._tcp.' + host);
      out.dns = `ok (${srv.length} servers)`;
      target = srv[0] && srv[0].name; port = (srv[0] && srv[0].port) || 27017;
    } catch (e) { out.dns = 'failed: ' + e.code; return out; }
  }
  out.tcp = await new Promise(resolve => {
    const sock = net.connect({ host: target, port, timeout: 3500 });
    sock.on('connect', () => { sock.destroy(); resolve('ok — the database host is reachable'); });
    sock.on('timeout', () => { sock.destroy(); resolve('timeout — blocked (check the Atlas Network Access IP list)'); });
    sock.on('error', e => resolve('failed: ' + e.code));
  });
  try {
    const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(1500) });
    out.thisServerIp = (await r.json()).ip;
  } catch { /* optional */ }
  return out;
}

if (!IS_PRODUCTION) {
  app.get('/api/staging/health', async (req, res) => {
    const redact = v => v ? String(v).replace(/(mongodb(?:\+srv)?:\/\/)[^@\s/]*@/gi, '$1***@') : null;
    const state = ['disconnected', 'connected', 'connecting', 'disconnecting'][mongoose.connection.readyState] || 'unknown';
    const out = {
      mode: 'staging',
      vercelEnv: process.env.VERCEL_ENV || null,
      gitBranch: process.env.VERCEL_GIT_COMMIT_REF || null,
      commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null,
      mongoUriSet: !!MONGODB_URI,
      mongoUriType: MONGODB_URI ? (MONGODB_URI.startsWith('mongodb+srv://') ? 'mongodb+srv' : MONGODB_URI.startsWith('mongodb://') ? 'mongodb' : 'not a MongoDB URI') : null,
      database: EFFECTIVE_DB,
      sessionSecretSet: !!process.env.SESSION_SECRET,
      connection: state,
      connectError: redact(dbError && dbError.message),
      startupError: redact(startupError && startupError.message),
    };
    // Not connected yet: wait a little for the outcome while checking the network path
    // (everything finishes in ~6 s, inside Vercel's function time limit)
    if (state !== 'connected' && MONGODB_URI) {
      const [, network] = await Promise.all([
        state === 'connecting'
          ? Promise.race([mongoose.connection.asPromise().catch(() => {}), new Promise(r => setTimeout(r, 6000))])
          : null,
        networkCheck(MONGODB_URI),
      ]);
      await new Promise(r => setImmediate(r)); // let the connect() error handler record its error
      out.connection = ['disconnected', 'connected', 'connecting', 'disconnecting'][mongoose.connection.readyState] || 'unknown';
      out.connectError = redact(dbError && dbError.message);
      if (out.connection !== 'connected') out.network = network;
    }
    if (out.connection === 'connected') {
      try {
        out.testUsers = await User.countDocuments({ username: /^test\./ });
        out.tasks = await Task.countDocuments({});
        out.ok = out.testUsers > 0;
      } catch (err) { out.queryError = redact(err.message); out.ok = false; }
    } else out.ok = false;
    res.json(out);
  });
}

app.use(requireAuth);

// Assignments can be dated in the future ("from 1 December"): once a day, bring every
// task's assignee list up to date (each instance, cheap and idempotent).
let assignSyncedFor = null;
app.use(async (req, res, next) => {
  await syncRules();
  const today = localNow().date;
  if (assignSyncedFor !== today) {
    assignSyncedFor = today;
    try { const changed = await worklog.syncAssignees({ Task, Assignment }, today); if (changed.length) await bumpRev(changed); }
    catch (err) { assignSyncedFor = null; console.error('Assignment sync error:', err); }
  }
  next();
});

// ── Protected page routes ──────────────────────────────────────────────────
// Member portal: My Space (/member) and My History (/member/history), one page
app.get(['/member', '/member/history'], (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'member.html')));

// Manager shell: /dashboard is Overview; each sidebar page has its own URL and the
// same page renders it client-side.
const DASHBOARD_PAGES = ['today', 'month', 'team', 'work', 'attendance', 'assignments', 'tasks', 'clients', 'reports', 'settings'];
app.get(['/dashboard', '/dashboard/:page', '/dashboard/team/:username', '/dashboard/profile/:username'], requireManager, (req, res, next) => {
  if (req.params.page && !DASHBOARD_PAGES.includes(req.params.page)) return next();
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ── Protected API routes ───────────────────────────────────────────────────

// tasks: the member's active tasks (entry form); historyTasks: also inactive and
// previously-assigned tasks, so old entries still show with their current names.
app.get('/api/me', async (req, res) => {
  try {
    const [tasks, historyTasks] = await Promise.all([
      tasksForUser(Task, req.session.username),
      tasksForUser(Task, req.session.username, { includeHistory: true }),
    ]);
    // name and shift straight from the database: another instance may have just changed them
    const u = (await User.findOne({ username: req.session.username }, { _id: 0, display: 1, shift: 1 }).lean()) || getUser(req.session.username) || {};
    const days = await memberDays(req.session.username);
    // The member's own daily target (from their assignment) where one is set
    const rows = await Assignment.find({ username: req.session.username }).lean();
    const mine = t => { const r = rows.filter(x => x.taskId === t.taskId); if (!r.length) return t;
      const cur = r.find(x => worklog.covers(x, days.today)); return { ...t, dailyTarget: cur ? cur.target ?? null : t.dailyTarget }; };
    tasks.splice(0, tasks.length, ...tasks.map(mine));
    res.json({ username: req.session.username, display: u.display || req.session.display, role: req.session.role,
               today: days.today, editableDates: days.editable,
               timeZone: process.env.APP_TIMEZONE || 'Asia/Karachi',   // attendance times are in this zone
               shift: u.shift || null, tasks, historyTasks });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// My Space: the member's own streak, today and "My Week" numbers (own data only)
app.get('/api/my/summary', async (req, res) => {
  try {
    res.json(await buildMySummary({ Task, Entry, Attendance, Assignment },
      { username: req.session.username, date: req.query.date, time: req.query.time }));
  } catch (err) {
    console.error('My summary error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Entries are saved keyed by taskId (entryVersion 2).
// partial: only the given task values (and _managerNote) are written; the rest of the day
// stays as it is in the database. The member portal and the manager both save this way, so
// two people editing the same day never overwrite each other's other tasks.
async function saveEntry(username, date, tasks, { partial = false } = {}) {
  if (!partial) {
    await Entry.findOneAndUpdate(
      { username, date },
      { username, date, tasks, entryVersion: ENTRY_VERSION },
      { upsert: true, new: true }
    );
    return;
  }
  const existing = await Entry.findOne({ username, date }).lean();
  if (existing && existing.entryVersion !== ENTRY_VERSION) {   // an old name-keyed day: convert, then merge
    const merged = { ...(await entryTasksV2(Task, existing)), ...tasks };
    await Entry.updateOne({ _id: existing._id }, { $set: { tasks: merged, entryVersion: ENTRY_VERSION } });
    return;
  }
  const set = { entryVersion: ENTRY_VERSION };
  for (const [k, v] of Object.entries(tasks)) {
    if (!/^[\w-]+$/.test(k)) continue;   // task IDs and _managerNote only (no dots / operators)
    set['tasks.' + k] = v;
  }
  await Entry.updateOne({ username, date }, { $set: set, $setOnInsert: { username, date } }, { upsert: true });
}

// Everyone a task is (or was) assigned to — a rename or a new target concerns all of them
async function taskPeople(filter) {
  const tasks = await Task.find(filter, { _id: 0, assignees: 1, formerAssignees: 1 }).lean();
  return tasks.flatMap(t => [...(t.assignees || []), ...(t.formerAssignees || [])]);
}

// Live updates for the member portal: the manager changing anything for a member bumps
// that member's revision; the portal polls /api/my/rev and reloads when it changes.
async function bumpRev(usernames) {
  const list = [...new Set([].concat(usernames || []).filter(Boolean))];
  if (list.length) await User.updateMany({ username: { $in: list } }, { $set: { rev: Date.now() } }).catch(err => console.error('Rev bump error:', err));
}

// Entries → { date: tasks } keyed by taskId (old name-keyed entries converted on the fly).
async function entriesByDate(entries, indexes = new Map()) {
  const out = {};
  for (const e of entries) out[e.date] = await entryTasksV2(Task, e, indexes);
  return out;
}

// Save all tasks for a given date (one document per username+date)
app.post('/api/save', async (req, res) => {
  const { date, tasks, partial } = req.body;
  if (!date || !tasks) return res.status(400).json({ error: 'Missing required fields' });
  try {
    // Past and future days are locked for members; the manager edits those from Work
    if (req.session.role === 'member' && !(await memberDays(req.session.username)).editable.includes(date))
      return res.status(403).json({ error: LOCKED_MSG });
    await saveEntry(req.session.username, date, tasks, { partial: !!partial });
    res.json({ success: true });
  } catch (err) {
    console.error('Save error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// The member's current revision (see bumpRev). Cheap: polled by the open portal.
app.get('/api/my/rev', async (req, res) => {
  try {
    const u = await User.findOne({ username: req.session.username }, { _id: 0, rev: 1 }).lean();
    res.set('Cache-Control', 'no-store');
    res.json({ rev: (u && u.rev) || 0 });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Fetch the current user's tasks for a specific date
app.get('/api/mydata/:date', async (req, res) => {
  try {
    const entry = await Entry.findOne(
      { username: req.session.username, date: req.params.date },
      { username: 1, tasks: 1, entryVersion: 1, _id: 0 }
    ).lean();
    res.json(entry ? await entryTasksV2(Task, entry) : {});
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
  const user = await refreshUser(target);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.role === 'manager' && target !== req.session.username)
    return res.status(403).json({ error: 'Manager passwords cannot be reset here' });
  const newVersion = Date.now();
  try {
    const hashed = await hashPassword(newPassword);
    await User.findOneAndUpdate({ username: target }, { password: hashed, passwordVersion: newVersion });
    usersCache[target] = { ...usersCache[target], password: hashed, passwordVersion: newVersion, checkedAt: Date.now() };
    res.json({ success: true });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Manager: save / override any member's submitted data for a date
app.post('/api/manager-save/:username', requireManager, async (req, res) => {
  const { date, tasks, partial } = req.body;
  const target = req.params.username;
  if (!date || !tasks) return res.status(400).json({ error: 'Missing fields' });
  try {
    await saveEntry(target, date, tasks, { partial: !!partial });
    await bumpRev(target);
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
    const entries = await Entry.find({ username: target }, { username: 1, date: 1, tasks: 1, entryVersion: 1, _id: 0 }).lean();
    res.json(await entriesByDate(entries));
  } catch (_) {
    res.json({});
  }
});

// Fetch everything — returns same shape as before: { username: { date: tasks } }
app.get('/api/all', requireManager, async (req, res) => {
  try {
    const entries = await Entry.find({}, { username: 1, date: 1, tasks: 1, entryVersion: 1, _id: 0 }).lean();
    const result  = {};
    const indexes = new Map();
    for (const e of entries) {
      if (!result[e.username]) result[e.username] = {};
      result[e.username][e.date] = await entryTasksV2(Task, e, indexes);
    }
    res.json(result);
  } catch (_) {
    res.json({});
  }
});

// Members with their active tasks (one query for all tasks).
app.get('/api/members', requireManager, async (req, res) => {
  try {
    const accounts = memberAccounts();
    const byUser   = await tasksByUser(Task, accounts.map(a => a.username));
    res.json(accounts.map(a => ({ ...a, tasks: byUser[a.username], hasDefault: !!defaultTasksFor(a.username, a.display) })));
  } catch (err) {
    console.error('Members error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Edit Tasks: save a member's full ordered task list (taskIds kept, new tasks created)
app.post('/api/tasks/:displayName', requireManager, async (req, res) => {
  const { tasks } = req.body;
  if (!Array.isArray(tasks)) return res.status(400).json({ error: 'tasks must be an array' });
  const username = usernameForDisplay(decodeURIComponent(req.params.displayName));
  if (!username) return res.status(404).json({ error: 'Member not found' });
  try {
    const before = await taskPeople({ assignees: username });
    await saveMemberTaskList(Task, username, tasks);
    await bumpRev([username, ...before, ...(await taskPeople({ assignees: username }))]);
    res.json({ success: true, tasks: await tasksForUser(Task, username) });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error('Task list save error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Reset to Default: the member gets their default list from code again (same taskIds)
app.delete('/api/tasks/:displayName', requireManager, async (req, res) => {
  const displayName = decodeURIComponent(req.params.displayName);
  const username = usernameForDisplay(displayName);
  if (!username) return res.status(404).json({ error: 'Member not found' });
  try {
    const defaults = defaultTasksFor(username, displayName);
    if (!defaults) return res.status(400).json({ error: 'This member has no default task list' });
    await resetMemberTasks(Task, username, defaults);
    await bumpRev(username);
    res.json({ success: true, tasks: await tasksForUser(Task, username) });
  } catch (err) {
    console.error('Task reset error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Manager Overview: KPIs, needs-attention list, team at a glance and chart history in
// one call. date = the portal's calendar date (UTC, as entries are dated), time = the
// manager's local clock (HH:MM) for the time-of-day rules.
app.get('/api/overview', requireManager, async (req, res) => {
  try {
    const members = memberAccounts({ activeOnly: true });
    const data = await buildOverview({ Task, Entry, Attendance, User, Assignment }, { members, date: req.query.date, time: req.query.time });
    // Open correction requests come first in Needs Attention
    const byName = Object.fromEntries(members.map(m => [m.username, m.display]));
    const open = await Correction.find({ status: 'open', username: { $in: members.map(m => m.username) } }).sort({ createdAt: 1 }).lean();
    data.attention = [...open.map(c => ({ username: c.username, display: byName[c.username], kind: 'correction', correctionId: String(c._id),
      reason: 'Asks for a correction · ' + c.date + (c.taskName ? ' · ' + c.taskName : c.kind === 'attendance' ? ' · attendance' : '') + ' — “' + c.message.slice(0, 80) + (c.message.length > 80 ? '…' : '') + '”' })),
      ...data.attention];
    res.json(data);
  } catch (err) {
    console.error('Overview error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Team page: one row per member (status, this-week target %, streak, last active)
app.get('/api/team', requireManager, async (req, res) => {
  try {
    const members = memberAccounts();
    const users = await User.find({ username: { $in: members.map(m => m.username) } },
                                  { _id: 0, username: 1, role: 1, shift: 1, active: 1, lastActiveAt: 1 }).lean();
    res.json(await buildTeam({ Task, Entry, Attendance, Assignment }, { members, users, date: req.query.date, time: req.query.time }));
  } catch (err) {
    console.error('Team error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Reports: per-member numbers for a period (?period=week|month|custom&from=&to=)
app.get('/api/reports', requireManager, async (req, res) => {
  try {
    res.json(await buildReport({ Task, Entry, Attendance, Assignment }, { members: memberAccounts(), query: req.query }));
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error('Reports error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Employee 360° profile
app.get('/api/members/:username/profile', requireManager, async (req, res) => {
  const member = memberAccounts().find(m => m.username === req.params.username);
  if (!member) return res.status(404).json({ error: 'Member not found' });
  try {
    const [user, notes] = await Promise.all([
      User.findOne({ username: member.username }, { _id: 0, password: 0, passwordVersion: 0 }).lean(),
      MemberNote.find({ username: member.username }).sort({ createdAt: -1 }).lean(),
    ]);
    res.json(await buildProfile({ Task, Entry, Attendance, Assignment }, {
      member, user: user || {}, notes: notes.map(n => ({ id: String(n._id), text: n.text, author: n.author, at: n.createdAt })),
      date: req.query.date, time: req.query.time,
    }));
  } catch (err) {
    console.error('Profile error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Manager notes about a member
app.post('/api/members/:username/notes', requireManager, async (req, res) => {
  const text = String((req.body && req.body.text) || '').trim();
  if (!text) return res.status(400).json({ error: 'Note text is required' });
  if (text.length > 2000) return res.status(400).json({ error: 'Note is too long (max 2000 characters)' });
  if (!memberAccounts().some(m => m.username === req.params.username)) return res.status(404).json({ error: 'Member not found' });
  try {
    const n = await MemberNote.create({ username: req.params.username, text, author: req.session.display || req.session.username });
    res.json({ id: String(n._id), text: n.text, author: n.author, at: n.createdAt });
  } catch (err) {
    console.error('Note error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Result of the one-time taskId migration (counts, backups) — for the manager to verify.
app.get('/api/admin/migration-report', requireManager, async (req, res) => {
  const doc = await Config.findOne({ key: 'taskIdMigration' }).lean();
  res.json((doc && doc.value) || { state: 'not started' });
});

// ── Task definitions (template-style: one task, many members) ──────────────
app.get('/api/task-defs', requireManager, async (req, res) => {
  try {
    const tasks = (await Task.find({}).lean()).map(t => publicTask(t, { withAssignees: true }));
    res.json(tasks);
  } catch (err) {
    console.error('Task defs error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// body: { name, type, label?, dailyTarget?, active?, assignees: [username] }
app.post('/api/task-defs', requireManager, async (req, res) => {
  const t = cleanTaskInput(req.body);
  if (!t) return res.status(400).json({ error: 'name and a valid type are required' });
  const assignees = Array.isArray(req.body.assignees) ? [...new Set(req.body.assignees.map(String))] : [];
  try {
    const taskId = newTaskId();
    const task = await Task.create({ taskId, legacyKey: `task:${taskId}`, ...t, order: 500, assignees });
    await bumpRev(assignees);
    res.json(publicTask(task, { withAssignees: true }));
  } catch (err) {
    console.error('Task create error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// body: any of { name, type, label, dailyTarget, active, assignees }
app.put('/api/task-defs/:taskId', requireManager, async (req, res) => {
  try {
    const task = await Task.findOne({ taskId: req.params.taskId }).lean();
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const t = cleanTaskInput({ ...publicTask(task), ...req.body });
    if (!t) return res.status(400).json({ error: 'name and a valid type are required' });
    await Task.updateOne({ taskId: task.taskId }, { $set: t });
    const updated = Array.isArray(req.body.assignees)
      ? await setAssignees(Task, task.taskId, req.body.assignees)
      : await Task.findOne({ taskId: task.taskId }).lean();
    await bumpRev([...(task.assignees || []), ...(task.formerAssignees || []), ...((updated && updated.assignees) || [])]);
    res.json(publicTask(updated, { withAssignees: true }));
  } catch (err) {
    console.error('Task update error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Save data for any member — used by manager to edit submitted entries
app.post('/api/admin/save', requireManager, async (req, res) => {
  const { username, date, tasks, partial } = req.body;
  if (!username || !date || !tasks) return res.status(400).json({ error: 'Missing fields' });
  const target = username.toLowerCase().trim();
  if (!usersCache[target] && !(await refreshUser(target))) return res.status(404).json({ error: 'User not found' });
  try {
    await saveEntry(target, date, tasks, { partial: !!partial });
    await bumpRev(target);
    res.json({ success: true });
  } catch (err) {
    console.error('Admin save error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});


// ── Work log: clients, task library, assignments, Today and Month ─────────
const YM_RE = /^\d{4}-\d{2}$/, DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const cleanName = (s, max = 80) => String(s || '').trim().replace(/\s+/g, ' ').slice(0, max);
const publicClient = c => ({ clientId: c.clientId, name: c.name, active: c.active !== false, fromTeam: !!c.fromTeam, addedBy: c.addedBy || null });
const actor = req => req.session.display || req.session.username;
const rowUnits = r => parseInt(String(r.value ?? r.links ?? '').replace(/\D+/g, '') || '0', 10);

// Everyone signed in reads the client list (members pick from it)
app.get('/api/clients', async (req, res) => {
  try {
    const q = req.session.role === 'member' ? { active: { $ne: false } } : {};
    res.json((await Client.find(q).lean()).map(publicClient).sort((a, b) => a.name.localeCompare(b.name)));
  } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

// Add a client. A team member may add one while logging work; it is marked for the manager.
app.post('/api/clients', async (req, res) => {
  const name = cleanName(req.body.name);
  if (name.length < 2) return res.status(400).json({ error: 'Write the client name (at least 2 characters)' });
  try {
    const key = worklog.looseName(name);
    const found = await Client.findOne({ key }).lean();
    if (found) {
      if (found.active === false && req.session.role !== 'member') await Client.updateOne({ key }, { $set: { active: true } });
      return res.json({ ...publicClient(found), active: true, existed: true });
    }
    const c = await Client.create({ clientId: newTaskId(), name, key, fromTeam: req.session.role === 'member', addedBy: actor(req) });
    res.json(publicClient(c));
  } catch (err) {
    if (err.code === 11000) { const c = await Client.findOne({ key: worklog.looseName(name) }).lean(); return res.json({ ...publicClient(c), existed: true }); }
    console.error('Client create error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Manager: rename, archive / restore, or accept a client a team member added
app.patch('/api/clients/:id', requireManager, async (req, res) => {
  try {
    const c = await Client.findOne({ clientId: req.params.id }).lean();
    if (!c) return res.status(404).json({ error: 'Client not found' });
    const set = {};
    if (req.body.name !== undefined) {
      const name = cleanName(req.body.name);
      if (name.length < 2) return res.status(400).json({ error: 'Write the client name (at least 2 characters)' });
      const key = worklog.looseName(name);
      if (key !== c.key && await Client.exists({ key })) return res.status(409).json({ error: 'Another client already has that name' });
      Object.assign(set, { name, key });
    }
    if (req.body.active !== undefined) set.active = !!req.body.active;
    if (req.body.fromTeam === false) set.fromTeam = false;
    await Client.updateOne({ clientId: c.clientId }, { $set: set });
    res.json(publicClient({ ...c, ...set }));
  } catch (err) {
    console.error('Client update error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Every line in a month (all members), resolved to a client of the list where possible
// Two names for one client: every line logged for :id moves to body.into, then :id goes away
app.post('/api/clients/:id/merge', requireManager, async (req, res) => {
  try {
    const [c, into] = await Promise.all([Client.findOne({ clientId: req.params.id }).lean(), Client.findOne({ clientId: String(req.body.into || '') }).lean()]);
    if (!c || !into) return res.status(404).json({ error: 'Client not found' });
    if (c.clientId === into.clientId) return res.status(400).json({ error: 'Pick a different client to merge into' });
    let lines = 0;
    const people = new Set();
    for (const e of await Entry.find({}, { username: 1, date: 1, tasks: 1 }).lean()) {
      const set = {};
      for (const [k, v] of Object.entries(e.tasks || {})) {
        if (k.startsWith('_') || !v || !Array.isArray(v.rows)) continue;
        let hit = false;
        const rows = v.rows.map(r => {
          const mine = r.clientId ? r.clientId === c.clientId : worklog.looseName(r.client || '') === c.key;
          if (!mine) return r;
          hit = true; lines++;
          return { ...r, client: into.name, clientId: into.clientId };
        });
        if (hit) set['tasks.' + k + '.rows'] = rows;
      }
      if (Object.keys(set).length) {
        // FerretDB (staging) has no dotted keys: write the whole tasks object
        const tasks = { ...e.tasks };
        for (const [path, rows] of Object.entries(set)) { const k = path.split('.')[1]; tasks[k] = { ...tasks[k], rows }; }
        await Entry.updateOne({ _id: e._id }, { $set: { tasks } });
        people.add(e.username);
      }
    }
    await Client.deleteOne({ clientId: c.clientId });
    await AssignLog.create({ text: `Client ${c.name} merged into ${into.name} (${lines} line${lines === 1 ? '' : 's'} moved)`, by: actor(req), from: localNow().date });
    await bumpRev([...people]);
    res.json({ merged: c.name, into: publicClient(into), lines });
  } catch (err) {
    console.error('Client merge error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

async function monthLines(ym) {
  const from = ym + '-01', to = worklog.monthEnd(ym);
  const [entries, tasks, clients] = await Promise.all([
    Entry.find({ date: { $gte: from, $lte: to } }).lean(), Task.find({}).lean(), Client.find({}).lean()]);
  const byKey = Object.fromEntries(clients.map(c => [c.key, c])), byId = Object.fromEntries(clients.map(c => [c.clientId, c]));
  const tasksById = Object.fromEntries(tasks.map(t => [t.taskId, t]));
  const days = await entriesByDate(entries.map(e => ({ ...e, date: e.username + '|' + e.date })));
  const lines = [];
  for (const [k, day] of Object.entries(days)) {
    const [username, date] = k.split('|');
    for (const [taskId, v] of Object.entries(day || {})) {
      if (taskId.startsWith('_')) continue;
      for (const r of worklog.rowsOf(v)) {
        const name = cleanName(r.client); if (!name) continue;
        const c = (r.clientId && byId[r.clientId]) || byKey[worklog.looseName(name)];
        lines.push({ username, date, taskId, task: tasksById[taskId], client: c || null, name, units: rowUnits(r) });
      }
    }
  }
  return lines;
}

// Manager: the client list with this month's totals, plus names typed in entries that are not in the list
app.get('/api/clients/summary', requireManager, async (req, res) => {
  const today = localNow().date, ym = YM_RE.test(req.query.month || '') ? req.query.month : today.slice(0, 7);
  try {
    const [clients, lines] = await Promise.all([Client.find({}).lean(), monthLines(ym)]);
    const tot = {}, unlisted = {};
    for (const l of lines) {
      if (l.client) tot[l.client.clientId] = (tot[l.client.clientId] || 0) + l.units;
      else { const k = worklog.looseName(l.name); unlisted[k] = unlisted[k] || { name: l.name, units: 0, lines: 0 }; unlisted[k].units += l.units; unlisted[k].lines++; }
    }
    res.json({ month: ym, label: worklog.monthLabel(ym),
      clients: clients.map(c => ({ ...publicClient(c), total: tot[c.clientId] || 0 })).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)),
      unlisted: Object.values(unlisted).sort((a, b) => b.units - a.units).slice(0, 50) });
  } catch (err) {
    console.error('Client summary error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Manager: one client's month — which task, by whom, how much
app.get('/api/clients/:id/work', requireManager, async (req, res) => {
  const today = localNow().date, ym = YM_RE.test(req.query.month || '') ? req.query.month : today.slice(0, 7);
  try {
    const c = await Client.findOne({ clientId: req.params.id }).lean();
    if (!c) return res.status(404).json({ error: 'Client not found' });
    const rows = {};
    for (const l of await monthLines(ym)) {
      if (!l.client || l.client.clientId !== c.clientId) continue;
      const k = l.taskId + '|' + l.username;
      const t = l.task || {};
      rows[k] = rows[k] || { taskName: titleCase(t.name || 'Task'), unit: t.unit || worklog.unitFromLabel(t), group: t.group || 'Other',
        username: l.username, display: (getUser(l.username) || {}).display || l.username, units: 0, days: new Set() };
      rows[k].units += l.units; rows[k].days.add(l.date);
    }
    const list = Object.values(rows).map(r => ({ ...r, days: r.days.size })).sort((a, b) => a.group.localeCompare(b.group) || b.units - a.units);
    res.json({ client: publicClient(c), month: ym, label: worklog.monthLabel(ym), total: list.reduce((a, r) => a + r.units, 0), rows: list });
  } catch (err) {
    console.error('Client work error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// The Assignments board: task library rows × team members, each cell the member's target today
async function boardData() {
  const today = localNow().date;
  const members = memberAccounts({ activeOnly: true });
  const [tasks, rows, log] = await Promise.all([Task.find({}).lean(), Assignment.find({}).lean(), AssignLog.find({}).sort({ createdAt: -1 }).limit(30).lean()]);
  const idx = new Map();
  for (const r of rows) { const k = r.username + '|' + r.taskId; if (!idx.has(k)) idx.set(k, []); idx.get(k).push(r); }
  const library = worklog.libraryOf(tasks).filter(l => l.active).map(lib => {
    const cells = {};
    for (const m of members) {
      const taskId = worklog.taskIdFor(lib, m.username), task = lib.tasks.find(t => t.taskId === taskId);
      const mine = (idx.get(m.username + '|' + taskId) || []).sort((a, b) => a.from.localeCompare(b.from));
      let now = null, next = null;
      if (mine.length) {
        const cur = mine.find(r => worklog.covers(r, today));
        if (cur) now = { target: cur.target ?? null, since: cur.from > worklog.BEGINNING ? cur.from : null };
        const fut = mine.find(r => r.from > today);
        if (fut) next = { from: fut.from, target: fut.target ?? null };
        else if (cur && cur.to) next = { from: addDay(cur.to, 1), target: null, ends: true };
      } else if ((task.assignees || []).includes(m.username) && task.active !== false) now = { target: task.dailyTarget ?? null, since: null };
      if (now || next) cells[m.username] = { taskId, ...(now || { target: null, notYet: true }), next };
    }
    return { key: lib.key, name: titleCase(lib.name), unit: lib.unit, group: lib.group, note: lib.note, cells };
  });
  const groups = [...new Set(library.map(l => l.group))].sort((a, b) => (a === 'Other') - (b === 'Other') || a.localeCompare(b));
  const archived = worklog.libraryOf(tasks).filter(l => !l.active).map(l => {
    const had = new Set(); l.tasks.forEach(t => [...(t.assignees || []), ...(t.formerAssignees || [])].forEach(u => had.add(u)));
    return { key: l.key, name: titleCase(l.name), unit: l.unit, group: l.group, note: l.note, had: had.size,
             archivedAt: l.tasks.map(t => t.archivedAt).filter(Boolean).sort().pop() || null };
  }).sort((a, b) => (b.archivedAt || '').localeCompare(a.archivedAt || '') || a.name.localeCompare(b.name));
  return { today, members: members.map(m => ({ username: m.username, display: m.display })), groups, library, archived,
           log: log.map(l => ({ text: l.text, by: l.by, at: l.createdAt })) };
}
app.get('/api/assign/board', requireManager, async (req, res) => {
  try { res.json(await boardData()); }
  catch (err) { console.error('Board error:', err); res.status(500).json({ error: 'Database error' }); }
});

async function libraryRow(key) {
  const tasks = await Task.find({}).lean();
  return worklog.libraryOf(tasks).find(l => l.key === key || l.taskIds.includes(key)) || null;
}
const UNIT_RE = /^[\p{L}\d .&/+-]{1,24}$/u;

// New task in the library (counted in units, logged as task · client · how many)
app.post('/api/library', requireManager, async (req, res) => {
  const name = titleCase(cleanName(req.body.name, 60)), unit = cleanName(req.body.unit || 'items', 24).toLowerCase(), group = cleanName(req.body.group || 'Other', 40);
  if (name.length < 2) return res.status(400).json({ error: 'Write the task name' });
  if (!UNIT_RE.test(unit)) return res.status(400).json({ error: 'Write what is counted, e.g. links, posts, audits' });
  try {
    const tasks = await Task.find({}).lean();
    if (worklog.libraryOf(tasks).some(l => l.active && worklog.looseName(l.name) === worklog.looseName(name)))
      return res.status(409).json({ error: 'A task with that name already exists' });
    const taskId = newTaskId();
    await Task.create({ taskId, legacyKey: `task:${taskId}`, name, type: 'links', label: unit, unit, group, dailyTarget: null, order: 500, assignees: [] });
    await AssignLog.create({ text: `New task: ${name} (${unit}) in ${group}`, by: actor(req), from: localNow().date });
    res.json(await boardData());
  } catch (err) {
    console.error('Library create error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Rename a task, change its unit or group, or archive it (archiving ends it for everyone today)
app.patch('/api/library/:key', requireManager, async (req, res) => {
  try {
    const lib = await libraryRow(req.params.key);
    if (!lib) return res.status(404).json({ error: 'Task not found' });
    const set = {}, people = new Set();
    lib.tasks.forEach(t => [...(t.assignees || []), ...(t.formerAssignees || [])].forEach(u => people.add(u)));
    if (req.body.name !== undefined) {
      const name = titleCase(cleanName(req.body.name, 60));
      if (name.length < 2) return res.status(400).json({ error: 'Write the task name' });
      const others = worklog.libraryOf(await Task.find({}).lean()).filter(l => l.key !== lib.key && l.active);
      if (others.some(l => worklog.looseName(l.name) === worklog.looseName(name))) return res.status(409).json({ error: 'A task with that name already exists' });
      set.name = name;
    }
    if (req.body.unit !== undefined) {
      const unit = cleanName(req.body.unit, 24).toLowerCase();
      if (!UNIT_RE.test(unit)) return res.status(400).json({ error: 'Write what is counted, e.g. links, posts, audits' });
      Object.assign(set, { unit, label: unit });
    }
    if (req.body.group !== undefined) set.group = cleanName(req.body.group, 40) || 'Other';
    const today = localNow().date;
    if (req.body.archive === true) {
      for (const t of lib.tasks) for (const u of new Set([...(t.assignees || [])]))
        await worklog.endAssignment({ Task, Assignment }, { username: u, taskId: t.taskId, from: today, by: actor(req) });
      await Assignment.deleteMany({ taskId: { $in: lib.taskIds }, from: { $gt: today } });
      set.active = false; set.archivedAt = today;
    }
    if (req.body.restore === true && !lib.active) {
      const others = worklog.libraryOf(await Task.find({}).lean()).filter(l => l.key !== lib.key && l.active);
      if (others.some(l => worklog.looseName(l.name) === worklog.looseName(set.name || lib.name)))
        return res.status(409).json({ error: 'An active task already has this name. Rename one of them first.' });
      set.active = true;
    }
    if (Object.keys(set).length) await Task.updateMany({ taskId: { $in: lib.taskIds } }, { $set: set });
    if (req.body.archive === true) {
      for (const t of lib.tasks) await Task.updateOne({ taskId: t.taskId }, { $set: { assignees: [] }, $addToSet: { formerAssignees: { $each: t.assignees || [] } } });
    }
    const changed = await worklog.syncAssignees({ Task, Assignment }, today);
    await bumpRev([...people, ...changed]);
    const what = req.body.archive ? 'archived (history kept)' : set.active === true ? 'restored' : [set.name && `renamed to ${set.name}`, set.unit && `counted in ${set.unit}`, set.group && `moved to ${set.group}`].filter(Boolean).join(', ');
    if (what) await AssignLog.create({ text: `${titleCase(lib.name)}: ${what}`, by: actor(req), from: today });
    res.json(await boardData());
  } catch (err) {
    console.error('Library update error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Give a task to a member (or change the target, or move it to someone else) from a date on.
// body: { username, key, target, from, moveTo? }      from: today or later (past months stay as they were)
app.put('/api/assign', requireManager, async (req, res) => {
  const { username, key, moveTo } = req.body;
  const today = localNow().date, from = DAY_RE.test(req.body.from || '') ? req.body.from : today;
  const target = req.body.target === '' || req.body.target == null ? null : Number(req.body.target);
  if (from < today) return res.status(400).json({ error: 'Changes start today or later, so past days keep their targets' });
  if (target !== null && !(Number.isFinite(target) && target >= 0 && target <= 100000)) return res.status(400).json({ error: 'The daily target must be a number' });
  const members = Object.fromEntries(memberAccounts({ activeOnly: true }).map(m => [m.username, m]));
  if (!members[username] || (moveTo && !members[moveTo])) return res.status(404).json({ error: 'Member not found' });
  try {
    const lib = await libraryRow(key);
    if (!lib || !lib.active) return res.status(404).json({ error: 'Task not found' });
    const name = titleCase(lib.name), when = from === today ? 'today' : from;
    const by = actor(req);
    if (moveTo) {
      await worklog.endAssignment({ Task, Assignment }, { username, taskId: worklog.taskIdFor(lib, username), from, by });
      await worklog.setAssignment({ Task, Assignment }, { username: moveTo, taskId: worklog.taskIdFor(lib, moveTo), target, from, by });
      await AssignLog.create({ text: `From ${when}: ${name} moves from ${members[username].display} to ${members[moveTo].display}` + (target ? ` (${target} ${lib.unit}/day)` : ''), by, from });
    } else {
      const taskId = worklog.taskIdFor(lib, username);
      const had = (await Assignment.exists({ username, taskId })) || (lib.tasks.find(t => t.taskId === taskId).assignees || []).includes(username);
      await worklog.setAssignment({ Task, Assignment }, { username, taskId, target, from, by });
      await AssignLog.create({ text: `From ${when}: ${members[username].display} · ${name} ` + (had ? `target ${target ?? 'none'}` : `assigned` + (target ? `, ${target} ${lib.unit}/day` : '')), by, from });
    }
    const changed = await worklog.syncAssignees({ Task, Assignment }, today);
    await bumpRev([username, moveTo, ...changed]);
    res.json(await boardData());
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Assign error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Take a task away from a member from a date on (their past work stays in the reports)
app.delete('/api/assign', requireManager, async (req, res) => {
  const { username, key } = req.body;
  const today = localNow().date, from = DAY_RE.test(req.body.from || '') ? req.body.from : today;
  if (from < today) return res.status(400).json({ error: 'Changes start today or later, so past days keep their targets' });
  try {
    const lib = await libraryRow(key);
    if (!lib) return res.status(404).json({ error: 'Task not found' });
    await worklog.endAssignment({ Task, Assignment }, { username, taskId: worklog.taskIdFor(lib, username), from, by: actor(req) });
    const display = (getUser(username) || {}).display || username;
    await AssignLog.create({ text: `From ${from === today ? 'today' : from}: ${titleCase(lib.name)} removed from ${display}. Past work stays in the reports.`, by: actor(req), from });
    const changed = await worklog.syncAssignees({ Task, Assignment }, today);
    await bumpRev([username, ...changed]);
    res.json(await boardData());
  } catch (err) {
    console.error('Unassign error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// A new teammate starts with the same tasks and targets as someone else. body: { username, from: source }
app.post('/api/assign/copy', requireManager, async (req, res) => {
  const { username, source } = req.body;
  const today = localNow().date;
  const members = Object.fromEntries(memberAccounts({ activeOnly: true }).map(m => [m.username, m]));
  if (!members[username] || !members[source] || username === source) return res.status(404).json({ error: 'Member not found' });
  try {
    const board = await boardData();
    let n = 0;
    for (const lib of board.library) {
      const c = lib.cells[source];
      if (!c || c.notYet) continue;
      const full = await libraryRow(lib.key);
      await worklog.setAssignment({ Task, Assignment }, { username, taskId: worklog.taskIdFor(full, username), target: c.target, from: today, by: actor(req) });
      n++;
    }
    await AssignLog.create({ text: `From today: ${members[username].display} starts with the ${n} tasks and targets of ${members[source].display}`, by: actor(req), from: today });
    await worklog.syncAssignees({ Task, Assignment }, today);
    await bumpRev(username);
    res.json(await boardData());
  } catch (err) {
    console.error('Assign copy error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// One task to several people at once, or one target for everyone who has it.
// body: { key, usernames: [...], target, from }
app.put('/api/assign/many', requireManager, async (req, res) => {
  const { key } = req.body;
  const today = localNow().date, from = DAY_RE.test(req.body.from || '') ? req.body.from : today;
  const target = req.body.target === '' || req.body.target == null ? null : Number(req.body.target);
  const usernames = [...new Set(Array.isArray(req.body.usernames) ? req.body.usernames.map(String) : [])];
  if (from < today) return res.status(400).json({ error: 'Changes start today or later, so past days keep their targets' });
  if (target !== null && !(Number.isFinite(target) && target >= 0 && target <= 100000)) return res.status(400).json({ error: 'The daily target must be a number' });
  if (!usernames.length) return res.status(400).json({ error: 'Pick at least one person' });
  const members = Object.fromEntries(memberAccounts({ activeOnly: true }).map(m => [m.username, m]));
  if (usernames.some(u => !members[u])) return res.status(404).json({ error: 'Member not found' });
  try {
    const lib = await libraryRow(key);
    if (!lib || !lib.active) return res.status(404).json({ error: 'Task not found' });
    const by = actor(req);
    for (const username of usernames)
      await worklog.setAssignment({ Task, Assignment }, { username, taskId: worklog.taskIdFor(lib, username), target: lib.note ? null : target, from, by });
    await AssignLog.create({ text: `From ${from === today ? 'today' : from}: ${titleCase(lib.name)} for ${usernames.map(u => members[u].display).join(', ')}` +
      (lib.note ? '' : target === null ? ', no target' : `, ${target} ${lib.unit}/day`), by, from });
    const changed = await worklog.syncAssignees({ Task, Assignment }, today);
    await bumpRev([...usernames, ...changed]);
    res.json(await boardData());
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Assign many error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Work rules (Settings → Work rules)
app.get('/api/rules', requireManager, (req, res) => res.json({ ...rules.get(), today: localNow().date }));
app.put('/api/rules', requireManagerOnly, async (req, res) => {
  try {
    const today = localNow().date;
    await syncRules(true);
    const next = rules.merge(rules.get(), req.body || {}, today);
    await Config.updateOne({ key: 'workRules' }, { $set: { value: next } }, { upsert: true });
    rules.set(next); rulesSyncedAt = Date.now();
    await AssignLog.create({ text: 'Work rules updated', by: actor(req), from: today });
    await bumpRev(memberAccounts({ activeOnly: true }).map(m => m.username));
    res.json({ ...rules.get(), today });
  } catch (err) {
    console.error('Rules save error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Today: every active member's work so far (done vs target per task)
app.get('/api/work/today', requireManager, async (req, res) => {
  try {
    const today = localNow().date, members = memberAccounts({ activeOnly: true });
    const usernames = members.map(m => m.username);
    const [{ tasksById, byUser }, docs] = await Promise.all([
      loadMembers({ Task, Entry, Attendance, Assignment }, usernames, today, today),
      Entry.find({ username: { $in: usernames }, date: today }, { username: 1, updatedAt: 1 }).lean()]);
    const docBy = Object.fromEntries(docs.map(d => [d.username, d]));
    const rows = members.map(m => { const r = worklog.todayRow(tasksById, m, byUser[m.username], today, docBy[m.username]);
      return { ...r, tasks: r.tasks.map(t => ({ ...t, name: titleCase(t.name) })) }; });
    res.json({ date: today, time: localNow().time, rows });
  } catch (err) {
    console.error('Today error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Month: the team (one row per member) or one member in detail, against the previous month
async function monthFor(usernames, ym) {
  const today = localNow().date, prev = worklog.prevMonth(ym);
  const to = worklog.monthEnd(ym) < today ? worklog.monthEnd(ym) : today;
  const { tasksById, byUser } = await loadMembers({ Task, Entry, Attendance, Assignment }, usernames, prev + '-01', to);
  return { today, prev, tasksById, byUser };
}
const titled = m => m && { ...m, tasks: m.tasks.map(t => ({ ...t, name: titleCase(t.name) })) };
app.get('/api/work/month', requireManager, async (req, res) => {
  const today = localNow().date, ym = YM_RE.test(req.query.month || '') ? req.query.month : today.slice(0, 7);
  if (ym > today.slice(0, 7)) return res.status(400).json({ error: 'That month has not started yet' });
  try {
    const members = memberAccounts();
    const { prev, tasksById, byUser } = await monthFor(members.map(m => m.username), ym);
    const rows = members.map(m => {
      const cur = worklog.monthOf(tasksById, byUser[m.username], ym, today), before = worklog.monthOf(tasksById, byUser[m.username], prev, today);
      if (!cur.present && !cur.tasks.length && m.active === false) return null;
      const scored = cur.tasks.filter(t => t.pct !== null).sort((a, b) => a.pct - b.pct);
      return { username: m.username, display: m.display, active: m.active !== false, present: cur.present, workdays: cur.workdays,
        score: cur.score, prevScore: before && before.score, tasks: cur.tasks.length,
        met: scored.filter(t => t.pct >= 100).length, scoredTasks: scored.length,
        taskList: cur.tasks.map(t => ({ taskId: t.taskId, name: titleCase(t.name), unit: t.unit, done: t.done, potential: t.potential, target: t.target, pct: t.pct })),
        weakest: scored.length && scored[0].pct < 85 ? { name: titleCase(scored[0].name), pct: scored[0].pct } : null };
    }).filter(Boolean);
    res.json({ month: ym, label: worklog.monthLabel(ym), prevLabel: worklog.monthLabel(prev), running: ym === today.slice(0, 7), rows });
  } catch (err) {
    console.error('Month error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});
app.get('/api/work/month/:username', requireManager, async (req, res) => {
  const today = localNow().date, ym = YM_RE.test(req.query.month || '') ? req.query.month : today.slice(0, 7);
  const m = memberAccounts().find(x => x.username === req.params.username);
  if (!m) return res.status(404).json({ error: 'Member not found' });
  if (ym > today.slice(0, 7)) return res.status(400).json({ error: 'That month has not started yet' });
  try {
    const { prev, tasksById, byUser } = await monthFor([m.username], ym);
    const cur = titled(worklog.monthOf(tasksById, byUser[m.username], ym, today)), before = titled(worklog.monthOf(tasksById, byUser[m.username], prev, today));
    cur.clientTasks = cur.clientTasks.map(c => ({ ...c, task: titleCase(c.task) }));
    const prevBy = Object.fromEntries(((before && before.tasks) || []).map(t => [t.taskId, t]));
    cur.tasks.forEach(t => { const p = prevBy[t.taskId]; t.prevAvg = p ? p.avg : null; });
    res.json({ member: { username: m.username, display: m.display, active: m.active !== false }, prevLabel: worklog.monthLabel(prev),
               prevScore: before && before.score, ...cur });
  } catch (err) {
    console.error('Member month error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Correction requests ───────────────────────────────────────────────────
const publicCorrection = c => ({ id: String(c._id), username: c.username, date: c.date, kind: c.kind, taskId: c.taskId || null, taskName: c.taskName || null,
  message: c.message, status: c.status, reply: c.reply || '', resolvedBy: c.resolvedBy || null, resolvedAt: c.resolvedAt || null, createdAt: c.createdAt });
const MAX_OPEN_CORRECTIONS = 10;

// Member: ask for a correction. body: { date, kind: attendance|task|other, taskId?, message }
app.post('/api/corrections', async (req, res) => {
  if (req.session.role !== 'member') return res.status(403).json({ error: 'Only team members send correction requests' });
  const { date, kind, taskId } = req.body;
  const message = String(req.body.message || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({ error: 'Pick the day to correct' });
  if (date > localNow().date) return res.status(400).json({ error: 'That day has not happened yet' });
  if (!['attendance', 'task', 'other'].includes(kind)) return res.status(400).json({ error: 'Choose what needs correcting' });
  if (message.length < 5) return res.status(400).json({ error: 'Write what should be corrected (at least 5 characters)' });
  if (message.length > 1000) return res.status(400).json({ error: 'Please keep it under 1000 characters' });
  try {
    let taskName;
    if (kind === 'task') {
      const t = taskId && await Task.findOne({ taskId, $or: [{ assignees: req.session.username }, { formerAssignees: req.session.username }] }).lean();
      if (!t) return res.status(400).json({ error: 'Choose which task' });
      taskName = titleCase(t.name);
    }
    if (await Correction.countDocuments({ username: req.session.username, status: 'open' }) >= MAX_OPEN_CORRECTIONS)
      return res.status(429).json({ error: 'You already have ' + MAX_OPEN_CORRECTIONS + ' open requests — wait for your manager to answer them' });
    const c = await Correction.create({ username: req.session.username, date, kind, taskId: kind === 'task' ? taskId : undefined, taskName, message });
    res.json({ success: true, correction: publicCorrection(c) });
  } catch (err) {
    console.error('Correction create error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Member: own requests (newest first)
app.get('/api/my/corrections', async (req, res) => {
  try {
    const list = await Correction.find({ username: req.session.username }).sort({ createdAt: -1 }).limit(50).lean();
    res.json(list.map(publicCorrection));
  } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

// Manager: requests (?status=open|done|declined|all, ?username=)
app.get('/api/corrections', requireManager, async (req, res) => {
  const q = {};
  if (['open', 'done', 'declined'].includes(req.query.status)) q.status = req.query.status;
  if (req.query.username) q.username = String(req.query.username);
  try {
    const list = await Correction.find(q).sort({ createdAt: -1 }).limit(200).lean();
    res.json(list.map(publicCorrection));
  } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

// Manager: close a request. body: { status: done|declined, reply? }
app.patch('/api/corrections/:id', requireManager, async (req, res) => {
  const { status } = req.body;
  if (!['done', 'declined'].includes(status)) return res.status(400).json({ error: 'status must be done or declined' });
  const reply = String(req.body.reply || '').trim().slice(0, 1000);
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Request not found' });
    // Only an open request can be answered — atomically, so two managers can't both answer it
    const c = await Correction.findOneAndUpdate({ _id: req.params.id, status: 'open' },
      { $set: { status, reply, resolvedBy: req.session.display || req.session.username, resolvedAt: new Date() } }, { new: true });
    if (!c) return (await Correction.exists({ _id: req.params.id }))
      ? res.status(409).json({ error: 'This request was already answered' })
      : res.status(404).json({ error: 'Request not found' });
    await bumpRev(c.username);    // the member's open page shows the answer
    res.json({ success: true, correction: publicCorrection(c) });
  } catch (err) {
    console.error('Correction update error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Every account for Settings (managers are listed but cannot be changed here)
app.get('/api/admin/accounts', requireManager, async (req, res) => {
  try {
    const users = await User.find({}, { _id: 0, username: 1, role: 1, display: 1, shift: 1, active: 1, lastActiveAt: 1, passwordVersion: 1 }).lean();
    const order = { manager: 0, assistant: 1, member: 2 };
    res.json(users
      .map(u => ({ username: u.username, display: u.display, role: u.role, shift: u.shift || null,
                   active: u.active !== false, lastActiveAt: u.lastActiveAt || null,
                   // An account from the old code list that never changed its password still uses the
                   // default that was written in the code (it is visible in the git history).
                   defaultPassword: !!USERS[u.username] && (u.passwordVersion || 1) <= 1 }))
      .sort((a, b) => (order[a.role] ?? 3) - (order[b.role] ?? 3) || a.display.localeCompare(b.display)));
  } catch (err) {
    console.error('Accounts error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

const SHIFTS = ['day', 'night'];
const USERNAME_RE = /^[a-z0-9._-]+$/;

// A member or assistant account that the manager may change (never a manager, never yourself)
async function editableAccount(req, res) {
  const target = String(req.params.username || '').toLowerCase().trim();
  const user = await refreshUser(target);
  if (!user) { res.status(404).json({ error: 'User not found' }); return null; }
  if (user.role === 'manager') { res.status(403).json({ error: 'Manager accounts cannot be changed here' }); return null; }
  if (target === req.session.username) { res.status(403).json({ error: 'You cannot change your own account here' }); return null; }
  return { target, user };
}

// Names must be unique (dashboard routes address members by name). Checked in the database.
async function displayTaken(display, exceptUsername = null) {
  const users = await User.find({}, { _id: 0, username: 1, display: 1 }).lean();
  return users.some(u => u.username !== exceptUsername && String(u.display).toLowerCase() === display.toLowerCase());
}

// Add a new member (manager only). body: { display, username, password, role, shift }
app.post('/api/admin/members', requireManagerOnly, async (req, res) => {
  let { username, password, role, display, shift } = req.body;
  if (!username || !password || !display) return res.status(400).json({ error: 'Missing required fields' });
  if (password.length < 6) return res.status(400).json({ error: 'Password too short (min 6 chars)' });
  const uname = username.toLowerCase().trim();
  const dname = display.trim();
  if (!uname || !USERNAME_RE.test(uname)) return res.status(400).json({ error: 'Username may only contain letters, numbers, dots, underscores, hyphens' });
  if (!dname) return res.status(400).json({ error: 'Full name is required' });
  // the database decides (this instance's cache may be stale)
  if (await refreshUser(uname)) return res.status(409).json({ error: 'Username already exists' });
  const removedDoc = await Config.findOne({ key: 'removedUsers' }).lean();
  if (((removedDoc && removedDoc.value) || []).includes(uname))
    return res.status(409).json({ error: 'This username belonged to a removed member and their past work is still saved under it. Pick another username, e.g. ' + uname + '2' });
  if (await displayTaken(dname)) return res.status(409).json({ error: 'A member with this name already exists' });
  const userRole  = ['member', 'assistant'].includes(role) ? role : 'member';
  const userShift = SHIFTS.includes(shift) ? shift : null;
  try {
    const hashed = await hashPassword(password);
    await User.create({ username: uname, password: hashed, role: userRole, display: dname, passwordVersion: 1,
                        shift: userShift || undefined, active: true });
    await Config.updateOne({ key: 'removedUsers' }, { $pull: { value: uname } });
    await refreshUser(uname);
    res.json({ success: true, username: uname, display: dname, role: userRole, shift: userShift });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Username already exists' });
    console.error('Add member error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Change name, shift or active state (manager only). body: any of { display, shift, active }
app.patch('/api/admin/members/:username', requireManagerOnly, async (req, res) => {
  const acc = await editableAccount(req, res);
  if (!acc) return;
  const set = {}, unset = {};
  if (req.body.display !== undefined) {
    const dname = String(req.body.display).trim();
    if (!dname) return res.status(400).json({ error: 'Full name is required' });
    if (await displayTaken(dname, acc.target)) return res.status(409).json({ error: 'A member with this name already exists' });
    set.display = dname;
  }
  if (req.body.shift !== undefined) {
    if (SHIFTS.includes(req.body.shift)) set.shift = req.body.shift;
    else if (!req.body.shift) unset.shift = 1;
    else return res.status(400).json({ error: 'Shift must be day or night' });
  }
  if (req.body.active !== undefined) set.active = req.body.active !== false;
  if (req.body.role !== undefined && req.body.role !== acc.user.role) {
    if (!['member', 'assistant'].includes(req.body.role)) return res.status(400).json({ error: 'Role must be member or assistant' });
    set.role = req.body.role;
  }
  if (!Object.keys(set).length && !Object.keys(unset).length) return res.status(400).json({ error: 'Nothing to change' });
  try {
    const update = {};
    if (Object.keys(set).length)   update.$set   = set;
    if (Object.keys(unset).length) update.$unset = unset;
    await User.updateOne({ username: acc.target }, update);
    // A member who becomes an assistant stops getting tasks from today (past work stays)
    if (set.role === 'assistant') {
      const today = localNow().date;
      await Assignment.deleteMany({ username: acc.target, from: { $gt: today } });
      await Assignment.updateMany({ username: acc.target, $or: [{ to: null }, { to: { $gte: today } }] }, { $set: { to: addDay(today, -1) } });
      await Task.updateMany({ assignees: acc.target }, { $pull: { assignees: acc.target }, $addToSet: { formerAssignees: acc.target } });
      await AssignLog.create({ text: `${acc.user.display} is now an assistant; their tasks end today`, by: actor(req), from: today });
    }
    await bumpRev(acc.target);
    const u = await refreshUser(acc.target);
    res.json({ success: true, username: acc.target, display: u.display, shift: u.shift, active: u.active, role: u.role });
  } catch (err) {
    console.error('Update member error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Remove a member (manager only). body: { confirm: "<username>" } — typed by the manager.
// The account is deleted; entries and attendance stay, their tasks move to "former".
app.delete('/api/admin/members/:username', requireManagerOnly, async (req, res) => {
  const acc = await editableAccount(req, res);
  if (!acc) return;
  if (!req.body || String(req.body.confirm || '').trim().toLowerCase() !== acc.target)
    return res.status(400).json({ error: 'Type the username to confirm' });
  try {
    await User.deleteOne({ username: acc.target });
    await Config.updateOne({ key: 'removedUsers' }, { $addToSet: { value: acc.target } }, { upsert: true });
    // Their assignments end today (yesterday was the last day); history stays
    const today = localNow().date;
    await Assignment.deleteMany({ username: acc.target, from: { $gte: today } });
    await Assignment.updateMany({ username: acc.target, $or: [{ to: null }, { to: { $gte: today } }] }, { $set: { to: addDay(today, -1) } });
    await Task.updateMany({ assignees: acc.target },
      { $pull: { assignees: acc.target }, $addToSet: { formerAssignees: acc.target } });
    delete usersCache[acc.target];
    res.json({ success: true });
  } catch (err) {
    console.error('Remove member error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Attendance helpers ─────────────────────────────────────────────────────
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

// Recalculate totalWorkingMinutes as first-start → last-end minus break time.
//
// Why not sum individual session durations?
// Multiple Start/End cycles on the same day (e.g. accidental End Working then
// re-Start) are treated as one continuous shift, not separate chunks.
// The gap between an accidental End and the next Start is therefore included
// in the total — employees should use Check Out / Check In for intentional
// breaks, which are properly subtracted via totalCheckOutMinutes.
//
// record.startTime is set ONLY on the first session (see /start route).
// record.endTime   is updated to the latest end on every /end call.
// So these two fields always represent "first clock-in" and "last clock-out".
function recalcWorkMins(record) {
  if (record.startTime && record.endTime) {
    record.totalWorkingMinutes = Math.max(0,
      timeDiffMins(record.startTime, record.endTime) - (record.totalCheckOutMinutes || 0)
    );
  }
}

// ── Records belong to the day they happen ──────────────────────────────────
// Attendance times come from the SERVER clock (team time zone), never from the browser,
// and members can only write today's records — plus yesterday's while a night shift that
// started yesterday is still open. Older (and future) days are locked; only the manager
// can change them.
const addDay = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function shiftOpen(r) {
  if (!r || !r.startTime) return false;
  const sessions = r.sessions || [];
  return sessions.length ? sessions.some(s => s.startTime && !s.endTime) : !r.endTime;
}
async function memberDays(username) {
  const today = localNow().date, yesterday = addDay(today, -1);
  const y = await Attendance.findOne({ username, date: yesterday }, { startTime: 1, endTime: 1, sessions: 1 }).lean();
  const open = shiftOpen(y);
  return { today, yesterday, editable: open || rules.get().editYesterday ? [yesterday, today] : [today], nightShiftOpen: open };
}
const LOCKED_MSG = 'This day is locked. Ask your manager if something needs to change.';

// ── Attendance routes ──────────────────────────────────────────────────────

// POST /api/attendance/start — start a working session (supports multiple sessions per day)
app.post('/api/attendance/start', async (req, res) => {
  const { workMode, date: reqDate } = req.body;
  if (!workMode || !['WFH', 'WFO'].includes(workMode))
    return res.status(400).json({ error: 'workMode must be WFH or WFO' });
  // The shift's day: today, or yesterday for a night shift that began before midnight
  const clock     = localNow();
  const date      = reqDate || clock.date;
  if (date !== clock.date && date !== addDay(clock.date, -1))
    return res.status(400).json({ error: 'You can only start today (or yesterday for a night shift).' });
  const startTime = clock.time;   // server clock — the browser's time is never used
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
  const { date: reqDate } = req.body;
  const clock = localNow();
  const date  = reqDate || clock.date;
  if (date !== clock.date && date !== addDay(clock.date, -1))
    return res.status(400).json({ error: LOCKED_MSG });
  const endTime = clock.time;   // server clock
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
// Check Out is intentionally independent of the Start/End Working (screen-share)
// state. An employee can check out at any point after their first Start Working,
// regardless of how many End/Start cycles have happened that day.
// The only guards are: (1) must have started today, (2) not already checked out.
app.post('/api/attendance/checkout', async (req, res) => {
  const { date: reqDate } = req.body;
  const clock = localNow();
  const date  = reqDate || clock.date;
  if (date !== clock.date && date !== addDay(clock.date, -1))
    return res.status(400).json({ error: LOCKED_MSG });
  const outTime = clock.time;   // server clock
  try {
    const record = await Attendance.findOne({ username: req.session.username, date });
    if (!record || !record.startTime)
      return res.status(400).json({ error: 'Not working yet' });
    // NOTE: deliberately no check on record.endTime — checkout is allowed even
    // after an End Working, because the employee may Start Working again the
    // same day and should never be locked out of the break system.
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
  const { date: reqDate } = req.body;
  const clock = localNow();
  const date  = reqDate || clock.date;
  if (date !== clock.date && date !== addDay(clock.date, -1))
    return res.status(400).json({ error: LOCKED_MSG });
  const inTime = clock.time;   // server clock
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
    if (req.session.role === 'member') {
      if (record.username !== req.session.username) return res.status(403).json({ error: 'Access denied' });
      if (!(await memberDays(req.session.username)).editable.includes(record.date)) return res.status(403).json({ error: LOCKED_MSG });
    }
    record.note = String(note).trim();
    await record.save();
    if (record.username !== req.session.username) await bumpRev(record.username);
    res.json({ success: true, record });
  } catch (err) {
    console.error('Attendance note error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/attendance/today — current user's today record
app.get('/api/attendance/today', async (req, res) => {
  try {
    const { today, yesterday, nightShiftOpen } = await memberDays(req.session.username);
    const record = await Attendance.findOne({ username: req.session.username, date: today });
    // a night shift that started yesterday and is still open is "today's" shift
    if (!shiftOpen(record) && nightShiftOpen) return res.json(await Attendance.findOne({ username: req.session.username, date: yesterday }));
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
  // Attendance times are records: only the manager (or assistant) corrects them
  if (req.session.role === 'member')
    return res.status(403).json({ error: 'Only your manager can change attendance times.' });
  try {
    const record = await Attendance.findById(req.params.id);
    if (!record) return res.status(404).json({ error: 'Record not found' });
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
    if (record.username !== req.session.username) await bumpRev(record.username);
    res.json({ success: true, record });
  } catch (err) {
    console.error('Attendance edit error:', err);
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
    console.log('  └─────────────────────────────────────────────┘');
    console.log('');
  });
}

module.exports = app;