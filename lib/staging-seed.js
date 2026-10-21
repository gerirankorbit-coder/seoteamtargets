// Test accounts and TEST data for staging databases only (never production).
//
// seedStagingData(models)                → idempotent: upserts with $setOnInsert, so
//                                          restarts and parallel cold starts never duplicate
// seedStagingData(models, { reset: true }) → also replaces the test.* entries/attendance
//
// Demo day: once per day (first start of the day, one instance via a Config lock)
// "today" is rebuilt for the TEST OV accounts so the Overview always shows every
// state — working, on break, offline, not started, each Needs Attention rule.
'use strict';
const { hashPassword } = require('./passwords');
const { newTaskId, legacyKey, ENTRY_VERSION } = require('./tasks');
const { localNow } = require('./overview');

// Test-only accounts in a staging database (seeding refuses any other database).
const TEST_PASSWORD = process.env.STAGING_TEST_PASSWORD || 'staging-test-123';
const TEST_USERS = [
  { username: 'test.manager', role: 'manager', display: 'TEST Manager' },
  { username: 'test.member1', role: 'member',  display: 'TEST Member One' },
  { username: 'test.member2', role: 'member',  display: 'TEST Member Two' },
  // demo-day accounts (their "today" is rebuilt every day)
  { username: 'test.ov.a',    role: 'member',  display: 'TEST OV A' },
  { username: 'test.ov.b',    role: 'member',  display: 'TEST OV B' },
  { username: 'test.ov.c',    role: 'member',  display: 'TEST OV C' },
  { username: 'test.ov.d',    role: 'member',  display: 'TEST OV D' },
];
// Per test member: task list (with daily targets) — stored as Task documents.
const TEST_TASKS = {
  'test.member1': [
    { name: 'Guest Posting',   type: 'links',      label: 'Links',     dailyTarget: 5 },
    { name: 'Reddit Profile',  type: 'count',      label: 'Profiles',  dailyTarget: 4 },
    { name: 'Quora',           type: 'links_note', label: 'Links',     dailyTarget: null },
  ],
  'test.member2': [
    { name: 'Google Stacking', type: 'layers',     label: 'Layers',    dailyTarget: 3 },
    { name: 'Citations',       type: 'count_note', label: 'Citations', dailyTarget: 6 },
    { name: 'Web Working',     type: 'note',       label: 'Notes',     dailyTarget: null },
  ],
  'test.ov.a': [{ name: 'OV Count A', type: 'count', label: 'Count', dailyTarget: 10 }],
  'test.ov.b': [{ name: 'OV Count B', type: 'count', label: 'Count', dailyTarget: 10 }],
  'test.ov.c': [{ name: 'OV Count C', type: 'count', label: 'Count', dailyTarget: 8 }],
  'test.ov.d': [{ name: 'OV Note D',  type: 'note',  label: 'Notes', dailyTarget: null }],
};

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function testEntries(i, date) {
  return {
    'test.member1': {
      'Guest Posting':  { rows: [{ client: 'TEST Client A', value: String(2 + i) }], total: 2 + i, sectionNote: '' },
      'Reddit Profile': { value: String(3 + i) },
      'Quora':          { links: 'https://example.com/test-quora', text: 'TEST data' },
    },
    'test.member2': {
      'Google Stacking': { rows: [{ client: 'TEST Client B', value: String(1 + i) }], total: 1 + i, sectionNote: '' },
      'Citations':       { value: String(5 + i), text: 'TEST data' },
      'Web Working':     { text: 'TEST note for day ' + date },
    },
  };
}

// Ignore duplicate-key races between two instances seeding at the same moment.
const ignoreDup = p => p.catch(e => { if (e.code !== 11000) throw e; });

async function ensureTask(Task, username, t, order, reset) {
  const found = await Task.findOne({ $or: [{ legacyKey: legacyKey(username, t.name) }, { name: t.name, assignees: username }] }).lean();
  if (found) {
    if (reset) await Task.updateOne({ taskId: found.taskId }, {
      $set: { ...t, active: true, order }, $addToSet: { assignees: username }, $pull: { formerAssignees: username } });
    return found.taskId;
  }
  const taskId = newTaskId();
  try {
    await Task.create({ taskId, legacyKey: legacyKey(username, t.name), ...t, active: true, order, assignees: [username] });
    return taskId;
  } catch (e) {
    if (e.code !== 11000) throw e;
    return (await Task.findOne({ legacyKey: legacyKey(username, t.name) }).lean()).taskId;
  }
}

// Rebuild "today" for the demo: once per day, or always when force (seed:staging).
async function refreshDemoDay({ Entry, Attendance, Config }, byId, { force = false } = {}) {
  const today = localNow().date;
  if (force) {
    await Config.updateOne({ key: 'stagingDemoDate' }, { $set: { value: today } }, { upsert: true });
  } else {
    try {
      const r = await Config.updateOne({ key: 'stagingDemoDate', value: { $ne: today } }, { $set: { value: today } }, { upsert: true });
      if (!r.modifiedCount && !r.upsertedCount) return;
    } catch (e) { if (e.code === 11000) return; throw e; } // another instance did it, or already done today
  }
  const day = n => addDays(today, n);
  const ov  = ['test.ov.a', 'test.ov.b', 'test.ov.c', 'test.ov.d'];
  const put = (Model, username, date, doc) => ignoreDup(Model.updateOne({ username, date }, { $setOnInsert: { username, date, ...doc } }, { upsert: true }));
  const entry = (username, date, tasks) => put(Entry, username, date, { tasks: { ...byId(username, tasks), _managerNote: '' }, entryVersion: ENTRY_VERSION });
  const att = (username, date, a) => put(Attendance, username, date, { workMode: 'WFO', note: 'TEST record', checkOuts: [], totalCheckOutMinutes: 0, totalWorkingMinutes: 0, ...a });
  const worked = (start, end, mode = 'WFO') => ({ workMode: mode, startTime: start, ...(end ? { endTime: end } : {}), sessions: [{ startTime: start, endTime: end || '', workMode: mode }] });

  // The demo accounts are always reset to today's scenario
  const reset = [...ov, ...(force ? ['test.member1', 'test.member2'] : [])];
  await Entry.deleteMany({ username: { $in: reset }, date: today });
  await Attendance.deleteMany({ username: { $in: reset }, date: today });
  await Entry.deleteMany({ username: 'test.ov.b', date: { $in: [day(-1), day(-2), day(-3)] } });
  await Attendance.deleteMany({ username: 'test.ov.b', date: { $in: [day(-1), day(-2), day(-3)] } });

  // Member One / Two keep a 3-day history; today's demo only fills an empty day
  for (let i = 1; i <= 3; i++) {
    const e = testEntries(i - 1, day(-i));
    await entry('test.member1', day(-i), e['test.member1']);
    await entry('test.member2', day(-i), e['test.member2']);
    await att('test.member1', day(-i), worked('09:00', '17:00'));
    await att('test.member2', day(-i), worked('09:00', '17:00', 'WFH'));
  }
  // Member One: working, Guest Posting 5/5, Reddit 2/4 → 75%.  Member Two: nothing today.
  await att('test.member1', today, worked('09:00'));
  await entry('test.member1', today, { 'Guest Posting': { rows: [{ client: 'TEST Client A', value: '5' }], total: 5, sectionNote: '' },
                                       'Reddit Profile': { value: '2', sectionNote: '' } });
  // A: entry without attendance (40%)
  await entry('test.ov.a', today, { 'OV Count A': { value: '4', sectionNote: '' } });
  // B: on break, 30% today, under 50% on the last 3 working days
  await att('test.ov.b', today, { ...worked('09:00'), checkOuts: [{ outTime: '13:00', inTime: '' }] });
  await entry('test.ov.b', today, { 'OV Count B': { value: '3', sectionNote: '' } });
  for (const [n, v] of [[-1, '2'], [-2, '4'], [-3, '1']]) {
    await att('test.ov.b', day(n), worked('09:00', '17:00'));
    await entry('test.ov.b', day(n), { 'OV Count B': { value: v, sectionNote: '' } });
  }
  // C: worked 09:00–17:00, no entry.  D: working, note entry (no target)
  await att('test.ov.c', today, worked('09:00', '17:00'));
  await att('test.ov.d', today, worked('10:00', null, 'WFH'));
  await entry('test.ov.d', today, { 'OV Note D': { text: 'TEST note', sectionNote: '' } });
  console.log(`✓ Staging demo day refreshed for ${today}`);
}

async function seedStagingData({ User, Entry, Attendance, Task, Config }, { reset = false } = {}) {
  const dbName = User.db.name;
  if (!/staging/i.test(dbName)) throw new Error(`Refusing to seed non-staging database "${dbName}"`);

  const password = await hashPassword(TEST_PASSWORD);
  for (const u of TEST_USERS) {
    await ignoreDup(User.updateOne(
      { username: u.username },
      reset ? { $set: { ...u, password, passwordVersion: 1 } }
            : { $setOnInsert: { ...u, password, passwordVersion: 1 } },
      { upsert: true }
    ));
  }

  // Tasks keyed like migrated ones ("<username>|<name>"), so re-seeding re-uses them;
  // a task of the same name already assigned to the member is re-used too.
  const taskIds = {};
  for (const [username, list] of Object.entries(TEST_TASKS)) {
    taskIds[username] = {};
    for (let i = 0; i < list.length; i++) taskIds[username][list[i].name] = await ensureTask(Task, username, list[i], i, reset);
  }
  const byId = (username, tasks) => Object.fromEntries(
    Object.entries(tasks).map(([name, v]) => [taskIds[username][name] || name, v]));

  // Member One / Two history and every demo account's "today" come from the demo day
  if (reset) {
    const testNames = TEST_USERS.filter(u => u.role === 'member').map(u => u.username);
    await Entry.deleteMany({ username: { $in: testNames } });
    await Attendance.deleteMany({ username: { $in: testNames } });
  }
  await refreshDemoDay({ Entry, Attendance, Config }, byId, { force: reset });
  console.log(`✓ Staging test data ready in "${dbName}"`);
}

module.exports = { seedStagingData, TEST_USERS, TEST_PASSWORD };
