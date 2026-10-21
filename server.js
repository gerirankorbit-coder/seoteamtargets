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
  entryTasksV2, saveMemberTaskList, resetMemberTasks, setAssignees, migrateToTaskIds,
} = require('./lib/tasks');
const { buildOverview } = require('./lib/overview');
const { buildTeam, buildProfile, buildMySummary } = require('./lib/team');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── MongoDB connection ─────────────────────────────────────────────────────
let dbError = null, startupError = null; // last failures, shown by /api/staging/health
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
    await Promise.all([Task.init(), Config.init()]);

    if (!IS_PRODUCTION) await require('./lib/staging-seed').seedStagingData({ User, Entry, Attendance, Config, Task });

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
  }
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
    { name: "Geo Fencing",            type: "layers",     label: "Layers" },
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
    { name: "Web 2.0 Blogs",      type: "links", label: "Links" },
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
    { name: "Content Write Keywords Tracking", type: "count", label: "Keywords" },
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
    { name: "Client Name",        type: "note",       label: "Clients" },
    { name: "Image Profile",      type: "count",      label: "Profiles" },
  ],
  "Ali Miraj Din": [
    { name: "Profile Creation", type: "count_note", label: "Profiles" },
    { name: "Local Citations",  type: "count_note", label: "Citations" },
    { name: "GEO Tagging",      type: "count",      label: "Tagged" },
    { name: "Quora",            type: "links_note", label: "Links" },
    { name: "Reddit",           type: "links_note", label: "Links" },
  ],
  "Muhammad Asim": [
    { name: "Profile Creations",   type: "count",      label: "Profiles" },
    { name: "Podcast Submission",  type: "count",      label: "Podcasts" },
    { name: "Image Submission",    type: "count",      label: "Images" },
    { name: "Video Submission",    type: "count",      label: "Videos" },
    { name: "Google Properties",   type: "count_note", label: "Count" },
    { name: "Google Site Blogs",   type: "links",      label: "Links" },
    { name: "Reddit Profile",      type: "count",      label: "Profiles" },
    { name: "Quora",               type: "links_note", label: "Links" },
    { name: "Google Sites",        type: "count",      label: "Sites" },
  ],
  "Anas Irfan": [
    { name: "GMB Guest Posting", type: "count", label: "Posts" },
    { name: "Keyword Research",  type: "count", label: "Keywords" },
    { name: "Reddit Profile",    type: "count", label: "Profiles" },
  ],
  "Mazhar": [
    { name: "Blogs Uploading",   type: "links",      label: "Links" },
    { name: "On Page Technical", type: "note",       label: "Notes" },
    { name: "Web 2.0 Blogs",     type: "links",      label: "Links" },
    { name: "Reddit",            type: "links_note", label: "Links" },
  ],
  "Anas Raza": [
    { name: "Profiles",           type: "count",      label: "Profiles" },
    { name: "Video Submission",   type: "count",      label: "Videos" },
    { name: "Podcast Submission", type: "count",      label: "Podcasts" },
    { name: "Image Submission",   type: "count",      label: "Images" },
    { name: "Reddit Profile",     type: "count",      label: "Profiles" },
    { name: "Quora",              type: "links_note", label: "Links" },
  ],
  "Atif Ahmad": [
    { name: "Quora",          type: "links_note", label: "Links" },
    { name: "Profile",        type: "count",      label: "Profiles" },
    { name: "Citations",      type: "count",      label: "Citations" },
    { name: "Reddit Profile", type: "count",      label: "Profiles" },
  ],
};

// Pre-V2 task list of a member (used only by the migration): a manager-saved override
// wins, plus TEAM tasks added in code after that override was saved.
function legacyMemberTasks(displayName) {
  const defaults = TEAM[displayName] || [];
  const override = taskOverrides[displayName];
  if (!override) return defaults;
  const have     = new Set(override.map(t => t.name));
  const baseline = new Set(taskBaselines[displayName] || []);
  const added    = defaults.filter(t => !have.has(t.name) && !baseline.has(t.name));
  return added.length ? [...override, ...added] : override;
}

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
  if (!IS_PRODUCTION) return require('./lib/staging-seed').TEST_TASKS[username] || null;
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
    'letter-spacing:.05em;pointer-events:none;opacity:.95">STAGING — test data only</div>' +
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

app.get('/login', (req, res) => {
  if (req.session.role === 'manager' || req.session.role === 'assistant') return res.redirect('/dashboard');
  if (req.session.role === 'member') return res.redirect('/member');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
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
    return res.redirect('/login');
  }
  let currentUser = getUser(req.session.username), removed = false;
  if (!currentUser || !currentUser.checkedAt || Date.now() - currentUser.checkedAt > VERSION_RECHECK_MS) {
    try { currentUser = await refreshUser(req.session.username); removed = !currentUser; }
    catch (err) { console.error('Session check error:', err); } // keep the session on a DB hiccup
  }
  touchLastActive(req.session);
  // Removed or deactivated from Settings: the session ends (on every instance within 30 s)
  if (removed || (currentUser && currentUser.active === false)) {
    req.session.destroy(() => {});
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'account_deactivated' });
    return res.redirect('/login?reason=deactivated');
  }
  if (currentUser) {
    const currentVer = currentUser.passwordVersion || 1;
    const sessionVer = req.session.passwordVersion  || 1;
    if (sessionVer !== currentVer) {
      req.session.destroy(() => {});
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'password_changed' });
      return res.redirect('/login?reason=password_changed');
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

// ── Protected page routes ──────────────────────────────────────────────────
// Member portal: My Space (/member) and My History (/member/history), one page
app.get(['/member', '/member/history'], (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'member.html')));

// Manager shell: /dashboard is Overview; each sidebar page has its own URL and the
// same page renders it client-side.
const DASHBOARD_PAGES = ['team', 'work', 'attendance', 'tasks', 'reports', 'settings'];
app.get(['/dashboard', '/dashboard/:page', '/dashboard/team/:username'], requireManager, (req, res, next) => {
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
    const u = getUser(req.session.username) || {};
    res.json({ username: req.session.username, display: u.display || req.session.display, role: req.session.role,
               shift: u.shift || null, tasks, historyTasks });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// My Space: the member's own streak, today and "My Week" numbers (own data only)
app.get('/api/my/summary', async (req, res) => {
  try {
    res.json(await buildMySummary({ Task, Entry, Attendance },
      { username: req.session.username, date: req.query.date, time: req.query.time }));
  } catch (err) {
    console.error('My summary error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Entries are saved keyed by taskId (entryVersion 2).
async function saveEntry(username, date, tasks) {
  await Entry.findOneAndUpdate(
    { username, date },
    { username, date, tasks, entryVersion: ENTRY_VERSION },
    { upsert: true, new: true }
  );
}

// Entries → { date: tasks } keyed by taskId (old name-keyed entries converted on the fly).
async function entriesByDate(entries, indexes = new Map()) {
  const out = {};
  for (const e of entries) out[e.date] = await entryTasksV2(Task, e, indexes);
  return out;
}

// Save all tasks for a given date (one document per username+date)
app.post('/api/save', async (req, res) => {
  const { date, tasks } = req.body;
  if (!date || !tasks) return res.status(400).json({ error: 'Missing required fields' });
  try {
    await saveEntry(req.session.username, date, tasks);
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
  const { date, tasks } = req.body;
  const target = req.params.username;
  if (!date || !tasks) return res.status(400).json({ error: 'Missing fields' });
  try {
    await saveEntry(target, date, tasks);
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
    await saveMemberTaskList(Task, username, tasks);
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
    res.json(await buildOverview({ Task, Entry, Attendance, User },
      { members: memberAccounts({ activeOnly: true }), date: req.query.date, time: req.query.time }));
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
    res.json(await buildTeam({ Task, Entry, Attendance }, { members, users, date: req.query.date, time: req.query.time }));
  } catch (err) {
    console.error('Team error:', err);
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
    res.json(await buildProfile({ Task, Entry, Attendance }, {
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
    res.json(publicTask(updated, { withAssignees: true }));
  } catch (err) {
    console.error('Task update error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Save data for any member — used by manager to edit submitted entries
app.post('/api/admin/save', requireManager, async (req, res) => {
  const { username, date, tasks } = req.body;
  if (!username || !date || !tasks) return res.status(400).json({ error: 'Missing fields' });
  const target = username.toLowerCase().trim();
  if (!usersCache[target] && !(await refreshUser(target))) return res.status(404).json({ error: 'User not found' });
  try {
    await saveEntry(target, date, tasks);
    res.json({ success: true });
  } catch (err) {
    console.error('Admin save error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Every account for Settings (managers are listed but cannot be changed here)
app.get('/api/admin/accounts', requireManager, async (req, res) => {
  try {
    const users = await User.find({}, { _id: 0, username: 1, role: 1, display: 1, shift: 1, active: 1, lastActiveAt: 1 }).lean();
    const order = { manager: 0, assistant: 1, member: 2 };
    res.json(users
      .map(u => ({ username: u.username, display: u.display, role: u.role, shift: u.shift || null,
                   active: u.active !== false, lastActiveAt: u.lastActiveAt || null }))
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
  if (!Object.keys(set).length && !Object.keys(unset).length) return res.status(400).json({ error: 'Nothing to change' });
  try {
    const update = {};
    if (Object.keys(set).length)   update.$set   = set;
    if (Object.keys(unset).length) update.$unset = unset;
    await User.updateOne({ username: acc.target }, update);
    const u = await refreshUser(acc.target);
    res.json({ success: true, username: acc.target, display: u.display, shift: u.shift, active: u.active });
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
// Check Out is intentionally independent of the Start/End Working (screen-share)
// state. An employee can check out at any point after their first Start Working,
// regardless of how many End/Start cycles have happened that day.
// The only guards are: (1) must have started today, (2) not already checked out.
app.post('/api/attendance/checkout', async (req, res) => {
  const { time, date: reqDate } = req.body;
  const date    = (reqDate && /^\d{4}-\d{2}-\d{2}$/.test(reqDate)) ? reqDate : new Date().toISOString().split('T')[0];
  const outTime = time || currentTimeStr();
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